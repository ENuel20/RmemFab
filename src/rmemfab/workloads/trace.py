"""Trace importer (docs/WORKLOADS.md): validation, page normalization, hashing."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from ..config.schema import trace_schema, validate_schema

LABELS = ("synthetic", "measured", "calibrated")
OPS = ("alloc", "free", "read", "write", "migrate", "prefetch", "evict")
# op tuple used everywhere downstream: (ts_ns, op, page_id, normalized_bytes, node, request_id)


class TraceError(Exception):
    pass


def normalize_bytes(nbytes: int, page: int):
    """Round up to a page multiple. Returns (normalized, adjusted?)."""
    nb = -(-nbytes // page) * page
    return nb, nb != nbytes


def seq_digest(entries) -> str:
    h = hashlib.sha256()
    for kind, pid, nb in entries:
        h.update(f"{kind}|{pid}|{nb}\n".encode())
    return h.hexdigest()


@dataclass
class LoadedTrace:
    ops: list
    info: dict = field(default_factory=dict)


def load_trace(path, page: int, *, sort=False, round_bytes=True, time_scale=1.0, best_effort=False) -> LoadedTrace:
    """Read, validate line by line, normalize, and hash a JSONL trace."""
    with open(path, "rb") as fh:
        raw_bytes = fh.read()
    sha = hashlib.sha256(raw_bytes).hexdigest()
    schema = trace_schema()
    header, rows, rejected = None, [], []
    adj = {"records": 0, "added_bytes": 0, "examples": []}
    unknown_fields = 0
    for ln, line in enumerate(raw_bytes.decode("utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
            errs = validate_schema(rec, schema)
            if errs:
                raise ValueError("; ".join(errs[:3]))
            if rec.get("type") == "header":
                if header is not None or rows:
                    raise ValueError("header must be the first record and appear once")
                header = rec
                continue
            if "type" in rec and rec["type"] == "header":
                raise ValueError("misplaced header")
        except (ValueError, json.JSONDecodeError) as exc:
            if best_effort:
                rejected.append({"line": ln, "error": str(exc)[:200]})
                continue
            raise TraceError(f"{path}:{ln}: {exc}") from exc
        nb, changed = normalize_bytes(rec["bytes"], page)
        if changed:
            if not round_bytes:
                raise TraceError(f"{path}:{ln}: bytes={rec['bytes']} is not a multiple of the page size "
                                 f"{page} (set workload.round_bytes=true to round up)")
            adj["records"] += 1
            adj["added_bytes"] += nb - rec["bytes"]
            if len(adj["examples"]) < 5:
                adj["examples"].append({"line": ln, "page_id": rec["page_id"], "bytes": rec["bytes"], "normalized": nb})
        unknown_fields += sum(1 for k in rec if k not in schema["$defs"]["record"]["properties"])
        rows.append((ln, rec["ts_ns"], rec["op"], rec["page_id"], nb, rec.get("node"), rec.get("request_id")))
    out_of_order = sum(1 for a, b in zip(rows, rows[1:]) if b[1] < a[1])
    file_order_digest = seq_digest((r[2], r[3], r[4]) for r in rows if r[2] in ("alloc", "free"))
    if out_of_order:
        if not sort:
            first = next(b for a, b in zip(rows, rows[1:]) if b[1] < a[1])
            raise TraceError(f"{path}:{first[0]}: ts_ns goes backwards ({out_of_order} out-of-order records); "
                             f"set workload.sort=true / --trace-sort, or write a clean copy with "
                             f"`rmemfab trace-normalize`")
        rows = sorted(rows, key=lambda r: r[1])  # stable
    if not rows:
        raise TraceError(f"{path}: trace has no records")
    origin = (header or {}).get("ts_origin_ns")
    t0 = origin if isinstance(origin, int) and not isinstance(origin, bool) else rows[0][1]
    ops = [(int(round((r[1] - t0) * time_scale)), r[2], r[3], r[4], r[5], r[6]) for r in rows]
    label = (header or {}).get("label")
    label_note = None
    if label not in LABELS:
        label_note = ("trace header has no valid 'label' (synthetic | measured | calibrated); "
                      "treated as synthetic so it can never be shown as measured")
        label = "synthetic"
    info = {
        "path": str(path), "sha256": sha, "records": len(ops), "header": header or {}, "label": label,
        "label_note": label_note, "ts_origin_ns": t0, "page_normalization": adj, "sorted": bool(out_of_order),
        "out_of_order_records": out_of_order, "unknown_fields_preserved": unknown_fields,
        "rejected_lines": rejected, "time_scale": time_scale, "duration_ns": ops[-1][0],
        "recorded_alloc_free_sha256": seq_digest((o[1], o[2], o[3]) for o in ops if o[1] in ("alloc", "free")),
        "file_order_alloc_free_sha256": file_order_digest,
        "sort_reordered_alloc_free": False,   # filled below
        "pairing": _pairing(ops),
        "ops": {k: sum(1 for o in ops if o[1] == k) for k in OPS},
    }
    info["sort_reordered_alloc_free"] = info["file_order_alloc_free_sha256"] != info["recorded_alloc_free_sha256"]
    if rejected:
        broken = info["pairing"]["orphan_frees"] + info["pairing"]["accesses_before_alloc"]
        info["best_effort_warning"] = (
            f"{len(rejected)} line(s) were dropped; the retained records have {info['pairing']['orphan_frees']} "
            f"free(s) with no alloc and {info['pairing']['accesses_before_alloc']} access(es) before alloc"
            + ("; alloc/free pairing is BROKEN, replay results are not trustworthy" if broken else ""))
    return LoadedTrace(ops, info)


def _pairing(ops) -> dict:
    """Static alloc/free consistency of the retained records (cheap; order = replay order)."""
    live, seen = set(), set()
    orphan_free = before_alloc = dup = 0
    for _, kind, pid, _, _, _ in ops:
        if kind == "alloc":
            if pid in live:
                dup += 1
            live.add(pid)
            seen.add(pid)
        elif kind == "free":
            if pid in live:
                live.discard(pid)
            else:
                orphan_free += 1
        elif kind in ("read", "write") and pid not in live:
            before_alloc += 1
    return {"orphan_frees": orphan_free, "accesses_before_alloc": before_alloc, "duplicate_allocs": dup,
            "never_freed": len(live)}


def normalize_trace(src, dst, *, label=None, page_size=2097152, hoist_allocs=False) -> dict:
    """Write a spec-conforming copy of a trace: stable-sorted, non-negative timestamps, explicit label.

    Nothing is dropped or invented unless `hoist_allocs` is requested: that moves an alloc whose page was
    already accessed earlier up to its first access (a derivation artifact in generated traces), and the
    number of moved records is written to the header. The source hash and every change are recorded in the header so the
    copy can always be traced back to the captured file.
    """
    with open(src, "rb") as fh:
        raw = fh.read()
    sha = hashlib.sha256(raw).hexdigest()
    header, recs = None, []
    for ln, line in enumerate(raw.decode("utf-8").splitlines(), 1):
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get("type") == "header":
            if header is not None or recs:
                raise TraceError(f"{src}:{ln}: header must be the first record and appear once")
            header = rec
        else:
            for k in ("ts_ns", "op", "page_id", "bytes"):
                if k not in rec:
                    raise TraceError(f"{src}:{ln}: record lacks '{k}'")
            recs.append(rec)
    if not recs:
        raise TraceError(f"{src}: trace has no records")
    header = dict(header or {"type": "header", "trace_version": "0.1", "source": "unknown"})
    have = header.get("label")
    if label is None and have not in LABELS:
        raise TraceError(f"{src}: header has no label; pass --label measured|calibrated|synthetic explicitly "
                         "(a trace is never labeled on your behalf)")
    if label is not None and have in LABELS and have != label:
        raise TraceError(f"{src}: header already says label={have!r}; refusing to relabel as {label!r}")
    header["label"] = label or have
    reordered = sum(1 for a, b in zip(recs, recs[1:]) if b["ts_ns"] < a["ts_ns"])
    hoisted = 0
    hoisted_ids = set()
    if hoist_allocs:
        first = {}
        for r in sorted(recs, key=lambda r: r["ts_ns"]):
            first.setdefault(r["page_id"], r["ts_ns"])
        for r in recs:
            if r["op"] == "alloc" and r["ts_ns"] > first[r["page_id"]]:
                r["ts_ns"] = first[r["page_id"]]
                hoisted_ids.add(id(r))
                hoisted += 1
    # stable: ties keep capture order (alloc before its first read); hoisted allocs go first at their new time
    recs.sort(key=lambda r: (r["ts_ns"], 0 if id(r) in hoisted_ids else 1))
    lo = recs[0]["ts_ns"]
    shift = -lo if lo < 0 else 0
    if shift:
        for r in recs:
            r["ts_ns"] += shift
    header["normalized_from_sha256"] = sha
    header["normalization"] = {"stable_sorted": True, "out_of_order_records": reordered, "ts_shift_ns": shift,
                               "records": len(recs), "hoisted_allocs": hoisted, "tool": "rmemfab trace-normalize"}
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(header, sort_keys=True, separators=(",", ":")) + "\n")
        for r in recs:
            f.write(json.dumps(r, sort_keys=True, separators=(",", ":")) + "\n")
    out = load_trace(dst, page_size)   # must now load strictly, with no sort and no best-effort
    return {"source_sha256": sha, "sha256": out.info["sha256"], "records": len(recs), "label": header["label"],
            "out_of_order_records": reordered, "ts_shift_ns": shift, "hoisted_allocs": hoisted}


def write_trace(path, header: dict, ops, *, include_tier=False) -> dict:
    """Write header + records (ops are (ts, op, page_id, bytes, node, request_id))."""
    n = 0
    h = hashlib.sha256()
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        line = json.dumps(header, separators=(",", ":"), sort_keys=False) + "\n"
        f.write(line)
        for ts, op, pid, nb, node, rid in ops:
            rec = {"ts_ns": ts, "op": op, "page_id": pid, "bytes": nb}
            if node is not None:
                rec["node"] = node
            if rid is not None:
                rec["request_id"] = rid
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")
            n += 1
    return {"records": n, "sha256": _file_sha(path)}


def _file_sha(path) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()
