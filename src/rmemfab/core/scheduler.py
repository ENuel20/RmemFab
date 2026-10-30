"""Priority-queue scheduler ordered by (time_ns, sequence_id)."""
from __future__ import annotations

import heapq
from typing import Any, Callable


class Scheduler:
    """Deterministic event queue. No wall-clock, no threads.

    Events at the same virtual time run in increasing sequence_id, and the
    sequence_id is assigned at scheduling time (SIMULATION-MODEL.md, rules 1-2).
    """

    def __init__(self) -> None:
        self._heap: list = []
        self._seq = 0
        self.now = 0
        self.processed = 0

    def schedule(self, time_ns: int, kind: str, data: Any = None) -> int:
        time_ns = int(time_ns)
        if time_ns < self.now:
            raise ValueError(f"cannot schedule {kind} in the past: {time_ns} < {self.now}")
        self._seq += 1
        heapq.heappush(self._heap, (time_ns, self._seq, kind, data))
        return self._seq

    def pending(self) -> int:
        return len(self._heap)

    def run(self, handler: Callable[[str, Any, int, int], None], end_time_ns: int) -> None:
        heap = self._heap
        while heap and heap[0][0] <= end_time_ns:
            time_ns, seq, kind, data = heapq.heappop(heap)
            self.now = time_ns
            self.processed += 1
            handler(kind, data, time_ns, seq)
