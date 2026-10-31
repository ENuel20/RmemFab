"""Phase 1 tests: timing closed forms, queueing, capacity accounting, determinism.

Runs with `python -m unittest discover -s tests` or pytest (no extra deps).
"""
import copy
import hashlib
import json
import random
import tempfile
import unittest
from pathlib import Path

import numpy as np

from rmemfab.cli import main as cli_main
from rmemfab.config.scenario import (ScenarioError, build_scenario, canonical_json, load_raw, scenario_hash,
                                     validate, LinkSpec, PoolSpec, TierSpec)
from rmemfab.config.schema import config_schema, validate_schema
from rmemfab.core.engine import Engine, LOCAL
from rmemfab.core.scheduler import Scheduler
from rmemfab.memory.fabric import Fabric, LocalTier
from rmemfab.telemetry.hist import Histogram
from rmemfab.telemetry.summary import canonical
from rmemfab.workloads.synthetic import kv_bytes_per_token

ROOT = Path(__file__).resolve().parents[1]
EX = ROOT / "examples"


def short(raw, duration_ns, warmup_ns=0):
    raw = copy.deepcopy(raw)
    raw["duration_ns"] = duration_ns
    raw["warmup_ns"] = warmup_ns
    raw.setdefault("metrics", {})["warmup_ns"] = warmup_ns
    return raw


def tier(L, B, cap=1 << 40):
    return TierSpec(capacity_bytes=cap, latency_ns=L, bandwidth_bytes_per_ns=B)


def make_fabric(nodes=1, link_bw=10.0, link_lat=100.0, pool_bw=1e6, pool_lat=0.0):
    links = {f"n{i}": LinkSpec(f"l{i}", f"n{i}", link_lat, link_bw, None, None, True) for i in range(nodes)}
    return Fabric(links, PoolSpec("pool", tier(pool_lat, pool_bw)))


class SchemaAndHash(unittest.TestCase):
    def test_bundled_schema_matches_spec(self):
        self.assertEqual(json.loads((ROOT / "SPECS/config.schema.json").read_text()), config_schema())
        bundled = ROOT / "src/rmemfab/config/config.schema.json"
        self.assertEqual(bundled.read_text(), (ROOT / "SPECS/config.schema.json").read_text())

    def test_examples_validate(self):
        for f in sorted(EX.glob("*.json")):
            errors, _, _ = validate(load_raw(f))
            self.assertEqual(errors, [], f.name)

    def test_errors_carry_paths(self):
        raw = load_raw(EX / "llama-70b-cxl.json")
        raw["nodes"][0]["local_memory"]["latency_ns"] = -1
        raw["bogus"] = 1
        errs = validate_schema(raw)
        self.assertTrue(any(e.startswith("nodes[0].local_memory.latency_ns") for e in errs), errs)
        self.assertTrue(any(e.startswith("bogus") for e in errs), errs)

    def test_semantic_errors(self):
        raw = load_raw(EX / "llama-70b-cxl.json")
        raw["fabric"]["links"][0]["to"] = "nowhere"
        errors, _, _ = validate(raw)
        self.assertTrue(any("unknown node 'nowhere'" in e for e in errors), errors)

    def test_hash_is_canonical(self):
        raw = load_raw(EX / "llama-70b-cxl.json")
        reordered = json.loads(json.dumps(raw, sort_keys=True))
        pretty = json.loads(json.dumps(raw, indent=4))
        self.assertEqual(scenario_hash(raw), scenario_hash(reordered))
        self.assertEqual(scenario_hash(raw), scenario_hash(pretty))
        float_form = copy.deepcopy(raw)
        float_form["seed"] = 42.0
        self.assertEqual(scenario_hash(raw), scenario_hash(float_form))
        changed = copy.deepcopy(raw)
        changed["seed"] = 43
        self.assertNotEqual(scenario_hash(raw), scenario_hash(changed))
        self.assertNotIn(" ", canonical_json({"a": 1, "b": [1, 2]}))

    def test_require_provenance(self):
        raw = load_raw(EX / "llama-70b-cxl.json")
        errors, _, _ = validate(raw, require_provenance=True)
        self.assertEqual(errors, [])
        del raw["fabric"]["links"][0]["provenance"]
        errors, warnings, _ = validate(raw, require_provenance=True)
        self.assertTrue(any("fabric.links[0].provenance" in e for e in errors))
        errors, warnings, _ = validate(raw)
        self.assertEqual(errors, [])
        self.assertTrue(any("fabric.links[0].provenance" in w for w in warnings))

    def test_unimplemented_profile_is_explicit(self):
        raw = load_raw(EX / "phase1-swap-pressure.json")
        raw["workload"]["profile"] = "mixed"
        self.assertEqual(validate(raw)[0], [])
        with self.assertRaises(ScenarioError) as cm:
            build_scenario(raw)
        self.assertIn("mixed", str(cm.exception))


class SchedulerTests(unittest.TestCase):
    def test_order_time_then_sequence(self):
        s, seen = Scheduler(), []
        s.schedule(10, "b")
        s.schedule(5, "a")
        s.schedule(10, "c")
        s.schedule(10, "d")
        s.run(lambda k, d, t, q: seen.append((t, k)), 100)
        self.assertEqual(seen, [(5, "a"), (10, "b"), (10, "c"), (10, "d")])

    def test_cannot_schedule_into_the_past_and_end_time_inclusive(self):
        s, seen = Scheduler(), []

        def h(k, d, t, q):
            seen.append(t)
            if k == "x":
                with self.assertRaises(ValueError):
                    s.schedule(t - 1, "bad")
        s.schedule(7, "x")
        s.schedule(100, "end")
        s.schedule(101, "late")
        s.run(h, 100)
        self.assertEqual(seen, [7, 100])


class TimingClosedForms(unittest.TestCase):
    """ACCEPTANCE A1.1 - A1.3."""

    def test_a11_single_tier_closed_form(self):
        L, B, n, N = 90.0, 400.0, 2 * 1024 * 1024, 50
        t = LocalTier(tier(L, B))
        now = 0.0
        for _ in range(N):
            lats, fin = t.access(now, 1, n, write=False)
            self.assertAlmostEqual(lats[0], L + n / B, delta=1.0)
            now = fin
        self.assertAlmostEqual(t.server.busy_ns, N * n / B, delta=1.0)

    def test_a11_dependent_batch_matches_sequential(self):
        L, B, n, k = 90.0, 400.0, 4096 * 512, 40
        t = LocalTier(tier(L, B))
        lats, fin = t.access(0.0, k, n, write=False)
        self.assertTrue(np.allclose(lats, L + n / B))
        self.assertAlmostEqual(fin, k * (L + n / B), delta=1.0)

    def test_a12_queue_saturation(self):
        B, L, n, k = 10.0, 100.0, 5000, 8
        f = make_fabric(link_bw=B, link_lat=L)
        for i in range(1, k + 1):
            _, fin, _, _ = f.transfer("n0", "in", 0.0, 1, n, pipelined=True)
            self.assertAlmostEqual(fin, L + i * n / B, delta=1.0)

    def test_a12_doubling_offered_bytes_grows_time_and_queue(self):
        def run(count):
            f = make_fabric(link_bw=10.0, link_lat=100.0)
            fin = 0.0
            for _ in range(count):
                _, fin, _, _ = f.transfer("n0", "in", 0.0, 1, 5000, pipelined=True)
            f.finish(fin)
            s = f.links["n0"]["in"]
            return fin, s.q_area
        (t1, q1), (t2, q2) = run(8), run(16)
        self.assertGreater(t2, t1)
        self.assertGreater(q2, q1)

    def test_a13_backlog_never_double_counted(self):
        """start == max(now, free_at); idle link starts at `now`; never later."""
        rng = random.Random(1234)
        for trial in range(200):
            B = rng.choice([1.0, 8.0, 48.0])
            f = make_fabric(link_bw=B, link_lat=rng.choice([0.0, 50.0, 180.0]))
            free_at, now = 0.0, 0.0
            for _ in range(rng.randint(1, 30)):
                now += rng.choice([0.0, 1.0, 10.0, 1000.0, 50000.0])
                n = rng.choice([4096, 65536, 2 * 1024 * 1024])
                k = rng.randint(1, 4)
                _, _, qd, _ = f.transfer("n0", "in", now, k, n, pipelined=True)
                expected_start = max(now, free_at)
                self.assertAlmostEqual(now + qd, expected_start, delta=1e-6)
                if free_at <= now:
                    self.assertAlmostEqual(qd, 0.0, delta=1e-9)  # idle: no queue term at all
                free_at = expected_start + k * n / B

    def test_a14_shared_pool_never_exceeds_bandwidth(self):
        pool_bw, n, per_node = 20.0, 1 << 20, 10
        f = make_fabric(nodes=4, link_bw=48.0, link_lat=0.0, pool_bw=pool_bw)
        last = 0.0
        for i in range(per_node):
            for node in range(4):
                _, fin, _, _ = f.transfer(f"n{node}", "in", 0.0, 1, n, pipelined=True)
                last = max(last, fin)
        total = 4 * per_node * n
        self.assertGreaterEqual(last, total / pool_bw - 1.0)  # aggregate service <= pool bandwidth
        self.assertAlmostEqual(f.pool.busy_ns, total / pool_bw, delta=1.0)

    def test_latency_factors_apply(self):
        spec = TierSpec(1 << 30, 100.0, 10.0, read_latency_factor=2.0, write_latency_factor=3.0)
        t = LocalTier(spec)
        self.assertAlmostEqual(t.access(0, 1, 1000, write=False)[0][0], 200 + 100)
        t2 = LocalTier(spec)
        self.assertAlmostEqual(t2.access(0, 1, 1000, write=True)[0][0], 300 + 100)


class HistogramAccuracy(unittest.TestCase):
    def test_percentiles_within_one_percent(self):
        rng = np.random.default_rng(5)
        data = rng.lognormal(mean=10, sigma=1.5, size=200000)
        h = Histogram()
        h.add(data)
        for p in (50, 95, 99):
            exact = float(np.percentile(data, p))
            got = h.percentile(p)
            self.assertGreaterEqual(got, exact * 0.99)
            self.assertLessEqual(got, exact * 1.02)
        self.assertAlmostEqual(h.mean(), float(data.mean()), delta=1e-6 * float(data.mean()))


class KvSizing(unittest.TestCase):
    def test_llama_3_70b_formula(self):
        m = load_raw(EX / "llama-70b-cxl.json")["workload"]["model"]
        self.assertEqual(kv_bytes_per_token(m), 2 * 80 * 8 * 128 * 2)
        self.assertEqual(kv_bytes_per_token(m) * 8192, 2684354560)

    def test_summary_reports_formula_inputs(self):
        sc = build_scenario(short(load_raw(EX / "llama-70b-cxl.json"), 300_000_000))
        s, _ = Engine(sc).run()
        self.assertEqual(s["workload"]["kv_bytes_per_token"], 327680)
        self.assertIn("layers", s["workload"]["kv_formula"])


def run_pressure(policy=None, duration=1_500_000_000, seed=None, out=None, **kw):
    raw = short(load_raw(EX / "phase1-swap-pressure.json"), duration, 200_000_000)
    sc = build_scenario(raw, policy=policy, seed=seed)
    eng = Engine(sc, out, **kw)
    summary, manifest = eng.run()
    return eng, summary, manifest


class CapacityAccounting(unittest.TestCase):
    """ACCEPTANCE A1.5."""

    def check_invariants(self, eng):
        for n in eng.nodes:
            self.assertLessEqual(n.peak, n.cap)
            self.assertGreaterEqual(n.used, 0)
            local = sum(int((r.where[:r.n_alloc] == LOCAL).sum()) for r in n.active)
            self.assertEqual(n.used, local, "node occupancy must equal resident pages exactly")
        if eng.pool:
            remote = sum(int((r.where[:r.n_alloc] != LOCAL).sum()) for n in eng.nodes for r in n.active)
            self.assertEqual(eng.pool.used, remote)
            self.assertLessEqual(eng.pool.peak, eng.pool.cap)

    def test_swap_remote_never_overcommits(self):
        eng, s, _ = run_pressure("swap_remote")
        self.check_invariants(eng)
        self.assertEqual(eng.nodes[0].peak, eng.nodes[0].cap)  # pressure really occurred
        self.assertGreater(s["memory"]["node-0"]["evicted_pages"], 0)
        self.assertGreater(s["access"]["remote_hits"], 0)
        self.assertEqual(s["requests"]["rejected"], 0)
        self.assertEqual(s["traffic"]["evict_bytes"], s["memory"]["node-0"]["evicted_pages"] * 2 * 1024 * 1024)

    def test_local_only_rejects_explicitly(self):
        eng, s, _ = run_pressure("local_only")
        self.check_invariants(eng)
        self.assertGreater(s["requests"]["rejected"], 0)
        self.assertEqual(s["traffic"]["remote_read_bytes"] + s["traffic"]["remote_write_bytes"], 0)
        self.assertEqual(s["access"]["remote_hits"], 0)

    def test_pool_exhaustion_rejects_instead_of_overcommitting(self):
        raw = short(load_raw(EX / "phase1-swap-pressure.json"), 1_500_000_000)
        raw["nodes"][1]["remote_memory"]["capacity_bytes"] = 64 * 2 * 1024 * 1024
        eng = Engine(build_scenario(raw))
        s, _ = eng.run()
        self.check_invariants(eng)
        self.assertGreater(s["requests"]["rejected"], 0)
        self.assertLessEqual(eng.pool.peak, 64)

    def test_conservation_of_accesses(self):
        eng, s, _ = run_pressure("swap_remote", duration=1_000_000_000)
        c = eng.m_all.c
        # ACCEPTANCE hit-ratio definition: hits partition READ accesses; writes are counted separately
        self.assertEqual(c["reads"], c["local_hits"] + c["remote_hits"])
        self.assertEqual(c["accesses"], c["reads"] + c["writes"])
        self.assertLessEqual(s["access"]["count"], c["accesses"])


class Determinism(unittest.TestCase):
    """ACCEPTANCE A6."""

    def bundle(self, seed, events=True):
        with tempfile.TemporaryDirectory() as d:
            _, s, m = run_pressure("swap_remote", duration=1_000_000_000, seed=seed, out=d, event_log=events)
            ev = hashlib.sha256((Path(d) / "events.jsonl").read_bytes()).hexdigest() if events else None
            man = json.loads((Path(d) / "manifest.json").read_text())
            return canonical(s), ev, man

    def test_same_seed_is_byte_identical(self):
        a, b = self.bundle(11), self.bundle(11)
        self.assertEqual(a[0], b[0])
        self.assertEqual(a[1], b[1])

    def test_different_seed_differs(self):
        self.assertNotEqual(self.bundle(11)[0], self.bundle(12)[0])

    def test_event_log_does_not_change_results(self):
        self.assertEqual(self.bundle(11, events=True)[0], self.bundle(11, events=False)[0])

    def test_event_ordering_guarantees(self):
        with tempfile.TemporaryDirectory() as d:
            run_pressure("swap_remote", duration=1_000_000_000, out=d)
            last_t, last_seq, names = -1, 0, set()
            for line in (Path(d) / "events.jsonl").read_text().splitlines():
                e = json.loads(line)
                self.assertGreaterEqual(e["time_ns"], last_t)
                self.assertGreater(e["seq"], last_seq)
                last_t, last_seq = e["time_ns"], e["seq"]
                names.add(e["event"])
            for need in ("run_start", "run_end", "request_arrival", "decode_step", "page_evict", "page_miss",
                         "transfer_begin", "transfer_complete", "request_complete", "metric_snapshot"):
                self.assertIn(need, names)

    def test_manifest_completeness(self):
        _, _, man = self.bundle(11)
        for key in ("rmemfab_version", "schema_version", "scenario_hash", "seed", "stream_seeds", "trace_hashes",
                    "policy", "event_count", "virtual_time_ns", "outputs", "shared_pool_model"):
            self.assertIn(key, man)
        self.assertEqual(set(man["stream_seeds"]), {"workload", "policy", "faults", "fabric"})
        self.assertEqual(man["seed"], 11)

    def test_rng_streams_independent(self):
        from rmemfab.core.rng import make_rng
        a = make_rng(5, "workload").random(4)
        b = make_rng(5, "policy").random(4)
        self.assertFalse(np.allclose(a, b))
        self.assertTrue(np.allclose(a, make_rng(5, "workload").random(4)))


class Metrics(unittest.TestCase):
    def test_warmup_excluded_from_steady_state(self):
        eng, s, _ = run_pressure("swap_remote", duration=1_200_000_000)
        self.assertLess(s["access"]["count"], s["access"]["total_accesses_incl_warmup"])

    def test_idle_single_request_latency_is_closed_form(self):
        raw = short(load_raw(EX / "phase1-swap-pressure.json"), 2_000_000_000)
        raw["workload"]["requests"].update(arrival_rate_per_second=1, concurrency=1, generated_tokens=8)
        raw["nodes"][0]["local_memory"]["capacity_bytes"] = 1 << 36
        s, _ = Engine(build_scenario(raw, seed=3)).run()
        self.assertGreater(s["requests"]["completed"], 0)
        lat = s["access"]["latency_ns"]
        self.assertAlmostEqual(lat["p50"], 90 + 2 * 1024 * 1024 / 400, delta=0.011 * 5400)
        self.assertEqual(s["access"]["local_hit_ratio"], 1.0)
        self.assertEqual(s["links"]["node-0-cxl"]["bytes_in"], 0)

    def test_utilization_never_exceeds_one(self):
        _, s, _ = run_pressure("swap_remote", duration=800_000_000)
        self.assertLessEqual(s["pool"]["utilization"], 1.0 + 1e-9)
        self.assertLessEqual(s["links"]["node-0-cxl"]["utilization"], 1.0 + 1e-9)
        self.assertLessEqual(s["memory"]["node-0"]["bandwidth_utilization"], 1.0 + 1e-9)

    def test_cost_model_reports_components(self):
        _, s, _ = run_pressure("swap_remote")
        self.assertGreater(s["cost"]["transfer"], 0)
        self.assertGreater(s["cost"]["migration"], 0)
        self.assertAlmostEqual(s["cost"]["total"], s["cost"]["capacity"] + s["cost"]["transfer"] + s["cost"]["migration"], places=4)


class PolicyFallback(unittest.TestCase):
    def test_hot_cold_falls_back_visibly(self):
        sc = build_scenario(short(load_raw(EX / "llama-70b-cxl.json"), 200_000_000))
        self.assertEqual((sc.policy_requested, sc.policy_effective), ("hot_cold", "swap_remote"))
        _, m = Engine(sc).run()
        self.assertEqual(m["policy"]["requested"], "hot_cold")
        self.assertEqual(m["policy"]["effective"], "swap_remote")
        self.assertIn("later-phase", m["policy"]["fallback_reason"])

    def test_strict_policy_refuses(self):
        with self.assertRaises(ScenarioError):
            build_scenario(load_raw(EX / "llama-70b-cxl.json"), strict_policy=True)


class CliTests(unittest.TestCase):
    def test_validate_run_summary(self):
        with tempfile.TemporaryDirectory() as d:
            scen = Path(d) / "s.json"
            scen.write_text(json.dumps(short(load_raw(EX / "phase1-swap-pressure.json"), 800_000_000)))
            self.assertEqual(cli_main(["validate", str(scen), "--require-provenance"]), 0)
            self.assertEqual(cli_main(["run", str(scen), "--seed", "3", "--out", d + "/a", "--quiet"]), 0)
            self.assertEqual(cli_main(["run", str(scen), "--seed", "3", "--out", d + "/b", "--quiet", "--no-events"]), 0)
            self.assertTrue((Path(d) / "a" / "events.jsonl").exists())
            self.assertFalse((Path(d) / "b" / "events.jsonl").exists())
            self.assertEqual((Path(d) / "a" / "summary.json").read_text(), (Path(d) / "b" / "summary.json").read_text())
            self.assertEqual(cli_main(["summary", d + "/a", "--canonical"]), 0)
            self.assertEqual(cli_main(["run", str(Path(d) / "missing.json")]), 1)

    def test_invalid_scenario_fails_before_running(self):
        with tempfile.TemporaryDirectory() as d:
            raw = load_raw(EX / "phase1-swap-pressure.json")
            raw["duration_ns"] = 0
            p = Path(d) / "bad.json"
            p.write_text(json.dumps(raw))
            self.assertEqual(cli_main(["validate", str(p)]), 1)
            self.assertEqual(cli_main(["run", str(p), "--out", d + "/x"]), 1)
            self.assertFalse((Path(d) / "x").exists())


if __name__ == "__main__":
    unittest.main()
