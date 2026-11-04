"""Trace replay: validated op streams through the shared execution core.

Reuses the byte servers, policies, metrics, histograms, and event shapes of
the synthetic engine. Differences are confined to the driver: where the
synthetic path generates ops from geometry, replay reads them from a
validated trace. Timing rules (L+n/B, spill-on-alloc, fetch-on-demand,
dirty-only writeback) are identical by construction, and a cross-validation
test proves the two drivers agree on identical op streams.

Batching rule: ops sharing a timestamp execute as one group; tier accesses
within a group batch by (kind, bytes) through the same batched primitives
the synthetic path uses, so identical issue patterns produce identical
numbers. Transfers execute per op in file order.
"""
from __future__ import annotations

import json
import math
import platform
from pathlib import Path

import numpy as np

from .. import __version__
from ..core.engine import GIB, LOCAL, REMOTE, Metrics, NodeState, PoolState
from ..core.faults import FaultModel
from ..memory.servers import Fabric, Server
from ..policies import create_policy
from ..policies.base import AccessContext, EvictToRemote, FetchInstall, PressureContext, Reject
from ..core.rng import stream_seeds
from ..telemetry.hist import PERCENTILE_METHOD, Histogram
from ..telemetry.summary import canonical, roundf
from ..telemetry.writers import JsonlWriter, NullWriter
from .validate import ValidatedTrace, load_trace

LOCAL_ONLY = "local_only"


class ReplayDivergence(Exception):
    """The trace does not fit the modeled machine (explicit halt, never silent)."""


class ReplayEngine:
    def __init__(self, sc, trace: ValidatedTrace, out_dir=None, *, event_log=True):
        self.sc = sc
        self.trace = trace
        self.page = sc.page_size
        self.nodes = {}
        self.policies = {}
        for spec in sc.nodes:
            nd = NodeState(spec, self.page)
            nd.m_all, nd.m_ss = Metrics(), Metrics()
            self.nodes[spec.id] = nd
            self.policies[spec.id] = create_policy(sc.policy_effective, sc.policy_params)
        self.pools = {pid: PoolState(pspec, self.page) for pid, pspec in sc.pools.items()}
        self.tiers = dict(self.nodes)
        self.tiers.update(self.pools)
        self.tier_ids = sorted(self.tiers)
        tier_specs = {n.id: n.spec.local for n in self.nodes.values()}
        tier_specs.update({pid: pspec.tier for pid, pspec in sc.pools.items()})
        tier_servers = {n.id: n.local.server for n in self.nodes.values()}
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
        self._edges = self.faults.edges() if self.faults else []
        self._edge_idx = 0
        self.mig_matrix: dict = {}
        # Request sharding for ops without an explicit node: first-seen
        # request order, round-robin over compute nodes (deterministic).
        self.req_node: dict = {}
        self._rr = 0
        self.run_id = f"{sc.hash[:12]}-{trace.sha256[:8]}-s{sc.seed}-{sc.policy_effective}"
        self.access_seq = 0
        self.pref_outstanding: dict = {}
        self.pref_issued = 0
        self.pref_useful = 0
        self.pref_skipped = 0
        self.pref_bytes = 0
        self.pref_wasted = 0
        self.out_dir = Path(out_dir) if out_dir else None
        want_log = event_log and sc.output.get("include_event_log", True) and self.out_dir is not None
        if self.out_dir:
            self.out_dir.mkdir(parents=True, exist_ok=True)
        self.events = JsonlWriter(self.out_dir / "events.jsonl") if want_log else NullWriter()
        self.log = want_log
        self.series = []
        self._seq = 0
        # residency: page_id -> [tier, last_touch, dirty, pages]
        self.pages: dict = {}
        self.m_all, self.m_ss = Metrics(), Metrics()
        self.req_first: dict = {}
        self.req_finish: dict = {}
        self.req_last_row: dict = {}
        for o in trace.ops:
            rid = o["request_id"]
            if rid is not None:
                self.req_last_row[rid] = o["row"]
                if rid not in self.req_first:
                    self.req_first[rid] = o["ts"]
        self.req_done: dict = {}
        self.migration_bytes = 0
        self.evict_bytes = 0
        self.install_bytes = 0
        self.link_xfers = 0
        self.dropped = 0
        self.now = 0
        self.processed = 0
        self._last_sample = {"accesses": 0, "evictions": 0, "completed": 0}
        self._last_link_bytes = {}

    def _pol(self, node):
        return self.policies[node.id]

    def _route_lat(self, src, dst, write):
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
        route = self.sc.routes[(src, dst)]
        per = nbytes / self.fabric.tier_servers[dst].bw
        for lid, _ in route.links:
            per = max(per, nbytes / self.sc.links[lid].bandwidth_bytes_per_ns)
        for sid in route.switches:
            per = max(per, nbytes / self.sc.switches[sid].bandwidth_bytes_per_ns)
        if self.sc.switch is not None:
            per = max(per, nbytes / self.sc.switch.bandwidth_bytes_per_ns)
        return per

    def _candidates(self, node, need, require_space):
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
        cands = self._candidates(node, need, require_space)
        if not cands:
            return None
        return self._pol(node).choose_tier(cands)

    def _node_for(self, op):
        """Resolve an op's compute node: explicit wins, else the owning
        request's round-robin shard (first-seen order)."""
        nid = op.get("node")
        if nid is not None:
            return self.nodes[nid]
        rid = op.get("request_id")
        key = rid if rid is not None else f"\0row{op['row']}"
        if key not in self.req_node:
            ids = list(self.nodes)
            self.req_node[key] = ids[self._rr % len(ids)]
            self._rr += 1
        return self.nodes[self.req_node[key]]

    # ------------------------------------------------------------- emit ---
    def _emit(self, name, now, request_id=None, node_id=None, **data):
        if not self.log:
            return
        self._seq += 1
        rec = {"event": name, "time_ns": int(now), "seq": self._seq, "run_id": self.run_id}
        if node_id is not None:
            rec["node"] = node_id
        if request_id is not None:
            rec["request_id"] = request_id
        rec["data"] = data
        self.events.write(rec)

    # --------------------------------------------------------- transfers ---
    def _xfer(self, now, node, dst_tier, tier_write, k, n, kind, request_id,
              from_tier, to_tier, pipelined=False):
        lats, finish, qd, flags, retx = self.fabric.transfer(
            node.id, dst_tier, now, k, n, tier_write, pipelined)
        route = self.sc.routes[(node.id, dst_tier)]
        hops = [lid for lid, _ in route.links]
        nbytes = k * n
        end = int(math.ceil(finish))
        self._emit("transfer_begin", now, request_id, node.id, link=hops[0], path=hops,
                   bytes=nbytes,
                   from_node=(dst_tier if not tier_write else node.id),
                   to_node=(node.id if not tier_write else dst_tier), kind=kind, pages=k,
                   attempts=retx["attempts"], retx_delay_ns=int(retx["delay_ns"]),
                   stall_ns=int(retx["stall_ns"]))
        for l in retx["lost"]:
            self._emit("transfer_lost", now, request_id, node.id, link=l["link"],
                       attempt=l["attempt"], bytes=nbytes, rto_ns=int(l["rto_ns"]))
        self._emit("page_migrate_begin", now, request_id, node.id, pages=k, bytes=nbytes,
                   from_tier=from_tier, to_tier=to_tier, link=hops[0], path=hops, kind=kind)
        if flags[0]:
            qmax = 0
            for lid, hop_dir in route.links:
                for s in self.fabric.links[lid].values():
                    qmax = max(qmax, int(s.backlog_bytes(now)))
            self._emit("link_congested", now, request_id, node.id, link=hops[0], path=hops,
                       queue_bytes=qmax, utilization=1.0)
        # Completion row is due at `end`; completions are flushed in order.
        self._pending_completions.append((end, hops[0], hops, node.id, nbytes,
                                          end - int(now), int(qd), request_id, kind, k,
                                          from_tier, to_tier))
        self.link_xfers += 1
        return lats, finish

    def _flush_completions(self, upto):
        self._pending_completions.sort(key=lambda t: t[0])
        while self._pending_completions and self._pending_completions[0][0] <= upto:
            end, link, hops, node, nbytes, dur, qd, rid, kkind, kpages, ft, tt = \
                self._pending_completions.pop(0)
            self._emit("transfer_complete", end, rid, node, link=link, path=hops, bytes=nbytes,
                       duration_ns=dur, queue_delay_ns=qd)
            self._emit("page_migrate_end", end, rid, node, pages=kpages, bytes=nbytes,
                       from_tier=ft, to_tier=tt, link=link, path=hops,
                       duration_ns=dur, kind=kkind)

    # ---------------------------------------------------------- placement ---
    def _victims(self, node, need_pages):
        """Victim reservations resident on `node`: foreign pages yield first,
        then domestic by the node's policy victim key (LRU by default),
        accumulating whole reservations until at least `need_pages` frames
        would free."""
        res = [(pid, v) for pid, v in self.pages.items() if v[5] == node.id]
        foreign = sorted(((self._pol(node).victim_key(pid, v[1], self.now), pid)
                          for pid, v in res if v[4] != node.id))
        domestic = sorted(((self._pol(node).victim_key(pid, v[1], self.now), pid)
                           for pid, v in res if v[4] == node.id))
        local = foreign + domestic
        out, freed = [], 0
        for _, pid in local:
            if freed >= need_pages:
                break
            out.append(pid)
            freed += self.pages[pid][3]
        return out

    def _trim_to_pages(self, pids, need_pages, exclude=None):
        out, freed = [], 0
        for pid in pids:
            if pid == exclude:
                continue
            out.append(pid)
            freed += self.pages[pid][3]
            if freed >= need_pages:
                break
        return out

    def _evict_pages(self, node, pids, now, request_id, cause, dst):
        if not pids:
            return 0, 0
        self._pref_abandon(pids)
        dirty_pgs = sum(self.pages[p][3] for p in pids if self.pages[p][2])
        total_pgs = sum(self.pages[p][3] for p in pids)
        clean_pgs = total_pgs - dirty_pgs
        for p in pids:
            rec = self.pages[p]
            rec[5] = dst
            rec[0] = LOCAL if dst == rec[4] else REMOTE
        self._emit("page_evict", now, request_id, node.id, tier=node.id, to_tier=dst,
                   pages=total_pgs, bytes=dirty_pgs * self.page, dirty_pages=dirty_pgs,
                   clean_pages=clean_pgs, page_ids=sorted(pids), cause=cause)
        if dirty_pgs:
            self._xfer(now, node, dst, True, dirty_pgs, self.page, "evict_writeback",
                       request_id, node.id, dst, pipelined=True)
            self.evict_bytes += dirty_pgs * self.page
            self.migration_bytes += dirty_pgs * self.page
        self.mig_matrix[(node.id, dst)] = self.mig_matrix.get((node.id, dst), 0) + total_pgs
        node.evicted_pages += total_pgs
        self._bump(now, node, "evictions", total_pgs)
        return total_pgs, len(pids)

    def _alloc(self, node, pid, npages, now, request_id, row):
        """Place a reservation atomically on `node`: all local if it fits
        (evicting under the node's policy when pressured), else all spilled
        to one policy-chosen remote tier. Partial splits are refused: a
        reservation lives in exactly one tier."""
        free = node.cap - node.used
        if npages <= free:
            node.set_used(now, node.used + npages)
            self.pages[pid] = [LOCAL, now, True, npages, node.id, node.id]
            placed, home = "local", node.id
        else:
            need = npages - free
            remote_free = sum(self.tiers[tid].cap - self.tiers[tid].used
                              for tid in self.tier_ids
                              if tid != node.id and (node.id, tid) in self.sc.routes)
            ctx = PressureContext(int(now), node.id, need, free, remote_free)
            d = self._pol(node).on_pressure(ctx)
            self._emit("policy_pressure", now, request_id, node.id, policy=self._pol(node).name,
                       tier=node.id, occupancy_bytes=node.used * self.page,
                       capacity_bytes=node.cap * self.page)
            if isinstance(d, Reject):
                raise ReplayDivergence(
                    f"row {row}: {d.reason} (alloc {pid}, {npages} pages, "
                    f"{free} local free, {remote_free} remote free)")
            victims = self._trim_to_pages(self._victims(node, need), need)
            freed = sum(self.pages[p][3] for p in victims)
            dst = self._choose_dst(node, need, require_space=True) if freed >= need else None
            if isinstance(d, EvictToRemote) and freed >= need and dst is not None:
                n, _ = self._evict_pages(node, victims, now, request_id,
                                         "allocation_pressure", dst)
                self.tiers[dst].set_used(now, self.tiers[dst].used + n)
                node.set_used(now, node.used - n + npages)
                self.pages[pid] = [LOCAL, now, True, npages, node.id, node.id]
                placed, home = "local", node.id
            else:
                if self.fabric is None or self._pol(node).name == LOCAL_ONLY:
                    raise ReplayDivergence(f"row {row}: local capacity exhausted and no spill path "
                                           f"(alloc {pid}, {npages} pages)")
                dst = self._choose_dst(node, npages, require_space=True)
                if dst is None:
                    raise ReplayDivergence(f"row {row}: no remote tier fits {npages} pages "
                                           f"(alloc {pid})")
                self.tiers[dst].set_used(now, self.tiers[dst].used + npages)
                lats, fin = self._xfer(now, node, dst, True, npages, self.page, "alloc_spill",
                                       request_id, node.id, dst, pipelined=True)
                self.migration_bytes += npages * self.page
                self.mig_matrix[(node.id, dst)] = self.mig_matrix.get((node.id, dst), 0) + npages
                self._record_writes(now, node, lats, pages=npages, nbytes=npages * self.page)
                self._note_finish(request_id, fin)
                self.pages[pid] = [REMOTE, now, True, npages, node.id, dst]
                placed, home = "remote", dst
        self._bump(now, node, "allocs", 1)
        self._bump(now, node, "alloc_pages", npages)
        self._emit("page_allocate", now, request_id, node.id, pages=npages, bytes=npages * self.page,
                   tiers={"local": npages if placed == "local" else 0,
                          "remote": 0 if placed == "local" else npages},
                   remote_tier=None if placed == "local" else home, page_id=pid)

    # -------------------------------------------------------------- ops ---
    def _record_reads(self, now, node, lats, **kw):
        self.m_all.record_reads(lats, **kw)
        node.m_all.record_reads(lats, **kw)
        if now >= self.sc.warmup_ns:
            self.m_ss.record_reads(lats, **kw)
            node.m_ss.record_reads(lats, **kw)

    def _record_writes(self, now, node, lats, **kw):
        self.m_all.record_writes(lats, **kw)
        node.m_all.record_writes(lats, **kw)
        if now >= self.sc.warmup_ns:
            self.m_ss.record_writes(lats, **kw)
            node.m_ss.record_writes(lats, **kw)

    def _bump(self, now, node, key, n):
        self.m_all.c[key] += n
        node.m_all.c[key] += n
        if now >= self.sc.warmup_ns:
            self.m_ss.c[key] += n
            node.m_ss.c[key] += n

    def _note_finish(self, request_id, fin):
        if request_id is not None:
            self.req_finish[request_id] = max(self.req_finish.get(request_id, 0), float(fin))

    def _fetch(self, node, pid, now, request_id, row, write=False):
        """Serve a non-local touch from `node`. Three cases: the page is
        parked on this node (foreign hit, no fabric); the owner touches its
        remote page (fetch + install decision); anyone else touches it
        (remote-through, no placement change). Returns (lats, finish,
        installed, bypass, parked)."""
        rec = self.pages[pid]
        npages = rec[3]
        home = rec[5]
        if home == node.id:
            # Foreign page parked here: serve from this tier, no fabric.
            lats, _ = node.local.access(now, 1, npages * self.page, write=write)
            rec[1] = now
            return lats, now + float(lats[-1]), 0, 0, True
        if (node.id, home) not in self.sc.routes:
            raise ReplayDivergence(
                f"row {row}: page {pid!r} is homed on {home!r}, unreachable from "
                f"{node.id!r} (no static route; the topology cannot serve this "
                f"sharing pattern)")
        d = self._pol(node).on_remote_access(AccessContext(int(now), node.id, request_id, npages))
        install, vict_n, vict_dst = 0, 0, None
        if node.id == rec[4] and isinstance(d, FetchInstall) and self._pol(node).install_page(pid):
            free = node.cap - node.used
            need = npages - free
            if need <= 0:
                install = npages
            else:
                victims = self._trim_to_pages(self._victims(node, need), need, exclude=pid)
                freed = sum(self.pages[p][3] for p in victims)
                room = min(need, freed)
                if freed >= need and room:
                    vict_dst = self._choose_dst(node, room, require_space=True)
                    victims = self._trim_to_pages(victims, room, exclude=pid)
                if freed >= need and room and vict_dst is not None:
                    n, _ = self._evict_pages(node, victims, now, request_id,
                                             "fetch_install", vict_dst)
                    vict_n = n
                    install = npages
                # else: bypass without evicting (no pointless churn)
        lats, fin = self._xfer(now, node, home, False, npages, self.page, "demand_fetch",
                               request_id, home, node.id, pipelined=False)
        self._emit("page_miss", now, request_id, node.id, requested_tier=node.id,
                   found_tier=home, pages=npages, page_id=pid)
        if install or vict_n:
            net: dict = {}
            if vict_n:
                net[vict_dst] = net.get(vict_dst, 0) + vict_n
            if install:
                net[home] = net.get(home, 0) - install
            for tid, delta in net.items():
                self.tiers[tid].set_used(now, self.tiers[tid].used + delta)
        if install:
            rec[0] = LOCAL
            rec[1] = now
            rec[5] = node.id
            node.set_used(now, node.used - vict_n + install)
            node.installed_pages += install
            self.install_bytes += install * self.page
            self.migration_bytes += install * self.page
            self._bump(now, node, "installs", install)
        return lats, fin, install, 0 if install else npages, False

    @staticmethod
    def _stride_successors(pid, stride, degree):
        """Trailing-integer stride: 'blk20572' +1 -> 'blk20573'. Returns []
        when the id has no numeric suffix (no address pattern to follow)."""
        i = len(pid)
        while i > 0 and pid[i - 1].isdigit():
            i -= 1
        if i == len(pid):
            return []
        stem, num = pid[:i], int(pid[i:])
        width = len(pid) - i
        return [f"{stem}{num + stride * k:0{width}d}" for k in range(1, degree + 1)]

    def _observe(self, touched: dict, now):
        """Per-node observation: {node_id: {pid: count}}. Prefetch-useful
        accounting runs once per touch ahead of the policy update."""
        for nid in sorted(touched):
            counts = touched[nid]
            if not counts:
                continue
            self.access_seq += 1
            for pid in counts:
                if pid in self.pref_outstanding and self.pref_outstanding[pid][0] < self.access_seq:
                    self.pref_useful += 1
                    del self.pref_outstanding[pid]
            self.policies[nid].observe_batch(counts, now)

    def _pref_abandon(self, pids):
        for pid in pids:
            if pid in self.pref_outstanding:
                _, nbytes = self.pref_outstanding.pop(pid)
                self.pref_wasted += nbytes

    def _prefetch_issue(self, node, pid, now, request_id):
        """Migrate stride successors to the TRIGGER node's local tier (single
        ownership: the home moves, nothing replicates)."""
        pol = self._pol(node)
        degree = pol.prefetch_degree
        if not degree:
            return
        cap = getattr(pol, "max_in_flight", 0)
        stride = getattr(pol, "stride", 1)
        for cand in self._stride_successors(pid, stride, degree):
            rec = self.pages.get(cand)
            if rec is None or rec[5] == node.id or cand in self.pref_outstanding:
                continue
            if len(self.pref_outstanding) >= cap:
                self.pref_skipped += 1
                continue
            npages = rec[3]
            src = rec[5]
            if (node.id, src) not in self.sc.routes:
                self.pref_skipped += 1
                continue
            free = node.cap - node.used
            need = npages - free
            vict_n, vict_dst = 0, None
            if need > 0:
                remote_free = sum(self.tiers[tid].cap - self.tiers[tid].used
                                  for tid in self.tier_ids
                                  if tid != node.id and (node.id, tid) in self.sc.routes)
                d = self._pol(node).on_pressure(PressureContext(
                    int(now), node.id, need, free, remote_free))
                if isinstance(d, Reject):
                    self.pref_skipped += 1
                    continue
                victims = self._trim_to_pages(self._victims(node, need), need, exclude=cand)
                freed = sum(self.pages[p][3] for p in victims)
                room = min(need, freed)
                vict_dst = None
                if freed >= need and room:
                    vict_dst = self._choose_dst(node, room, require_space=True)
                    victims = self._trim_to_pages(victims, room, exclude=cand)
                if freed < need or room == 0 or vict_dst is None:
                    self.pref_skipped += 1
                    continue
                n, _ = self._evict_pages(node, victims, now, request_id,
                                         "prefetch_install", vict_dst)
                vict_n = n
            self._xfer(now, node, src, False, npages, self.page, "prefetch_fetch",
                       request_id, src, node.id, pipelined=True)
            net: dict = {}
            if vict_n:
                net[vict_dst] = net.get(vict_dst, 0) + vict_n
            net[src] = net.get(src, 0) - npages
            for tid, delta in net.items():
                self.tiers[tid].set_used(now, self.tiers[tid].used + delta)
            rec[0] = LOCAL if node.id == rec[4] else REMOTE
            rec[1] = now
            rec[5] = node.id
            node.set_used(now, node.used - vict_n + npages)
            node.installed_pages += npages
            self.mig_matrix[(src, node.id)] = self.mig_matrix.get((src, node.id), 0) + npages
            nbytes = npages * self.page
            self.install_bytes += nbytes
            self.migration_bytes += nbytes
            self._bump(now, node, "installs", npages)
            self.pref_outstanding[cand] = [self.access_seq, nbytes]
            self.pref_issued += 1
            self.pref_bytes += nbytes

    def _run_group(self, now, group):
        """Execute one timestamp's ops: state walk in file order, tier
        accesses batched by (node, kind, bytes) through the shared
        primitives. Each op executes on its resolved node against the page's
        current home tier: owner-local touches batch locally, foreign pages
        parked here hit this tier, and anything else fetches over the static
        route (owners may install; non-owners read through without moving
        the page). Single ownership holds throughout: no replication, no
        coherence protocol needed."""
        local_batches: dict = {}
        touched: dict = {}
        reads: list = []
        for o in group:
            pid, op, nbytes, rid, row = o["page_id"], o["op"], o["bytes"], o["request_id"], o["row"]
            node = self._node_for(o)
            if self.faults is not None and self.faults.down(node.id, now):
                raise ReplayDivergence(
                    f"row {row}: op executes on '{node.id}', which is down at ts={now} "
                    f"(node-failure windows halt replay: parking a traced op would "
                    f"invert causality with later rows)")
            if op == "alloc":
                npages = -(-nbytes // self.page)
                self._alloc(node, pid, npages, now, rid, row)
                self._note_finish(rid, now)
            elif op == "free":
                rec = self.pages.pop(pid, None)
                if rec is None:  # pragma: no cover (validator rules this out)
                    raise ReplayDivergence(f"row {row}: free of unknown page {pid!r}")
                if node.id != rec[4]:
                    raise ReplayDivergence(
                        f"row {row}: page {pid!r} allocated on {rec[4]!r} but freed on "
                        f"{node.id!r} (only the allocating node may free)")
                self._pref_abandon([pid])
                self.tiers[rec[5]].set_used(now, self.tiers[rec[5]].used - rec[3])
                self._emit("page_free", now, rid, node.id, pages=rec[3], bytes=rec[3] * self.page,
                           tiers={"local": rec[3] if rec[5] == node.id else 0,
                                  "remote": 0 if rec[5] == node.id else rec[3]},
                           home_tier=rec[5], page_id=pid)
                self._note_finish(rid, now)
            elif op in ("read", "write"):
                rec = self.pages[pid]
                # Cross-node touches are legal: _fetch serves foreign pages
                # parked here locally and reads anything else through over
                # the static route (owners may install; non-owners never move
                # the page).
                tc = touched.setdefault(node.id, {})
                tc[pid] = tc.get(pid, 0) + 1
                if rec[0] == LOCAL and rec[4] == node.id:
                    local_batches.setdefault(
                        (node.id, "read" if op == "read" else "write", nbytes), []).append(o)
                    rec[1] = now
                    if op == "write":
                        rec[2] = True
                    if op == "read":
                        reads.append((node, pid, False, rid))
                else:
                    src = rec[5]
                    lats, fin, installed, bypass, parked = self._fetch(
                        node, pid, now, rid, row, write=(op == "write"))
                    if op == "read":
                        reads.append((node, pid, not parked, rid))
                        res_bytes = rec[3] * self.page
                        lat = float(lats[-1])
                        if parked:
                            sp = node.spec.local
                            ideal = sp.latency_ns * sp.read_latency_factor + res_bytes / sp.bandwidth_bytes_per_ns
                            self._record_reads(now, node, np.atleast_1d(lat), local=1,
                                               remote=0, missed=0, bypass=0,
                                               stall=max(lat - ideal, 0.0))
                        else:
                            self._record_reads(now, node, np.atleast_1d(lat), local=0, remote=1,
                                               missed=0, bypass=1 if bypass else 0,
                                               stall=max(lat - self._remote_ideal(
                                                   node, src, res_bytes), 0.0))
                    else:
                        rec[2] = True
                        self._record_writes(now, node, np.atleast_1d(lats[-1]), pages=1, nbytes=nbytes)
                    self._note_finish(rid, fin)
        self._observe(touched, now)
        # Causal order within a timestamp: appends land before attention reads them.
        ordered = sorted(local_batches.items(),
                         key=lambda t: (0 if t[0][1] == "write" else 1, t[0][2], t[0][0]))
        for (nid, kind, nbytes), items in ordered:
            nd = self.nodes[nid]
            sp = nd.spec.local
            lats, fin = nd.local.access(now, len(items), nbytes, write=(kind == "write"))
            ideal = sp.latency_ns * sp.read_latency_factor + nbytes / sp.bandwidth_bytes_per_ns
            for o, lat in zip(items, lats):
                if kind == "read":
                    # Writes carry no stall: their queueing is visible in the
                    # write latency distribution instead.
                    self._record_reads(now, nd, np.atleast_1d(lat), local=1, remote=0,
                                       missed=0, bypass=0, stall=max(float(lat) - ideal, 0.0))
                else:
                    self._record_writes(now, nd, np.atleast_1d(lat), pages=1, nbytes=nbytes)
                self._note_finish(o["request_id"], now + float(lat))
        for node, pid, was_remote, rid in reads:
            pol = self._pol(node)
            if pol.prefetch_degree and (getattr(pol, "on_hit", True) or was_remote):
                self._prefetch_issue(node, pid, now, rid)

    def _remote_ideal(self, node, home, res_bytes):
        return (self._route_lat(node.id, home, False)
                + self._route_service(node.id, home, res_bytes))

    def _apply_edges(self, upto):
        """Apply fault-window edges in time order (bandwidth rescale at the
        edge's own timestamp keeps the fluid drain exact)."""
        while self._edge_idx < len(self._edges) and self._edges[self._edge_idx][0] <= upto:
            t, kind, payload = self._edges[self._edge_idx]
            self._edge_idx += 1
            if kind == "degrade_begin":
                self.fabric.rescale_link(payload["link"], payload["bandwidth_factor"], t)
                self._emit("link_degraded", t, None, None, link=payload["link"],
                           bandwidth_factor=payload["bandwidth_factor"],
                           latency_factor=payload["latency_factor"])
            elif kind == "degrade_end":
                self.fabric.rescale_link(payload["link"], 1.0, t)
                self._emit("link_restored", t, None, None, link=payload["link"])
            elif kind == "node_fail":
                self._emit("node_fail", t, None, payload["node"],
                           reason=payload["reason"], recovery_ns=payload["recovery_ns"])
            elif kind == "node_recover":
                self._emit("node_recover", t, None, payload["node"],
                           downtime_ns=payload["downtime_ns"])

    # ---------------------------------------------------------------- run ---
    def run(self):
        sc = self.sc
        for p in self.policies.values():
            p.reset()
        self._pending_completions = []
        try:
            self._emit("run_start", 0, scenario_hash=sc.hash, seed=sc.seed, version=__version__,
                       trace_sha256=self.trace.sha256)
            ops = [o for o in self.trace.ops if o["ts"] <= sc.duration_ns]
            self.dropped = len(self.trace.ops) - len(ops)
            next_sample = sc.sample_interval_ns
            i = 0
            while i < len(ops):
                ts = ops[i]["ts"]
                while next_sample <= ts and next_sample <= sc.duration_ns:
                    self._flush_completions(next_sample)
                    self._sample(next_sample)
                    next_sample += sc.sample_interval_ns
                j = i
                while j < len(ops) and ops[j]["ts"] == ts:
                    j += 1
                self.now = ts
                self._flush_completions(ts)
                self._apply_edges(ts)
                self._run_group(ts, ops[i:j])
                self.processed += j - i
                for o in ops[i:j]:
                    if o["request_id"] is not None and o["row"] == self.req_last_row.get(o["request_id"]):
                        self.req_done[o["request_id"]] = True
                i = j
            while next_sample <= sc.duration_ns:
                self._flush_completions(next_sample)
                self._sample(next_sample)
                next_sample += sc.sample_interval_ns
            end = sc.duration_ns
            for nd in self.nodes.values():
                nd.local.server.finish(end)
                nd.set_used(end, nd.used)
            for p in self.pools.values():
                p.set_used(end, p.used)
            if self.fabric:
                self.fabric.finish(end)
            self._flush_completions(math.inf)
            for _, nbytes in self.pref_outstanding.values():
                self.pref_wasted += nbytes
            self.pref_outstanding.clear()
            summary = self._summary()
            self._emit("run_end", end, events_processed=self.processed, virtual_time_ns=end,
                       status="completed")
            manifest = self._manifest(summary)
            if self.out_dir:
                self._write_bundle(summary, manifest)
            return summary, manifest
        finally:
            self.events.close()

    def _sample(self, now):
        c = self.m_all.c
        ops_n = c["reads"] + c["writes"]
        row = {"t_ns": int(now), "accesses": ops_n - self._last_sample["accesses"],
               "evictions": c["evictions"] - self._last_sample["evictions"],
               "completed": len(self.req_done) - self._last_sample["completed"],
               "degraded": self.faults.active_count(now) if self.faults else 0,
               "local_used_pages": {nid: nd.used for nid, nd in self.nodes.items()},
               "pool_used_pages": sum(p.used for p in self.pools.values()),
               "pools_used_pages": {pid: p.used for pid, p in self.pools.items()},
               "link_bytes": {}}
        self._last_sample = {"accesses": ops_n, "evictions": c["evictions"],
                             "completed": len(self.req_done)}
        if self.fabric:
            for lid in self.fabric.dir_bytes:
                total = sum(self.fabric.dir_bytes[lid].values())
                row["link_bytes"][lid] = total - self._last_link_bytes.get(lid, 0)
                self._last_link_bytes[lid] = total
        self.series.append(row)
        self._emit("sampling_tick", now, interval_ns=self.sc.sample_interval_ns)

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

        def busy(s):
            return max(0.0, s.busy_ns - max(0.0, s.free_at - end_t))

        links = {}
        if self.fabric:
            for lid, d in self.fabric.links.items():
                l = sc.links[lid]
                uniq = list({id(s): s for s in d.values()}.values())
                busy_total = sum(busy(s) for s in uniq)
                cap_ns = sc.duration_ns * len(uniq)
                compute_ends = [e for e in (l.frm, l.to) if e in self.nodes]
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
        for nid, nd in self.nodes.items():
            nc = nd.m_ss.c
            nn = nc["reads"] or 1
            mem[nid] = {
                "capacity_pages": nd.cap, "peak_used_pages": nd.peak,
                "final_used_pages": nd.used,
                "evicted_pages": nd.evicted_pages,
                "installed_pages": nd.installed_pages,
                "bandwidth_utilization": busy(nd.local.server) / sc.duration_ns,
                "max_queue_bytes": nd.local.server.q_max,
                "reads": nc["reads"], "local_hits": nc["read_local"],
                "remote_hits": nc["read_remote"],
                "local_hit_ratio": nc["read_local"] / nn,
                "remote_hit_ratio": nc["read_remote"] / nn,
                "stall_ns": nc["stall_ns"],
                "writes": nc["writes"], "write_bytes": nc["write_bytes"],
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
        lats = sorted(self.req_finish[r] - self.req_first[r] for r in self.req_done)
        req_hist = Histogram()
        if lats:
            req_hist.add(np.asarray(lats))
        rl = req_hist.stats(pct)
        cost = None
        cm = sc.cost_model
        if cm:
            tot_ns = sum(nd.occ_ns for nd in self.nodes.values()) * self.page
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
        s = {
            "schema": "rmemfab.summary/0.1", "rmemfab_version": __version__, "scenario": sc.name,
            "scenario_hash": sc.hash, "seed": sc.seed, "run_id": self.run_id,
            "workload_label": "trace",
            "policy": {"requested": sc.policy_requested, "effective": sc.policy_effective,
                       "version": next(iter(self.policies.values())).version,
                       "fallback_reason": sc.fallback_reason,
                       "instances": "per compute node (independent state)"},
            "events_processed": self.processed,
            "time": {"virtual_time_ns": sc.duration_ns, "warmup_ns": sc.warmup_ns, "steady_window_ns": steady},
            "requests": {"arrived": len(self.req_first), "completed": len(self.req_done),
                         "rejected": 0, "reject_reasons": {},
                         "in_flight_at_end": len(self.req_first) - len(self.req_done),
                         "queued_at_end": 0, "latency_ns": rl, "latency_all_ns": rl,
                         "completed_steady": len(self.req_done),
                         "throughput_per_s": len(self.req_done) / (steady / 1e9),
                         "tokens_per_s": 0},
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
                       "total_incl_warmup": allc["writes"]},
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
            "workload": {"page_size_bytes": self.page, "geometry_source": "trace"},
            "trace": {"path": self.trace.path, "sha256": self.trace.sha256,
                      "source": self.trace.header.get("source"), "model": self.trace.header.get("model"),
                      "runtime": self.trace.header.get("runtime"),
                      "unit_bytes": self.trace.unit_bytes,
                      "ops": self.trace.report["stats"]["ops"], "pages": self.trace.report["stats"]["pages"],
                      "trace_requests": self.trace.report["stats"]["requests"],
                      "dropped_beyond_duration": self.dropped,
                      "normalization": self.trace.report["normalization"],
                      "validation_warnings": self.trace.report["warnings"]},
            "series_points": len(self.series),
            "degraded": {"windows": self.faults.windows() if self.faults else [],
                         "stalled_requests": 0,
                         **(self.faults.counters() if self.faults
                            else FaultModel.zero_counters())},
        }
        return roundf(s)

    def _remote_bytes(self, direction):
        if not self.fabric:
            return 0
        return self.fabric.endpoint_bytes[direction]

    def _manifest(self, summary):
        sc = self.sc
        notes = ["Fabric: links, pools, and switches are FIFO byte servers; transfers "
                 "occupy every hop on their static route plus the destination tier.",
                 "Replay: ops execute in (ts_ns, file order); same-timestamp ops batch by (kind, bytes).",
                 "Observed placement (migrate/prefetch/evict rows, tier hints) is never replayed as "
                 "directives; the configured policy recomputes all placement.",
                 "Capacity overcommit halts replay with the first offending row (no silent divergence).",
                 "Prefetch (when enabled) follows trailing-integer stride, shares demand fabric, and "
                 "reports accuracy = touched-after-issue / issued (strictly later timestamps).",
                 "Multi-page reservations place atomically (all local or all on one remote tier).",
                 "Clean evictions transfer 0 bytes; only dirty pages write back.",
                 "Ops with an explicit node run there; ops without one follow their "
                 "request's round-robin shard. Placement is single-owner N-tier: "
                 "non-owners read through without moving the page; there is no "
                 "replication and no coherence protocol."]
        if self.faults is not None:
            notes.append("Faults: degradation rescales link bandwidth exactly at window edges; "
                         "transfers issued inside a window use degraded latency.")
            notes.append("Loss: reliable-transport persistence with RTO = 2x path fixed latency, "
                         "at most 8 simulated draws per transfer; retries are computed "
                         "synchronously at issue (no interleaved traffic in the RTO gap).")
            notes.append("An op whose executing node is down halts replay with the offending row "
                         "(no silent divergence). Policies are fault-oblivious.")
        return {
            "rmemfab_version": __version__, "schema_version": "0.1", "scenario_name": sc.name,
            "scenario_hash": sc.hash, "seed": sc.seed, "run_id": self.run_id,
            "stream_seeds": stream_seeds(sc.seed),
            "trace_hashes": [self.trace.sha256], "workload_label": "trace",
            "percentile_method": PERCENTILE_METHOD,
            "policy": {"requested": sc.policy_requested, "effective": sc.policy_effective,
                       "version": next(iter(self.policies.values())).version,
                       "fallback_reason": sc.fallback_reason,
                       "instances": "per compute node (independent state)"},
            "shared_pool_model": "shared_byte_server",
            "tiers": sorted(self.tier_ids),
            "routes": {f"{a}>{b}": [lid for lid, _ in r.links]
                       for (a, b), r in sorted(sc.routes.items())},
            "event_count": self.processed, "events_logged": self.events.count,
            "virtual_time_ns": sc.duration_ns, "warmup_ns": sc.warmup_ns, "status": "completed",
            "assumed_parameters": sc.assumed, "scenario_assumptions": sc.raw.get("assumptions", []),
            "warnings": sc.warnings, "limitations": notes,
            "outputs": {"scenario": "scenario.json", "summary": "summary.json", "series": "series.jsonl",
                        "events": "events.jsonl" if self.log else None},
            "host": {"python": platform.python_version(), "numpy": np.__version__, "platform": platform.system()},
        }

    def _write_bundle(self, summary, manifest):
        d = self.out_dir
        (d / "scenario.json").write_text(canonical(self.sc.raw) + "\n", encoding="utf-8")
        (d / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        (d / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        with open(d / "series.jsonl", "w", encoding="utf-8", newline="\n") as f:
            for row in self.series:
                f.write(json.dumps(row, separators=(",", ":")) + "\n")
        a = summary["access"]
        (d / "README.md").write_text(
            f"# {self.sc.name}\n\nPolicy `{summary['policy']['effective']}`, seed {self.sc.seed}, trace "
            f"`{self.trace.sha256[:16]}`, workload label trace. Mean read latency {a['latency_ns']['mean']:,.1f} ns, "
            f"local-hit ratio {a['local_hit_ratio']:.4f} (reads only), "
            f"{summary['requests']['completed']} requests replayed. "
            "Caveat: parameters are assumptions unless their provenance says measured; treat results as relative.\n",
            encoding="utf-8")
