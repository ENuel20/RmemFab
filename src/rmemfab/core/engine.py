"""Run lifecycle: workload geometry -> scheduler -> memory/fabric -> policy -> telemetry.

The core is model-agnostic: it moves pages between tiers and charges time for
it. All model shape lives in `workloads.geometry`, which the engine calls as
pure functions (page counts per layer class). Hardware is likewise data: tiers
and links are parameterized byte servers with no media-specific branches.

Metric contract (normative): hit ratios are fractions of page READ accesses.
Writes, allocations, frees, evictions, and migrations are reported separately
and never enter the hit denominator. `misses` counts reads for pages resident
nowhere; in the closed two-tier Phase 1 model every read resolves to a tier,
so it is 0 by construction (documented, not measured).
"""
from __future__ import annotations

import json
import math
import platform
from pathlib import Path

import numpy as np

from .. import SCHEMA_VERSION, __version__
from ..config.scenario import Scenario, canonical_json
from ..memory.servers import Fabric, LocalTier, Server
from ..policies import create_policy
from ..policies.base import (AccessContext, EvictToRemote, FetchInstall, PressureContext, Reject)
from ..telemetry.hist import PERCENTILE_METHOD, Histogram
from ..telemetry.summary import canonical, roundf
from ..telemetry.writers import JsonlWriter, NullWriter
from ..workloads.geometry import pages_for, read_span
from ..workloads.synthetic import ArrivalProcess
from .faults import FaultModel
from .rng import make_rng, stream_seeds
from .scheduler import Scheduler

LOCAL, REMOTE = 0, 1
GIB = float(2 ** 30)


class ClassPages:
    """Per-request, per-layer-class residency bitmaps."""
    __slots__ = ("n_alloc", "where", "last", "dirty", "home")

    def __init__(self, max_pages: int):
        self.n_alloc = 0
        self.where = np.zeros(max_pages, dtype=np.int8)
        self.last = np.zeros(max_pages, dtype=np.int64)
        self.dirty = np.zeros(max_pages, dtype=bool)
        self.home = np.zeros(max_pages, dtype=np.int64)  # tier index into engine.tier_ids


class Request:
    __slots__ = ("id", "idx", "node", "arrival", "tokens_done", "classes", "status")

    def __init__(self, idx, node, arrival, max_pages_per_class):
        self.id = f"req-{idx}"
        self.idx = idx
        self.node = node
        self.arrival = arrival
        self.tokens_done = 0
        self.classes = [ClassPages(m) for m in max_pages_per_class]
        self.status = "active"


class NodeState:
    def __init__(self, spec, page):
        self.spec = spec
        self.id = spec.id
        self.local = LocalTier(spec.local)
        self.cap = spec.local.capacity_bytes // page
        self.used = 0
        self.peak = 0
        self.active: list = []
        self.waiting: list = []
        self.active_count = 0
        # Foreign pages parked on this tier: [(request, class_idx, page_idx)].
        # Lazily valid: an entry counts only while the page is still homed
        # here and live; stale entries are skipped (and compacted on scan).
        self.foreign: list = []
        self.evicted_pages = 0
        self.installed_pages = 0
        self.occ_ns = 0.0  # page*ns integral
        self._occ_t = 0
        self.m_all = None  # Metrics pair, attached by the driver (synthetic/replay)
        self.m_ss = None

    def set_used(self, now, used):
        self.occ_ns += self.used * (now - self._occ_t)
        self._occ_t = now
        self.used = used
        self.peak = max(self.peak, used)


class PoolState:
    def __init__(self, spec, page):
        self.cap = spec.tier.capacity_bytes // page
        self.used = 0
        self.peak = 0
        self.occ_ns = 0.0
        self._occ_t = 0

    def set_used(self, now, used):
        self.occ_ns += self.used * (now - self._occ_t)
        self._occ_t = now
        self.used = used
        self.peak = max(self.peak, used)


class Metrics:
    def __init__(self):
        self.read_hist = Histogram()
        self.write_hist = Histogram()
        self.step_hist = Histogram()
        self.c = dict(reads=0, read_local=0, read_remote=0, read_miss=0, read_bypass=0,
                      writes=0, write_bytes=0, allocs=0, alloc_pages=0,
                      installs=0, evictions=0, stall_ns=0.0)

    def record_reads(self, lats, *, local, remote, missed, bypass, stall):
        if lats.size:
            self.read_hist.add(lats)
        c = self.c
        c["reads"] += int(lats.size)
        c["read_local"] += local
        c["read_remote"] += remote
        c["read_miss"] += missed
        c["read_bypass"] += bypass
        c["stall_ns"] += stall

    def record_writes(self, lats, *, pages, nbytes):
        if lats.size:
            self.write_hist.add(lats)
        c = self.c
        c["writes"] += pages
        c["write_bytes"] += nbytes

    def record_step(self, step_ns):
        if step_ns is not None:
            self.step_hist.add_one(step_ns)


class Engine:
    def __init__(self, sc: Scenario, out_dir=None, *, event_log=True):
        self.sc = sc
        self.page = sc.page_size
        self.classes = sc.layer_classes
        self.prompt = int(sc.requests["prompt_tokens"])
        self.gen = int(sc.requests["generated_tokens"])
        # Concurrency is per compute node: each node admits up to this many
        # active requests and queues the rest locally.
        self.concurrency = int(sc.requests.get("concurrency", 1 << 30))
        self.max_pages = [pages_for(self.prompt + self.gen, k.kv_bytes_per_token, self.page)
                          for k in self.classes]
        self.sched = Scheduler()
        # One policy instance per compute node: same name/params, independent
        # observation state (per-node agents, as in real systems).
        self.policies = {}
        self.arrivals = ArrivalProcess(make_rng(sc.seed, "workload"), float(sc.requests["arrival_rate_per_second"]))
        self.access_seq = 0
        self.pref_outstanding: dict = {}
        self.pref_issued = 0
        self.pref_useful = 0
        self.pref_skipped = 0
        self.pref_bytes = 0
        self.pref_wasted = 0
        self.nodes = [NodeState(n, self.page) for n in sc.nodes]
        self.node_by_id = {n.id: n for n in self.nodes}
        for n in self.nodes:
            n.m_all, n.m_ss = Metrics(), Metrics()
            self.policies[n.id] = create_policy(sc.policy_effective, sc.policy_params)
        self.pools = {pid: PoolState(pspec, self.page) for pid, pspec in sc.pools.items()}
        # Tier accounting view: compute locals + pools, all with cap/used/set_used.
        self.tiers = {n.id: n for n in self.nodes}
        self.tiers.update(self.pools)
        self.tier_ids = sorted(self.tiers)
        self.tier_idx = {tid: i for i, tid in enumerate(self.tier_ids)}
        tier_specs = {n.id: n.spec.local for n in self.nodes}
        tier_specs.update({pid: pspec.tier for pid, pspec in sc.pools.items()})
        tier_servers = {n.id: n.local.server for n in self.nodes}
        tier_servers.update({pid: Server(pspec.tier.bandwidth_bytes_per_ns)
                             for pid, pspec in sc.pools.items()})
        fspec = sc.faults or {}
        if (fspec.get("node_failures") or fspec.get("link_degradations")
                or fspec.get("packet_loss_ppm") or fspec.get("link_loss_ppm")):
            self.faults = FaultModel(
                fspec.get("node_failures", []), fspec.get("link_degradations", []),
                fspec.get("packet_loss_ppm", 0), fspec.get("link_loss_ppm", {}),
                sc.seed, sc.duration_ns)
        else:
            self.faults = None
        self.fabric = Fabric(sc.links, tier_specs, tier_servers, sc.switches,
                             sc.routes, sc.switch, self.faults) if sc.links else None
        self.mig_matrix: dict = {}
        self.run_id = f"{sc.hash[:12]}-s{sc.seed}-{sc.policy_effective}"
        self.out_dir = Path(out_dir) if out_dir else None
        want_log = event_log and sc.output.get("include_event_log", True) and self.out_dir is not None
        if self.out_dir:
            self.out_dir.mkdir(parents=True, exist_ok=True)
        self.events = JsonlWriter(self.out_dir / "events.jsonl") if want_log else NullWriter()
        self.log = want_log
        self.series = []
        self._seq = 0
        # run state
        self.m_all, self.m_ss = Metrics(), Metrics()
        self.req_hist = Histogram()
        self.req_hist_all = Histogram()
        self.ttft_hist = Histogram()
        self.ttft_hist_all = Histogram()
        self.compute_ns_prefill = 0.0
        self.compute_ns_decode = 0.0
        # Window-scoped read-latency histogram: same steady-state stream as
        # m_ss, snapshotted into each series row by _sample() and reset.
        self.win_read = Histogram()
        self.arrived = self.completed = self.rejected = 0
        self.stalled_requests = 0
        self.completed_ss = 0
        self.tokens_ss = 0
        self.reject_reasons: dict = {}
        self.migration_bytes = 0
        self.evict_bytes = 0
        self.install_bytes = 0
        self.link_xfers = 0
        self._last_sample = {"accesses": 0, "evictions": 0, "completed": 0}
        self._last_link_bytes = {}

    def _pid_prefix(self, r, ci):
        return f"{r.id}:{self.classes[ci].name}:"

    # ------------------------------------------------------------- emit ---
    def _emit(self, name, now, node=None, request_id=None, **data):
        if not self.log:
            return
        self._seq += 1
        rec = {"event": name, "time_ns": int(now), "seq": self._seq, "run_id": self.run_id}
        if node is not None:
            rec["node"] = node
        if request_id is not None:
            rec["request_id"] = request_id
        rec["data"] = data
        self.events.write(rec)

    def _pol(self, node):
        return self.policies[node.id]

    def _route_lat(self, src, dst, write):
        """Uncontended fixed latency over the static route (links + switches
        + tier endpoint with read/write factor)."""
        route = self.sc.routes[(src, dst)]
        lat = sum(self.sc.links[lid].latency_ns for lid, _ in route.links)
        lat += sum(self.sc.switches[sid].latency_ns for sid in route.switches)
        if self.sc.switch is not None:
            lat += self.sc.switch.latency_ns
        tspec = self.fabric.tier_specs[dst]
        lat += tspec.latency_ns * (
            tspec.write_latency_factor if write else tspec.read_latency_factor)
        return lat

    def _route_service(self, src, dst, nbytes):
        """Uncontended per-transfer service time over the static route: the
        max single-server service across links, switches, and tier."""
        route = self.sc.routes[(src, dst)]
        bw = self.fabric.tier_servers[dst].bw
        per = nbytes / bw
        for lid, _ in route.links:
            per = max(per, nbytes / self.sc.links[lid].bandwidth_bytes_per_ns)
        for sid in route.switches:
            per = max(per, nbytes / self.sc.switches[sid].bandwidth_bytes_per_ns)
        if self.sc.switch is not None:
            per = max(per, nbytes / self.sc.switch.bandwidth_bytes_per_ns)
        return per

    def _candidates(self, node, need, require_space):
        """Reachable remote tiers for `node` as policy candidates:
        (tier_id, kind, free_pages, hops, path_latency_ns)."""
        out = []
        for tid in self.tier_ids:
            if tid == node.id or (node.id, tid) not in self.sc.routes:
                continue
            route = self.sc.routes[(node.id, tid)]
            free = self.tiers[tid].cap - self.tiers[tid].used
            if require_space and free < need:
                continue
            kind = "pool" if tid in self.pools else "peer"
            out.append((tid, kind, free, route.hops,
                        self._route_lat(node.id, tid, True)))
        out.sort(key=lambda c: (c[3], c[4], c[0]))
        return out

    def _choose_dst(self, node, need, require_space):
        """Destination tier for spill/evict: policy choice among reachable
        tiers (nearest-with-space default). None when no candidate qualifies."""
        cands = self._candidates(node, need, require_space)
        if not cands:
            return None
        return self._pol(node).choose_tier(cands)

    def _record_reads(self, now, node, lats, **kw):
        self.m_all.record_reads(lats, **kw)
        node.m_all.record_reads(lats, **kw)
        if now >= self.sc.warmup_ns:
            self.m_ss.record_reads(lats, **kw)
            node.m_ss.record_reads(lats, **kw)
            self.win_read.add(lats)

    def _record_writes(self, now, node, lats, **kw):
        self.m_all.record_writes(lats, **kw)
        node.m_all.record_writes(lats, **kw)
        if now >= self.sc.warmup_ns:
            self.m_ss.record_writes(lats, **kw)
            node.m_ss.record_writes(lats, **kw)

    def _record_step(self, now, step_ns):
        if step_ns is None:
            return
        self.m_all.record_step(step_ns)
        if now >= self.sc.warmup_ns:
            self.m_ss.record_step(step_ns)

    def _bump(self, now, node, key, n):
        self.m_all.c[key] += n
        node.m_all.c[key] += n
        if now >= self.sc.warmup_ns:
            self.m_ss.c[key] += n
            node.m_ss.c[key] += n

    def _observe(self, touched: dict, now, node):
        """Record one timestamp's touches: prefetch-useful accounting first
        (a touch counts only for prefetches issued strictly earlier), then
        the node's policy observation state."""
        if not touched:
            return
        self.access_seq += 1
        for key in touched:
            if key in self.pref_outstanding and self.pref_outstanding[key][0] < self.access_seq:
                self.pref_useful += 1
                del self.pref_outstanding[key]
        self._pol(node).observe_batch(touched, now)

    def _pref_abandon(self, keys):
        """Prefetched pages evicted or freed before use: bytes wasted."""
        for key in keys:
            if key in self.pref_outstanding:
                _, nbytes = self.pref_outstanding.pop(key)
                self.pref_wasted += nbytes

    def _prefetch_issue(self, r, ci, now):
        """Growth-anticipation prefetch: pre-allocate the next `degree` pages
        through the normal alloc path (placement and spill stay honest).
        Never fails the run: rejects and a full in-flight window skip
        (counted, reported)."""
        pol = self._pol(r.node)
        degree = pol.prefetch_degree
        if not degree:
            return
        cap = getattr(pol, "max_in_flight", 0)
        cp = r.classes[ci]
        for _ in range(degree):
            if cp.n_alloc >= len(cp.where):
                return
            if len(self.pref_outstanding) >= cap:
                self.pref_skipped += 1
                continue
            n_old = cp.n_alloc
            ok, _ = self._alloc(r, ci, 1, now)
            if not ok:
                self.pref_skipped += 1
                continue
            key = (r.idx, ci, n_old)
            moved = self.page if cp.where[n_old] == REMOTE else 0
            self.pref_outstanding[key] = [self.access_seq, moved]
            self.pref_issued += 1
            self.pref_bytes += moved

    # --------------------------------------------------------- transfers ---
    def _xfer(self, now, node, dst_tier, tier_write, k, n, kind, request_id,
              from_tier, to_tier, pipelined=False):
        lats, finish, qd, flags, retx = self.fabric.transfer(
            node.id, dst_tier, now, k, n, tier_write, pipelined)
        route = self.sc.routes[(node.id, dst_tier)]
        hops = [lid for lid, _ in route.links]
        nbytes = k * n
        end = int(math.ceil(finish))
        self._emit("transfer_begin", now, node.id, request_id, link=hops[0], path=hops,
                   bytes=nbytes,
                   from_node=(dst_tier if not tier_write else node.id),
                   to_node=(node.id if not tier_write else dst_tier), kind=kind, pages=k,
                   attempts=retx["attempts"], retx_delay_ns=int(retx["delay_ns"]),
                   stall_ns=int(retx["stall_ns"]))
        for l in retx["lost"]:
            self._emit("transfer_lost", now, node.id, request_id, link=l["link"],
                       attempt=l["attempt"], bytes=nbytes, rto_ns=int(l["rto_ns"]))
        self._emit("page_migrate_begin", now, node.id, request_id, pages=k, bytes=nbytes,
                   from_tier=from_tier, to_tier=to_tier, link=hops[0], path=hops, kind=kind)
        if flags[0]:
            qmax = 0
            for lid, hop_dir in route.links:
                for s in self.fabric.links[lid].values():
                    qmax = max(qmax, int(s.backlog_bytes(now)))
            self._emit("link_congested", now, node.id, request_id, link=hops[0], path=hops,
                       queue_bytes=qmax, utilization=1.0)
        self.sched.schedule(end, "xfer_done",
                            (hops[0], hops, node.id, nbytes, end - int(now), qd, request_id,
                             kind, k, from_tier, to_tier))
        self.link_xfers += 1
        return lats, finish

    # ---------------------------------------------------------- eviction ---
    def _victims(self, node, need, protect, now):
        """Eviction candidates: foreign pages parked here yield first (by
        policy key), then domestic pages by the policy's victim key (LRU by
        default; LRU-K / hot-cold bands for adaptive policies). Returns
        [((request, class_idx), page_index_array)]. Pages touched this tick
        by the protected (request, class) are excluded. Foreign entries are
        validated lazily (homed here, live, owned elsewhere)."""
        domestic = []
        for pos, r in enumerate(node.active):
            for ci, cp in enumerate(r.classes):
                n = cp.n_alloc
                if not n:
                    continue
                loc = np.nonzero(cp.where[:n] == LOCAL)[0]
                if loc.size == 0:
                    continue
                for idx in loc:
                    last = int(cp.last[idx])
                    if protect is not None and r is protect[0] and ci == protect[1] and last == now:
                        continue
                    key = (r.idx, ci, int(idx))
                    domestic.append((self._pol(node).victim_key(key, last, now), pos, ci, int(idx)))
        domestic.sort(key=lambda c: (c[0], c[1], c[2], c[3]))
        mine = self.tier_idx[node.id]
        foreign, keep = [], []
        for (r, ci, idx) in node.foreign:
            cp = r.classes[ci]
            if idx >= cp.n_alloc or int(cp.home[idx]) != mine or r.node is node:
                continue  # stale: freed, moved, or domestic now
            keep.append((r, ci, idx))
            key = (r.idx, ci, int(idx))
            foreign.append((self._pol(node).victim_key(key, int(cp.last[idx]), now),
                            r.idx, ci, int(idx), r))
        node.foreign = keep
        foreign.sort(key=lambda c: (c[0], c[1], c[2], c[3]))
        picks = [(r, ci, idx) for _, _, ci, idx, r in foreign[:need]]
        left = need - len(picks)
        for _, pos, ci, idx in domestic[:left]:
            picks.append((node.active[pos], ci, idx))
        out = []
        for r, ci, idx in picks:
            if out and out[-1][0] == (r, ci):
                out[-1][1].append(idx)
            else:
                out.append(((r, ci), [idx]))
        return [((r, ci), np.asarray(ix, dtype=np.int64)) for (r, ci), ix in out]

    @staticmethod
    def _trim(vict, need):
        out, left = [], need
        for key, idx in vict:
            if left <= 0:
                break
            take = idx[:left]
            out.append((key, take))
            left -= int(take.size)
        return out

    def _apply_evict(self, vict, dst):
        """Mark victims with their new home; return (dirty, clean).
        No bytes move here. Invariant: where==LOCAL iff home is the page's
        owner node, so a foreign page evicted back onto its owner's tier
        becomes locally accessible (no self-fetch) instead of stranded."""
        dst_idx = self.tier_idx[dst]
        dirty = clean = 0
        for (r, ci), idx in vict:
            cp = r.classes[ci]
            cp.home[idx] = dst_idx
            cp.where[idx] = LOCAL if dst == r.node.id else REMOTE
            d = int(cp.dirty[idx].sum())
            dirty += d
            clean += int(idx.size) - d
        return dirty, clean

    def _evict_batch(self, node, vict, now, request_id, cause, dst):
        """Evict victim pages to tier `dst`. Only dirty pages transfer
        bytes; clean pages just invalidate (0 bytes moved) but still occupy
        the destination (as before: eviction never refuses for space)."""
        self._pref_abandon((r.idx, ci, int(i)) for (r, ci), ix in vict for i in ix)
        dirty, clean = self._apply_evict(vict, dst)
        total = dirty + clean
        if total == 0:
            return 0
        for (r, ci), idx in vict:
            d = int(r.classes[ci].dirty[idx].sum())
            self._emit("page_evict", now, node.id, r.id, tier=node.id, to_tier=dst,
                       pages=int(idx.size), bytes=d * self.page,
                       dirty_pages=d, clean_pages=int(idx.size) - d,
                       class_name=self.classes[ci].name,
                       page_id_prefix=self._pid_prefix(r, ci),
                       cause=cause)
        if dirty:
            self._xfer(now, node, dst, True, dirty, self.page, "evict_writeback",
                       request_id, node.id, dst, pipelined=True)
            self.evict_bytes += dirty * self.page
            self.migration_bytes += dirty * self.page
        self.mig_matrix[(node.id, dst)] = self.mig_matrix.get((node.id, dst), 0) + total
        if dst in self.node_by_id:
            for (r, ci), ix in vict:
                self.node_by_id[dst].foreign.extend((r, ci, int(i)) for i in ix)
        node.evicted_pages += total
        self._bump(now, node, "evictions", total)
        return total

    # --------------------------------------------------------- allocation ---
    def _alloc(self, r, ci, count, now):
        """Allocate `count` pages of class ci for r.

        Fits locally what fits (evicting under policy when pressured) and
        spills the remainder directly to the pool with a write transfer.
        Returns (ok, reason). Rejection is always explicit with a reason.
        """
        node = r.node
        cp = r.classes[ci]
        klass = self.classes[ci]
        free = node.cap - node.used
        need = count - free
        evicted = 0
        if need > 0:
            remote_free = sum(self.tiers[tid].cap - self.tiers[tid].used
                              for tid in self.tier_ids
                              if tid != node.id and (node.id, tid) in self.sc.routes)
            ctx = PressureContext(int(now), node.id, need, free, remote_free)
            d = self._pol(node).on_pressure(ctx)
            self._emit("policy_pressure", now, node.id, r.id, policy=self._pol(node).name,
                       tier=node.id, occupancy_bytes=node.used * self.page,
                       capacity_bytes=node.cap * self.page)
            if isinstance(d, Reject):
                return False, d.reason
            if isinstance(d, EvictToRemote):
                vict = self._victims(node, need, (r, ci), now)
                avail = sum(int(i.size) for _, i in vict)
                if avail:
                    dst = self._choose_dst(node, avail, require_space=False)
                    if dst is None:
                        return False, "no remote tier reachable for eviction"
                    evicted = self._evict_batch(node, self._trim(vict, need), now, r.id,
                                               "allocation_pressure", dst)
                    self.tiers[dst].set_used(now, self.tiers[dst].used + evicted)
                    node.set_used(now, node.used - evicted)
        local_place = min(count, node.cap - node.used)
        spill = count - local_place
        dst = None
        if spill > 0:
            if self.fabric is None or self._pol(node).name == "local_only":
                return False, "local capacity exhausted (local_only)"
            dst = self._choose_dst(node, spill, require_space=True)
            if dst is None:
                return False, f"no remote tier fits {spill} pages"
        a = cp.n_alloc
        if local_place:
            cp.where[a:a + local_place] = LOCAL
            cp.last[a:a + local_place] = now
            cp.dirty[a:a + local_place] = True
            cp.home[a:a + local_place] = self.tier_idx[node.id]
            node.set_used(now, node.used + local_place)
        if spill:
            b = a + local_place
            cp.where[b:b + spill] = REMOTE
            cp.dirty[b:b + spill] = True
            cp.home[b:b + spill] = self.tier_idx[dst]
            self.tiers[dst].set_used(now, self.tiers[dst].used + spill)
            lats, _ = self._xfer(now, node, dst, True, spill, self.page, "alloc_spill", r.id,
                                 node.id, dst, pipelined=True)
            self.migration_bytes += spill * self.page
            self.mig_matrix[(node.id, dst)] = self.mig_matrix.get((node.id, dst), 0) + spill
            if dst in self.node_by_id:
                self.node_by_id[dst].foreign.extend((r, ci, int(i)) for i in range(b, b + spill))
            self._record_writes(now, node, lats, pages=spill, nbytes=spill * self.page)
        cp.n_alloc = a + count
        self._bump(now, node, "allocs", 1)
        self._bump(now, node, "alloc_pages", count)
        self._emit("page_allocate", now, node.id, r.id, pages=count, bytes=count * self.page,
                   tiers={"local": local_place, "remote": spill}, remote_tier=dst, owner=r.id,
                   class_name=klass.name, page_id_prefix=self._pid_prefix(r, ci), index_start=a)
        return True, None

    def _free(self, r, now):
        total = 0
        for ci, cp in enumerate(r.classes):
            n = cp.n_alloc
            if n == 0:
                continue
            self._pref_abandon((r.idx, ci, i) for i in range(n))
            homes = cp.home[:n]
            for tid in self.tier_ids:
                cnt = int((homes == self.tier_idx[tid]).sum())
                if cnt:
                    self.tiers[tid].set_used(now, self.tiers[tid].used - cnt)
            cp.n_alloc = 0
            total += n
            self._emit("page_free", now, r.node.id, r.id, pages=n, bytes=n * self.page,
                       tiers={tid: int((homes == self.tier_idx[tid]).sum())
                              for tid in self.tier_ids},
                       class_name=self.classes[ci].name, page_id_prefix=self._pid_prefix(r, ci))
        return total

    # ----------------------------------------------------------- lifecycle ---
    def _admit_or_queue(self, r, now):
        if r.node.active_count < self.concurrency:
            self._start(r, now)
        else:
            r.node.waiting.append(r)

    def _start(self, r, now):
        """Admit a request. Returns False when the node is down (the request
        is re-queued with a resume event, or rejected when unrecoverable)."""
        if self.faults is not None:
            rec = self.faults.recovery_of(r.node.id, now)
            if rec is not None:
                if rec <= self.sc.duration_ns:
                    r.node.waiting.append(r)
                    self.stalled_requests += 1
                    self.sched.schedule(int(rec), "admit_retry", r.node.id)
                    self._emit("request_stalled", now, r.node.id, r.id,
                               reason="node_failed", resume_ns=int(rec))
                    return False
                self._reject_unadmitted(r, now, "node_failed")
                return False
        r.node.active_count += 1
        r.node.active.append(r)
        self._emit("prefill_begin", now, r.node.id, r.id, tokens=self.prompt)
        wrote_any = False
        finish = float(now)
        ideal = 0.0
        for ci, klass in enumerate(self.classes):
            if klass.kv_bytes_per_token == 0:
                continue
            npages = pages_for(self.prompt, klass.kv_bytes_per_token, self.page)
            if not npages:
                continue
            a = r.classes[ci].n_alloc
            ok, why = self._alloc(r, ci, npages, now)
            if not ok:
                self._reject(r, now, why)
                return True
            self._observe({(r.idx, ci, i): 1 for i in range(a, a + npages)}, now, r.node)
            cp = r.classes[ci]
            placed_local = int((cp.where[a:a + npages] == LOCAL).sum())
            sp = r.node.spec.local
            if placed_local:
                # Prefill materializes the full prompt state: every local page is written.
                lats, fin = r.node.local.access(now, placed_local, self.page, write=True)
                self._record_writes(now, r.node, lats, pages=placed_local, nbytes=placed_local * self.page)
                finish = max(finish, fin)
                ideal += placed_local * (sp.latency_ns * sp.write_latency_factor
                                         + self.page / sp.bandwidth_bytes_per_ns)
                wrote_any = True
            spill = npages - placed_local
            if spill and self.fabric:
                dst = self.tier_ids[int(cp.home[a + placed_local])]
                ideal += spill * (self._route_lat(r.node.id, dst, True)
                                  + self._route_service(r.node.id, dst, self.page))
                wrote_any = True
        if wrote_any:
            self._bump(now, r.node, "stall_ns", max(finish - now - ideal, 0.0))
        # Serialized compute bound: prefill compute runs after memory service
        # with no overlap. Unset tokens_per_second means memory-only.
        ctps = r.node.spec.compute_tokens_per_second
        if ctps:
            cns = self.prompt / ctps * 1e9
            finish += cns
            self.compute_ns_prefill += cns
        self.sched.schedule(int(math.ceil(finish)), "prefill_end", (r, int(now)))
        return True

    def _reject(self, r, now, why):
        r.status = "rejected"
        self.rejected += 1
        self.reject_reasons[why] = self.reject_reasons.get(why, 0) + 1
        self._emit("request_rejected", now, r.node.id, r.id, reason=why)
        self._finish_common(r, now)

    def _reject_unadmitted(self, r, now, why):
        """Reject a request that never admitted (no slot held, no drain)."""
        r.status = "rejected"
        self.rejected += 1
        self.reject_reasons[why] = self.reject_reasons.get(why, 0) + 1
        self._emit("request_rejected", now, r.node.id, r.id, reason=why)
        self._free(r, now)

    def _finish_common(self, r, now):
        self._free(r, now)
        if r in r.node.active:
            r.node.active.remove(r)
        r.node.active_count -= 1
        while r.node.waiting and r.node.active_count < self.concurrency:
            if not self._start(r.node.waiting.pop(0), now):
                break

    def _decode(self, r, now):
        if self.faults is not None:
            rec = self.faults.recovery_of(r.node.id, now)
            if rec is not None:
                if rec <= self.sc.duration_ns:
                    self.stalled_requests += 1
                    self.sched.schedule(int(rec), "decode", r)
                    self._emit("request_stalled", now, r.node.id, r.id,
                               reason="node_failed", resume_ns=int(rec))
                    return
                self._reject(r, now, "node_failed")
                return
        node = r.node
        sp = node.spec.local
        total_tok = self.prompt + r.tokens_done + 1
        # 1. state growth for this token (spills when local is short).
        for ci, klass in enumerate(self.classes):
            if klass.kv_bytes_per_token == 0:
                continue
            need_pages = pages_for(total_tok, klass.kv_bytes_per_token, self.page)
            if need_pages > r.classes[ci].n_alloc:
                ok, why = self._alloc(r, ci, need_pages - r.classes[ci].n_alloc, now)
                if not ok:
                    self._reject(r, now, why)
                    return
        read_parts, write_parts = [], []
        write_bytes = 0
        finish = float(now)
        ideal = 0.0
        k_l_tot = k_r_tot = bypass_tot = n_tot = 0
        read_base = sp.latency_ns * sp.read_latency_factor + self.page / sp.bandwidth_bytes_per_ns
        for ci, klass in enumerate(self.classes):
            kv = klass.kv_bytes_per_token
            if kv == 0:
                continue
            cp = r.classes[ci]
            n = cp.n_alloc
            n_tot += n
            # 2. append this token's state (one write, always produced locally).
            wl, fin_w = node.local.access(now, 1, kv, write=True)
            write_parts.append(wl)
            write_bytes += kv
            finish = max(finish, fin_w)
            ideal += sp.latency_ns * sp.write_latency_factor + kv / sp.bandwidth_bytes_per_ns
            # 3. attention reads over the class's span (full context or trailing window).
            lo, hi = read_span(total_tok, klass, self.page)
            hi = min(hi, n)
            if hi <= lo:
                continue
            w = cp.where[lo:hi]
            loc_mask = w == LOCAL
            k_l = int(loc_mask.sum())
            rel_remote = np.nonzero(~loc_mask)[0]
            k_r = int(rel_remote.size)
            if k_l:
                cp.last[lo:hi][loc_mask] = now
                ll, fin_l = node.local.access(now, k_l, self.page, write=False)
                read_parts.append(ll)
                finish = max(finish, fin_l)
            bypass = 0
            if k_r:
                d = self._pol(node).on_remote_access(AccessContext(int(now), node.id, r.id, k_r))
                install = 0
                vict_n = 0
                if isinstance(d, FetchInstall):
                    want = [i for i in rel_remote
                            if self._pol(node).install_page((r.idx, ci, int(lo + i)))]
                    free = node.cap - node.used
                    need = len(want) - free
                    vict_n = 0
                    vict_dst = None
                    if need > 0:
                        vict = self._victims(node, need, (r, ci), now)
                        avail = sum(int(i.size) for _, i in vict)
                        if avail:
                            vict_dst = self._choose_dst(node, avail, require_space=False)
                            if vict_dst is not None:
                                vict = self._trim(vict, min(need, avail))
                                vict_n = sum(int(i.size) for _, i in vict)
                                self._evict_batch(node, vict, now, r.id, "fetch_install", vict_dst)
                    install = min(len(want), free + vict_n)
                    inst_rel = np.asarray([int(i) for i in want[:install]], dtype=np.int64)
                # Remote pages may live on different tiers: fetch per home tier.
                by_home: dict = {}
                for i in rel_remote:
                    by_home.setdefault(self.tier_ids[int(cp.home[lo + i])], []).append(i)
                for home in sorted(by_home):
                    cnt = len(by_home[home])
                    rl_, fin_r = self._xfer(now, node, home, False, cnt, self.page,
                                           "demand_fetch", r.id, home, node.id,
                                           pipelined=False)
                    read_parts.append(rl_)
                    finish = max(finish, fin_r)
                    self._emit("page_miss", now, node.id, r.id, requested_tier=node.id,
                               found_tier=home, pages=cnt, class_name=klass.name)
                if install or vict_n:
                    # Net per tier, applied once: peak reflects net occupancy.
                    net: dict = {}
                    if vict_n:
                        net[vict_dst] = net.get(vict_dst, 0) + vict_n
                    if install:
                        inst = lo + inst_rel
                        for tid in self.tier_ids:
                            back = int((cp.home[inst] == self.tier_idx[tid]).sum())
                            if back:
                                net[tid] = net.get(tid, 0) - back
                    for tid, delta in net.items():
                        self.tiers[tid].set_used(now, self.tiers[tid].used + delta)
                if install:
                    inst = lo + inst_rel
                    cp.where[inst] = LOCAL
                    cp.last[inst] = now
                    cp.home[inst] = self.tier_idx[node.id]
                    node.set_used(now, node.used - vict_n + install)
                    node.installed_pages += install
                    self.install_bytes += install * self.page
                    self.migration_bytes += install * self.page
                    self._bump(now, node, "installs", install)
                bypass = k_r - install
            ideal += (k_l + k_r) * read_base
            k_l_tot += k_l
            k_r_tot += k_r
            bypass_tot += bypass
            touched = {(r.idx, ci, int(i)): 1 for i in range(lo, hi)}
            if n > 0:
                touched[(r.idx, ci, n - 1)] = touched.get((r.idx, ci, n - 1), 0) + 1
            self._observe(touched, now, node)
            pol = self._pol(node)
            if pol.prefetch_degree and (k_l + k_r) > 0 and (
                    getattr(pol, "on_hit", True) or k_r > 0):
                self._prefetch_issue(r, ci, now)
        lats = np.concatenate(read_parts) if read_parts else np.empty(0)
        self._record_reads(now, node, lats, local=k_l_tot, remote=k_r_tot, missed=0,
                           bypass=bypass_tot, stall=max(finish - now - ideal, 0.0))
        if write_parts:
            wlats = np.concatenate(write_parts)
            n_wr = len(write_parts)
            self._record_writes(now, node, wlats, pages=n_wr, nbytes=write_bytes)
        ctps = r.node.spec.compute_tokens_per_second
        if ctps:
            cns = 1.0 / ctps * 1e9
            finish += cns
            self.compute_ns_decode += cns
        step_ns = finish - now
        self._record_step(now, step_ns)
        self._emit("decode_step", now, node.id, r.id, token_index=r.tokens_done, pages=n_tot,
                   pages_remote=k_r_tot, step_ns=int(math.ceil(finish)) - int(now))
        r.tokens_done += 1
        end = int(math.ceil(finish))
        if r.tokens_done == 1:
            # First-token boundary: queue + prefill + first decode step.
            self.ttft_hist_all.add_one(float(end - r.arrival))
            if end >= self.sc.warmup_ns:
                self.ttft_hist.add_one(float(end - r.arrival))
        if r.tokens_done < self.gen:
            self.sched.schedule(end, "decode", r)
        else:
            self.sched.schedule(end, "complete", r)

    # ------------------------------------------------------------ handler ---
    def _handle(self, kind, data, now, seq):
        if kind == "decode":
            self._decode(data, now)
        elif kind == "arrival":
            idx = self.arrived
            self.arrived += 1
            node = self.nodes[idx % len(self.nodes)]
            r = Request(idx, node, now, self.max_pages)
            self._emit("request_arrival", now, node.id, r.id, **{"class": "default"},
                       prompt_tokens=self.prompt, generated_tokens=self.gen)
            self.sched.schedule(now + self.arrivals.next_gap_ns(), "arrival")
            self._admit_or_queue(r, now)
        elif kind == "prefill_end":
            r, t0 = data
            self._emit("prefill_end", now, r.node.id, r.id, duration_ns=now - t0)
            self._decode(r, now)
        elif kind == "complete":
            r = data
            r.status = "completed"
            self.completed += 1
            lat = now - r.arrival
            self.req_hist_all.add_one(float(lat))
            if now >= self.sc.warmup_ns:
                self.completed_ss += 1
                self.tokens_ss += self.gen
                self.req_hist.add_one(float(lat))
            self._emit("request_complete", now, r.node.id, r.id, tokens_generated=self.gen,
                       latency_ns=lat)
            self._finish_common(r, now)
        elif kind == "xfer_done":
            link, hops, node, nbytes, dur, qd, rid, kkind, kpages, from_tier, to_tier = data
            self._emit("transfer_complete", now, node, rid, link=link, path=hops, bytes=nbytes,
                       duration_ns=dur, queue_delay_ns=int(qd))
            self._emit("page_migrate_end", now, node, rid, pages=kpages, bytes=nbytes,
                       from_tier=from_tier, to_tier=to_tier, link=link, path=hops,
                       duration_ns=dur, kind=kkind)
        elif kind == "sample":
            self._sample(now)
        elif kind == "admit_retry":
            node = self.node_by_id[data]
            while node.waiting and node.active_count < self.concurrency:
                if not self._start(node.waiting.pop(0), now):
                    break
        elif kind == "fault_degrade_begin":
            self.fabric.rescale_link(data["link"], data["bandwidth_factor"], now)
            self._emit("link_degraded", now, None, None, link=data["link"],
                       bandwidth_factor=data["bandwidth_factor"],
                       latency_factor=data["latency_factor"])
        elif kind == "fault_degrade_end":
            self.fabric.rescale_link(data["link"], 1.0, now)
            self._emit("link_restored", now, None, None, link=data["link"])
        elif kind == "fault_node_fail":
            self._emit("node_fail", now, data["node"], None,
                       reason=data["reason"], recovery_ns=data["recovery_ns"])
        elif kind == "fault_node_recover":
            self._emit("node_recover", now, data["node"], None,
                       downtime_ns=data["downtime_ns"])

    def _sample(self, now):
        c = self.m_all.c
        ops = c["reads"] + c["writes"]
        row = {"t_ns": int(now), "accesses": ops - self._last_sample["accesses"],
               "evictions": c["evictions"] - self._last_sample["evictions"],
               "completed": self.completed - self._last_sample["completed"],
               "degraded": self.faults.active_count(now) if self.faults else 0,
               "local_used_pages": {n.id: n.used for n in self.nodes},
               "pool_used_pages": sum(p.used for p in self.pools.values()),
               "pools_used_pages": {pid: p.used for pid, p in self.pools.items()},
               "link_bytes": {},
               "latency_ns": self.win_read.stats(self.sc.percentiles)}
        self.win_read = Histogram()
        self._last_sample = {"accesses": ops, "evictions": c["evictions"], "completed": self.completed}
        if self.fabric:
            for lid in self.fabric.dir_bytes:
                total = sum(self.fabric.dir_bytes[lid].values())
                row["link_bytes"][lid] = total - self._last_link_bytes.get(lid, 0)
                self._last_link_bytes[lid] = total
        self.series.append(row)
        self._emit("sampling_tick", now, interval_ns=self.sc.sample_interval_ns)
        self._emit("metric_snapshot", now, window_ns=self.sc.sample_interval_ns,
                   **{k: v for k, v in row.items() if k != "t_ns"})
        nxt = now + self.sc.sample_interval_ns
        if nxt <= self.sc.duration_ns:
            self.sched.schedule(nxt, "sample")

    # ---------------------------------------------------------------- run ---
    def run(self):
        sc = self.sc
        for p in self.policies.values():
            p.reset()
        try:
            self._emit("run_start", 0, scenario_hash=sc.hash, seed=sc.seed, version=__version__)
            self.sched.schedule(self.arrivals.next_gap_ns(), "arrival")
            self.sched.schedule(sc.sample_interval_ns, "sample")
            if self.faults is not None:
                for t, kind, payload in self.faults.edges():
                    self.sched.schedule(int(t), "fault_" + kind, payload)
            self.sched.run(self._handle, sc.duration_ns)
            end = sc.duration_ns
            for n in self.nodes:
                n.local.server.finish(end)
                n.set_used(end, n.used)
            for p in self.pools.values():
                p.set_used(end, p.used)
            if self.fabric:
                self.fabric.finish(end)
            for _, nbytes in self.pref_outstanding.values():
                self.pref_wasted += nbytes
            self.pref_outstanding.clear()
            summary = self._summary()
            self._emit("run_end", end, events_processed=self.sched.processed,
                       virtual_time_ns=end, status="completed")
            manifest = self._manifest(summary)
            if self.out_dir:
                self._write_bundle(summary, manifest)
            return summary, manifest
        finally:
            self.events.close()

    # ------------------------------------------------------------ reports ---
    def _summary(self):
        sc = self.sc
        pct = sc.percentiles
        ss = self.m_ss
        allc = self.m_all.c
        steady = max(sc.duration_ns - sc.warmup_ns, 1)
        c = ss.c
        n = max(c["reads"], 1)
        end_t = sc.duration_ns

        def busy(s):  # service queued past the end of the run is not utilization
            return max(0.0, s.busy_ns - max(0.0, s.free_at - end_t))

        links = {}
        if self.fabric:
            for lid, d in self.fabric.links.items():
                l = sc.links[lid]
                uniq = list({id(s): s for s in d.values()}.values())
                busy_total = sum(busy(s) for s in uniq)
                cap_ns = sc.duration_ns * len(uniq)
                compute_ends = [e for e in (l.frm, l.to) if e in self.node_by_id]
                links[lid] = {
                    "node": compute_ends[0] if len(compute_ends) == 1 else None,
                    "endpoints": [l.frm, l.to],
                    "bytes_in": self.fabric.dir_bytes[lid]["in"],
                    "bytes_out": self.fabric.dir_bytes[lid]["out"],
                    "busy_ns": busy_total, "utilization": busy_total / cap_ns if cap_ns else 0.0,
                    "max_queue_bytes": max(s.q_max for s in uniq),
                    "time_weighted_queue_bytes": sum(s.q_area for s in uniq) / sc.duration_ns,
                    "congested_events": sum(s.congested for s in uniq),
                    "queue_overflow_events": sum(s.overflow for s in uniq),
                }
        pools = {}
        for pid, pst in self.pools.items():
            ps = self.fabric.tier_servers[pid] if self.fabric else None
            pools[pid] = {"capacity_pages": pst.cap, "peak_used_pages": pst.peak,
                          "final_used_pages": pst.used,
                          "overcommit_pages_max": max(0, pst.peak - pst.cap),
                          "utilization": (busy(ps) / sc.duration_ns) if ps else 0.0,
                          "max_queue_bytes": ps.q_max if ps else 0,
                          "bytes_served": ps.bytes if ps else 0}
        pool = pools[sorted(pools)[0]] if len(pools) == 1 else None
        mem = {}
        for nd in self.nodes:
            nc = nd.m_ss.c
            nn = nc["reads"] or 1
            mem[nd.id] = {
                "capacity_pages": nd.cap, "peak_used_pages": nd.peak, "final_used_pages": nd.used,
                "evicted_pages": nd.evicted_pages, "installed_pages": nd.installed_pages,
                "bandwidth_utilization": busy(nd.local.server) / sc.duration_ns,
                "max_queue_bytes": nd.local.server.q_max,
                "reads": nc["reads"], "local_hits": nc["read_local"],
                "remote_hits": nc["read_remote"],
                "local_hit_ratio": nc["read_local"] / nn,
                "remote_hit_ratio": nc["read_remote"] / nn,
                "stall_ns": nc["stall_ns"],
                "writes": nc["writes"], "write_bytes": nc["write_bytes"],
                "in_flight_at_end": nd.active_count, "queued_at_end": len(nd.waiting),
                "total_accesses_incl_warmup": nd.m_all.c["reads"],
            }
        switch = None
        if self.fabric is not None and self.fabric.legacy is not None:
            sws = self.fabric.legacy
            switch = {"bytes_served": sws.bytes, "busy_ns": busy(sws),
                      "utilization": busy(sws) / sc.duration_ns,
                      "max_queue_bytes": sws.q_max}
        switches = {}
        if self.fabric:
            for sid, sws in self.fabric.switches.items():
                switches[sid] = {"bytes_served": sws.bytes, "busy_ns": busy(sws),
                                 "utilization": busy(sws) / sc.duration_ns,
                                 "max_queue_bytes": sws.q_max}
        rl = self.req_hist.stats(pct)
        rl_all = self.req_hist_all.stats(pct)
        cost = None
        cm = sc.cost_model
        if cm:
            tot_ns = sum(nd.occ_ns for nd in self.nodes) * self.page
            tot_ns += sum(p.occ_ns for p in self.pools.values()) * self.page
            comp = {
                "capacity": cm.get("capacity_per_gib_second", 0.0) * tot_ns / 1e9 / GIB,
                "transfer": cm.get("transfer_per_gib", 0.0) * sum(v["bytes_in"] + v["bytes_out"] for v in links.values()) / GIB,
                "migration": cm.get("migration_per_gib", 0.0) * self.migration_bytes / GIB,
                "prefetch": cm.get("prefetch_per_gib", 0.0) * self.pref_bytes / GIB,
                "wasted_prefetch": cm.get("wasted_prefetch_per_gib", 0.0) * self.pref_wasted / GIB,
            }
            cost = {"currency": cm.get("currency", "unit"), **comp, "total": sum(comp.values())}
        w = ss.c
        w_all = allc
        s = {
            "schema": "rmemfab.summary/0.1", "rmemfab_version": __version__, "scenario": sc.name,
            "scenario_hash": sc.hash, "seed": sc.seed, "run_id": self.run_id,
            "workload_label": "synthetic",
            "policy": {"requested": sc.policy_requested, "effective": sc.policy_effective,
                       "version": next(iter(self.policies.values())).version,
                       "fallback_reason": sc.fallback_reason,
                       "instances": "per compute node (independent state)"},
            "events_processed": self.sched.processed,
            "time": {"virtual_time_ns": sc.duration_ns, "warmup_ns": sc.warmup_ns, "steady_window_ns": steady},
            "requests": {"arrived": self.arrived, "completed": self.completed, "rejected": self.rejected,
                         "reject_reasons": dict(sorted(self.reject_reasons.items())),
                         "in_flight_at_end": sum(n.active_count for n in self.nodes),
                         "queued_at_end": sum(len(n.waiting) for n in self.nodes),
                         "latency_ns": rl, "latency_all_ns": rl_all,
                         "completed_steady": self.completed_ss,
                         "throughput_per_s": self.completed_ss / (steady / 1e9),
                         "tokens_per_s": self.tokens_ss / (steady / 1e9)},
            "decode_step_latency_ns": ss.step_hist.stats(pct),
            "serving": {"ttft_ns": self.ttft_hist.stats(pct),
                        "ttft_all_ns": self.ttft_hist_all.stats(pct),
                        "tpot_ns": ss.step_hist.mean(),
                        "itl_ns": ss.step_hist.stats(pct),
                        "compute_ns": self.compute_ns_prefill + self.compute_ns_decode,
                        "compute_prefill_ns": self.compute_ns_prefill,
                        "compute_decode_ns": self.compute_ns_decode,
                        "compute_note": ("Serialized bound: prefill compute "
                                         "(prompt_tokens/tokens_per_second) and decode compute "
                                         "(1/tokens_per_second per token) are added after memory "
                                         "service with no overlap; 0 when "
                                         "compute.tokens_per_second is unset.")},
            "access": {"count": c["reads"], "latency_ns": ss.read_hist.stats(pct),
                       "latency_all_ns": self.m_all.read_hist.stats(pct),
                       "local_hits": c["read_local"], "remote_hits": c["read_remote"],
                       "bypass_reads": c["read_bypass"], "misses": c["read_miss"],
                       "local_hit_ratio": c["read_local"] / n, "remote_hit_ratio": c["read_remote"] / n,
                       "miss_ratio": c["read_miss"] / n, "stall_ns": c["stall_ns"],
                       "total_accesses_incl_warmup": allc["reads"]},
            "writes": {"count": w["writes"], "bytes": w["write_bytes"],
                       "latency_ns": ss.write_hist.stats(pct),
                       "latency_all_ns": self.m_all.write_hist.stats(pct),
                       "total_incl_warmup": w_all["writes"]},
            "traffic": {"remote_read_bytes": self._remote_bytes("in"),
                        "remote_write_bytes": self._remote_bytes("out"),
                        "migration_bytes": self.migration_bytes, "evict_bytes": self.evict_bytes,
                        "install_bytes": self.install_bytes, "prefetch_bytes": self.pref_bytes,
                        "wasted_prefetch_bytes": self.pref_wasted,
                        "prefetch_issued": self.pref_issued, "prefetch_useful": self.pref_useful,
                        "prefetch_skipped": self.pref_skipped,
                        "prefetch_accuracy": (self.pref_useful / self.pref_issued
                                              if self.pref_issued else None),
                        "transfer_bytes": self.page,
                        "transfer_note": "transfer unit equals page size by construction"},
            "links": links, "switch": switch, "switches": switches,
            "pool": pool, "pools": pools, "memory": mem, "cost": cost,
            "tiers": sorted(self.tier_ids),
            "migration_matrix_pages": {f"{a}>{b}": v for (a, b), v in
                                       sorted(self.mig_matrix.items())},
            "workload": {"page_size_bytes": self.page, "geometry_source": sc.geometry_source,
                         "classes": [
                             {"name": k.name, "layers": k.layers,
                              "kv_bytes_per_token": k.kv_bytes_per_token,
                              "window_tokens": k.window_tokens,
                              "pages_per_request_max": pages_for(
                                  self.prompt + self.gen, k.kv_bytes_per_token, self.page)}
                             for k in self.classes]},
            "series_points": len(self.series),
            "degraded": {"windows": self.faults.windows() if self.faults else [],
                         "stalled_requests": self.stalled_requests,
                         **(self.faults.counters() if self.faults
                            else FaultModel.zero_counters())},
        }
        if sc.geometry_source == "legacy_dense":
            s["workload"]["kv_formula"] = "2 * layers * kv_heads * head_dim * dtype_bytes"
        return roundf(s)

    def _remote_bytes(self, direction):
        if not self.fabric:
            return 0
        return self.fabric.endpoint_bytes[direction]

    def _manifest(self, summary):
        sc = self.sc
        notes = ["Fabric: links, pools, and switches are FIFO byte servers; transfers "
                 "occupy every hop on their static route plus the destination tier.",
                 "Requests shard round-robin across compute nodes; each node runs an independent "
                 "policy instance and its own admission queue (concurrency is per node).",
                 "Clean evictions transfer 0 bytes; only dirty pages write back.",
                 "Prefetch (when enabled) anticipates growth, shares demand fabric, and reports "
                 "accuracy = touched-after-issue / issued; skipped counts cap/pressure refusals.",
                 "In-flight/queue-depth breaches are counted as congestion/overflow telemetry; "
                 "transfers are never dropped.",
                 "Page lifecycle events use aggregate rows (pages + id prefix), not per-page rows.",
                 "Fetch installs at demand time; page_migrate pairs span the transfer flight."]
        if sc.switch is not None:
            notes.append("A legacy switch server caps aggregate transfer bandwidth (bisection).")
        if sc.switches and not (sc.switch is not None and set(sc.switches) == {"switch-0"}):
            notes.append("Named switches occupy the transfers whose static route crosses them.")
        if not sc.switches and len(sc.nodes) > 1:
            notes.append("No switch configured: bisection is unbounded (infinite-bisection assumption).")
        notes.append("Placement is single-owner N-tier: pages migrate between node locals and "
                     "pools over static shortest-path routes; there is no page sharing or "
                     "coherence protocol.")
        if any(n.compute_tokens_per_second for n in sc.nodes):
            notes.append("Compute: serialized service time from compute.tokens_per_second "
                         "(prompt/tps at prefill, 1/tps per decode token), added after "
                         "memory service with no overlap; memory-bandwidth changes cannot "
                         "move the compute term.")
        if self.faults is not None:
            notes.append("Faults: degradation rescales link bandwidth exactly at window edges; "
                         "transfers issued inside a window use degraded latency.")
            notes.append("Loss: reliable-transport persistence with RTO = 2x path fixed latency, "
                         "at most 8 simulated draws per transfer; retries are computed "
                         "synchronously at issue (no interleaved traffic in the RTO gap).")
            notes.append("Failures gate issue at event boundaries; node-down requests park to "
                         "recovery or reject with reason node_failed. Policies are "
                         "fault-oblivious: placement estimates use nominal fabric values.")
        return {
            "rmemfab_version": __version__, "schema_version": SCHEMA_VERSION, "scenario_name": sc.name,
            "scenario_hash": sc.hash, "seed": sc.seed, "run_id": self.run_id,
            "stream_seeds": stream_seeds(sc.seed),
            "trace_hashes": [], "workload_label": "synthetic",
            "percentile_method": PERCENTILE_METHOD,
            "kv_inputs": {"geometry_source": sc.geometry_source,
                          "classes": summary["workload"]["classes"],
                          "formula": summary["workload"].get("kv_formula")},
            "policy": {"requested": sc.policy_requested, "effective": sc.policy_effective,
                       "version": next(iter(self.policies.values())).version,
                       "fallback_reason": sc.fallback_reason,
                       "instances": "per compute node (independent state)"},
            "shared_pool_model": "shared_byte_server",
            "tiers": sorted(self.tier_ids),
            "routes": {f"{a}>{b}": [lid for lid, _ in r.links]
                       for (a, b), r in sorted(sc.routes.items())},
            "event_count": self.sched.processed, "events_logged": self.events.count,
            "virtual_time_ns": sc.duration_ns, "warmup_ns": sc.warmup_ns, "status": "completed",
            "assumed_parameters": sc.assumed, "scenario_assumptions": sc.raw.get("assumptions", []),
            "warnings": sc.warnings, "limitations": notes,
            "outputs": {"scenario": "scenario.json", "summary": "summary.json", "series": "series.jsonl",
                        "events": "events.jsonl" if self.log else None},
            "host": {"python": platform.python_version(), "numpy": np.__version__, "platform": platform.system()},
        }

    def _write_bundle(self, summary, manifest):
        d = self.out_dir
        (d / "scenario.json").write_text(canonical_json(self.sc.raw) + "\n", encoding="utf-8")
        (d / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        (d / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        with open(d / "series.jsonl", "w", encoding="utf-8", newline="\n") as f:
            for row in self.series:
                f.write(json.dumps(row, separators=(",", ":")) + "\n")
        a = summary["access"]
        (d / "README.md").write_text(
            f"# {self.sc.name}\n\nPolicy `{summary['policy']['effective']}`, seed {self.sc.seed}, scenario hash "
            f"`{self.sc.hash[:16]}`, synthetic workload. Mean read latency {a['latency_ns']['mean']:,.1f} ns, "
            f"local-hit ratio {a['local_hit_ratio']:.4f} (reads only), "
            f"{summary['requests']['completed']} requests completed. "
            "Caveat: parameters are assumptions unless their provenance says measured; treat results as relative.\n",
            encoding="utf-8")
