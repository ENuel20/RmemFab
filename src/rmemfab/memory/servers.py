"""Fluid FIFO byte servers: local tiers, fabric links, and the shared pool.

Queueing rule: `free_at` is the single authoritative queue state. A transfer
starts at max(now, free_at of every server it occupies). There is no separate
backlog term, so queue delay is never counted twice. Backlog in bytes is
*derived* as (free_at - now) * B for telemetry only.
"""
from __future__ import annotations

import numpy as np


class Server:
    """Single FIFO byte server (fluid approximation, no packetization)."""

    __slots__ = ("bw", "free_at", "busy_ns", "bytes", "_t", "_backlog", "q_area", "q_max",
                 "in_flight", "queue_depth", "congested", "overflow")

    def __init__(self, bandwidth: float, in_flight=None, queue_depth=None):
        self.bw = float(bandwidth)
        self.free_at = 0.0
        self.busy_ns = 0.0
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

    def admit(self, now: float, start: float, nbytes: int):
        """Occupy the server for nbytes beginning at `start` (>= now)."""
        self._advance(now)
        pre = self._backlog
        flags = (False, False)
        if self.in_flight is not None and pre + nbytes > self.in_flight:
            self.congested += 1
            flags = (True, False)
        if self.queue_depth is not None and pre + nbytes > self.queue_depth:
            self.overflow += 1
            flags = (flags[0], True)
        self._backlog = pre + nbytes
        self.q_max = max(self.q_max, self._backlog)
        service = nbytes / self.bw
        self.free_at = start + service
        self.busy_ns += service
        self.bytes += nbytes
        return flags


class LocalTier:
    """Per-node local memory modeled as a byte server shared by that node's requests."""

    def __init__(self, spec):
        self.spec = spec
        self.server = Server(spec.bandwidth_bytes_per_ns)

    def access(self, now: float, k: int, n: int, write: bool):
        """k dependent accesses of n bytes (each issued when the previous completes).

        Every access costs L + n/B once the tier is free, so one access on an
        idle tier is exactly L + n/B. The first access also waits for any
        backlog from other requests. The server is occupied for k*n/B only
        (latency L overlaps), so bandwidth is conserved.
        Returns (latencies[k], finish_time).
        """
        sp = self.spec
        lat = sp.latency_ns * (sp.write_latency_factor if write else sp.read_latency_factor)
        s = self.server
        start = max(now, s.free_at)
        one = lat + n / s.bw
        lats = np.full(k, one, dtype=np.float64)
        lats[0] += start - now
        s.admit(now, start, k * n)
        return lats, float(start + k * one)


class Fabric:
    """Byte servers over a static routed link graph: per-link servers, one
    server per pool, one per named switch, plus an optional legacy switch
    that occupies every transfer (star semantic).

    transfer() routes src_node -> dst_tier over the scenario's static
    shortest path and occupies every hop link server, every intermediate
    switch server, and the destination tier server. Direction byte counts
    are requester-relative: "in" flows toward the requesting compute node
    (fetches), "out" flows away from it (spills, writebacks).
    """

    def __init__(self, links: dict, tier_specs: dict, tier_servers: dict,
                 switches: dict, routes: dict, legacy_switch=None):
        self.specs = links  # link_id -> LinkSpec
        self.tier_specs = tier_specs  # tier_id -> TierSpec
        self.tier_servers = tier_servers  # tier_id -> Server (pools owned here, locals shared)
        self.routes = routes
        self.switches = {sid: Server(sw.bandwidth_bytes_per_ns) for sid, sw in switches.items()}
        self.switch_specs = switches
        self.legacy = Server(legacy_switch.bandwidth_bytes_per_ns) if legacy_switch else None
        self.legacy_lat = float(legacy_switch.latency_ns) if legacy_switch else 0.0
        self.links = {}
        self.dir_bytes: dict = {}
        for lid, l in links.items():
            if l.bidirectional:
                self.links[lid] = {
                    "fwd": Server(l.bandwidth_bytes_per_ns, l.in_flight_bytes, l.queue_depth_bytes),
                    "rev": Server(l.bandwidth_bytes_per_ns, l.in_flight_bytes, l.queue_depth_bytes),
                }
            else:
                s = Server(l.bandwidth_bytes_per_ns, l.in_flight_bytes, l.queue_depth_bytes)
                self.links[lid] = {"fwd": s, "rev": s}
            self.dir_bytes[lid] = {"in": 0, "out": 0}
        self.endpoint_bytes = {"in": 0, "out": 0}

    def transfer(self, src_node: str, dst_tier: str, now: float, k: int, n: int,
               tier_write: bool, pipelined: bool = False):
        """Move k units of n bytes between src_node and dst_tier over the
        static route. tier_write=True means the tier endpoint is written
        (spill/evict); False means it is read (fetch). Data direction is
        requester-relative: fetches flow "in" (toward src), spills "out".

        start = max(now, every occupied server's free_at); per-byte service
        is the max over the same set; fixed latency sums link + switch +
        tier latencies. Every occupied server holds k*n/B (bandwidth is
        conserved). Returns (latencies[k] from issue, finish, queue_delay,
        flags) where flags OR the per-hop link admits.
        """
        route = self.routes[(src_node, dst_tier)]
        data_in = not tier_write  # fetches flow toward the requester
        servers = []
        fixed = 0.0
        for lid, hop_dir in route.links:
            spec = self.specs[lid]
            # Data "out" follows path order; data "in" flows against it.
            srv_dir = hop_dir if not data_in else ("rev" if hop_dir == "fwd" else "fwd")
            servers.append(self.links[lid][srv_dir])
            fixed += spec.latency_ns
        for sid in route.switches:
            servers.append(self.switches[sid])
            fixed += self.switch_specs[sid].latency_ns
        tspec = self.tier_specs[dst_tier]
        tier_lat = tspec.latency_ns * (
            tspec.write_latency_factor if tier_write else tspec.read_latency_factor)
        fixed += tier_lat
        tserver = self.tier_servers[dst_tier]
        start = max(now, tserver.free_at, *(s.free_at for s in servers))
        per = n / tserver.bw
        for s in servers:
            per = max(per, n / s.bw)
        if self.legacy is not None:
            start = max(start, self.legacy.free_at)
            per = max(per, n / self.legacy.bw)
            fixed += self.legacy_lat
        idx = np.arange(1, k + 1, dtype=np.float64)
        if pipelined:
            comp = start + fixed + per * idx
            lats = comp - now
        else:
            lats = np.full(k, fixed + per, dtype=np.float64)
            lats[0] += start - now
            comp = start + (fixed + per) * idx
        nbytes = k * n
        flags = (False, False)
        for lid, hop_dir in route.links:
            srv_dir = hop_dir if not data_in else ("rev" if hop_dir == "fwd" else "fwd")
            f = self.links[lid][srv_dir].admit(now, start, nbytes)
            flags = (flags[0] or f[0], flags[1] or f[1])
            self.dir_bytes[lid]["in" if data_in else "out"] += nbytes
        self.endpoint_bytes["in" if data_in else "out"] += nbytes
        occupants = [tserver] + [self.switches[s] for s in route.switches]
        if self.legacy is not None:
            occupants.append(self.legacy)
        for srv in occupants:
            srv._advance(now)
            srv._backlog += nbytes
            srv.q_max = max(srv.q_max, srv._backlog)
            srv.free_at = start + nbytes / srv.bw
            srv.busy_ns += nbytes / srv.bw
            srv.bytes += nbytes
        return lats, float(comp[-1]), start - now, flags

    def finish(self, now: float) -> None:
        seen = set()
        for s in list(self.tier_servers.values()) + list(self.switches.values()):
            if id(s) not in seen:
                seen.add(id(s))
                s._advance(now)
        if self.legacy is not None:
            self.legacy._advance(now)
        for d in self.links.values():
            for s in d.values():
                if id(s) not in seen:
                    seen.add(id(s))
                    s.finish(now)
