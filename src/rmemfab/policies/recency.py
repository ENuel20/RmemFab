"""Shared observation state: lifetime counts plus last-K touch times.

One tracker powers LRU-K eviction order, hot/cold banding, and any future
frequency-aware policy. Touches arrive in execution order with one sequence
number per batch (documented granularity: same-timestamp touches tie).
"""
from __future__ import annotations

from collections import deque


class RecencyTracker:
    def __init__(self, k: int = 2):
        self.k = max(1, int(k))
        self.counts: dict = {}
        self.recent: dict = {}
        self._seq = 0

    def reset(self):
        self.counts.clear()
        self.recent.clear()
        self._seq = 0

    def touch_batch(self, counts: dict, now_ns: int):
        self._seq += 1
        for key, n in counts.items():
            self.counts[key] = self.counts.get(key, 0) + n
            dq = self.recent.get(key)
            if dq is None:
                dq = self.recent[key] = deque(maxlen=self.k)
            dq.append((self._seq, int(now_ns)))

    def touches(self, key) -> int:
        return self.counts.get(key, 0)

    def kth_touch(self, key):
        """Sequence of the K-th most recent touch batch (-1 if fewer than K)."""
        dq = self.recent.get(key)
        if not dq or len(dq) < self.k:
            return -1
        return dq[0][0]
