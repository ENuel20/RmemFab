"""Phase 3 policies: unit semantics + engine integration on micro-traces."""
import json
import tempfile
import unittest
from pathlib import Path

from support import REPO, load_example, write_tmp_scenario
from rmemfab.config.scenario import ScenarioError, build_scenario, load_raw
from rmemfab.policies import create_policy
from rmemfab.policies.base import PressureContext
from rmemfab.trace.replay import ReplayEngine

UNIT = 4096
HEADER = {"type": "header", "trace_version": "0.1", "source": "test"}


def micro_trace(rows):
    f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
    f.write(json.dumps(HEADER) + "\n")
    for r in rows:
        f.write(json.dumps(r) + "\n")
    f.close()
    return f.name


def op(ts, op, page, req="r0", nbytes=UNIT):
    return {"ts_ns": ts, "op": op, "page_id": page, "request_id": req, "bytes": nbytes}


def trace_scenario(trace_path, local_pages, pool_pages, policy, params=None,
                   cost_model=None):
    raw = load_example("phase1-overflow.json")
    raw["name"] = "policy-test"
    raw["page_size_bytes"] = UNIT
    raw["duration_ns"] = 10_000_000_000
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["metrics"]["sample_interval_ns"] = 1_000_000_000
    raw["nodes"][0]["local_memory"]["capacity_bytes"] = local_pages * UNIT
    raw["nodes"][1]["remote_memory"]["capacity_bytes"] = pool_pages * UNIT
    raw["policy"] = {"name": policy, **({"params": params} if params else {})}
    raw["workload"] = {"type": "trace", "path": trace_path}
    raw["output"] = {"format": "jsonl", "include_event_log": False}
    if cost_model is not None:
        raw["cost_model"] = cost_model
    return write_tmp_scenario(raw)


def run_trace(path, outdir):
    sc = build_scenario(load_raw(path), base_dir=str(Path(path).parent))
    summary, _ = ReplayEngine(sc, sc.trace, outdir, event_log=False).run()
    return summary


class PolicyUnits(unittest.TestCase):
    def test_hot_cold_bands_and_victims(self):
        p = create_policy("hot_cold", {"k": 2, "hot_threshold": 3, "cold_threshold": 1})
        for _ in range(3):
            p.observe_batch({"a": 1}, 1)
        p.observe_batch({"b": 1}, 2)
        self.assertEqual(p.band("a"), 2)      # 3 lifetime touches: hot
        self.assertEqual(p.band("b"), 0)      # 1 lifetime touch: cold
        self.assertTrue(p.install_page("a"))
        self.assertFalse(p.install_page("b"))
        self.assertLess(p.victim_key("b", 2, 2), p.victim_key("a", 1, 2))
        p.reset()
        self.assertEqual(p.band("a"), 0)      # cleared: unseen reads as cold

    def test_hot_cold_rejects_bad_bands(self):
        with self.assertRaises(ValueError):
            create_policy("hot_cold", {"k": 0})
        with self.assertRaises(ValueError):
            create_policy("hot_cold", {"hot_threshold": 2, "cold_threshold": 2})
        with self.assertRaises(ValueError):
            create_policy("hot_cold", {"cold_threshold": -1})

    def test_frequency_aware_protects_reused(self):
        p = create_policy("frequency_aware", {"k": 2})
        p.observe_batch({"a": 1}, 1)
        p.observe_batch({"a": 1}, 2)   # a: K=2 touches, kth ts = 1
        p.observe_batch({"s": 1}, 3)   # s: 1 recent touch
        self.assertLess(p.victim_key("s", 3, 4), p.victim_key("a", 2, 4))
        p2 = create_policy("frequency_aware", {"k": 2})
        p2.observe_batch({"a": 1}, 1)
        p2.observe_batch({"a": 1}, 2)
        p2.observe_batch({"s": 1}, 3)
        # Same observation stream -> identical victim order (deterministic state).
        self.assertEqual(p.victim_key("a", 2, 4), p2.victim_key("a", 2, 4))
        with self.assertRaises(ValueError):
            create_policy("frequency_aware", {"k": 0})
        # K=1 degenerates to plain LRU and is legal.
        create_policy("frequency_aware", {"k": 1})

    def test_prefetch_params_and_lru_victims(self):
        p = create_policy("predictive_prefetch", {"degree": 2, "stride": -1})
        self.assertEqual(p.prefetch_degree, 2)
        self.assertEqual(p.stride, -1)
        self.assertTrue(p.on_hit)
        self.assertLess(p.victim_key("old", 1, 9), p.victim_key("new", 8, 9))
        with self.assertRaises(ValueError):
            create_policy("predictive_prefetch", {"stride": 0})
        with self.assertRaises(ValueError):
            create_policy("predictive_prefetch", {"degree": 0})

    def test_baselines_install_everything(self):
        for name in ("local_only", "swap_remote"):
            p = create_policy(name, {})
            self.assertTrue(p.install_page("anything"))
            self.assertEqual(p.prefetch_degree, 0)
        d = create_policy("local_only").on_pressure(
            PressureContext(0, "n0", 1, 0, 100))
        self.assertEqual(type(d).__name__, "Reject")

    def test_unknown_policy_names_registered(self):
        with self.assertRaises(KeyError) as c:
            create_policy("cost_aware", {})
        self.assertIn("swap_remote", str(c.exception))

    def test_scenario_warns_on_unknown_param(self):
        tp = micro_trace([op(10, "alloc", "a")])
        sc = build_scenario(load_raw(trace_scenario(tp, 2, 8, "hot_cold", {"nope": 1})))
        self.assertTrue(any("policy.params.nope" in w for w in sc.warnings), sc.warnings)

    def test_scenario_rejects_invalid_bands(self):
        tp = micro_trace([op(10, "alloc", "a")])
        with self.assertRaises(ScenarioError) as c:
            build_scenario(load_raw(trace_scenario(tp, 2, 8, "hot_cold",
                                                   {"cold_threshold": 5})))
        self.assertIn("policy.params", str(c.exception))


class PolicyEngines(unittest.TestCase):
    def test_hot_cold_bypass_vs_swap_install(self):
        # Local holds 1 page; alloc b evicts a to the pool. One cold read of a.
        tp = micro_trace([op(10, "alloc", "a"), op(20, "alloc", "b"), op(30, "read", "a")])
        with tempfile.TemporaryDirectory() as td:
            s = run_trace(trace_scenario(tp, 1, 8, "hot_cold",
                                         {"cold_threshold": 100, "hot_threshold": 101}),
                          td + "/hc")
            self.assertEqual(s["traffic"]["install_bytes"], 0)  # cold: bypass, stays remote
            self.assertEqual(s["access"]["remote_hits"], 1)
        with tempfile.TemporaryDirectory() as td:
            s = run_trace(trace_scenario(tp, 1, 8, "swap_remote"), td + "/sw")
            self.assertEqual(s["traffic"]["install_bytes"], UNIT)  # swap: install on touch

    def test_frequency_aware_beats_lru_on_streaming_pollution(self):
        # a touched twice early; s streams once, recently. c forces one victim.
        # LRU evicts a (older); LRU-2 evicts s (once-touched). Final read of a
        # discriminates: local hit under frequency_aware, remote under swap.
        rows = [op(10, "alloc", "a"), op(20, "read", "a"), op(30, "read", "a"),
                op(40, "alloc", "s"), op(50, "read", "s"), op(60, "alloc", "c"),
                op(70, "read", "a")]
        tp = micro_trace(rows)
        with tempfile.TemporaryDirectory() as td:
            f = run_trace(trace_scenario(tp, 2, 8, "frequency_aware", {"k": 2}),
                          td + "/f")
            w = run_trace(trace_scenario(tp, 2, 8, "swap_remote"), td + "/w")
            self.assertEqual(f["access"]["local_hits"], 4)
            self.assertEqual(w["access"]["local_hits"], 3)

    def test_prefetch_stride_useful_and_deterministic(self):
        # Descending-trailing ids p2..p0; stride -1 pulls the next block early.
        rows = [op(10, "alloc", "p2"), op(20, "alloc", "p1"), op(30, "alloc", "p0"),
                op(40, "read", "p2"), op(50, "read", "p1"), op(60, "read", "p0")]
        tp = micro_trace(rows)
        outs = []
        with tempfile.TemporaryDirectory() as td:
            for tag in ("a", "b"):
                s = run_trace(trace_scenario(
                    tp, 2, 8, "predictive_prefetch", {"stride": -1}), td + f"/{tag}")
                outs.append(s)
                t = s["traffic"]
                self.assertGreaterEqual(t["prefetch_issued"], 1)
                self.assertEqual(t["prefetch_accuracy"], 1.0)
                self.assertEqual(t["prefetch_useful"], t["prefetch_issued"])
            self.assertEqual(json.dumps(outs[0], sort_keys=True),
                             json.dumps(outs[1], sort_keys=True))

    def test_cost_model_prices_policy_traffic(self):
        # A3.3: migration, prefetch, and wasted prefetch bytes appear in the
        # cost model, not just the traffic metrics.
        rows = [op(10, "alloc", "p2"), op(20, "alloc", "p1"), op(30, "alloc", "p0"),
                op(40, "read", "p2"), op(50, "read", "p1"), op(60, "read", "p0")]
        tp = micro_trace(rows)
        cm = {"currency": "unit", "migration_per_gib": 1.0,
              "prefetch_per_gib": 2.0, "wasted_prefetch_per_gib": 4.0}
        with tempfile.TemporaryDirectory() as td:
            s = run_trace(trace_scenario(tp, 2, 8, "predictive_prefetch",
                                         {"stride": -1}, cost_model=cm), td + "/c")
            t, c = s["traffic"], s["cost"]
            gib = 1024 ** 3
            # Summaries round floats; cost identity holds within rounding.
            self.assertAlmostEqual(c["migration"], t["migration_bytes"] / gib, delta=1e-6)
            self.assertAlmostEqual(c["prefetch"], 2.0 * t["prefetch_bytes"] / gib, delta=1e-6)
            self.assertAlmostEqual(c["wasted_prefetch"],
                                   4.0 * t["wasted_prefetch_bytes"] / gib, delta=1e-9)
            self.assertAlmostEqual(c["total"], c["capacity"] + c["transfer"] +
                                   c["migration"] + c["prefetch"] + c["wasted_prefetch"],
                                   delta=1e-6)

    def test_prefetch_wrong_direction_issues_nothing(self):
        rows = [op(10, "alloc", "p0"), op(20, "alloc", "p1"), op(30, "alloc", "p2"),
                op(40, "read", "p0"), op(50, "read", "p1"), op(60, "read", "p2")]
        tp = micro_trace(rows)
        with tempfile.TemporaryDirectory() as td:
            s = run_trace(trace_scenario(
                tp, 2, 8, "predictive_prefetch", {"stride": 5}), td + "/w")
            t = s["traffic"]
            # Stride +5 from p0/p1 points at unallocated ids: nothing issued, nothing wasted.
            self.assertEqual(t["prefetch_issued"], 0)
            self.assertIsNone(t["prefetch_accuracy"])
            self.assertEqual(t["wasted_prefetch_bytes"], 0)


if __name__ == "__main__":
    unittest.main()
