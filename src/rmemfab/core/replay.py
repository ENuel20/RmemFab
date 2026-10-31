"""Replay engine: executes a page-operation stream (trace or generator) against the memory model.

Residency unit is the *object* (one page_id; ceil(bytes/page) pages). Operations replay open-loop at
their recorded times: simulated latency never moves later operations (POLICIES.md, feedback loops).
"""
from __future__ import annotations

import hashlib
import json
import math
import platform
from collections import OrderedDict
from pathlib import Path

import numpy as np

from .. import SCHEMA_VERSION, __version__
from ..config.scenario import Scenario, canonical_json
from ..memory.fabric import Fabric
from ..policies import create_policy
from ..policies.base import AccessContext, EvictToRemote, FetchInstall, PressureContext, Reject
from ..telemetry.hist import Histogram
from ..telemetry.summary import roundf
from ..telemetry.writers import JsonlWriter, NullWriter
from .engine import GIB, Metrics, NodeState, PoolState
from .rng import stream_seeds
from .scheduler import Scheduler
from ..workloads.trace import seq_digest

DATA_OPS = ("read", "write")
IGNORED_OPS = ("migrate", "prefetch", "evict")  # what the recorded system did; our policy decides instead


class Obj:
    __slots__ = ("id", "pages", "node", "remote")

    def __init__(self, oid, pages, node):
        self.id, self.pages, self.node, self.remote = oid, pages, node, False


class ReplayEngine:
    def __init__(self, sc: Scenario, ops, *, trace_info=None, generator_info=None, label="synthetic",
                 total_records=None, out_dir=None, event_log=True, backpressure="stall"):
        self.sc, self.page = sc, sc.page_size
        self.it = iter(ops)
        self.trace_info, self.generator_info, self.label = trace_info, generator_info, label
        self.total_records = total_records
        self.sched = Scheduler()
        self.policy = create_policy(sc.policy_effective)
        self.nodes = [NodeState(n, self.page) for n in sc.nodes]
        for n in self.nodes:
            n.lru = OrderedDict()
        self.node_by_id = {n.id: n for n in self.nodes}
        self.node_map: dict = {}
        self.pool = PoolState(sc.pool, self.page) if sc.pool else None
        self.fabric = Fabric(sc.links, sc.pool) if sc.pool and sc.links else None
        self.objs: dict = {}
        self.failed: set = set()
        self.backpressure = backpressure     # "stall": a full link queue throttles the op stream; "report": count only
        self.slip_ns = 0.0                   # cumulative source stall injected by backpressure
        self.spill_bytes = self.spilled_objects = 0
        self.implicit_alloc_bytes = 0
        self.page_allocations = 0
        self.xfer_n = self.xfer_total = self.xfer_max = 0
        self._mig = 0
        if self.fabric:
            self.fabric.set_horizon(sc.duration_ns)
        for n in self.nodes:
            n.local.server.horizon = float(sc.duration_ns)
        self.run_id = f"{sc.hash[:12]}-s{sc.seed}-{sc.policy_effective}"
        self.out_dir = Path(out_dir) if out_dir else None
        want = event_log and sc.output.get("include_event_log", True) and self.out_dir is not None
        if self.out_dir:
            self.out_dir.mkdir(parents=True, exist_ok=True)
        self.events = JsonlWriter(self.out_dir / "events.jsonl") if want else NullWriter()
        self.log = want
        self._seq = 0
        self.m_all, self.m_ss = Metrics(), Metrics()
        self.op_hist = Histogram()
        self.series, self._last = [], {"accesses": 0, "evictions": 0}
        self._last_link_bytes: dict = {}
        self.ops_seen = 0
        self.executed = {k: 0 for k in ("alloc", "free", "read", "write")}
        self.ignored = {k: 0 for k in IGNORED_OPS}
        self.anomalies: dict = {}
        self.alloc_failed = 0
        self.fail_reasons: dict = {}
        self.exec_digest = hashlib.sha256()
        self.exec_entries = 0
        self.migration_bytes = self.evict_bytes = self.install_bytes = 0
        self.requests_seen: set = set()

    # ------------------------------------------------------------ helpers ---
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

    def _anom(self, key):
        self.anomalies[key] = self.anomalies.get(key, 0) + 1

    def _node(self, name):
        if name is None:
            return self.nodes[0]  # records without a node go to the first compute node (not listed in node_map)
        if name in self.node_by_id:
            return self.node_by_id[name]
        if name not in self.node_map:
            self.node_map[name] = self.nodes[len(self.node_map) % len(self.nodes)].id
        return self.node_by_id[self.node_map[name]]

    def _record(self, now, lats, **kw):
        self.m_all.record(lats, **kw)
        if now >= self.sc.warmup_ns:
            self.m_ss.record(lats, **kw)

    def _bump(self, now, key, n):
        self.m_all.c[key] += n
        if now >= self.sc.warmup_ns:
            self.m_ss.c[key] += n

    def _migrate(self, now, node, rid, frm, to, pages, fin):
        self._mig += 1   # always scheduled so the event log can never change the simulation
        pid = f"{rid or 'run'}#m{self._mig}"
        nbytes = pages * self.page
        self._emit("page_migrate_begin", now, node.id, rid, page_id=pid, from_tier=frm, to_tier=to, bytes=nbytes,
                   pages=pages)
        end = int(math.ceil(fin))
        self.sched.schedule(end, "migrate_end", (node.id, rid, pid, frm, to, nbytes, end - int(now)))

    def _xfer(self, now, node, direction, nbytes, kind, rid):
        bp = self.fabric.links[node.id][direction].backpressure_ns(now, nbytes)
        if bp > 0 and self.backpressure == "stall":
            self.slip_ns += bp          # the issuer blocks until the link queue has room (HARDWARE-MODELS D_l)
        self.xfer_n += 1
        self.xfer_total += nbytes
        self.xfer_max = max(self.xfer_max, nbytes)
        lats, finish, qd, flags = self.fabric.transfer(node.id, direction, now, 1, nbytes, True)
        link = self.sc.links[node.id]
        end = int(math.ceil(finish))
        self._emit("transfer_begin", now, node.id, rid, link=link.id, bytes=nbytes, kind=kind,
                   from_node=(self.sc.pool.id if direction == "in" else node.id),
                   to_node=(node.id if direction == "in" else self.sc.pool.id))
        if flags[0]:
            self._emit("link_congested", now, node.id, rid, link=link.id,
                       queue_bytes=int(self.fabric.links[node.id][direction].backlog_bytes(now)), utilization=1.0)
        self.sched.schedule(end, "xfer_done", (link.id, node.id, nbytes, end - int(now), qd, rid))
        return float(lats[0]), finish

    # ---------------------------------------------------------- capacity ---
    def _plan_room(self, node, pages, protect, now, credit=0):
        """Choose LRU victims to free `pages` local frames. Returns list, [] if nothing to do, None on failure."""
        free = node.cap - node.used
        short = pages - free
        if short <= 0:
            return []
        d = self.policy.on_pressure(PressureContext(int(now), node.id, short, free,
                                                    (self.pool.cap - self.pool.used + credit) if self.pool else 0))
        if isinstance(d, Reject):
            return None, d.reason
        got, victims = 0, []
        for oid, o in node.lru.items():
            if oid == protect:
                continue
            victims.append(o)
            got += o.pages
            if got >= short:
                break
        if got < short:
            return None, "no evictable objects"
        if self.pool.cap - self.pool.used + credit < got:
            return None, "remote pool exhausted"
        return victims

    def _apply_victims(self, node, victims, now, rid, cause):
        got = sum(o.pages for o in victims)
        for o in victims:
            del node.lru[o.id]
            o.remote = True
        node.set_used(now, node.used - got)
        self.pool.set_used(now, self.pool.used + got)
        node.local.background(now, got * self.page)   # write-back reads the pages out of local DRAM
        _, fin = self._xfer(now, node, "out", got * self.page, "evict_writeback", rid)
        self._migrate(now, node, rid, "local", "remote", got, fin)
        node.evicted_pages += got
        self.evict_bytes += got * self.page
        self.migration_bytes += got * self.page
        self._bump(now, "evictions", got)
        self._emit("page_evict", now, node.id, rid, tier="local", to_tier="remote", pages=got,
                   bytes=got * self.page, dirty=True, cause=cause, objects=len(victims))

    # --------------------------------------------------------------- ops ---
    def _alloc(self, oid, pages, node, now, rid, implicit=False):
        plan = self._plan_room(node, pages, None, now)
        if isinstance(plan, tuple) and plan[1] == "no evictable objects" and self.pool \
                and pages <= self.pool.cap - self.pool.used:
            return self._alloc_remote(oid, pages, node, now, rid, implicit)
        if isinstance(plan, tuple):
            self.alloc_failed += 1
            self.fail_reasons[plan[1]] = self.fail_reasons.get(plan[1], 0) + 1
            self.failed.add(oid)
            self._emit("alloc_failed", now, node.id, rid, page_id=oid, pages=pages, reason=plan[1])
            return None
        if plan:
            self._apply_victims(node, plan, now, rid, "allocation_pressure")
        o = Obj(oid, pages, node)
        self.objs[oid] = o
        node.lru[oid] = o
        node.set_used(now, node.used + pages)
        self.page_allocations += pages
        if implicit:
            self.implicit_alloc_bytes += pages * self.page
        self._emit("page_allocate", now, node.id, rid, page_id=oid, pages=pages, bytes=pages * self.page,
                   tier="local", owner=rid, implicit=implicit)
        return o

    def _alloc_remote(self, oid, pages, node, now, rid, implicit):
        """Object cannot fit in local DRAM even with everything else evicted: place it in the pool."""
        o = Obj(oid, pages, node)
        o.remote = True
        self.objs[oid] = o
        self.pool.set_used(now, self.pool.used + pages)
        self.page_allocations += pages
        self.spill_bytes += pages * self.page
        self.spilled_objects += 1
        if implicit:
            self.implicit_alloc_bytes += pages * self.page
        self._emit("page_allocate", now, node.id, rid, page_id=oid, pages=pages, bytes=pages * self.page,
                   tier="remote", owner=rid, implicit=implicit, spilled=True)
        self._xfer(now, node, "out", pages * self.page, "spill_write", rid)
        return o

    def _free(self, o, now, rid):
        if o.remote:
            self.pool.set_used(now, self.pool.used - o.pages)
        else:
            o.node.set_used(now, o.node.used - o.pages)
            del o.node.lru[o.id]
        del self.objs[o.id]
        self._emit("page_free", now, o.node.id, rid, page_id=o.id, tier="remote" if o.remote else "local",
                   bytes=o.pages * self.page)

    def _access(self, o, nb, write, now, rid):
        node, page, sp = o.node, self.page, o.node.spec.local
        q = max(1, min(o.pages, nb // page))
        lat_f = sp.write_latency_factor if write else sp.read_latency_factor
        one = sp.latency_ns * lat_f + page / sp.bandwidth_bytes_per_ns
        rem = bypass = 0
        if not o.remote:
            lats, fin = node.local.access(now, q, page, write)
            node.lru.move_to_end(o.id)
            tier = "local"
        else:
            tier = "remote"
            rem = q
            d = self.policy.on_remote_access(AccessContext(int(now), node.id, rid or "", q))
            plan = None
            if isinstance(d, FetchInstall):
                plan = self._plan_room(node, o.pages, o.id, now, credit=o.pages)
            if isinstance(plan, list):
                lat, fin = self._xfer(now, node, "in", o.pages * page, "demand_fetch", rid)
                self._migrate(now, node, rid, "remote", "local", o.pages, fin)
                node.local.background(now, o.pages * page)   # installed pages are written into local DRAM
                if plan:
                    self._apply_victims(node, plan, now, rid, "fetch_install")
                o.remote = False
                node.lru[o.id] = o
                node.set_used(now, node.used + o.pages)
                self.pool.set_used(now, self.pool.used - o.pages)
                node.installed_pages += o.pages
                self.install_bytes += o.pages * page
                self.migration_bytes += o.pages * page
                self._bump(now, "installs", o.pages)
            else:
                bypass = q
                lat, fin = self._xfer(now, node, "out" if write else "in", q * page, "remote_access", rid)
            lats = np.full(q, lat, dtype=np.float64)
            self._emit("page_miss", now, node.id, rid, page_id=o.id, requested_tier="local", found_tier="remote",
                       pages=q)
        ideal = q * one
        op_ns = fin - now
        # hit ratios count READS only (ACCEPTANCE); remote writes are tracked separately
        self._record(now, lats, stall=max(op_ns - ideal, 0.0), step=op_ns, writes=q if write else 0,
                     local=0 if write else q - rem, remote=0 if write else rem,
                     bypass=0 if write else bypass, rwrites=rem if write else 0)
        self._emit("page_access", now, node.id, rid, page_id=o.id, bytes=q * page, op="write" if write else "read",
                   tier=tier, latency_ns=int(op_ns))

    def _execute(self, op, now):
        ts, kind, pid, nb, node_name, rid = op
        self.ops_seen += 1
        if rid:
            self.requests_seen.add(rid)
        if kind in IGNORED_OPS:
            self.ignored[kind] += 1
            return
        node = self._node(node_name)
        if kind == "alloc":
            if pid in self.objs:
                self._anom("duplicate_alloc")
                return
            self.executed["alloc"] += 1
            self.exec_digest.update(f"alloc|{pid}|{nb}\n".encode())
            self.exec_entries += 1
            self._alloc(pid, nb // self.page, node, now, rid)
        elif kind == "free":
            o = self.objs.get(pid)
            if o is None:
                self._anom("skipped_failed_alloc" if pid in self.failed else "free_of_unknown_object")
                return
            self.executed["free"] += 1
            self.exec_digest.update(f"free|{pid}|{nb}\n".encode())
            self.exec_entries += 1
            self._free(o, now, rid)
        else:
            o = self.objs.get(pid)
            if o is None:
                if pid in self.failed:
                    self._anom("skipped_failed_alloc")
                    return
                self._anom("access_before_alloc")
                o = self._alloc(pid, nb // self.page, node, now, rid, implicit=True)
                if o is None:
                    return
            self.executed[kind] += 1
            self._access(o, nb, kind == "write", now, rid)

    # ----------------------------------------------------------- driver ---
    def _pump(self):
        op = next(self.it, None)
        if op is None:
            return
        t = op[0] + int(self.slip_ns)
        if t > self.sc.duration_ns:
            self.unissued_after_stall = True
            return
        self.sched.schedule(max(t, self.sched.now), "op", op)

    def _handle(self, kind, data, now, seq):
        if kind == "op":
            self._execute(data, now)
            self._pump()
        elif kind == "migrate_end":
            nid, rid, pid, frm, to, nbytes, dur = data
            self._emit("page_migrate_end", now, nid, rid, page_id=pid, from_tier=frm, to_tier=to,
                       bytes=nbytes, duration_ns=dur)
        elif kind == "xfer_done":
            link, node, nbytes, dur, qd, rid = data
            self._emit("transfer_complete", now, node, rid, link=link, bytes=nbytes, duration_ns=dur,
                       queue_delay_ns=int(qd))
        elif kind == "sample":
            self._sample(now)

    def _sample(self, now):
        c = self.m_all.c
        row = {"t_ns": int(now), "accesses": c["accesses"] - self._last["accesses"],
               "evictions": c["evictions"] - self._last["evictions"],
               "local_used_pages": {n.id: n.used for n in self.nodes},
               "pool_used_pages": self.pool.used if self.pool else 0, "link_bytes": {}}
        self._last = {"accesses": c["accesses"], "evictions": c["evictions"]}
        if self.fabric:
            for nid, d in self.fabric.links.items():
                total = sum(s.bytes for s in {id(s): s for s in d.values()}.values())
                row["link_bytes"][self.sc.links[nid].id] = total - self._last_link_bytes.get(nid, 0)
                self._last_link_bytes[nid] = total
        self.series.append(row)
        self._emit("sampling_tick", now, interval_ns=self.sc.sample_interval_ns)
        self._emit("metric_snapshot", now, window_ns=self.sc.sample_interval_ns,
                   **{k: v for k, v in row.items() if k != "t_ns"})
        if now + self.sc.sample_interval_ns <= self.sc.duration_ns:
            self.sched.schedule(now + self.sc.sample_interval_ns, "sample")

    def run(self):
        sc = self.sc
        self._emit("run_start", 0, scenario_hash=sc.hash, seed=sc.seed, version=__version__)
        self._pump()
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
        manifest = self._manifest()
        if self.out_dir:
            self._write_bundle(summary, manifest)
        return summary, manifest

    # ---------------------------------------------------------- reports ---
    def _summary(self):
        sc, ss = self.sc, self.m_ss
        pct = sc.percentiles
        steady = max(sc.duration_ns - sc.warmup_ns, 1)
        c, n = ss.c, max(ss.c["reads"], 1)   # hit ratios are fractions of page READ accesses
        end_t = sc.duration_ns

        def busy(s):  # service that actually ran inside the run window (exact; see Server.occupy)
            return s.busy_in

        links = {}
        if self.fabric:
            for nid, d in self.fabric.links.items():
                uniq = list({id(s): s for s in d.values()}.values())
                bt = sum(busy(s) for s in uniq)
                links[sc.links[nid].id] = {
                    "node": nid, "bytes_in": d["in"].bytes, "bytes_out": d["out"].bytes if d["out"] is not d["in"] else 0,
                    "busy_ns": bt, "utilization": bt / (end_t * len(uniq)),
                    "max_queue_bytes": max(s.q_max for s in uniq),
                    "time_weighted_queue_bytes": sum(s.q_area for s in uniq) / end_t,
                    "service_admitted_ns": sum(s.busy_ns for s in uniq),
                    "congested_events": sum(s.congested for s in uniq),
                    "queue_overflow_events": sum(s.overflow for s in uniq),
                    "backpressure_stall_ns": sum(s.stall_ns for s in uniq)}
        pool = None
        if self.pool:
            ps = self.fabric.pool if self.fabric else None
            pool = {"capacity_pages": self.pool.cap, "peak_used_pages": self.pool.peak, "final_used_pages": self.pool.used,
                    "utilization": busy(ps) / end_t if ps else 0.0, "max_queue_bytes": ps.q_max if ps else 0,
                    "service_admitted_ns": ps.busy_ns if ps else 0.0, "bytes_served": ps.bytes if ps else 0}
        mem = {x.id: {"capacity_pages": x.cap, "peak_used_pages": x.peak, "final_used_pages": x.used,
                      "evicted_pages": x.evicted_pages, "installed_pages": x.installed_pages,
                      "bandwidth_utilization": busy(x.local.server) / end_t, "max_queue_bytes": x.local.server.q_max}
               for x in self.nodes}
        cost = None
        cm = sc.cost_model
        if cm:
            occ = (sum(x.occ_ns for x in self.nodes) + (self.pool.occ_ns if self.pool else 0.0)) * self.page
            comp = {"capacity": cm.get("capacity_per_gib_second", 0.0) * occ / 1e9 / GIB,
                    "transfer": cm.get("transfer_per_gib", 0.0) * sum(v["bytes_in"] + v["bytes_out"] for v in links.values()) / GIB,
                    "migration": cm.get("migration_per_gib", 0.0) * self.migration_bytes / GIB}
            cost = {"currency": cm.get("currency", "unit"), **comp, "total": sum(comp.values())}
        recorded = (self.trace_info or {}).get("recorded_alloc_free_sha256")
        executed = self.exec_digest.hexdigest()
        replay = {"executed_alloc_free_sha256": executed, "executed_alloc_free_records": self.exec_entries,
                  "backpressure": {"mode": self.backpressure, "source_slip_ns": int(self.slip_ns),
                                   "ops_unissued_due_to_stall": bool(getattr(self, "unissued_after_stall", False))}}
        if recorded is not None:
            total_af = sum(self.trace_info["ops"][k] for k in ("alloc", "free"))
            complete = self.exec_entries == total_af
            replay.update(recorded_alloc_free_sha256=recorded, recorded_alloc_free_records=total_af,
                          complete=complete, sequence_matches=(complete and recorded == executed
                                                              and not self.anomalies and not self.alloc_failed))
        total_ops = self.total_records if self.total_records is not None else self.ops_seen
        s = {
            "schema": "rmemfab.summary/0.1", "workload_kind": "replay", "rmemfab_version": __version__,
            "scenario": sc.name, "scenario_hash": sc.hash, "seed": sc.seed, "run_id": self.run_id,
            "workload_label": self.label,
            "policy": {"requested": sc.policy_requested, "effective": sc.policy_effective,
                       "version": self.policy.version, "fallback_reason": sc.fallback_reason},
            "events_processed": self.sched.processed,
            "time": {"virtual_time_ns": sc.duration_ns, "warmup_ns": sc.warmup_ns, "steady_window_ns": steady},
            "requests": {"distinct_request_ids": len(self.requests_seen)},
            "ops": {"total_in_source": total_ops, "executed": dict(self.executed), "ignored_recorded_ops": dict(self.ignored),
                    "after_end": max(total_ops - self.ops_seen, 0) if self.total_records is not None else None,
                    "anomalies": dict(sorted(self.anomalies.items())), "alloc_failed": self.alloc_failed, "implicit_alloc_bytes": self.implicit_alloc_bytes,
                    "alloc_fail_reasons": dict(sorted(self.fail_reasons.items()))},
            "op_latency_ns": ss.step_hist.stats(pct),
            "access": {"count": c["accesses"], "reads": c["reads"], "writes": c["writes"],
                       "remote_writes": c["remote_writes"], "page_allocations": self.page_allocations,
                       "ratio_denominator": "page read accesses", "latency_ns": ss.hist.stats(pct),
                       "local_hits": c["local_hits"], "remote_hits": c["remote_hits"], "bypass_reads": c["bypass_reads"],
                       "misses": c["misses"], "local_hit_ratio": c["local_hits"] / n, "remote_hit_ratio": c["remote_hits"] / n,
                       "miss_ratio": c["misses"] / n, "stall_ns": c["stall_ns"],
                       "total_accesses_incl_warmup": self.m_all.c["accesses"],
                       "warmup": {"samples_all": self.m_all.c["accesses"], "samples_steady_state": c["accesses"],
                                  "samples_in_warmup": self.m_all.c["accesses"] - c["accesses"],
                                  "note": "equal all/steady counts mean no samples fell in the warmup window; the filter still ran"}},
            "traffic": {"remote_read_bytes": sum(d["in"].bytes for d in self.fabric.links.values()) if self.fabric else 0,
                        "remote_write_bytes": sum(d["out"].bytes for d in self.fabric.links.values()) if self.fabric else 0,
                        "migration_bytes": self.migration_bytes, "evict_bytes": self.evict_bytes,
                        "spill_bytes": self.spill_bytes, "spilled_objects": self.spilled_objects,
                        "transfer_granularity": "object",
                        "transfer_bytes": {"count": self.xfer_n, "mean": (self.xfer_total / self.xfer_n) if self.xfer_n else 0,
                                           "max": self.xfer_max, "page_size_bytes": self.page},
                        "install_bytes": self.install_bytes,
                        # fetches that installed the page locally (a policy decision) vs reads served in place
                        "remote_read_migration_bytes": self.install_bytes,
                        "remote_read_demand_bytes": max(0, (sum(d["in"].bytes for d in self.fabric.links.values()) if self.fabric else 0) - self.install_bytes),
                        "evictions_dirty_by_construction": True,   # every evicted page/object was written, so evict == write-back
                        "prefetch_bytes": 0, "wasted_prefetch_bytes": 0},
            "links": links, "pool": pool, "memory": mem, "cost": cost, "replay": replay,
            "workload": {"type": sc.workload_type, "profile": sc.profile, "page_size_bytes": self.page,
                         "live_objects_at_end": len(self.objs)},
            "series_points": len(self.series),
        }
        if self.trace_info:
            ti = self.trace_info
            s["workload"]["trace"] = {k: ti[k] for k in ("sha256", "records", "label", "page_normalization", "sorted",
                                                        "duration_ns", "time_scale")}
        if self.generator_info:
            s["workload"]["generator"] = self.generator_info
        return roundf(s)

    def _manifest(self):
        sc = self.sc
        gi = self.generator_info or {}
        return {
            "rmemfab_version": __version__, "schema_version": SCHEMA_VERSION, "scenario_name": sc.name,
            "scenario_hash": sc.hash, "seed": sc.seed, "stream_seeds": stream_seeds(sc.seed),
            "trace_hashes": ([{"path": self.trace_info["path"], "sha256": self.trace_info["sha256"],
                               "records": self.trace_info["records"], "label": self.trace_info["label"]}]
                             if self.trace_info else []),
            "workload_label": self.label, "label_note": (self.trace_info or {}).get("label_note"),
            "trace_header": (self.trace_info or {}).get("header"),
            "generator": gi or None, "defaulted_parameters": gi.get("defaulted_parameters", []),
            "node_map": dict(sorted(self.node_map.items())),
            "page_normalization": (self.trace_info or {}).get("page_normalization") or gi.get("page_normalization"),
            "policy": {"requested": sc.policy_requested, "effective": sc.policy_effective,
                       "version": self.policy.version, "fallback_reason": sc.fallback_reason},
            "replay_semantics": ("open-loop with backpressure: operations execute at their recorded/generated "
                                 "times; simulated latency does not delay later operations, but a link queue "
                                 "above queue_depth_bytes stalls the whole op stream until it has room"
                                 if self.backpressure == "stall" else
                                 "open-loop: operations execute at their recorded/generated times; simulated "
                                 "latency and queue depth never delay later operations (backpressure only reported)"),
            "backpressure": self.backpressure, "percentile_method": "nearest_rank_log_bucket_upper_edge_1pct",
            "hit_ratio_denominator": "page_read_accesses", "transfer_granularity": "object",
            "shared_pool_model": "shared_byte_server", "event_count": self.sched.processed,
            "events_logged": self.events.count, "virtual_time_ns": sc.duration_ns, "warmup_ns": sc.warmup_ns,
            "status": "completed", "assumed_parameters": sc.assumed, "scenario_assumptions": sc.raw.get("assumptions", []),
            "warnings": list(sc.warnings) + [w for w in ((self.trace_info or {}).get("label_note"),
                                                          (self.trace_info or {}).get("best_effort_warning")) if w],
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
            f"`{self.sc.hash[:16]}`, workload label **{self.label}**. Mean access latency "
            f"{a['latency_ns']['mean']:,.1f} ns, local-hit ratio {a['local_hit_ratio']:.4f}. Replay is open-loop. "
            "Caveat: parameters are assumptions unless their provenance says measured.\n", encoding="utf-8")
