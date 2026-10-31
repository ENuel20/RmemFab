"""Fluid FIFO byte servers: local tiers, fabric links, and the shared pool.

Queueing rule (resolves ACCEPTANCE.md A1.3): `free_at` is the single
authoritative queue state. A transfer starts at max(now, free_at of every
server it occupies). There is no separate backlog/B term, so queue delay is
never counted twice. Backlog in bytes is *derived* as (free_at - now) * B for
telemetry only.
"""
from __future__ import annotations

import math

import numpy as np


class Server:
    """Single FIFO byte server (fluid approximation, no packetization)."""

    __slots__ = ("bw", "free_at", "busy_ns", "busy_in", "horizon", "bytes", "_t", "_backlog", "q_area",
                 "q_max", "in_flight", "queue_depth", "congested", "overflow", "stall_ns")

    def __init__(self, bandwidth: float, in_flight=None, queue_depth=None):
        self.bw = float(bandwidth)
        self.free_at = 0.0
        self.busy_ns = 0.0   # all service ever admitted, including work queued past the horizon
        self.busy_in = 0.0   # service that actually ran inside [0, horizon): the utilization numerator
        self.horizon = math.inf
        self.stall_ns = 0.0  # time requesters spent blocked by the queue-depth limit (backpressure)
        self.bytes = 0
        self._t = 0.0
        self._backlog = 0.0
        self.q_area = 0.0   # integral of backlog bytes over time (byte*ns)
        self.q_max = 0.0
        self.in_flight = in_flight
        self.queue_depth = queue_depth
        self.congested = 0
        self.overflow = 0

    def backlog_bytes(self, now: float) -> float:
        return max(0.0, self.free_at - now) * self.bw

    def _advance(self, now: float) -> None:
        """Integrate the exactly-draining fluid backlog up to `now`."""
        dt = now - self._t
        if dt > 0:
            drain = self.bw * dt
            if self._backlog >= drain:
                self.q_area += dt * (self._backlog - drain / 2.0)
                self._backlog -= drain
            else:
                self.q_area += self._backlog * self._backlog / (2.0 * self.bw)
                self._backlog = 0.0
            self._t = now

    def finish(self, now: float) -> None:
        self._advance(now)

    def occupy(self, start: float, service: float) -> None:
        """Record the busy interval [start, start+service).

        Intervals are disjoint and ordered because start >= free_at, so the part
        inside the horizon is exact even when the server idles while a transfer
        waits for another server (the shared pool). The old `busy_ns - (free_at - end)`
        correction assumed no such gaps and read 0 for a saturated link.
        """
        self.busy_ns += service
        h = self.horizon
        if start < h:
            self.busy_in += min(start + service, h) - start

    def backpressure_ns(self, now: float, nbytes: float) -> float:
        """How long a requester must wait before nbytes fit under queue_depth (0 if unlimited/fits)."""
        if self.queue_depth is None:
            return 0.0
        # a single transfer larger than the whole queue only has to wait for an empty queue
        excess = self.backlog_bytes(now) + nbytes - max(self.queue_depth, nbytes)
        return excess / self.bw if excess > 0 else 0.0

    def admit(self, now: float, start: float, k: int, n: int):
        """Occupy the server for k*n bytes beginning at `start` (>= now)."""
        self._advance(now)
        nbytes = k * n
        pre = self._backlog
        flags = (False, False)
        if self.in_flight is not None and pre + nbytes > self.in_flight:
            self.congested += 1
            flags = (True, False)
        if self.queue_depth is not None and pre + nbytes > self.queue_depth:
            self.overflow += 1
            self.stall_ns += max(0.0, pre + nbytes - max(self.queue_depth, nbytes)) / self.bw
            flags = (flags[0], True)
        self._backlog = pre + nbytes
        self.q_max = max(self.q_max, self._backlog)
        service = nbytes / self.bw
        self.free_at = start + service
        self.occupy(start, service)
        self.bytes += nbytes
        return flags


class LocalTier:
    """Per-node local DRAM modeled as a byte server (shared by that node's requests)."""

    def __init__(self, spec):
        self.spec = spec
        self.server = Server(spec.bandwidth_bytes_per_ns)

    def access(self, now: float, k: int, n: int, write: bool):
        """k dependent accesses of n bytes (each issued when the previous completes).

        Every access costs L + n/B once the tier is free, so one access on an idle
        tier is exactly L + n/B (SIMULATION-MODEL.md). The first access also waits
        for any backlog from other requests. The server is occupied for k*n/B
        only (latency L overlaps with other requests' service), so bandwidth is
        conserved. Returns (latencies[k], finish_time).
        """
        sp = self.spec
        lat = sp.latency_ns * (sp.write_latency_factor if write else sp.read_latency_factor)
        s = self.server
        start = max(now, s.free_at)
        one = lat + n / s.bw
        lats = np.full(k, one, dtype=np.float64)
        lats[0] += start - now
        s.admit(now, start, k, n)
        return lats, float(start + k * one)


    def background(self, now: float, nbytes: int) -> None:
        """Bandwidth-only cost of fabric-driven traffic (install writes / write-back reads).

        Nobody waits on it, but it occupies the DRAM server, so it delays later local
        accesses and shows up in bandwidth utilization.
        """
        if nbytes <= 0:
            return
        s = self.server
        s.admit(now, max(now, s.free_at), 1, int(nbytes))


class Fabric:
    """Per-node link servers plus one shared pool server.

    The pool is a shared byte server (ACCEPTANCE.md A1.4, option 1): every
    transfer occupies both its link and the pool, so aggregate service never
    exceeds the pool bandwidth.
    """

    def __init__(self, links: dict, pool):
        self.pool_spec = pool.tier
        self.pool = Server(pool.tier.bandwidth_bytes_per_ns)
        self.links = {}
        self.link_ids = {}
        for node_id, l in links.items():
            if l.bidirectional:
                self.links[node_id] = {"in": Server(l.bandwidth_bytes_per_ns, l.in_flight_bytes, l.queue_depth_bytes),
                                       "out": Server(l.bandwidth_bytes_per_ns, l.in_flight_bytes, l.queue_depth_bytes)}
            else:
                s = Server(l.bandwidth_bytes_per_ns, l.in_flight_bytes, l.queue_depth_bytes)
                self.links[node_id] = {"in": s, "out": s}
            self.link_ids[node_id] = l
        self.pool_bytes = {"read": 0, "write": 0}

    def transfer(self, node_id: str, direction: str, now: float, k: int, n: int, pipelined: bool = False):
        """Move k pages of n bytes. direction 'in' = pool->node (fetch), 'out' = node->pool (write-back).

        start = max(now, link.free_at, pool.free_at)

        pipelined=True  (bulk / back-to-back; ACCEPTANCE A1.2):
            complete_i = start + L_link + L_pool + i * max(n/B_link, n/B_pool)
        pipelined=False (dependent demand faults, one outstanding page):
            complete_i = start + i * (L_link + L_pool + max(n/B_link, n/B_pool))

        Either way the link and pool servers are occupied for k*n/B (bandwidth is conserved).
        Returns (latencies[k] measured from issue, finish_time, queue_delay_ns, (congested, overflow)).
        """
        ls = self.links[node_id][direction]
        spec = self.link_ids[node_id]
        pool = self.pool
        write = direction == "out"
        pool_lat = self.pool_spec.latency_ns * (
            self.pool_spec.write_latency_factor if write else self.pool_spec.read_latency_factor)
        start = max(now, ls.free_at, pool.free_at)
        per = max(n / ls.bw, n / pool.bw)
        fixed = spec.latency_ns + pool_lat
        idx = np.arange(1, k + 1, dtype=np.float64)
        if pipelined:
            comp = start + fixed + per * idx
            lats = comp - now
        else:
            lats = np.full(k, fixed + per, dtype=np.float64)
            lats[0] += start - now
            comp = start + (fixed + per) * idx
        flags = ls.admit(now, start, k, n)
        pool._advance(now)
        pool._backlog += k * n
        pool.q_max = max(pool.q_max, pool._backlog)
        pool.free_at = start + k * n / pool.bw
        pool.occupy(start, k * n / pool.bw)
        pool.bytes += k * n
        self.pool_bytes["write" if write else "read"] += k * n
        return lats, float(comp[-1]), start - now, flags

    def servers(self):
        seen = {}
        for d in self.links.values():
            for s in d.values():
                seen[id(s)] = s
        return [self.pool] + list(seen.values())

    def set_horizon(self, horizon_ns: float) -> None:
        for s in self.servers():
            s.horizon = float(horizon_ns)

    def finish(self, now: float) -> None:
        self.pool._advance(now)
        seen = set()
        for d in self.links.values():
            for s in d.values():
                if id(s) not in seen:
                    seen.add(id(s))
                    s.finish(now)
