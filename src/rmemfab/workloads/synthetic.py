"""Synthetic KV-cache decode workload (docs/WORKLOADS.md)."""
from __future__ import annotations

import math


def kv_bytes_per_token(model: dict) -> int:
    """2 * layers * kv_heads * head_dim * dtype_bytes (SIMULATION-MODEL.md)."""
    return int(2 * model["layers"] * model["kv_heads"] * model["head_dim"] * model["dtype_bytes"])


def pages_for(tokens: int, kv_per_token: int, page_size: int) -> int:
    return max(0, -(-(tokens * kv_per_token) // page_size))


class ArrivalProcess:
    """Open-loop Poisson arrivals drawn from the dedicated `workload` stream."""

    def __init__(self, rng, rate_per_second: float):
        self.rng = rng
        self.mean_gap_ns = 1e9 / rate_per_second

    def next_gap_ns(self) -> int:
        return max(0, int(math.ceil(self.rng.exponential(self.mean_gap_ns))))
