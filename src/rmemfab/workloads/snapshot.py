"""Converter: PyTorch CUDA allocator snapshots -> RmemFab trace records.

Accepts the pickle written by torch.cuda.memory._dump_snapshot() or the same dict as JSON.
The pickle is read with a restricted unpickler that refuses every global, so loading a
snapshot cannot execute code (snapshots contain only plain dict/list/str/int values).
Allocator snapshots contain alloc/free history but no access records; `touch_on_alloc`
optionally adds one write per allocation and the header says so.
"""
from __future__ import annotations

import hashlib
import io
import json
import pickle


class _Restricted(pickle.Unpickler):
    def find_class(self, module, name):
        raise pickle.UnpicklingError(f"snapshot pickle references {module}.{name}; only plain data is allowed")


def load_snapshot(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    sha = hashlib.sha256(raw).hexdigest()
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        data = _Restricted(io.BytesIO(raw)).load()
    if not isinstance(data, dict):
        raise ValueError("snapshot must be a dict")
    return data, sha


def convert_snapshot(snap: dict, *, source_sha256: str, label: str = "measured", touch_on_alloc: bool = False):
    """Return (header, ops, report). ops are (ts, op, page_id, bytes, node, None)."""
    rep = {"alloc": 0, "free": 0, "touch_writes": 0, "dropped": {}, "ignored_actions": {},
           "synthesized": {"timestamps": 0, "from_segments": 0}}
    events = []
    traces = snap.get("device_traces") or []
    for dev, tr in enumerate(traces):
        node = f"gpu{dev}"
        live, gen = {}, {}
        for i, e in enumerate(tr):
            act = e.get("action")
            if "time_us" in e:
                ts = int(e["time_us"]) * 1000
            else:
                ts, _ = i * 1000, rep["synthesized"].__setitem__("timestamps", rep["synthesized"]["timestamps"] + 1)
            addr, size = int(e.get("addr", 0)), int(e.get("size", 0))
            if act == "alloc":
                if size <= 0:
                    rep["dropped"]["alloc_zero_size"] = rep["dropped"].get("alloc_zero_size", 0) + 1
                    continue
                n = gen.get(addr, 0)
                gen[addr] = n + 1
                pid = f"{node}/{addr:#x}#{n}"
                live[addr] = (pid, size)
                events.append((ts, dev, i, "alloc", pid, size, node))
                if touch_on_alloc:
                    events.append((ts, dev, i, "write", pid, size, node))
            elif act == "free_requested":
                if addr not in live:
                    rep["dropped"]["free_of_unknown_block"] = rep["dropped"].get("free_of_unknown_block", 0) + 1
                    continue
                pid, sz = live.pop(addr)
                events.append((ts, dev, i, "free", pid, sz, node))
            else:
                rep["ignored_actions"][str(act)] = rep["ignored_actions"].get(str(act), 0) + 1
    if not events:
        for si, seg in enumerate(snap.get("segments") or []):
            dev = int(seg.get("device", 0))
            for bi, b in enumerate(seg.get("blocks") or []):
                if b.get("state") == "active_allocated" and int(b.get("size", 0)) > 0:
                    rep["synthesized"]["from_segments"] += 1
                    events.append((0, dev, si * 100000 + bi, "alloc",
                                   f"gpu{dev}/{int(b.get('address', 0)):#x}#0", int(b["size"]), f"gpu{dev}"))
    events.sort(key=lambda e: (e[0], e[1], e[2]))
    if not events:
        raise ValueError("snapshot has no device_traces and no active blocks; record with "
                         "torch.cuda.memory._record_memory_history() before dumping")
    t0 = events[0][0]
    ops = [(e[0] - t0, e[3], e[4], e[5], e[6], None) for e in events]
    rep["alloc"] = sum(1 for o in ops if o[1] == "alloc")
    rep["free"] = sum(1 for o in ops if o[1] == "free")
    rep["touch_writes"] = sum(1 for o in ops if o[1] == "write")
    header = {
        "type": "header", "trace_version": "0.1", "source": "pytorch-cuda-snapshot", "clock_unit": "ns",
        "label": label, "source_sha256": source_sha256, "conversion": rep,
        "notes": ("Converted from allocator history. Allocator snapshots carry no access records"
                  + ("; one write per allocation was synthesized (touch_on_alloc)." if touch_on_alloc else
                     "; the trace contains alloc/free only.")),
    }
    return header, ops, rep
