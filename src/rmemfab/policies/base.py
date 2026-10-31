"""Policy interface (docs/POLICIES.md): pure decision functions.

Policies observe read-only contexts and return decisions. The memory model
applies them; a policy never mutates simulator state.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PressureContext:
    now_ns: int
    node: str
    needed_pages: int          # local frames that must be freed
    local_free_pages: int
    remote_free_pages: int     # free frames in the pool (0 if there is no pool)


@dataclass(frozen=True)
class AccessContext:
    now_ns: int
    node: str
    request_id: str
    remote_pages: int          # pages of this request currently resident remotely


# Decisions ----------------------------------------------------------------
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

    def on_pressure(self, ctx: PressureContext):
        raise NotImplementedError

    def on_remote_access(self, ctx: AccessContext):
        raise NotImplementedError


_REGISTRY: dict = {}


def register(cls):
    _REGISTRY[cls.name] = cls
    return cls


def create_policy(name: str) -> MemoryPolicy:
    try:
        return _REGISTRY[name]()
    except KeyError:
        raise KeyError(f"policy '{name}' is not registered (registered: {sorted(_REGISTRY)})") from None
