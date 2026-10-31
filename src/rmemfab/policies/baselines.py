"""Phase 1 baseline policies: local-only and swap-to-remote."""
from __future__ import annotations

from .base import (AccessContext, EvictToRemote, FetchInstall, MemoryPolicy, PressureContext,
                   Reject, ServeRemote, register)


@register
class LocalOnly(MemoryPolicy):
    """All pages must fit in local memory; there is no remote capacity.

    Under pressure the allocation is rejected explicitly (the request fails
    with an out-of-memory status). Never silently overcommits.
    """

    name = "local_only"
    version = "1"

    def on_pressure(self, ctx: PressureContext):
        return Reject("local capacity exhausted (local_only)")

    def on_remote_access(self, ctx: AccessContext):  # unreachable: nothing is ever remote
        return ServeRemote()


@register
class SwapRemote(MemoryPolicy):
    """Remote memory as a slower backing store: evict LRU to remote, fetch back on access."""

    name = "swap_remote"
    version = "1"

    def on_pressure(self, ctx: PressureContext):
        if ctx.remote_free_pages < ctx.needed_pages:
            return Reject("remote pool exhausted (swap_remote)")
        return EvictToRemote(writeback=True)

    def on_remote_access(self, ctx: AccessContext):
        return FetchInstall()
