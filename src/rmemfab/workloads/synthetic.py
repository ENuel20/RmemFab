"""Synthetic serving processes (open-loop arrivals)."""
from __future__ import annotations

import math


class ArrivalProcess:
    """Open-loop Poisson arrivals drawn from the dedicated `workload` stream."""

    def __init__(self, rng, rate_per_second: float):
        self.rng = rng
        self.mean_gap_ns = 1e9 / float(rate_per_second)

    def next_gap_ns(self) -> int:
        return max(0, int(math.ceil(self.rng.exponential(self.mean_gap_ns))))
