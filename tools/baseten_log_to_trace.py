"""Derive a canonical RmemFab trace from a Baseten raw request log.

Derivation (documented, not measured): each served request becomes P pages
where P = ceil(tokens * kv_bytes_per_token / page_size) under STATED
geometry flags (defaults are an 8B-class shape, not the served model's
geometry, which Baseten does not disclose). Each page gets alloc (at
arrival), one read (evenly spaced across the request's served span), and
free (at completion). Arrival/overlap patterns are the measured signal;
page counts are derived. Output header carries provenance=derived plus a
limitation note; the checked-in manifest repeats it.

Lifecycle is exact by construction: alloc -> read -> free per page, one
alloc row per page so alloc sizes are uniform (the validator rejects
mixed alloc sizes).

Example:
    python3 tools/baseten_log_to_trace.py /tmp/basen.jsonl \\
        --out /tmp/basen_trace.jsonl
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

CONVERTER = "tools/baseten_log_to_trace.py"
LIMITATION = ("request-level capture; page ops derived under stated geometry, "
              "not block-table-measured")


def kv_bytes_per_token(layers: int, kv_heads: int, head_dim: int,
                       dtype_bytes: int) -> int:
    return 2 * layers * kv_heads * head_dim * dtype_bytes


def convert(rows: list, *, kv_bpt: int, page_size: int) -> tuple[list, dict]:
    """Pure derivation: raw request rows -> canonical trace rows + stats."""
    ok = [r for r in rows if "error" not in r and r.get("arrival_ts")]
    if not ok:
        raise ValueError("no successful requests to derive from")
    t0 = min(r["arrival_ts"] for r in ok)
    out, pages_total = [], 0
    for r in sorted(ok, key=lambda r: r["arrival_ts"]):
        rid = r["request_id"]
        tokens = (r.get("prompt_tokens") or 0) + (r.get("completion_tokens") or 0)
        if tokens <= 0:
            continue
        pages = max(1, math.ceil(tokens * kv_bpt / page_size))
        t_arr = int((r["arrival_ts"] - t0) * 1e9)
        span = max((r.get("end_ts") or r["arrival_ts"]) - r["arrival_ts"], 0.001)
        for j in range(pages):
            pid = f"{rid}-p{j:05d}"
            out.append({"ts_ns": t_arr, "op": "alloc", "page_id": pid,
                        "request_id": rid, "bytes": page_size})
            t_read = t_arr + int(span * 1e9 * (j + 1) / (pages + 1))
            out.append({"ts_ns": t_read, "op": "read", "page_id": pid,
                        "request_id": rid, "bytes": page_size})
            out.append({"ts_ns": t_arr + int(span * 1e9), "op": "free",
                        "page_id": pid, "request_id": rid,
                        "bytes": page_size})
        pages_total += pages
    out.sort(key=lambda r: (r["ts_ns"], {"alloc": 0, "read": 1, "free": 2}[r["op"]]))
    stats = {"requests_ok": len(ok), "requests_error": len(rows) - len(ok),
             "requests_derived": sum(1 for r in ok if ((r.get("prompt_tokens") or 0)
                                     + (r.get("completion_tokens") or 0)) > 0),
             "pages": pages_total, "rows": len(out)}
    return out, stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("raw_log")
    ap.add_argument("--out", required=True)
    ap.add_argument("--layers", type=int, default=32)
    ap.add_argument("--kv-heads", type=int, default=8)
    ap.add_argument("--head-dim", type=int, default=128)
    ap.add_argument("--dtype-bytes", type=int, default=2)
    ap.add_argument("--page-size", type=int, default=2097152)
    a = ap.parse_args(argv)
    lines = [ln for ln in Path(a.raw_log).read_text(encoding="utf-8").split("\n")
             if ln.strip()]
    header = json.loads(lines[0])
    rows = [json.loads(ln) for ln in lines[1:]]
    kv_bpt = kv_bytes_per_token(a.layers, a.kv_heads, a.head_dim, a.dtype_bytes)
    trace_rows, stats = convert(rows, kv_bpt=kv_bpt, page_size=a.page_size)
    trace_header = {
        "type": "header", "trace_version": "0.1",
        "source": f"baseten:{header.get('model', 'unknown')}",
        "provenance": "derived", "converter": CONVERTER,
        "converter_params": {"layers": a.layers, "kv_heads": a.kv_heads,
                             "head_dim": a.head_dim,
                             "dtype_bytes": a.dtype_bytes,
                             "page_size": a.page_size,
                             "kv_bytes_per_token": kv_bpt},
        "limitation_note": LIMITATION,
        "derived_from": {"prompt_lens": header.get("prompt_lens"),
                         "concurrencies": header.get("concurrencies"),
                         "seed": header.get("seed")}}
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(json.dumps(trace_header) + "\n")
        for r in trace_rows:
            f.write(json.dumps(r) + "\n")
    print(json.dumps({"out": a.out, **stats}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
