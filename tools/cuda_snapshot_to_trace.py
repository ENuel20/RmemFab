"""Convert a PyTorch CUDA allocator snapshot into an RmemFab trace.

The snapshot is produced by ``torch.cuda.memory._dump_snapshot(path)`` after
``torch.cuda.memory._record_memory_history(...)``. This converter emits the
allocator's ``alloc`` / ``free`` history in ``SPECS/trace.schema.json`` form.

It is intentionally separate from ``infra/modal/capture.py`` so a snapshot
downloaded from a Modal volume can be converted without rerunning vLLM.

Usage:

    python tools/cuda_snapshot_to_trace.py \
        --snapshot runs/traces/<run>/snapshot.pickle \
        --out runs/traces/<run>/allocator_trace.jsonl \
        --model facebook/opt-125m

Requires the same major PyTorch version that wrote the snapshot if the pickle
contains torch classes. Loading a plain snapshot does not require a GPU.
"""

from __future__ import annotations

import argparse
import json
import pickle
from pathlib import Path


def _load(path: Path):
    try:
        with path.open("rb") as f:
            return pickle.load(f)
    except ModuleNotFoundError as exc:
        raise SystemExit(
            f"{exc}. Install the matching torch version to read this snapshot."
        ) from exc


def _rows(snapshot: dict, min_bytes: int, device: int | None):
    first_us: int | None = None
    events: list[dict] = []
    traces = snapshot.get("device_traces", [])
    for device_index, device_trace in enumerate(traces):
        if device is not None and device_index != device:
            continue
        for entry in device_trace:
            action = entry.get("action")
            if action == "alloc":
                op = "alloc"
            elif action == "free_completed":
                op = "free"
            else:
                continue
            size = int(entry.get("size", 0))
            if size < min_bytes:
                continue
            time_us = int(entry.get("time_us", 0))
            if first_us is None or time_us < first_us:
                first_us = time_us
            events.append(
                {
                    "ts_ns": time_us * 1000,
                    "op": op,
                    "page_id": f"cuda:{int(entry.get('addr', 0)):x}",
                    "bytes": size,
                    "tier": "local",
                    "metadata": {
                        "source": "torch.cuda.memory._snapshot",
                        "action": action,
                        "stream": entry.get("stream"),
                        "device": device_index,
                    },
                }
            )
    if first_us is not None:
        for event in events:
            event["ts_ns"] = max(0, event["ts_ns"] - first_us * 1000)
    events.sort(key=lambda e: (e["ts_ns"], e["page_id"], e["op"]))
    return events


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--model", default="unknown")
    parser.add_argument("--min-bytes", type=int, default=1)
    parser.add_argument("--device", type=int, default=None)
    args = parser.parse_args()

    snapshot = _load(args.snapshot)
    events = _rows(snapshot, max(1, args.min_bytes), args.device)

    header = {
        "type": "header",
        "trace_version": "0.1",
        "source": "torch-cuda-snapshot",
        "model": args.model,
        "runtime": "torch.cuda.memory._snapshot",
        "clock_unit": "ns",
        "notes": "Allocator alloc/free history, converted from snapshot.pickle.",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        for row in [header, *events]:
            f.write(json.dumps(row, sort_keys=True, separators=(",", ":")))
            f.write("\n")
    print(f"wrote {len(events)} allocator events to {args.out}")


if __name__ == "__main__":
    main()
