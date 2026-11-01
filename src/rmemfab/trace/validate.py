"""Trace validation and normalization for replay.

Rules (all refusals name the first offending row):
- Row 1 must be a header (`type: header`, `trace_version: 0.1`, non-empty `source`).
- Every op row needs `ts_ns` (int >= 0), `op` (schema enum), `page_id`,
  `bytes` (int >= 1). Negative timestamps and malformed rows are errors.
- Lifecycle per page, in replay order: alloc -> (read|write)* -> free.
  Ops before alloc, after free, double allocs, and frees without allocs are
  errors. Empty traces (header only) are valid with zero ops.
- Ordering: replay order is (ts_ns, file order). `sort=True` (default)
  normalizes and reports how many rows moved; `sort=False` refuses
  out-of-order files instead.
- Observed placement is NEVER replayed: `migrate`/`prefetch`/`evict` rows,
  `tier` hints, and `latency_ns` observations are counted, reported, and
  ignored. The configured policy recomputes all placement; anything else
  would bake the capture system's decisions into the evaluation.
- Page units: allocation sizes must be uniform (the trace unit) unless
  `round_bytes` is set, in which case every op rounds up to whole engine
  pages and the inflation is reported. A scenario page size different from
  the trace unit is an error unless `round_bytes` is set.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

HEADER_VERSION = "0.1"
OPS = ("alloc", "free", "read", "write", "migrate", "prefetch", "evict")
IGNORED_OPS = ("migrate", "prefetch", "evict")


class TraceError(Exception):
    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__("; ".join(self.errors))


@dataclass
class ValidatedTrace:
    path: str
    sha256: str
    header: dict
    ops: list  # normalized dicts, replay order
    unit_bytes: int | None
    report: dict = field(default_factory=dict)


def _is_int(x):
    return (isinstance(x, int) and not isinstance(x, bool))


def load_trace(path, *, sort=True, round_bytes=False, time_scale=1.0,
               page_size=None, node=None) -> ValidatedTrace:
    errors, warnings = [], []
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise TraceError([f"{path}: cannot read trace: {exc}"]) from exc
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    lines = [ln for ln in text.split("\n") if ln.strip()]
    if not lines:
        raise TraceError([f"{path}: empty file (a header row is required)"])
    try:
        header = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise TraceError([f"{path}:1: malformed JSON: {exc}"]) from exc
    if not isinstance(header, dict) or header.get("type") != "header":
        raise TraceError([f"{path}:1: first row must be a header (type: header)"])
    if header.get("trace_version") != HEADER_VERSION:
        errors.append(f"{path}:1: trace_version {header.get('trace_version')!r} is not {HEADER_VERSION!r}")
    if not header.get("source"):
        errors.append(f"{path}:1: header.source is required")

    rows = []
    for lineno, ln in enumerate(lines[1:], start=2):
        try:
            r = json.loads(ln)
        except json.JSONDecodeError as exc:
            errors.append(f"{path}:{lineno}: malformed JSON: {exc}")
            continue
        if not isinstance(r, dict):
            errors.append(f"{path}:{lineno}: expected an object")
            continue
        rows.append((lineno, r))
    if errors:
        raise TraceError(errors)

    # per-row field checks
    for lineno, r in rows:
        op = r.get("op")
        if op not in OPS:
            errors.append(f"{path}:{lineno}: op {op!r} is not one of {list(OPS)}")
            continue
        if op in IGNORED_OPS:
            continue  # field-checked lightly below; skipped from lifecycle
        if not _is_int(r.get("ts_ns")) or r["ts_ns"] < 0:
            errors.append(f"{path}:{lineno}: ts_ns must be an integer >= 0")
        pid = r.get("page_id")
        if not isinstance(pid, str) or not (1 <= len(pid) <= 512):
            errors.append(f"{path}:{lineno}: page_id must be a 1..512 char string")
        if not _is_int(r.get("bytes")) or r["bytes"] < 1:
            errors.append(f"{path}:{lineno}: bytes must be an integer >= 1")
        if "tier" in r and r["tier"] not in ("local", "remote", "cache"):
            errors.append(f"{path}:{lineno}: tier {r['tier']!r} is not local/remote/cache")
        if "latency_ns" in r and (not isinstance(r["latency_ns"], (int, float)) or r["latency_ns"] < 0):
            errors.append(f"{path}:{lineno}: latency_ns must be a number >= 0")
    if errors:
        if len(errors) > 25:
            errors = errors[:25] + [f"... and {len(errors) - 25} more defect(s)"]
        raise TraceError(errors)

    # time scale (order-preserving: positive monotonic map)
    try:
        scale = float(time_scale)
    except (TypeError, ValueError):
        raise TraceError([f"{path}: time_scale {time_scale!r} is not a number"]) from None
    if not scale > 0:
        raise TraceError([f"{path}: time_scale must be > 0"])
    for _, r in rows:
        if r["op"] not in IGNORED_OPS:
            r["_ts"] = int(round(r["ts_ns"] * scale))

    # ordering
    live = [(ln, r) for ln, r in rows if r["op"] not in IGNORED_OPS]
    reordered = sum(1 for a, b in zip(live, live[1:]) if b[1]["_ts"] < a[1]["_ts"])
    if reordered and not sort:
        first = next(i for i, (a, b) in enumerate(zip(live, live[1:])) if b[1]["_ts"] < a[1]["_ts"])
        raise TraceError([f"{path}:{live[first + 1][0]}: out of order (ts decreases) and sort is false"])
    ordered = sorted(live, key=lambda t: (t[1]["_ts"], t[0]))

    # lifecycle in replay order
    live_pages: dict = {}
    for lineno, r in ordered:
        pid = r["page_id"]
        op = r["op"]
        if node is not None and "node" in r and r["node"] != node:
            errors.append(f"{path}:{lineno}: node {r['node']!r} is outside the --node {node!r} filter")
            continue
        if op == "alloc":
            if pid in live_pages:
                errors.append(f"{path}:{lineno}: double alloc of live page {pid!r}")
            else:
                live_pages[pid] = lineno
        elif op == "free":
            if pid not in live_pages:
                errors.append(f"{path}:{lineno}: free of unallocated page {pid!r}")
            else:
                del live_pages[pid]
        elif pid not in live_pages:
            errors.append(f"{path}:{lineno}: {op} of unallocated page {pid!r} "
                          f"(no live alloc; first defect wins)")
    if errors:
        raise TraceError(errors[:1] + ([f"... and {len(errors) - 1} more defect(s)"] if len(errors) > 1 else []))

    # unit bytes
    alloc_bytes = {r["bytes"] for _, r in ordered if r["op"] == "alloc"}
    unit = None
    if alloc_bytes:
        if len(alloc_bytes) > 1 and not round_bytes:
            raise TraceError([f"{path}: mixed alloc sizes {sorted(alloc_bytes)}; set round_bytes "
                              f"to map them onto engine pages explicitly"])
        unit = alloc_bytes.pop() if len(alloc_bytes) == 1 else None

    ops = [{"ts": r["_ts"], "row": ln, "op": r["op"], "page_id": r["page_id"],
            "request_id": r.get("request_id"), "bytes": r["bytes"],
            "node": r.get("node")} for ln, r in ordered]
    n_ignored = sum(1 for _, r in rows if r["op"] in IGNORED_OPS)
    n_lat = sum(1 for _, r in rows if "latency_ns" in r)
    n_tier = sum(1 for _, r in rows if "tier" in r)
    if n_ignored:
        warnings.append(f"{n_ignored} observed placement op(s) (migrate/prefetch/evict) are ignored; "
                        f"the configured policy recomputes all placement")
    if n_tier:
        warnings.append(f"{n_tier} row(s) carry tier hints; hints are ignored, placement is recomputed")
    if n_lat:
        warnings.append(f"{n_lat} row(s) carry observed latency_ns; observations are inputs, never results")
    if reordered and sort:
        warnings.append(f"{reordered} row(s) reordered into (ts_ns, file order); ties keep file order")
    pages = {o["page_id"] for o in ops}
    reqs = {o["request_id"] for o in ops if o["request_id"] is not None}
    report = {"valid": True, "errors": [], "warnings": warnings,
              "stats": {"ops": len(ops), "pages": len(pages), "requests": len(reqs),
                        "ts_min": min([o["ts"] for o in ops], default=0),
                        "ts_max": max([o["ts"] for o in ops], default=0),
                        "ignored_policy_ops": n_ignored, "observed_latency_rows": n_lat,
                        "tier_hints_ignored": n_tier, "reordered_steps": reordered},
              "normalization": {"sort_applied": bool(sort), "time_scale": scale,
                                "round_bytes": bool(round_bytes), "trace_unit_bytes": unit,
                                "engine_page_bytes": page_size}}
    return ValidatedTrace(str(path), sha, header, ops, unit, report)
