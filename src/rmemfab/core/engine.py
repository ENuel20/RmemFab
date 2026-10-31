"""Run lifecycle: workload -> scheduler -> memory/fabric -> policy -> telemetry."""
from __future__ import annotations

import json
import math
import platform
from pathlib import Path

import numpy as np

from .. import SCHEMA_VERSION, __version__
from ..config.scenario import Scenario, canonical_json
from ..memory.fabric import Fabric, LocalTier
from ..policies import create_policy
from ..policies.base import (AccessContext, EvictToRemote, FetchInstall, PressureContext, Reject)
from ..telemetry.hist import Histogram
from ..telemetry.summary import canonical, roundf
from ..telemetry.writers import JsonlWriter, NullWriter
from ..workloads.synthetic import ArrivalProcess, kv_bytes_per_token, pages_for
from .rng import make_rng, stream_seeds
from .scheduler import Scheduler

LOCAL, REMOTE = 0, 1
GIB = float(2 ** 30)


class Request:
    __slots__ = ("id", "idx", "node", "arrival", "tokens_done", "n_alloc", "where", "last", "status")

    def __init__(self, idx, node, arrival, max_pages):
        self.id = f"req-{idx}"
        self.idx = idx
        self.node = node
        self.arrival = arrival
        self.tokens_done = 0
        self.n_alloc = 0
        self.where = np.zeros(max_pages, dtype=np.int8)
        self.last = np.zeros(max_pages, dtype=np.int64)
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
        self.evicted_pages = 0
        self.installed_pages = 0
        self.occ_ns = 0.0  # page*ns integral
        self._occ_t = 0

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
        self.hist = Histogram()
        self.step_hist = Histogram()
        self.c = dict(accesses=0, reads=0, writes=0, remote_writes=0, local_hits=0, remote_hits=0,
                      bypass_reads=0, misses=0, stall_ns=0.0, installs=0, evictions=0)

    def record(self, lats, *, stall, step, writes, local, remote, bypass, rwrites=0):
        """local/remote count page READS only (ACCEPTANCE hit-ratio definition); writes are separate."""
        self.hist.add(lats)
        if step is not None:
            self.step_hist.add_one(step)
        c = self.c
        c["accesses"] += int(lats.size)
        c["writes"] += writes
        c["remote_writes"] += rwrites
        c["reads"] += local + remote
        c["local_hits"] += local
        c["remote_hits"] += remote
        c["bypass_reads"] += bypass
        c["stall_ns"] += stall


class Engine:
    def __init__(self, sc: Scenario, out_dir=None, *, event_log=True):
        self.sc = sc
        self.page = sc.page_size
        self.kvtok = kv_bytes_per_token(sc.model)
        self.prompt = int(sc.requests["prompt_tokens"])
        self.gen = int(sc.requests["generated_tokens"])
        self.concurrency = int(sc.requests.get("concurrency", 1 << 30))
        self.max_pages = pages_for(self.prompt + self.gen, self.kvtok, self.page)
        self.sched = Scheduler()
        self.policy = create_policy(sc.policy_effective)
        self.arrivals = ArrivalProcess(make_rng(sc.seed, "workload"), float(sc.requests["arrival_rate_per_second"]))
        self.nodes = [NodeState(n, self.page) for n in sc.nodes]
        self.node_by_id = {n.id: n for n in self.nodes}
        self.pool = PoolState(sc.pool, self.page) if sc.pool else None
        self.fabric = Fabric(sc.links, sc.pool) if sc.pool and sc.links else None
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
        self.arrived = self.completed = self.rejected = 0
        self.completed_ss = 0
        self.tokens_ss = 0
        self.reject_reasons: dict = {}
        self.active_count = 0
        self.waiting: list = []
        self.migration_bytes = 0
        self.evict_bytes = 0
        self.install_bytes = 0
        self.link_xfers = 0
        self.spill_bytes = 0
        self.spilled_pages = 0
        self.page_allocations = 0
        self._mig = 0
        self._last_spill = (0, 0.0, None)
        if self.fabric:
            self.fabric.set_horizon(sc.duration_ns)
        for n in self.nodes:
            n.local.server.horizon = float(sc.duration_ns)
        self._last_sample = {"accesses": 0, "evictions": 0, "completed": 0}
        self._last_link_bytes = {}

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

    def _record(self, now, lats, **kw):
        self.m_all.record(lats, **kw)
        if now >= self.sc.warmup_ns:
            self.m_ss.record(lats, **kw)

    def _bump(self, now, key, n):
        self.m_all.c[key] += n
        if now >= self.sc.warmup_ns:
            self.m_ss.c[key] += n

    # --------------------------------------------------------- transfers ---
    def _xfer(self, now, node, direction, k, kind, request_id, pipelined=False):
        lats, finish, qd, flags = self.fabric.transfer(node.id, direction, now, k, self.page, pipelined)
        link = self.sc.links[node.id]
        nbytes = k * self.page
        end = int(math.ceil(finish))
        self._emit("transfer_begin", now, node.id, request_id, link=link.id, bytes=nbytes,
                   from_node=(self.sc.pool.id if direction == "in" else node.id),
                   to_node=(node.id if direction == "in" else self.sc.pool.id), kind=kind, pages=k)
        if flags[0]:
            ls = self.fabric.links[node.id][direction]
            self._emit("link_congested", now, node.id, request_id, link=link.id,
                       queue_bytes=int(ls.backlog_bytes(now)), utilization=1.0)
        self.sched.schedule(end, "xfer_done", (link.id, node.id, nbytes, end - int(now), qd, request_id))
        self.link_xfers += 1
        return lats, finish

    # ---------------------------------------------------------- eviction ---
    def _victims(self, node, need, protect, now):
        lasts, poss, idxs = [], [], []
        for pos, r in enumerate(node.active):
            n = r.n_alloc
            if not n:
                continue
            loc = np.nonzero(r.where[:n] == LOCAL)[0]
            if loc.size == 0:
                continue
            la = r.last[loc]
            if r is protect:
                keep = la != now
                loc, la = loc[keep], la[keep]
            if loc.size:
                lasts.append(la)
                poss.append(np.full(loc.size, pos, dtype=np.int64))
                idxs.append(loc)
        if not lasts:
            return []
        last, pos, idx = np.concatenate(lasts), np.concatenate(poss), np.concatenate(idxs)
        order = np.lexsort((idx, pos, last))[:need]
        pos_o, idx_o = pos[order], idx[order]
        out = []
        for p in np.unique(pos_o):
            out.append((node.active[int(p)], idx_o[pos_o == p]))
        return out

    def _migrate(self, now, node, request_id, frm, to, pages, fin):
        """page_migrate_begin now, page_migrate_end when the transfer completes (SPECS/events.md)."""
        self._mig += 1   # always scheduled: the event log must never change the simulation
        pid = f"{request_id}#m{self._mig}"
        nbytes = pages * self.page
        self._emit("page_migrate_begin", now, node.id, request_id, page_id=pid, from_tier=frm, to_tier=to,
                   bytes=nbytes, pages=pages)
        end = int(math.ceil(fin))
        self.sched.schedule(end, "migrate_end", (node.id, request_id, pid, frm, to, nbytes, end - int(now)))

    def _apply_evict(self, node, victims, now, request_id):
        total = 0
        for r, idx in victims:
            r.where[idx] = REMOTE
            total += int(idx.size)
        return total

    def _evict_pages(self, node, victims, now, request_id, cause):
        v = self._apply_evict(node, victims, now, request_id)
        if v:
            self.fabric_evict(node, v, now, request_id, cause)
        return v

    def fabric_evict(self, node, v, now, request_id, cause):
        node.local.background(now, v * self.page)          # write-back reads the pages out of local DRAM
        _, fin = self._xfer(now, node, "out", v, "evict_writeback", request_id, pipelined=True)
        self._migrate(now, node, request_id, "local", "remote", v, fin)
        self.evict_bytes += v * self.page
        self.migration_bytes += v * self.page
        node.evicted_pages += v
        self._bump(now, "evictions", v)
        self._emit("page_evict", now, node.id, request_id, tier="local", to_tier="remote", pages=v,
                   bytes=v * self.page, dirty=True, cause=cause)

    # --------------------------------------------------------- allocation ---
    def _alloc(self, r, count, now, charge_spill=True):
        """Allocate `count` KV pages for r.

        If local DRAM cannot hold them even after evicting every other request's
        pages, the policy may still place the overflow directly in the remote pool
        (`spill`): a request larger than local memory is a legitimate workload, not
        an error. local_only has no pool, so it still rejects.
        """
        node = r.node
        free = max(node.cap - node.used, 0)
        need = count - free
        spill = 0
        spill_lats, spill_fin = None, float(now)
        if need > 0:
            ctx = PressureContext(int(now), node.id, need, free,
                                  (self.pool.cap - self.pool.used) if self.pool else 0)
            d = self.policy.on_pressure(ctx)
            self._emit("policy_pressure", now, node.id, r.id, policy=self.policy.name, tier="local",
                       occupancy_bytes=node.used * self.page, capacity_bytes=node.cap * self.page)
            if isinstance(d, Reject):
                return False, d.reason
            if isinstance(d, EvictToRemote):
                vict = self._victims(node, need, r, now)
                avail = sum(int(i.size) for _, i in vict)
                spill = need - avail
                if need > self.pool.cap - self.pool.used:
                    return False, "remote pool full"
                v = self._apply_evict(node, vict, now, r.id)
                self.pool.set_used(now, self.pool.used + v + spill)
                node.set_used(now, node.used - v)
                if v:
                    self.fabric_evict(node, v, now, r.id, "allocation_pressure")
        a, b = r.n_alloc, r.n_alloc + count
        r.where[a:b] = LOCAL
        if spill:
            r.where[b - spill:b] = REMOTE
        r.last[a:b] = now
        r.n_alloc = b
        node.set_used(now, node.used + count - spill)
        self.page_allocations += count
        self._emit("page_allocate", now, node.id, r.id, pages=count, bytes=count * self.page, tier="local",
                   owner=r.id, pages_spilled_remote=spill)
        if spill:
            self.spill_bytes += spill * self.page
            self.spilled_pages += spill
            self._emit("page_spill", now, node.id, r.id, pages=spill, bytes=spill * self.page, tier="remote")
            if charge_spill:
                spill_lats, spill_fin = self._xfer(now, node, "out", spill, "spill_write", r.id, pipelined=True)
        self._last_spill = (spill, spill_fin, spill_lats)
        return True, None

    def _free(self, r, now):
        n = r.n_alloc
        loc = int((r.where[:n] == LOCAL).sum())
        rem = n - loc
        r.node.set_used(now, r.node.used - loc)
        if rem and self.pool:
            self.pool.set_used(now, self.pool.used - rem)
        r.n_alloc = 0
        if n:
            self._emit("page_free", now, r.node.id, r.id, pages=n, bytes=n * self.page)

    # ----------------------------------------------------------- lifecycle ---
    def _admit_or_queue(self, r, now):
        if self.active_count < self.concurrency:
            self._start(r, now)
        else:
            self.waiting.append(r)

    def _start(self, r, now):
        self.active_count += 1
        r.node.active.append(r)
        npages = pages_for(self.prompt, self.kvtok, self.page)
        self._emit("prefill_begin", now, r.node.id, r.id, tokens=self.prompt)
        if npages:
            ok, why = self._alloc(r, npages, now)
            if not ok:
                self._reject(r, now, why)
                return
            spill, sfin, slats = self._last_spill
            local_n = npages - spill
            sp = r.node.spec.local
            base = sp.latency_ns * sp.write_latency_factor + self.page / sp.bandwidth_bytes_per_ns
            parts, fin, stall = [], float(now), 0.0
            if local_n:
                lats, fin = r.node.local.access(now, local_n, self.page, write=True)
                parts.append(lats)
                stall = max(fin - now - local_n * base, 0.0)
            if spill:
                parts.append(slats)
                fin = max(fin, sfin)
            self._record(now, np.concatenate(parts) if len(parts) > 1 else parts[0], stall=stall, step=None,
                         writes=npages, local=0, remote=0, bypass=0, rwrites=spill)
        else:
            fin = float(now)
        self.sched.schedule(int(math.ceil(fin)), "prefill_end", (r, int(now)))

    def _reject(self, r, now, why):
        r.status = "rejected"
        self.rejected += 1
        self.reject_reasons[why] = self.reject_reasons.get(why, 0) + 1
        self._emit("request_rejected", now, r.node.id, r.id, reason=why)
        self._finish_common(r, now)

    def _finish_common(self, r, now):
        self._free(r, now)
        if r in r.node.active:
            r.node.active.remove(r)
        self.active_count -= 1
        while self.waiting and self.active_count < self.concurrency:
            self._start(self.waiting.pop(0), now)

    def _decode(self, r, now):
        node = r.node
        sp = node.spec.local
        # 1. KV growth for this token
        need_pages = pages_for(self.prompt + r.tokens_done + 1, self.kvtok, self.page)
        if need_pages > r.n_alloc:
            ok, why = self._alloc(r, need_pages - r.n_alloc, now, charge_spill=False)
            if not ok:
                self._reject(r, now, why)
                return
        n = r.n_alloc
        lat_parts = []
        # 2. append the new token's KV (one write)
        rwr = 0
        if r.where[n - 1] == LOCAL:
            wl, fin_w = node.local.access(now, 1, self.kvtok, write=True)
        else:  # the page holding the newest token lives in the pool: the append crosses the fabric
            wl, fin_w = self._xfer(now, node, "out", 1, "remote_append", r.id)
            rwr = 1
        lat_parts.append(wl)
        finish = fin_w
        # 3. attention reads every KV page of this request
        w = r.where[:n]
        loc_mask = w == LOCAL
        k_l = int(loc_mask.sum())
        remote_idx = np.nonzero(~loc_mask)[0]
        k_r = int(remote_idx.size)
        read_base = sp.latency_ns * sp.read_latency_factor + self.page / sp.bandwidth_bytes_per_ns
        if k_l:
            r.last[:n][loc_mask] = now
            ll, fin_l = node.local.access(now, k_l, self.page, write=False)
            lat_parts.append(ll)
            finish = max(finish, fin_l)
        bypass = 0
        if k_r:
            d = self.policy.on_remote_access(AccessContext(int(now), node.id, r.id, k_r))
            install = 0
            vict_n = 0
            inst = None
            if isinstance(d, FetchInstall):
                free = node.cap - node.used
                need = k_r - free
                vict = self._victims(node, need, r, now) if need > 0 else []
                avail = sum(int(i.size) for _, i in vict)
                if need > 0 and avail > need:  # trim to exactly what is needed
                    vict = self._trim(vict, need)
                    avail = need
                vict_n = avail if need > 0 else 0
                install = min(k_r, free + vict_n)
            rl_, fin_r = self._xfer(now, node, "in", k_r, "demand_fetch", r.id)
            lat_parts.append(rl_)
            finish = max(finish, fin_r)
            self._emit("page_miss", now, node.id, r.id, requested_tier="local", found_tier="remote", pages=k_r)
            if vict_n:
                self._apply_evict(node, vict, now, r.id)
            if install:
                inst = remote_idx[:install]
                r.where[inst] = LOCAL
                r.last[inst] = now
                node.set_used(now, node.used - vict_n + install)
                node.installed_pages += install
                self.install_bytes += install * self.page
                self.migration_bytes += install * self.page
                node.local.background(now, install * self.page)   # installed pages are written into local DRAM
                self._bump(now, "installs", install)
                self._migrate(now, node, r.id, "remote", "local", install, fin_r)
            if install or vict_n:
                self.pool.set_used(now, self.pool.used + vict_n - install)
            if vict_n:
                self.fabric_evict(node, vict_n, now, r.id, "fetch_install")
            bypass = k_r - install
        lats = np.concatenate(lat_parts) if len(lat_parts) > 1 else lat_parts[0]
        write_base = sp.latency_ns * sp.write_latency_factor + self.kvtok / sp.bandwidth_bytes_per_ns
        ideal = write_base + n * read_base          # every page a local hit on an idle tier
        step_ns = finish - now
        self._record(now, lats, stall=max(step_ns - ideal, 0.0), step=step_ns,
                     writes=1, local=k_l, remote=k_r, bypass=bypass, rwrites=rwr)
        self._emit("decode_step", now, node.id, r.id, token_index=r.tokens_done, pages=n,
                   pages_remote=k_r, step_ns=int(math.ceil(finish)) - int(now))
        r.tokens_done += 1
        end = int(math.ceil(finish))
        if r.tokens_done < self.gen:
            self.sched.schedule(end, "decode", r)
        else:
            self.sched.schedule(end, "complete", r)

    @staticmethod
    def _trim(vict, need):
        out, left = [], need
        for r, idx in vict:
            if left <= 0:
                break
            take = idx[:left]
            out.append((r, take))
            left -= int(take.size)
        return out

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
            if now >= self.sc.warmup_ns:
                self.completed_ss += 1
                self.tokens_ss += self.gen
                self.req_hist.add_one(float(lat))
            self._emit("request_complete", now, r.node.id, r.id, tokens_generated=self.gen, latency_ns=lat)
            self._finish_common(r, now)
        elif kind == "xfer_done":
            link, node, nbytes, dur, qd, rid = data
            self._emit("transfer_complete", now, node, rid, link=link, bytes=nbytes, duration_ns=dur,
                       queue_delay_ns=int(qd))
        elif kind == "migrate_end":
            nid, rid, pid, frm, to, nbytes, dur = data
            self._emit("page_migrate_end", now, nid, rid, page_id=pid, from_tier=frm, to_tier=to,
                       bytes=nbytes, duration_ns=dur)
        elif kind == "sample":
            self._sample(now)

    def _sample(self, now):
        c = self.m_all.c
        row = {"t_ns": int(now), "accesses": c["accesses"] - self._last_sample["accesses"],
               "evictions": c["evictions"] - self._last_sample["evictions"],
               "completed": self.completed - self._last_sample["completed"],
               "local_used_pages": {n.id: n.used for n in self.nodes},
               "pool_used_pages": self.pool.used if self.pool else 0, "link_bytes": {}}
        self._last_sample = {"accesses": c["accesses"], "evictions": c["evictions"], "completed": self.completed}
        if self.fabric:
            for nid, d in self.fabric.links.items():
                total = sum(s.bytes for s in {id(s): s for s in d.values()}.values())
                row["link_bytes"][self.sc.links[nid].id] = total - self._last_link_bytes.get(nid, 0)
                self._last_link_bytes[nid] = total
        self.series.append(row)
        self._emit("sampling_tick", now, interval_ns=self.sc.sample_interval_ns)
        self._emit("metric_snapshot", now, window_ns=self.sc.sample_interval_ns, **{k: v for k, v in row.items() if k != "t_ns"})
        nxt = now + self.sc.sample_interval_ns
        if nxt <= self.sc.duration_ns:
            self.sched.schedule(nxt, "sample")

    # ---------------------------------------------------------------- run ---
    def run(self):
        sc = self.sc
        self._emit("run_start", 0, scenario_hash=sc.hash, seed=sc.seed, version=__version__)
        self.sched.schedule(self.arrivals.next_gap_ns(), "arrival")
        self.sched.schedule(sc.sample_interval_ns, "sample")
        self.sched.run(self._handle, sc.duration_ns)
        end = sc.duration_ns
        for n in self.nodes:
            n.local.server.finish(end)
            n.set_used(end, n.used)
        if self.pool:
            self.pool.set_used(end, self.pool.used)
        if self.fabric:
            self.fabric.finish(end)
        summary = self._summary()
        self._emit("run_end", end, events_processed=self.sched.processed, virtual_time_ns=end, status="completed")
        self.events.close()
        manifest = self._manifest(summary)
        if self.out_dir:
            self._write_bundle(summary, manifest)
        return summary, manifest

    # ------------------------------------------------------------ reports ---
    def _summary(self):
        sc = self.sc
        pct = sc.percentiles
        ss = self.m_ss
        steady = max(sc.duration_ns - sc.warmup_ns, 1)
        c = ss.c
        n = max(c["reads"], 1)   # hit ratios are fractions of page READ accesses
        end_t = sc.duration_ns

        def busy(s):  # service that actually ran inside the run window (exact; see Server.occupy)
            return s.busy_in

        links = {}
        if self.fabric:
            for nid, d in self.fabric.links.items():
                l = sc.links[nid]
                uniq = {id(s): s for s in d.values()}.values()
                busy_total = sum(busy(s) for s in uniq)
                cap_ns = sc.duration_ns * len(list(uniq))
                links[l.id] = {
                    "node": nid, "bytes_in": d["in"].bytes, "bytes_out": d["out"].bytes if d["out"] is not d["in"] else 0,
                    "busy_ns": busy_total, "utilization": busy_total / cap_ns if cap_ns else 0.0,
                    "max_queue_bytes": max(s.q_max for s in uniq),
                    "time_weighted_queue_bytes": sum(s.q_area for s in uniq) / sc.duration_ns,
                    "service_admitted_ns": sum(s.busy_ns for s in uniq),
                    "congested_events": sum(s.congested for s in uniq),
                    "backpressure_stall_ns": sum(s.stall_ns for s in uniq),
                    "queue_overflow_events": sum(s.overflow for s in uniq),
                }
        pool = None
        if self.pool:
            ps = self.fabric.pool if self.fabric else None
            pool = {"capacity_pages": self.pool.cap, "peak_used_pages": self.pool.peak,
                    "final_used_pages": self.pool.used,
                    "utilization": (busy(ps) / sc.duration_ns) if ps else 0.0,
                    "max_queue_bytes": ps.q_max if ps else 0,
                    "service_admitted_ns": ps.busy_ns if ps else 0.0,
                    "bytes_served": ps.bytes if ps else 0}
        mem = {n.id: {"capacity_pages": n.cap, "peak_used_pages": n.peak, "final_used_pages": n.used,
                      "evicted_pages": n.evicted_pages, "installed_pages": n.installed_pages,
                      "bandwidth_utilization": busy(n.local.server) / sc.duration_ns,
                      "max_queue_bytes": n.local.server.q_max} for n in self.nodes}
        rl = self.req_hist.stats(pct)
        cost = None
        cm = sc.cost_model
        if cm:
            tot_ns = sum(nd.occ_ns for nd in self.nodes) * self.page
            comp = {
                "capacity": cm.get("capacity_per_gib_second", 0.0) * (tot_ns + (self.pool.occ_ns * self.page if self.pool else 0.0)) / 1e9 / GIB,
                "transfer": cm.get("transfer_per_gib", 0.0) * sum(v["bytes_in"] + v["bytes_out"] for v in links.values()) / GIB,
                "migration": cm.get("migration_per_gib", 0.0) * self.migration_bytes / GIB,
            }
            cost = {"currency": cm.get("currency", "unit"), **comp, "total": sum(comp.values())}
        s = {
            "schema": "rmemfab.summary/0.1", "rmemfab_version": __version__, "scenario": sc.name,
            "scenario_hash": sc.hash, "seed": sc.seed, "run_id": self.run_id,
            "workload_label": "synthetic",
            "policy": {"requested": sc.policy_requested, "effective": sc.policy_effective,
                       "version": self.policy.version, "fallback_reason": sc.fallback_reason},
            "events_processed": self.sched.processed,
            "time": {"virtual_time_ns": sc.duration_ns, "warmup_ns": sc.warmup_ns, "steady_window_ns": steady},
            "requests": {"arrived": self.arrived, "completed": self.completed, "rejected": self.rejected,
                         "reject_reasons": dict(sorted(self.reject_reasons.items())),
                         "in_flight_at_end": self.active_count, "queued_at_end": len(self.waiting),
                         "latency_ns": rl, "completed_steady": self.completed_ss,
                         "throughput_per_s": self.completed_ss / (steady / 1e9),
                         "tokens_per_s": self.tokens_ss / (steady / 1e9)},
            "decode_step_latency_ns": ss.step_hist.stats(pct),
            "access": {"count": c["accesses"], "reads": c["reads"], "writes": c["writes"],
                       "remote_writes": c["remote_writes"], "page_allocations": self.page_allocations,
                       "ratio_denominator": "page read accesses", "latency_ns": ss.hist.stats(pct),
                       "local_hits": c["local_hits"], "remote_hits": c["remote_hits"],
                       "bypass_reads": c["bypass_reads"], "misses": c["misses"],
                       "local_hit_ratio": c["local_hits"] / n, "remote_hit_ratio": c["remote_hits"] / n,
                       "miss_ratio": c["misses"] / n, "stall_ns": c["stall_ns"],
                       "total_accesses_incl_warmup": self.m_all.c["accesses"],
                       "warmup": {"samples_all": self.m_all.c["accesses"], "samples_steady_state": c["accesses"],
                                  "samples_in_warmup": self.m_all.c["accesses"] - c["accesses"],
                                  "note": "equal all/steady counts mean no samples fell in the warmup window; the filter still ran"}},
            "traffic": {"remote_read_bytes": self._remote_bytes("in"),
                        "remote_write_bytes": self._remote_bytes("out"),
                        "migration_bytes": self.migration_bytes, "evict_bytes": self.evict_bytes,
                        "spill_bytes": self.spill_bytes, "spilled_pages": self.spilled_pages,
                        "transfer_granularity": "page", "transfer_bytes": self.page,
                        "install_bytes": self.install_bytes,
                        # fetches that installed the page locally (a policy decision) vs reads served in place
                        "remote_read_migration_bytes": self.install_bytes,
                        "remote_read_demand_bytes": max(0, self._remote_bytes("in") - self.install_bytes),
                        "evictions_dirty_by_construction": True,   # every evicted page/object was written, so evict == write-back
                        "prefetch_bytes": 0, "wasted_prefetch_bytes": 0},
            "links": links, "pool": pool, "memory": mem, "cost": cost,
            "workload": {"kv_bytes_per_token": self.kvtok,
                         "kv_formula": "2 * layers * kv_heads * head_dim * dtype_bytes",
                         "kv_bytes_per_request_at_full_context": self.kvtok * (self.prompt + self.gen),
                         "pages_per_request_max": self.max_pages, "page_size_bytes": self.page},
            "series_points": len(self.series),
        }
        return roundf(s)

    def _remote_bytes(self, direction):
        if not self.fabric:
            return 0
        return sum(d[direction].bytes for d in self.fabric.links.values())

    def _manifest(self, summary):
        sc = self.sc
        notes = ["Fabric: each compute->pool link is a FIFO byte server and the pool is a shared byte server "
                 "(aggregate pool service never exceeds pool bandwidth).",
                 "Requests larger than local DRAM spill their overflow pages to the pool (swap_remote only); "
                 "a spilled newest page makes each KV append a fabric write.",
                 "Closed-loop: the issuing request blocks until its transfer completes, so queue_depth_bytes "
                 "backpressure is inherent; excess is still reported as queue_overflow_events / backpressure_stall_ns.",
                 "Percentiles come from a log-bucket histogram (upper bucket edge, <=1% relative error, never under-reports)."]
        return {
            "rmemfab_version": __version__, "schema_version": SCHEMA_VERSION, "scenario_name": sc.name,
            "scenario_hash": sc.hash, "seed": sc.seed, "stream_seeds": stream_seeds(sc.seed),
            "trace_hashes": [], "workload_label": "synthetic",
            "policy": {"requested": sc.policy_requested, "effective": sc.policy_effective,
                       "version": self.policy.version, "fallback_reason": sc.fallback_reason},
            "shared_pool_model": "shared_byte_server",
            "percentile_method": "nearest_rank_log_bucket_upper_edge_1pct",
            "hit_ratio_denominator": "page_read_accesses",
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
            f"`{self.sc.hash[:16]}`, synthetic workload. Mean access latency {a['latency_ns']['mean']:,.1f} ns, "
            f"local-hit ratio {a['local_hit_ratio']:.4f}, {summary['requests']['completed']} requests completed. "
            "Caveat: parameters are assumptions unless their provenance says measured; treat results as relative.\n",
            encoding="utf-8")
