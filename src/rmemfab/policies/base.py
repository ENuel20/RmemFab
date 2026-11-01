"""Policy interface: deterministic decisions over observed access history.

Policies observe touch batches and return decisions; the memory model applies
them. A policy may keep per-run state, but that state must derive only from
observed contexts in execution order, making every policy a deterministic
function of the op stream. `reset()` clears state between runs.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PressureContext:
    now_ns: int
    node: str
    needed_pages: int       # local frames that must be freed
    local_free_pages: int
    remote_free_pages: int  # free frames in the pool (0 when there is no pool)


@dataclass(frozen=True)
class AccessContext:
    now_ns: int
    node: str
    request_id: str
    remote_pages: int       # pages of this request currently resident remotely


@dataclass(frozen=True)
class Reject:
    reason: str = "capacity"


@dataclass(frozen=True)
class EvictToRemote:
    writeback: bool = True


@dataclass(frozen=True)
class FetchInstall:
    """Bring remote pages into local memory (evicting LRU pages if needed)."""


@dataclass(frozen=True)
class ServeRemote:
    """Read remote pages in place without installing them locally."""


class MemoryPolicy:
    name = "base"
    version = "1"
    KNOWN_PARAMS: dict = {}

    def __init__(self, params=None):
        self.params = dict(params or {})

    def reset(self):
        """Clear per-run observation state. Called once before each run."""

    def observe_batch(self, counts: dict, now_ns: int):
        """Record one timestamp's touches: {page_key: touch_count}."""

    def victim_key(self, key, last_touch, now_ns):
        """Sort key for eviction candidates (lowest evicted first)."""
        return (last_touch, key)

    def on_pressure(self, ctx: PressureContext):
        raise NotImplementedError

    def on_remote_access(self, ctx: AccessContext):
        raise NotImplementedError

    # Prefetch capability. degree 0 disables prefetching entirely.
    @property
    def prefetch_degree(self):
        return 0

    def install_page(self, key) -> bool:
        """Whether a remotely-read page should install locally (hot/cold
        overrides this for selective install; default installs everything)."""
        return True

    def choose_tier(self, candidates: list) -> str:
        """Pick a destination tier for spill/evict migration. Each candidate
        is (tier_id, kind, free_pages, hops, path_latency_ns) with kind in
        {"pool", "peer"}. Default: nearest by (hops, latency, id) — the
        cheapest reachable home. Override to optimize destination choice."""
        return min(candidates, key=lambda c: (c[3], c[4], c[0]))[0]


_REGISTRY: dict = {}


def register(cls):
    _REGISTRY[cls.name] = cls
    return cls


def known_params(name: str) -> dict:
    return dict(_REGISTRY[name].KNOWN_PARAMS)


def create_policy(name: str, params=None) -> MemoryPolicy:
    try:
        return _REGISTRY[name](params)
    except KeyError:
        raise KeyError(f"policy '{name}' is not registered "
                       f"(registered: {sorted(_REGISTRY)})") from None


def registered_policies():
    return sorted(_REGISTRY)
