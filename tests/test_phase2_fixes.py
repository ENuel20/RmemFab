"""Regression tests for the Phase 2 hardening pass (utilization, spill, backpressure, traces, metric definitions)."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from rmemfab.cli import main as cli_main
from rmemfab.config.scenario import build_scenario, load_raw
from rmemfab.core.engine import Engine
from rmemfab.core.runner import make_engine
from rmemfab.memory.fabric import LocalTier, Server
from rmemfab.telemetry.summary import canonical
from rmemfab.workloads.trace import TraceError, load_trace, normalize_trace

from test_phase1 import short
from test_phase2 import EX, MIB, PAGE, rec, trace_scenario, write_lines


def run_raw(raw, **kw):
    return make_engine(build_scenario(raw), **kw).run()


_CACHE = {}


def overflow(policy=None, out=None, duration=2_500_000_000):
    """Runs are deterministic, so identical (policy, events?) runs are shared between tests."""
    key = (policy, out is not None)
    if out is None and key in _CACHE:
        return _CACHE[key]
    raw = short(load_raw(EX / "phase1-overflow.json"), duration, duration // 5)
    raw.setdefault("output", {})["include_event_log"] = True
    eng = Engine(build_scenario(raw, policy=policy), out)
    s, m = eng.run()
    if out is None:
        _CACHE[key] = (eng, s, m)
    return eng, s, m


class Utilization(unittest.TestCase):
    def test_busy_is_clipped_exactly_even_with_idle_gaps(self):
        s = Server(10.0)
        s.horizon = 100.0
        s.admit(0, 50, 1, 1000)    # occupies [50, 150): only [50, 100) is inside the run
        s.admit(0, 150, 1, 100)    # starts after the horizon: contributes nothing
        self.assertAlmostEqual(s.busy_in, 50.0)
        self.assertAlmostEqual(s.busy_ns, 110.0)

    def test_saturated_link_does_not_read_zero(self):
        _, s, _ = overflow()
        link = next(iter(s["links"].values()))
        self.assertGreater(link["utilization"], 0.2)
        for u in (link["utilization"], s["pool"]["utilization"]):
            self.assertLessEqual(u, 1.0 + 1e-9)
        # the shared pool carries both directions, so it is at least as busy as either link direction
        self.assertGreaterEqual(s["pool"]["utilization"], link["utilization"] - 1e-9)

    def test_background_dram_traffic_delays_later_accesses(self):
        spec = SimpleNamespace(latency_ns=90.0, bandwidth_bytes_per_ns=400.0, read_latency_factor=1.0,
                               write_latency_factor=1.0)
        t = LocalTier(spec)
        idle, _ = t.access(0, 1, 400, False)
        t2 = LocalTier(spec)
        t2.background(0, 4000)
        busy, _ = t2.access(0, 1, 400, False)
        self.assertAlmostEqual(busy[0] - idle[0], 10.0)
        self.assertAlmostEqual(t2.server.busy_in, (4000 + 400) / 400.0)


class OverflowAcceptance(unittest.TestCase):
    """ACCEPTANCE A1.6: a request larger than local DRAM must exercise the pool."""

    def test_overflow_uses_remote_path(self):
        with tempfile.TemporaryDirectory() as d:
            eng, s, _ = overflow(out=d)
            self.assertEqual(s["requests"]["rejected"], 0)
            self.assertGreater(s["traffic"]["remote_read_bytes"], 0)
            self.assertGreater(s["traffic"]["migration_bytes"], 0)
            self.assertGreater(s["traffic"]["spill_bytes"], 0)
            a = s["access"]
            self.assertAlmostEqual(a["local_hit_ratio"] + a["remote_hit_ratio"] + a["miss_ratio"], 1.0, places=5)
            ev = [json.loads(l)["event"] for l in (Path(d) / "events.jsonl").read_text().splitlines()]
            b, e = ev.count("page_migrate_begin"), ev.count("page_migrate_end")
            self.assertGreater(b, 0)
            self.assertGreater(e, 0)
            self.assertLessEqual(e, b)
            for n in eng.nodes:  # capacity accounting still exact with spilled pages
                self.assertLessEqual(n.peak, n.cap)
                local = sum(int((r.where[:r.n_alloc] == 0).sum()) for r in n.active)
                self.assertEqual(n.used, local)
            remote = sum(int((r.where[:r.n_alloc] != 0).sum()) for n in eng.nodes for r in n.active)
            self.assertEqual(eng.pool.used, remote)

    def test_local_only_still_rejects_oversized_requests(self):
        _, s, _ = overflow(policy="local_only")
        self.assertGreater(s["requests"]["rejected"], 0)
        self.assertEqual(s["traffic"]["remote_read_bytes"], 0)
        self.assertEqual(s["traffic"]["spill_bytes"], 0)

    def test_event_log_does_not_change_results(self):
        with tempfile.TemporaryDirectory() as d:
            a = canonical(overflow(out=d)[1])
        b = canonical(overflow()[1])
        self.assertEqual(a, b)


class MetricDefinitions(unittest.TestCase):
    """The normative definitions at the top of ACCEPTANCE.md."""

    def test_hit_ratio_denominator_is_reads(self):
        _, s, m = overflow()
        a = s["access"]
        self.assertEqual(a["count"], a["reads"] + a["writes"])
        self.assertEqual(a["local_hits"] + a["remote_hits"] + a["misses"], a["reads"])
        self.assertEqual(a["ratio_denominator"], "page read accesses")
        self.assertEqual(m["hit_ratio_denominator"], "page_read_accesses")
        self.assertIn("nearest_rank", m["percentile_method"])

    def test_traffic_split_and_transfer_unit_declared(self):
        _, s, _ = overflow()
        t = s["traffic"]
        self.assertEqual(t["remote_read_migration_bytes"] + t["remote_read_demand_bytes"], t["remote_read_bytes"])
        self.assertEqual(t["transfer_granularity"], "page")
        self.assertEqual(t["transfer_bytes"], s["workload"]["page_size_bytes"])
        self.assertTrue(t["evictions_dirty_by_construction"])
        w = s["access"]["warmup"]
        self.assertEqual(w["samples_all"], w["samples_steady_state"] + w["samples_in_warmup"])

    def test_replay_counts_reads_only_in_ratios(self):
        with tempfile.TemporaryDirectory() as d:
            tr = Path(d) / "t.jsonl"
            write_lines(tr, [{"type": "header", "trace_version": "0.1", "source": "test", "label": "synthetic"},
                             rec(0, "alloc", "a", PAGE), rec(10, "write", "a", PAGE), rec(20, "read", "a", PAGE)])
            s, _ = run_raw(trace_scenario(tr))
            a = s["access"]
            self.assertEqual((a["reads"], a["writes"], a["count"]), (1, 1, 2))
            self.assertEqual(a["local_hit_ratio"], 1.0)
            self.assertEqual(s["traffic"]["transfer_granularity"], "object")


class ReplaySpillAndBackpressure(unittest.TestCase):
    def test_object_larger_than_local_spills_instead_of_failing(self):
        with tempfile.TemporaryDirectory() as d:
            tr = Path(d) / "t.jsonl"
            write_lines(tr, [{"type": "header", "trace_version": "0.1", "source": "test", "label": "synthetic"},
                             rec(0, "alloc", "big", 4 * PAGE), rec(10, "read", "big", 2 * PAGE),
                             rec(20, "free", "big", 4 * PAGE)])
            s, _ = run_raw(trace_scenario(tr, local=2 * PAGE))
            self.assertEqual(s["ops"]["alloc_failed"], 0)
            self.assertEqual(s["traffic"]["spill_bytes"], 4 * PAGE)
            self.assertGreater(s["traffic"]["remote_read_bytes"], 0)
            self.assertTrue(s["replay"]["sequence_matches"])

    def _pressure_trace(self, d):
        tr = Path(d) / "t.jsonl"
        lines = [{"type": "header", "trace_version": "0.1", "source": "test", "label": "synthetic"}]
        lines += [rec(i, "alloc", f"o{i}", PAGE) for i in range(8)]
        for rnd in range(6):
            lines += [rec(100 + rnd * 20 + i, "read", f"o{i}", PAGE) for i in range(8)]
        write_lines(tr, lines)
        return tr

    def test_queue_depth_throttles_the_source_in_stall_mode(self):
        with tempfile.TemporaryDirectory() as d:
            tr = self._pressure_trace(d)
            raw = trace_scenario(tr, local=2 * PAGE, duration=50_000_000)
            raw["fabric"]["links"][0]["queue_depth_bytes"] = 2 * PAGE
            stall, m = run_raw(raw, backpressure="stall")
            report, _ = run_raw(raw, backpressure="report")
            self.assertGreater(stall["replay"]["backpressure"]["source_slip_ns"], 0)
            self.assertEqual(report["replay"]["backpressure"]["source_slip_ns"], 0)
            link = next(iter(stall["links"].values()))
            self.assertGreater(link["queue_overflow_events"], 0)
            self.assertGreater(link["backpressure_stall_ns"], 0)
            self.assertEqual(m["backpressure"], "stall")
            again, _ = run_raw(raw, backpressure="stall")
            self.assertEqual(canonical(stall), canonical(again))

    def test_replay_event_log_is_neutral(self):
        with tempfile.TemporaryDirectory() as d:
            raw = trace_scenario(self._pressure_trace(d), local=2 * PAGE, duration=50_000_000)
            with tempfile.TemporaryDirectory() as o:
                a = canonical(run_raw(raw, out_dir=o, event_log=True)[0])
            b = canonical(run_raw(raw, event_log=False)[0])
            self.assertEqual(a, b)


class RealTraces(unittest.TestCase):
    def test_normalize_makes_unsorted_negative_trace_strict_loadable(self):
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / "a.jsonl", Path(d) / "b.jsonl"
            write_lines(src, [{"type": "header", "trace_version": "0.1", "source": "test"},
                              rec(-50, "alloc", "a", PAGE), rec(30, "read", "a", PAGE), rec(10, "write", "a", PAGE),
                              rec(40, "free", "a", PAGE)])
            with self.assertRaises(TraceError):
                load_trace(src, PAGE)
            with self.assertRaises(TraceError):          # a label is never inferred
                normalize_trace(src, dst)
            rep = normalize_trace(src, dst, label="measured")
            self.assertEqual(rep["ts_shift_ns"], 50)
            self.assertEqual(rep["out_of_order_records"], 1)
            lt = load_trace(dst, PAGE)                    # strict: no sort, no best-effort
            self.assertEqual(lt.info["label"], "measured")
            self.assertEqual([o[1] for o in lt.ops], ["alloc", "write", "read", "free"])
            self.assertEqual(lt.info["header"]["normalized_from_sha256"], rep["source_sha256"])
            with self.assertRaises(TraceError):          # cannot silently relabel
                normalize_trace(dst, Path(d) / "c.jsonl", label="calibrated")

    def test_best_effort_reports_broken_pairing(self):
        with tempfile.TemporaryDirectory() as d:
            tr = Path(d) / "t.jsonl"
            write_lines(tr, [{"type": "header", "trace_version": "0.1", "source": "test", "label": "synthetic"},
                             rec(-1, "alloc", "a", PAGE), rec(5, "read", "a", PAGE), rec(9, "free", "a", PAGE)])
            info = load_trace(tr, PAGE, best_effort=True).info
            self.assertEqual(len(info["rejected_lines"]), 1)
            self.assertEqual(info["pairing"]["orphan_frees"], 1)
            self.assertIn("BROKEN", info["best_effort_warning"])

    def test_sort_effect_on_alloc_free_order_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            tr = Path(d) / "t.jsonl"
            write_lines(tr, [{"type": "header", "trace_version": "0.1", "source": "test", "label": "synthetic"},
                             rec(10, "alloc", "b", PAGE), rec(5, "alloc", "a", PAGE)])
            info = load_trace(tr, PAGE, sort=True).info
            self.assertTrue(info["sort_reordered_alloc_free"])

    def _shipped(self, name):
        p = EX / "traces" / name / "kv_trace.normalized.jsonl"
        if not p.is_file():
            self.skipTest(f"{p} not present")
        return p

    def test_measured_vllm_trace_replays_with_matching_sequence(self):
        p = self._shipped("20261029T202303Z-opt-125m")
        s, m = run_raw(trace_scenario(p, local=256 * MIB, duration=1_000_000_000))
        self.assertEqual(s["workload_label"], "measured")
        self.assertTrue(s["replay"]["sequence_matches"])
        self.assertEqual(s["ops"]["anomalies"], {})
        self.assertIsNone(m["label_note"])

    def test_hoist_allocs_is_opt_in_and_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            src, a, b = Path(d) / "a.jsonl", Path(d) / "a2.jsonl", Path(d) / "b.jsonl"
            write_lines(src, [{"type": "header", "trace_version": "0.1", "source": "test"},
                              rec(0, "write", "p", PAGE), rec(9, "alloc", "p", PAGE), rec(12, "free", "p", PAGE)])
            normalize_trace(src, a, label="calibrated")
            self.assertEqual(load_trace(a, PAGE).info["pairing"]["accesses_before_alloc"], 1)   # left as captured
            rep = normalize_trace(src, b, label="calibrated", hoist_allocs=True)
            info = load_trace(b, PAGE).info
            self.assertEqual(rep["hoisted_allocs"], 1)
            self.assertEqual(info["pairing"]["accesses_before_alloc"], 0)
            self.assertEqual(info["header"]["normalization"]["hoisted_allocs"], 1)
            self.assertEqual([o[1] for o in load_trace(b, PAGE).ops], ["alloc", "write", "free"])

    def test_derived_glimmer_trace_loads_strictly_and_is_labeled_calibrated(self):
        p = self._shipped("20261030T000445Z-muse-glimmer-derived")
        lt = load_trace(p, PAGE)
        self.assertEqual(lt.info["label"], "calibrated")
        self.assertEqual(lt.info["header"]["normalization"]["hoisted_allocs"], 104)
        self.assertEqual(lt.info["pairing"]["orphan_frees"], 0)
        self.assertEqual(lt.info["pairing"]["accesses_before_alloc"], 0)

    def test_cli_trace_normalize(self):
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / "a.jsonl", Path(d) / "b.jsonl"
            write_lines(src, [{"type": "header", "trace_version": "0.1", "source": "test"}, rec(2, "alloc", "a", PAGE),
                              rec(1, "write", "a", PAGE)])
            self.assertEqual(cli_main(["trace-normalize", str(src), "-o", str(dst)]), 1)
            self.assertEqual(cli_main(["trace-normalize", str(src), "-o", str(dst), "--label", "synthetic"]), 0)


if __name__ == "__main__":
    unittest.main()
