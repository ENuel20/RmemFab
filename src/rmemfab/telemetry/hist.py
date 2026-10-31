"""Streaming log-bucket histogram: bounded memory, ~1% relative percentile error."""
from __future__ import annotations

import math

import numpy as np

GROWTH = 1.01
_INV_LOG = 1.0 / math.log(GROWTH)
NBUCKETS = int(math.ceil(math.log(1e13) * _INV_LOG)) + 1  # 1 ns .. ~10^13 ns


class Histogram:
    __slots__ = ("counts", "n", "total", "lo", "hi")

    def __init__(self) -> None:
        self.counts = np.zeros(NBUCKETS, dtype=np.int64)
        self.n = 0
        self.total = 0.0
        self.lo = math.inf
        self.hi = 0.0

    def add(self, values: np.ndarray) -> None:
        if values.size == 0:
            return
        idx = np.minimum((np.log(np.maximum(values, 1.0)) * _INV_LOG).astype(np.int64), NBUCKETS - 1)
        self.counts += np.bincount(idx, minlength=NBUCKETS)
        self.n += int(values.size)
        self.total += float(values.sum())
        self.lo = min(self.lo, float(values.min()))
        self.hi = max(self.hi, float(values.max()))

    def add_one(self, value: float) -> None:
        self.add(np.asarray([value], dtype=np.float64))

    def mean(self) -> float:
        return self.total / self.n if self.n else 0.0

    def percentile(self, p: float) -> float:
        """Upper edge of the bucket holding the p-th percentile (never under-reports)."""
        if self.n == 0:
            return 0.0
        target = max(1, int(math.ceil(p / 100.0 * self.n)))
        cum = np.cumsum(self.counts)
        i = int(np.searchsorted(cum, target, side="left"))
        edge = GROWTH ** (i + 1)
        return float(min(max(edge, self.lo), self.hi))

    def stats(self, percentiles) -> dict:
        out = {"count": self.n, "mean": self.mean(), "min": 0.0 if self.n == 0 else self.lo, "max": self.hi}
        for p in percentiles:
            out[f"p{p:g}"] = self.percentile(p)
        return out
