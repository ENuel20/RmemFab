"""N-tier single-owner placement over the routed link graph.

Routing (static shortest path, deterministic ties), multi-pool spill choice,
peer migration with foreign-first eviction, non-owner read-through, the
policy choose_tier hook, per-tier accounting identities, and determinism.
"""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from support import load_example, write_tmp_scenario
from rmemfab.config.scenario import ScenarioError, build_scenario, load_raw, validate
from rmemfab.core.engine import Engine
from rmemfab.trace.replay import ReplayDivergence, ReplayEngine

UNIT = 4096
HEADER = {"type": "header", "trace_version": "0.1", "source": "test"}


def base_raw():
    raw = load_example("phase1-overflow.json")
    raw["name"] = "ntier-test"
    raw["page_size_bytes"] = UNIT
    raw["duration_ns"] = 500_000_000
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["metrics"]["sample_interval_ns"] = 500_000_000
    raw["workload"]["requests"]["arrival_rate_per_second"] = 10.0
    raw["workload"]["requests"]["prompt_tokens"] = 64
    raw["workload"]["requests"]["generated_tokens"] = 4
    raw["policy"] = {"name": "swap_remote"}
    raw["output"] = {"format": "jsonl", "include_event_log": False}
    return raw


def compute(base, nid, local_pages):
    n = copy.deepcopy(base)
    n["id"] = nid
    n["local_memory"]["capacity_bytes"] = local_pages * UNIT
    return n


def pool(base, pid, pool_pages, lat=180, bw=48):
    p = copy.deepcopy(base)
    p["id"] = pid
    p["remote_memory"]["capacity_bytes"] = pool_pages * UNIT
    p["remote_memory"]["latency_ns"] = lat
    p["remote_memory"]["bandwidth_bytes_per_ns"] = bw
    return p


def link(lid, frm, to, bw=48, lat=180):
    return {"id": lid, "from": frm, "to": to, "latency_ns": lat,
            "bandwidth_bytes_per_ns": bw, "bidirectional": True}


def run_synth(path, outdir):
    sc = build_scenario(load_raw(path))
    return Engine(sc, outdir, event_log=False).run()


def run_replay(path, outdir):
    sc = build_scenario(load_raw(path), base_dir=str(Path(path).parent))
    return ReplayEngine(sc, sc.trace, outdir, event_log=False).run()


def canonical_bytes(summary):
    return json.dumps(summary, sort_keys=True).encode()


def two_pool_raw(near_pages=1 << 30):
    raw = base_raw()
    n0 = compute(raw["nodes"][0], "node-0", 64)
    pn = pool(raw["nodes"][1], "pool-near", near_pages, lat=180)
    pf = pool(raw["nodes"][1], "pool-far", 1 << 30, lat=900)
    raw["nodes"] = [n0, pn, pf]
    raw["fabric"]["links"] = [link("l-near", "node-0", "pool-near", 48, 50),
                              link("l-far", "node-0", "pool-far", 48, 400)]
    return raw


def op(ts, op, page, req, nbytes=UNIT, node=None):
    r = {"ts_ns": ts, "op": op, "page_id": page, "request_id": req, "bytes": nbytes}
    if node is not None:
        r["node"] = node
    return r


def peer_only_replay_paths(td):
    trace_path = str(Path(td) / "trace.jsonl")
    rows = [op(100, "alloc", "a", "r0", node="node-0"),
            op(200, "alloc", "b", "r0", node="node-0"),
            op(250, "alloc", "f", "r0", node="node-0"),   # node-0 full: a+b+f
            op(300, "alloc", "c", "r0", node="node-0"),   # evicts a -> node-1
            op(400, "alloc", "d", "r1", node="node-1"),   # node-1 full: a + d
            op(450, "free", "f", "r0", node="node-0"),    # room for a's return
            op(500, "alloc", "e", "r1", node="node-1"),   # evicts a -> node-0
            op(600, "read", "a", "r0", node="node-0"),    # parked: local, no fabric
            op(700, "read", "b", "r1", node="node-1"),    # non-owner fetch 1
            op(800, "read", "b", "r1", node="node-1"),    # non-owner fetch 2
            op(900, "free", "e", "r1", node="node-1")]
    Path(trace_path).write_text(
        "\n".join([json.dumps(HEADER)] + [json.dumps(r) for r in rows]) + "\n",
        encoding="utf-8")
    raw = load_example("phase1-overflow.json")
    raw["name"] = "ntier-replay-test"
    raw["page_size_bytes"] = UNIT
    raw["duration_ns"] = 10_000_000_000
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["metrics"]["sample_interval_ns"] = 1_000_000_000
    raw["nodes"] = [compute(raw["nodes"][0], "node-0", 3),
                    compute(raw["nodes"][0], "node-1", 2)]
    raw["fabric"]["links"] = [link("l-peer", "node-0", "node-1", 48, 10)]
    raw["fabric"].pop("switch", None)
    raw["policy"] = {"name": "swap_remote"}
    raw["workload"] = {"type": "trace", "path": trace_path}
    raw["output"] = {"format": "jsonl", "include_event_log": False}
    scen_path = str(Path(td) / "scen.json")
    Path(scen_path).write_text(json.dumps(raw), encoding="utf-8")
    return scen_path


def spine_leaf_raw():
    raw = base_raw()
    n0 = compute(raw["nodes"][0], "node-0", 64)
    n1 = compute(raw["nodes"][0], "node-1", 64)
    pa = pool(raw["nodes"][1], "pool-a", 1024)
    pb = pool(raw["nodes"][1], "pool-b", 1024)
    raw["nodes"] = [n0, n1, pa, pb]
    raw["fabric"].pop("switch", None)
    raw["fabric"]["switches"] = [
        {"id": "leaf-0", "bandwidth_bytes_per_ns": 100, "latency_ns": 20},
        {"id": "spine-0", "bandwidth_bytes_per_ns": 200, "latency_ns": 20}]
    raw["fabric"]["links"] = [link("n0-leaf", "node-0", "leaf-0", 48, 50),
                              link("n1-leaf", "node-1", "leaf-0", 48, 50),
                              link("leaf-spine", "leaf-0", "spine-0", 96, 100),
                              link("spine-pa", "spine-0", "pool-a", 48, 60),
                              link("leaf-pb", "leaf-0", "pool-b", 24, 60)]
    return raw


class StaticRouting(unittest.TestCase):
    def test_spine_leaf_shortest_paths(self):
        sc = build_scenario(spine_leaf_raw())
        r = sc.routes[("node-0", "pool-b")]
        self.assertEqual([l for l, _ in r.links], ["n0-leaf", "leaf-pb"])
        self.assertEqual(r.switches, ["leaf-0"])
        self.assertEqual(r.hops, 2)
        r = sc.routes[("node-0", "pool-a")]
        self.assertEqual([l for l, _ in r.links],
                         ["n0-leaf", "leaf-spine", "spine-pa"])
        self.assertEqual(sorted(r.switches), ["leaf-0", "spine-0"])
        self.assertEqual(r.hops, 3)
        r = sc.routes[("node-0", "node-1")]
        self.assertEqual([l for l, _ in r.links], ["n0-leaf", "n1-leaf"])
        self.assertEqual(r.hops, 2)

    def test_tie_break_is_deterministic(self):
        raw = base_raw()
        n0 = compute(raw["nodes"][0], "node-0", 64)
        pl = pool(raw["nodes"][1], "pool", 1024)
        raw["nodes"] = [n0, pl]
        raw["fabric"]["switches"] = [
            {"id": "sw-a", "bandwidth_bytes_per_ns": 48, "latency_ns": 10},
            {"id": "sw-b", "bandwidth_bytes_per_ns": 48, "latency_ns": 10}]
        raw["fabric"]["links"] = [link("l-b0", "node-0", "sw-b", 48, 50),
                                  link("l-a0", "node-0", "sw-a", 48, 50),
                                  link("l-b1", "sw-b", "pool", 48, 50),
                                  link("l-a1", "sw-a", "pool", 48, 50)]
        sc1 = build_scenario(copy.deepcopy(raw))
        sc2 = build_scenario(copy.deepcopy(raw))
        won1 = [l for l, _ in sc1.routes[("node-0", "pool")].links]
        won2 = [l for l, _ in sc2.routes[("node-0", "pool")].links]
        self.assertEqual(won1, won2)
        # Sorted adjacency visits sw-a first: the winning path is fixed by
        # construction, not by dict order or link declaration order.
        self.assertEqual(won1, ["l-a0", "l-a1"])

    def test_legacy_switch_maps_to_switch0_and_occupies_all(self):
        raw = load_example("two-node-switch.json")
        raw["page_size_bytes"] = UNIT
        raw["duration_ns"] = 500_000_000
        raw["warmup_ns"] = 0
        raw["metrics"]["warmup_ns"] = 0
        raw["metrics"]["sample_interval_ns"] = 500_000_000
        for n in raw["nodes"]:
            if n["role"] == "compute":
                n["local_memory"]["capacity_bytes"] = 64 * UNIT
        raw["workload"]["requests"]["arrival_rate_per_second"] = 10.0
        raw["workload"]["requests"]["prompt_tokens"] = 64
        raw["workload"]["requests"]["generated_tokens"] = 4
        raw["output"] = {"format": "jsonl", "include_event_log": False}
        p = write_tmp_scenario(raw)
        sc = build_scenario(load_raw(p))
        self.assertEqual(sorted(sc.switches), ["switch-0"])
        self.assertIsNotNone(sc.switch)
        with tempfile.TemporaryDirectory() as td:
            s, m = run_synth(p, td + "/o")
            self.assertGreater(s["switch"]["bytes_served"], 0)
            self.assertIn("node-0>remote-pool", m["routes"])

    def test_unreachable_peer_is_opportunistic_not_error(self):
        raw = base_raw()
        n0 = compute(raw["nodes"][0], "node-0", 64)
        n1 = compute(raw["nodes"][0], "node-1", 64)
        pl = pool(raw["nodes"][1], "pool", 1024)
        raw["nodes"] = [n0, n1, pl]
        raw["fabric"]["links"] = [link("l-0p", "node-0", "pool"),
                                  link("l-1p", "node-1", "pool")]
        sc = build_scenario(raw)  # must not raise
        self.assertIn(("node-0", "pool"), sc.routes)
        self.assertNotIn(("node-0", "node-1"), sc.routes)


class TopologyValidation(unittest.TestCase):
    def _broken(self, mutator):
        raw = spine_leaf_raw()
        mutator(raw)
        return raw

    def _expect(self, raw, needle):
        errors, _, _ = validate(raw)
        self.assertTrue(any(needle in e for e in errors), errors)
        with self.assertRaises(ScenarioError) as c:
            build_scenario(copy.deepcopy(raw))
        self.assertIn(needle, str(c.exception))

    def test_switch_and_switches_exclusive(self):
        self._expect(self._broken(
            lambda r: r["fabric"].update(
                {"switch": {"bandwidth_bytes_per_ns": 48}})), "exclusive")

    def test_unknown_endpoint_rejected(self):
        def m(r):
            r["fabric"]["links"][0]["to"] = "nope"
        self._expect(self._broken(m), "unknown node or switch")

    def test_self_link_rejected(self):
        def m(r):
            r["fabric"]["links"][0]["to"] = r["fabric"]["links"][0]["from"]
        self._expect(self._broken(m), "self-link")

    def test_unreachable_pool_rejected(self):
        def m(r):
            r["fabric"]["links"] = [l for l in r["fabric"]["links"]
                                    if l["id"] != "spine-pa"]
        self._expect(self._broken(m), "cannot reach pool")

    def test_isolated_compute_rejected(self):
        raw = base_raw()
        raw["nodes"] = [compute(raw["nodes"][0], "node-0", 64)]
        raw["fabric"]["switches"] = [
            {"id": "sw-0", "bandwidth_bytes_per_ns": 48, "latency_ns": 10}]
        raw["fabric"]["links"] = [link("l-0", "node-0", "sw-0")]
        self._expect(raw, "no pool and no peer")

    def test_validate_and_build_agree_on_good_topology(self):
        raw = spine_leaf_raw()
        errors, _, _ = validate(raw)
        self.assertEqual(errors, [])
        sc = build_scenario(copy.deepcopy(raw))
        self.assertEqual(sorted(sc.pools), ["pool-a", "pool-b"])
        self.assertEqual(sorted(sc.switches), ["leaf-0", "spine-0"])


class MultiPoolPlacement(unittest.TestCase):
    def test_spill_prefers_nearest_pool(self):
        with tempfile.TemporaryDirectory() as td:
            s, _ = run_synth(write_tmp_scenario(two_pool_raw()), td + "/o")
            self.assertGreater(s["pools"]["pool-near"]["peak_used_pages"], 0)
            self.assertEqual(s["pools"]["pool-far"]["peak_used_pages"], 0)
            self.assertEqual(sorted(s["migration_matrix_pages"]),
                             ["node-0>pool-near"])
            self.assertEqual(s["tiers"], ["node-0", "pool-far", "pool-near"])

    def test_spill_overflows_to_far_pool(self):
        with tempfile.TemporaryDirectory() as td:
            s, _ = run_synth(write_tmp_scenario(two_pool_raw(near_pages=4)),
                             td + "/o")
            self.assertGreater(s["pools"]["pool-near"]["peak_used_pages"], 0)
            self.assertGreater(s["pools"]["pool-far"]["peak_used_pages"], 0)
            self.assertIn("node-0>pool-near", s["migration_matrix_pages"])
            self.assertIn("node-0>pool-far", s["migration_matrix_pages"])

    def test_peer_is_spill_candidate(self):
        raw = base_raw()
        n0 = compute(raw["nodes"][0], "node-0", 64)
        n1 = compute(raw["nodes"][0], "node-1", 64)
        pf = pool(raw["nodes"][1], "pool-far", 1 << 30, lat=900)
        raw["nodes"] = [n0, n1, pf]
        raw["fabric"]["links"] = [link("l-peer", "node-0", "node-1", 48, 10),
                                  link("l-0p", "node-0", "pool-far", 48, 400),
                                  link("l-1p", "node-1", "pool-far", 48, 400)]
        with tempfile.TemporaryDirectory() as td:
            s, _ = run_synth(write_tmp_scenario(raw), td + "/o")
            self.assertGreater(
                s["migration_matrix_pages"].get("node-0>node-1", 0), 0)
            self.assertGreater(
                s["migration_matrix_pages"].get("node-1>node-0", 0), 0)

    def test_peer_only_remote_without_pool(self):
        raw = base_raw()
        raw["workload"]["model"] = {"name": "tiny", "family": "test", "layers": 8,
                                    "attention_heads": 8, "kv_heads": 2,
                                    "head_dim": 32, "dtype_bytes": 2}
        raw["nodes"] = [compute(raw["nodes"][0], "node-0", 24),
                        compute(raw["nodes"][0], "node-1", 24)]
        raw["fabric"]["links"] = [link("l-peer", "node-0", "node-1", 48, 10)]
        with tempfile.TemporaryDirectory() as td:
            s, m = run_synth(write_tmp_scenario(raw), td + "/o")
            self.assertIsNone(s["pool"])
            self.assertEqual(s["pools"], {})
            self.assertGreater(s["requests"]["arrived"], 0)
            self.assertEqual(s["requests"]["rejected"], 0)
            self.assertEqual(s["requests"]["completed"], s["requests"]["arrived"])
            self.assertGreater(
                s["migration_matrix_pages"].get("node-0>node-1", 0), 0)
            self.assertGreater(
                s["migration_matrix_pages"].get("node-1>node-0", 0), 0)
            self.assertTrue(any("peer-only" in w for w in m["warnings"]),
                            m["warnings"])

    def test_choose_tier_hook_controls_destination(self):
        with tempfile.TemporaryDirectory() as td:
            p = write_tmp_scenario(two_pool_raw())
            sc = build_scenario(load_raw(p))
            eng = Engine(sc, td + "/o", event_log=False)
            eng.policies["node-0"].choose_tier = lambda cands: "pool-far"
            s, _ = eng.run()
            self.assertGreater(s["pools"]["pool-far"]["peak_used_pages"], 0)
            self.assertEqual(s["pools"]["pool-near"]["peak_used_pages"], 0)
            self.assertEqual(sorted(s["migration_matrix_pages"]),
                             ["node-0>pool-far"])


class ReplayForeignPages(unittest.TestCase):
    def test_spill_evict_return_and_parked_read(self):
        with tempfile.TemporaryDirectory() as td:
            p = peer_only_replay_paths(td)
            s1, _ = run_replay(p, td + "/o1")
            s2, _ = run_replay(p, td + "/o2")
            self.assertEqual(canonical_bytes(s1), canonical_bytes(s2))
            s = s1
            # Evict a node-0->node-1 plus writeback node-1->node-0: exactly
            # two dirty page transfers out; the parked read adds nothing.
            self.assertEqual(s["links"]["l-peer"]["bytes_out"], 2 * UNIT)
            self.assertEqual(s["links"]["l-peer"]["bytes_in"], 2 * UNIT)
            self.assertEqual(s["migration_matrix_pages"],
                             {"node-0>node-1": 1, "node-1>node-0": 1})
            self.assertEqual(s["access"]["count"], 3)
            self.assertEqual(s["access"]["local_hits"], 1)
            self.assertEqual(s["access"]["remote_hits"], 2)

    def test_non_owner_read_through_never_installs(self):
        with tempfile.TemporaryDirectory() as td:
            s, _ = run_replay(peer_only_replay_paths(td), td + "/o")
            # Both non-owner reads bypass: the page stays home, so each read
            # pays fabric again instead of caching on the reader.
            self.assertEqual(s["access"]["bypass_reads"], 2)
            self.assertEqual(s["memory"]["node-1"]["local_hits"], 0)

    def test_unroutable_touch_diverges_with_row(self):
        # A star topology has no peer route, so a cross-node touch cannot be
        # served: honest divergence naming the row, not a KeyError.
        with tempfile.TemporaryDirectory() as td:
            trace_path = str(Path(td) / "t.jsonl")
            rows = [op(10, "alloc", "a", "r0", node="node-0"),
                    op(20, "read", "a", "r0", node="node-1")]
            Path(trace_path).write_text(
                "\n".join([json.dumps(HEADER)] + [json.dumps(r) for r in rows]) + "\n",
                encoding="utf-8")
            raw = load_example("phase1-overflow.json")
            raw["name"] = "ntier-unroutable-test"
            raw["page_size_bytes"] = UNIT
            raw["duration_ns"] = 10_000_000_000
            raw["warmup_ns"] = 0
            raw["metrics"]["warmup_ns"] = 0
            raw["metrics"]["sample_interval_ns"] = 1_000_000_000
            raw["nodes"] = [compute(raw["nodes"][0], "node-0", 2),
                            compute(raw["nodes"][0], "node-1", 2),
                            pool(raw["nodes"][1], "pool", 16)]
            raw["fabric"]["links"] = [link("l-0p", "node-0", "pool"),
                                      link("l-1p", "node-1", "pool")]
            raw["fabric"].pop("switch", None)
            raw["policy"] = {"name": "swap_remote"}
            raw["workload"] = {"type": "trace", "path": trace_path}
            raw["output"] = {"format": "jsonl", "include_event_log": False}
            scen_path = str(Path(td) / "scen.json")
            Path(scen_path).write_text(json.dumps(raw), encoding="utf-8")
            sc = build_scenario(load_raw(scen_path),
                                base_dir=str(Path(scen_path).parent))
            with self.assertRaises(ReplayDivergence) as c:
                ReplayEngine(sc, sc.trace, td + "/o", event_log=False).run()
            self.assertIn("no static route", str(c.exception))

    def test_single_owner_invariant_and_accounting(self):
        with tempfile.TemporaryDirectory() as td:
            s, _ = run_replay(peer_only_replay_paths(td), td + "/o")
            finals = {n: s["memory"][n]["final_used_pages"]
                      for n in ("node-0", "node-1")}
            # Live pages a, b, c, d sit in exactly one tier each (e was
            # freed). The owner return exactly fills node-0; a fuller
            # return would overcommit (eviction allows, never refuses).
            self.assertEqual(finals, {"node-0": 3, "node-1": 1})
            for n in ("node-0", "node-1"):
                self.assertGreaterEqual(s["memory"][n]["peak_used_pages"],
                                        finals[n])


class DeterminismAndIdentities(unittest.TestCase):
    def test_synth_placement_is_byte_deterministic(self):
        with tempfile.TemporaryDirectory() as td:
            p = write_tmp_scenario(two_pool_raw())
            s1, _ = run_synth(p, td + "/o1")
            s2, _ = run_synth(p, td + "/o2")
            self.assertEqual(canonical_bytes(s1), canonical_bytes(s2))

    def test_per_tier_identities(self):
        with tempfile.TemporaryDirectory() as td:
            s, _ = run_synth(write_tmp_scenario(two_pool_raw()), td + "/o")
            for row in list(s["pools"].values()) + list(s["memory"].values()):
                self.assertGreaterEqual(row["peak_used_pages"],
                                        row["final_used_pages"])
            tiers = set(s["tiers"])
            for key in s["migration_matrix_pages"]:
                a, b = key.split(">")
                self.assertIn(a, tiers)
                self.assertIn(b, tiers)
            # The far pool is never chosen, so its link carries no bytes in
            # either direction.
            self.assertEqual(s["links"]["l-far"]["bytes_in"], 0)
            self.assertEqual(s["links"]["l-far"]["bytes_out"], 0)
            self.assertGreater(s["links"]["l-near"]["bytes_out"], 0)


if __name__ == "__main__":
    unittest.main()
