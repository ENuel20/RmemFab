"""Run-bundle and trace-upload storage behind the HTTP API.

Thin IO over the on-disk layout the engines already write: a run bundle is
a directory with scenario.json / summary.json / manifest.json /
series.jsonl / events.jsonl (optional) / README.md. Nothing here reimplements
engine math; series decimation and event paging are presentation-only.
"""
from __future__ import annotations

import hashlib
import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SUMMARY = "summary.json"
MANIFEST = "manifest.json"
SCENARIO = "scenario.json"
SERIES = "series.jsonl"
EVENTS = "events.jsonl"
FAILURE = "failure.json"
README = "README.md"


def split_error(err: str) -> dict:
    """'path: message' strings -> {path, message} (path may be '')."""
    path, sep, message = err.partition(": ")
    if not sep:
        return {"path": "", "message": err}
    return {"path": path, "message": message}


class RunStore:
    def __init__(self, runs_dir):
        self.runs = Path(runs_dir)
        self.runs.mkdir(parents=True, exist_ok=True)

    def bundle_dir(self, run_id: str) -> Path | None:
        d = self.runs / run_id
        if not d.is_dir():
            return None
        if not (d / SUMMARY).is_file() and not (d / FAILURE).is_file():
            return None
        return d

    @staticmethod
    def _read_json(path: Path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def status_of(self, d: Path) -> str:
        if (d / SUMMARY).is_file():
            return "completed"
        return "failed"

    def strip(self, run_id: str) -> dict | None:
        """RunSummary strip shape (PRODUCT-SPEC section 4)."""
        d = self.bundle_dir(run_id)
        if d is None:
            return None
        s = self._read_json(d / SUMMARY) or {}
        m = self._read_json(d / MANIFEST) or {}
        sc = self._read_json(d / SCENARIO) or {}
        lat = (s.get("access") or {}).get("latency_ns") or {}
        req = s.get("requests") or {}
        traf = s.get("traffic") or {}
        pol = s.get("policy") or m.get("policy") or {}
        try:
            created = datetime.fromtimestamp(
                (d / SUMMARY).stat().st_mtime, tz=timezone.utc).isoformat()
        except OSError:
            created = None
        fail = self._read_json(d / FAILURE) or {}
        return {
            "run_id": run_id,
            "scenario_name": s.get("scenario") or sc.get("name"),
            "scenario_hash": s.get("scenario_hash") or m.get("scenario_hash"),
            "seed": s.get("seed"),
            "policy": {"requested": pol.get("requested"),
                       "effective": pol.get("effective"),
                       "fallback_reason": pol.get("fallback_reason")},
            "status": self.status_of(d),
            "error": fail.get("error"),
            "arrived": req.get("arrived"), "completed": req.get("completed"),
            "rejected": req.get("rejected"),
            "p50": lat.get("p50"), "p95": lat.get("p95"),
            "remote_read_bytes": traf.get("remote_read_bytes"),
            "migration_bytes": traf.get("migration_bytes"),
            "created_at": created,
        }

    def list(self, *, limit=50, policy=None, status=None) -> list:
        rows = []
        for d in sorted(self.runs.iterdir()):
            if not d.is_dir():
                continue
            row = self.strip(d.name)
            if row is None:
                continue
            if policy is not None and row["policy"].get("effective") != policy:
                continue
            if status is not None and row["status"] != status:
                continue
            rows.append(row)
            if len(rows) >= limit:
                break
        return rows

    def detail(self, run_id: str) -> dict | None:
        d = self.bundle_dir(run_id)
        if d is None:
            return None
        return {"run_id": run_id, "status": self.status_of(d),
                "summary": self._read_json(d / SUMMARY),
                "manifest": self._read_json(d / MANIFEST),
                "error": (self._read_json(d / FAILURE) or {}).get("error")}

    def series(self, run_id: str, downsample: int) -> list | None:
        d = self.bundle_dir(run_id)
        if d is None or not (d / SERIES).is_file():
            return None
        rows = []
        with open(d / SERIES, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
        n = max(int(downsample), 1)
        if len(rows) <= n:
            return rows
        import math
        stride = math.ceil(len(rows) / n)
        return rows[::stride][:n]

    def events(self, run_id: str, *, types=None, t0=None, t1=None,
               request_id=None, limit=500, cursor=None) -> dict | None:
        d = self.bundle_dir(run_id)
        if d is None:
            return None
        if not (d / EVENTS).is_file():
            return {"events": [], "next_cursor": None, "summary_only": True}
        try:
            offset = max(int(cursor), 0) if cursor is not None else 0
        except (TypeError, ValueError):
            offset = 0
        wanted = set(types.split(",")) if types else None
        out, idx, kept = [], 0, 0
        limit = min(max(int(limit), 1), 5000)
        with open(d / EVENTS, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if idx < offset:
                    idx += 1
                    continue
                e = json.loads(line)
                idx += 1
                if wanted is not None and e.get("event") not in wanted:
                    continue
                if t0 is not None and e.get("time_ns", 0) < t0:
                    continue
                if t1 is not None and e.get("time_ns", 0) > t1:
                    continue
                if request_id is not None and e.get("request_id") != request_id:
                    continue
                out.append(e)
                kept += 1
                if kept >= limit:
                    break
        nxt = None
        # Any unread lines remain (filters may have skipped some, so probe).
        with open(d / EVENTS, encoding="utf-8") as f:
            total = sum(1 for line in f if line.strip())
        if idx < total:
            nxt = str(idx)
        return {"events": out, "next_cursor": nxt, "summary_only": False}

    def iter_sse(self, run_id: str):
        """Yield SSE chunks replaying stored events over virtual time."""
        d = self.bundle_dir(run_id)
        if d is None or not (d / EVENTS).is_file():
            yield 'event: done\ndata: {"summary_only": true}\n\n'
            return
        last_t = None
        with open(d / EVENTS, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                e = json.loads(line)
                t = e.get("time_ns")
                if t != last_t:
                    last_t = t
                    yield f"event: tick\ndata: {json.dumps({'t_ns': t})}\n\n"
                yield f"event: event\ndata: {line}\n\n"
        yield 'event: done\ndata: {}\n\n'

    def export_zip(self, run_id: str) -> bytes | None:
        d = self.bundle_dir(run_id)
        if d is None:
            return None
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for name in (SCENARIO, MANIFEST, SUMMARY, SERIES, EVENTS, README):
                p = d / name
                if p.is_file():
                    z.write(p, arcname=f"{run_id}/{name}")
        return buf.getvalue()


class TraceStore:
    def __init__(self, traces_dir, max_bytes=128 * 1024 * 1024):
        self.traces = Path(traces_dir)
        self.traces.mkdir(parents=True, exist_ok=True)
        self.max_bytes = int(max_bytes)

    def save(self, filename: str, data: bytes) -> tuple[str, Path]:
        digest = hashlib.sha256(data).hexdigest()
        trace_id = digest[:16]
        path = self.traces / f"{trace_id}.jsonl"
        path.write_bytes(data)
        (self.traces / f"{trace_id}.name").write_text(
            Path(filename).name, encoding="utf-8")
        return trace_id, path

    def discard(self, trace_id: str):
        for suffix in (".jsonl", ".name", ".profile.json"):
            p = self.traces / f"{trace_id}{suffix}"
            if p.is_file():
                p.unlink()

    def profile_path(self, trace_id: str) -> Path | None:
        p = self.traces / f"{trace_id}.profile.json"
        return p if p.is_file() else None

    def get(self, trace_id: str) -> dict | None:
        p = self.profile_path(trace_id)
        if p is None:
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def list(self) -> list:
        out = []
        for p in sorted(self.traces.glob("*.profile.json")):
            try:
                out.append(json.loads(p.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        return out


def trace_profile(trace_id: str, filename: str, vt) -> dict:
    """TraceProfile shape (PRODUCT-SPEC section 4) from a ValidatedTrace."""
    header = vt.header or {}
    counts = {"alloc": 0, "read": 0, "write": 0, "free": 0, "migrate": 0}
    for o in vt.ops:
        if o["op"] in counts:
            counts[o["op"]] += 1
    counts["migrate"] = vt.report["stats"].get("ignored_policy_ops", 0)
    pages = {o["page_id"] for o in vt.ops}
    unit = vt.unit_bytes
    return {
        "trace_id": trace_id, "filename": filename, "sha256": vt.sha256,
        "source": header.get("source"), "model": header.get("model"),
        "runtime": header.get("runtime"),
        "capture_date": header.get("capture_date"),
        "converter": header.get("converter"),
        "trace_schema_version": header.get("trace_version"),
        "provenance": header.get("provenance"),
        "limitation_note": header.get("limitation_note"),
        "counts": counts, "requests": vt.report["stats"].get("requests", 0),
        "footprint_bytes": len(pages) * unit if unit else None,
        "normalized_pages": len(pages),
        "validation": {"errors": vt.report.get("errors", []),
                       "warnings": vt.report.get("warnings", [])},
        "normalization": vt.report.get("normalization", {}),
    }
