"""Shared metric extraction: one flat row per run bundle.

Every consumer (sweep index, compare tables, CSV export) reads the same keys,
so a number in a CSV cell always matches the number in the compare report.
Missing metrics (replay has no request throughput; prefetch-less policies have
no accuracy) stay None, never 0.
"""
from __future__ import annotations


def _lat(lat):
    if not isinstance(lat, dict):
        return None, None, None, None
    return lat.get("mean"), lat.get("p50"), lat.get("p95"), lat.get("p99")


def extract(summary: dict) -> dict:
    a = summary.get("access", {})
    t = summary.get("traffic", {})
    mean, p50, p95, p99 = _lat(a.get("latency_ns"))
    req = summary.get("requests", {})
    return {
        "policy": summary.get("policy", {}).get("effective"),
        "seed": summary.get("seed"),
        "reads": a.get("count"),
        "read_mean_ns": mean,
        "read_p50_ns": p50,
        "read_p95_ns": p95,
        "read_p99_ns": p99,
        "local_hit_ratio": a.get("local_hit_ratio"),
        "remote_hit_ratio": a.get("remote_hit_ratio"),
        "miss_ratio": a.get("miss_ratio"),
        "stall_ns": a.get("stall_ns"),
        "remote_read_bytes": t.get("remote_read_bytes"),
        "remote_write_bytes": t.get("remote_write_bytes"),
        "migration_bytes": t.get("migration_bytes"),
        "evict_bytes": t.get("evict_bytes"),
        "install_bytes": t.get("install_bytes"),
        "prefetch_issued": t.get("prefetch_issued"),
        "prefetch_useful": t.get("prefetch_useful"),
        "prefetch_accuracy": t.get("prefetch_accuracy"),
        "wasted_prefetch_bytes": t.get("wasted_prefetch_bytes"),
        "throughput_per_s": req.get("throughput_per_s"),
        "completed": req.get("completed"),
        "rejected": req.get("rejected"),
    }


#: Columns for CSV export, in order.
COLUMNS = ["combo", "bundle", "policy", "seed", "reads",
           "read_mean_ns", "read_p50_ns", "read_p95_ns", "read_p99_ns",
           "local_hit_ratio", "remote_hit_ratio", "miss_ratio", "stall_ns",
           "remote_read_bytes", "remote_write_bytes", "migration_bytes",
           "evict_bytes", "install_bytes", "prefetch_issued", "prefetch_useful",
           "prefetch_accuracy", "wasted_prefetch_bytes",
           "throughput_per_s", "completed", "rejected"]
