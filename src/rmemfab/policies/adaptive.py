"""Phase 3 adaptive policies: hot/cold, frequency-aware (LRU-K), prefetch.

All three keep swap-to-remote as their placement substrate and differ in
*which* pages move: hot/cold bands by lifetime frequency, frequency_aware
orders victims by K-th-last-touch, and predictive_prefetch adds stride
prefetching on top of swap semantics.
"""
from __future__ import annotations

from .base import (AccessContext, EvictToRemote, FetchInstall, MemoryPolicy, PressureContext,
                   Reject, ServeRemote, register)
from .recency import RecencyTracker


class _SwapBase(MemoryPolicy):
    version = "1"

    def on_pressure(self, ctx: PressureContext):
        if ctx.remote_free_pages < ctx.needed_pages:
            return Reject(f"remote pool exhausted ({self.name})")
        return EvictToRemote(writeback=True)

    def on_remote_access(self, ctx: AccessContext):
        return FetchInstall()


@register
class FrequencyAware(_SwapBase):
    """LRU-K eviction: victims ordered by K-th-last-touch (default K=2),
    so once-touched streaming pages yield to genuinely reused ones.
    K=1 degenerates to plain LRU."""

    name = "frequency_aware"
    KNOWN_PARAMS = {"k": 2}

    def __init__(self, params=None):
        super().__init__(params)
        self.k = int(self.params.get("k", 2))
        if self.k < 1:
            raise ValueError("frequency_aware.k must be >= 1")
        self.tracker = RecencyTracker(self.k)

    def reset(self):
        self.tracker.reset()

    def observe_batch(self, counts, now_ns):
        self.tracker.touch_batch(counts, now_ns)

    def victim_key(self, key, last_touch, now_ns):
        return (self.tracker.kth_touch(key), last_touch, key)


@register
class HotCold(_SwapBase):
    """Frequency bands: pages with >= hot_threshold lifetime touches are hot,
    <= cold_threshold are cold, the rest neutral. Eviction takes cold first,
    then neutral, then hot (LRU-K order within a band); remote reads install
    unless cold. LRU-K recency (k) breaks ties inside bands."""

    name = "hot_cold"
    KNOWN_PARAMS = {"k": 2, "hot_threshold": 3, "cold_threshold": 1}

    def __init__(self, params=None):
        super().__init__(params)
        self.k = int(self.params.get("k", 2))
        self.hot = int(self.params.get("hot_threshold", 3))
        self.cold = int(self.params.get("cold_threshold", 1))
        if self.k < 1 or self.hot <= self.cold or self.cold < 0:
            raise ValueError("hot_cold needs k >= 1 and 0 <= cold_threshold < hot_threshold")
        self.tracker = RecencyTracker(self.k)

    def reset(self):
        self.tracker.reset()

    def observe_batch(self, counts, now_ns):
        self.tracker.touch_batch(counts, now_ns)

    def band(self, key):
        n = self.tracker.touches(key)
        if n >= self.hot:
            return 2
        if n <= self.cold:
            return 0
        return 1

    def victim_key(self, key, last_touch, now_ns):
        return (self.band(key), self.tracker.kth_touch(key), last_touch, key)

    def on_remote_access(self, ctx: AccessContext):
        # Selective install happens per page in the engine (install_page);
        # the batch-level answer stays FetchInstall for shape compatibility.
        return FetchInstall()

    def install_page(self, key) -> bool:
        """Install a remotely-read page unless it is cold."""
        return self.band(key) != 0


@register
class PredictivePrefetch(_SwapBase):
    """Stride prefetcher over swap semantics: on a touch of page i, fetch
    i+stride .. i+degree*stride when allocated but not local. Prefetches share
    the demand fabric (no priority lane), so aggressive settings visibly
    congest — the failure mode the prefetch-failure fixture demonstrates.
    Accuracy = touched-after-prefetch / issued; never-touched prefetches are
    reported as wasted bytes, never hidden."""

    name = "predictive_prefetch"
    KNOWN_PARAMS = {"degree": 1, "stride": 1, "max_in_flight": 64, "on_hit": True}

    def __init__(self, params=None):
        super().__init__(params)
        p = self.params
        self.degree = int(p.get("degree", 1))
        self.stride = int(p.get("stride", 1))
        self.max_in_flight = int(p.get("max_in_flight", 64))
        self.on_hit = bool(p.get("on_hit", True))
        if self.degree < 1 or self.stride == 0 or self.max_in_flight < 1:
            raise ValueError("predictive_prefetch needs degree >= 1, stride != 0, max_in_flight >= 1")

    @property
    def prefetch_degree(self):
        return self.degree
