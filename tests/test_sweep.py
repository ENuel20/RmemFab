"""Sweep runner, guarded compare, and export."""
import csv
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from support import REPO, load_example, write_tmp_scenario
from rmemfab.cli import main
from rmemfab.sweep.compare import ComparisonRefused, compare_runs
from rmemfab.sweep.runner import apply_combo, enumerate_combos, run_sweep

UNIT = 4096
HEADER = {"type": "header", "trace_version": "0.1", "source": "test"}


def micro_trace(path):
    rows = [HEADER,
            {"ts_ns": 10, "op": "alloc", "page_id": "a", "bytes": UNIT, "request_id": "r"},
            {"ts_ns": 20, "op": "alloc", "page_id": "b", "bytes": UNIT, "request_id": "r"},
            {"ts_ns": 30, "op": "read", "page_id": "a", "bytes": UNIT, "request_id": "r"},
            {"ts_ns": 40, "op": "read", "page_id": "a", "bytes": UNIT, "request_id": "r"},
            {"ts_ns": 50, "op": "alloc", "page_id": "c", "bytes": UNIT, "request_id": "r"},
            {"ts_ns": 60, "op": "read", "page_id": "a", "bytes": UNIT, "request_id": "r"},
            {"ts_ns": 70, "op": "read", "page_id": "c", "bytes": UNIT, "request_id": "r"}]
    Path(path).write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")


def trace_base(path, trace_path, local_pages=2, pool_pages=8):
    raw = load_example("phase1-overflow.json")
    raw["name"] = "sweep-base"
    raw["page_size_bytes"] = UNIT
    raw["duration_ns"] = 10_000_000_000
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["metrics"]["sample_interval_ns"] = 1_000_000_000
    raw["nodes"][0]["local_memory"]["capacity_bytes"] = local_pages * UNIT
    raw["nodes"][1]["remote_memory"]["capacity_bytes"] = pool_pages * UNIT
    raw["policy"] = {"name": "swap_remote"}
    raw["workload"] = {"type": "trace", "path": trace_path}
    raw["output"] = {"format": "jsonl", "include_event_log": False}
    Path(path).write_text(json.dumps(raw), encoding="utf-8")


def write_spec(path, base, grid, seeds, **kw):
    spec = {"name": "t", "base": base, "grid": grid, "seeds": seeds,
            "no_events": True, **kw}
    Path(path).write_text(json.dumps(spec), encoding="utf-8")


class SweepUnits(unittest.TestCase):
    def test_enumerate_order_and_policy_reset(self):
        combos = enumerate_combos({"b": [1, 2], "a": [3]}, [7, 8])
        self.assertEqual(len(combos), 4)
        # Sorted keys, seed fastest: (a,b,seed).
        self.assertEqual([dict(c) for c in combos],
                         [{"a": 3, "b": 1, "seed": 7}, {"a": 3, "b": 1, "seed": 8},
                          {"a": 3, "b": 2, "seed": 7}, {"a": 3, "b": 2, "seed": 8}])
        raw = {"policy": {"name": "hot_cold", "params": {"k": 5}}, "seed": 1}
        out = apply_combo(raw, [("policy.name", "swap_remote")])
        self.assertEqual(out["policy"], {"name": "swap_remote"})
        out = apply_combo({"nodes": [{"x": 1}]}, [("nodes.0.x", 9)])
        self.assertEqual(out["nodes"][0]["x"], 9)

    def test_bad_spec_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            sp = str(Path(td) / "spec.json")
            Path(sp).write_text(json.dumps({"grid": {}, "seeds": [1]}), encoding="utf-8")
            with self.assertRaises(Exception) as c:
                run_sweep(sp, str(Path(td) / "out"))
            self.assertIn("base", str(c.exception))


class SweepRuns(unittest.TestCase):
    def _sweep(self, td, grid, seeds, workers=1, **kw):
        micro_trace(str(Path(td) / "t.jsonl"))
        base = str(Path(td) / "base.json")
        trace_base(base, str(Path(td) / "t.jsonl"))
        sp = str(Path(td) / "spec.json")
        write_spec(sp, base, grid, seeds, **kw)
        out = str(Path(td) / "out")
        return run_sweep(sp, out, workers=workers), out

    def test_policy_grid_parallel_and_deterministic(self):
        with tempfile.TemporaryDirectory() as td:
            idx, out = self._sweep(td, {"policy.name": ["swap_remote", "hot_cold"]},
                                   [7, 8], workers=2)
            self.assertEqual(len(idx["combos"]), 4)
            self.assertTrue(all(c["status"] == "completed" for c in idx["combos"]))
            self.assertTrue((Path(out) / "combos" / "0000" / "summary.json").is_file())
            m0 = idx["combos"][0]["metrics"]
            for k in ("read_p95_ns", "local_hit_ratio", "remote_read_bytes",
                      "migration_bytes", "prefetch_accuracy"):
                self.assertIn(k, m0)
            idx1 = json.loads((Path(out) / "sweep.json").read_bytes())
            # Rerun sequentially over the same spec/out: identical results
            # (workers affect wall time only; the count itself is provenance).
            run_sweep(str(Path(td) / "spec.json"), out, workers=1)
            idx2 = json.loads((Path(out) / "sweep.json").read_bytes())
            idx2["workers"] = idx1["workers"]
            self.assertEqual(idx2, idx1)

    def test_failed_combo_recorded_not_dropped(self):
        with tempfile.TemporaryDirectory() as td:
            idx, _ = self._sweep(td, {"policy.name": ["frequency_aware"],
                                      "policy.params.k": [2, 0]}, [7])
            by_status = {c["combo"]: c["status"] for c in idx["combos"]}
            self.assertEqual(by_status, {0: "completed", 1: "failed"})
            self.assertIn("policy.params", idx["combos"][1]["error"])
            self.assertIsNone(idx["combos"][1]["metrics"])


class Compare(unittest.TestCase):
    def _two_policy_sweep(self, td):
        micro_trace(str(Path(td) / "t.jsonl"))
        base = str(Path(td) / "base.json")
        trace_base(base, str(Path(td) / "t.jsonl"))
        sp = str(Path(td) / "spec.json")
        write_spec(sp, base, {"policy.name": ["swap_remote", "hot_cold"]}, [7])
        return run_sweep(sp, str(Path(td) / "out"), workers=1), str(Path(td) / "out")

    def test_same_seed_table(self):
        with tempfile.TemporaryDirectory() as td:
            _, out = self._two_policy_sweep(td)
            rep = compare_runs([str(Path(out) / "combos" / "0000"),
                                str(Path(out) / "combos" / "0001")])
            self.assertEqual(rep["mode"], "same_seed")
            self.assertEqual(rep["policies"], ["hot_cold", "swap_remote"])
            for k in ("read_p95_ns", "local_hit_ratio", "remote_read_bytes",
                      "migration_bytes", "prefetch_accuracy"):
                self.assertIn(k, rep["runs"][0])

    def test_refuses_uncontrolled(self):
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"))
            outs = []
            for i, cap in enumerate((2, 4)):
                base = str(Path(td) / f"base{i}.json")
                trace_base(base, str(Path(td) / "t.jsonl"), local_pages=cap)
                sp = str(Path(td) / f"spec{i}.json")
                write_spec(sp, base, {"policy.name": ["swap_remote"]}, [7])
                run_sweep(sp, str(Path(td) / f"out{i}"), workers=1)
                outs.append(str(Path(td) / f"out{i}" / "combos" / "0000"))
            with self.assertRaises(ComparisonRefused) as c:
                compare_runs(outs)
            self.assertIn("local_memory.capacity_bytes", str(c.exception))

    def test_refuses_seed_mix_without_flag(self):
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"))
            base = str(Path(td) / "base.json")
            trace_base(base, str(Path(td) / "t.jsonl"))
            sp = str(Path(td) / "spec.json")
            write_spec(sp, base, {"policy.name": ["swap_remote"]}, [7, 8])
            run_sweep(sp, str(Path(td) / "out"), workers=1)
            b = [str(Path(td) / "out" / "combos" / f"{i:04d}") for i in (0, 1)]
            with self.assertRaises(ComparisonRefused):
                compare_runs(b)
            rep = compare_runs(b, multi_seed=True)
            g = rep["groups"]["swap_remote"]["metrics"]["read_p50_ns"]
            self.assertEqual(g["n"], 2)
            self.assertIsNotNone(g["ci95"])  # degenerate 0-width: replay ignores seed

    def test_multi_seed_ci_math(self):
        # Synthetic workload: seeds vary arrivals, so CIs have real width.
        with tempfile.TemporaryDirectory() as td:
            base = str(Path(td) / "base.json")
            raw = load_example("phase1-overflow.json")
            raw["output"] = {"format": "jsonl", "include_event_log": False}
            Path(base).write_text(json.dumps(raw), encoding="utf-8")
            sp = str(Path(td) / "spec.json")
            write_spec(sp, base, {"policy.name": ["swap_remote", "frequency_aware"]},
                       [7, 8, 9])
            run_sweep(sp, str(Path(td) / "out"), workers=2)
            bundles = [str(Path(td) / "out" / "combos" / f"{i:04d}") for i in range(6)]
            rep = compare_runs(bundles, multi_seed=True)
            for pol in ("swap_remote", "frequency_aware"):
                g = rep["groups"][pol]["metrics"]["read_p50_ns"]
                self.assertEqual(g["n"], 3)
                self.assertIsNotNone(g["ci95"])
                self.assertGreaterEqual(g["mean"], min(g["values"]))
                self.assertLessEqual(g["mean"], max(g["values"]))


class Export(unittest.TestCase):
    def test_bundle_and_sweep_csv(self):
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"))
            base = str(Path(td) / "base.json")
            trace_base(base, str(Path(td) / "t.jsonl"))
            sp = str(Path(td) / "spec.json")
            write_spec(sp, base, {"policy.name": ["swap_remote", "hot_cold"],
                                  "policy.params.cold_threshold": [1]}, [7])
            run_sweep(sp, str(Path(td) / "out"), workers=1)
            self.assertEqual(main(["export", str(Path(td) / "out"), "--out",
                                   str(Path(td) / "csv")]), 0)
            rows = list(csv.DictReader(
                open(Path(td) / "csv" / "sweep.csv", encoding="utf-8")))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["param:policy.name"], "swap_remote")
            # CSV cell matches the bundle summary on disk (export never recomputes).
            s = json.loads((Path(td) / "out" / "combos" / "0000" /
                            "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(rows[0]["local_hit_ratio"],
                             repr(s["access"]["local_hit_ratio"]))
            self.assertEqual(main(["export", str(Path(td) / "out" / "combos" / "0000"),
                                   "--out", str(Path(td) / "one"), "--format", "json"]), 0)
            self.assertTrue((Path(td) / "one" / "summary.json").is_file())

    def test_cli_sweep_compare(self):
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"))
            base = str(Path(td) / "base.json")
            trace_base(base, str(Path(td) / "t.jsonl"))
            sp = str(Path(td) / "spec.json")
            write_spec(sp, base, {"policy.name": ["swap_remote", "hot_cold"]}, [7])
            self.assertEqual(main(["sweep", sp, "--out", str(Path(td) / "out"),
                                   "--workers", "1"]), 0)
            b = [str(Path(td) / "out" / "combos" / f"{i:04d}") for i in (0, 1)]
            buf = io.StringIO()
            with redirect_stdout(buf):
                self.assertEqual(main(["compare"] + b), 0)
            self.assertIn("local_hit_ratio", buf.getvalue())
            self.assertIn("DIRECTIONAL", buf.getvalue())
            buf = io.StringIO()
            with redirect_stdout(buf):
                self.assertEqual(main(["compare"] + b + ["--format", "json"]), 0)
            rep = json.loads(buf.getvalue())
            self.assertEqual(rep["mode"], "same_seed")
            self.assertIn("directional", rep["verdict"])

    def test_cli_scenario_mode_set_brackets(self):
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"))
            base = str(Path(td) / "base.json")
            trace_base(base, str(Path(td) / "t.jsonl"))
            # Bracket path + string values; seeds from the flag.
            self.assertEqual(main(["sweep", base, "--out", str(Path(td) / "out"),
                                   "--set", "policy.name=swap_remote,hot_cold",
                                   "--set", "nodes[0].local_memory.latency_ns=90,100",
                                   "--seeds", "7", "--no-events"]), 0)
            idx = json.loads((Path(td) / "out" / "sweep.json").read_text(encoding="utf-8"))
            self.assertEqual(len(idx["combos"]), 4)
            self.assertTrue(all(c["status"] == "completed" for c in idx["combos"]))
            lat = json.loads((Path(td) / "out" / "combos" / "0001" /
                              "scenario.json").read_text(encoding="utf-8"))
            self.assertEqual(lat["nodes"][0]["local_memory"]["latency_ns"], 100)

    def test_bad_grid_path_recorded(self):
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"))
            base = str(Path(td) / "base.json")
            trace_base(base, str(Path(td) / "t.jsonl"))
            sp = str(Path(td) / "spec.json")
            write_spec(sp, base, {"nodes[9].x": [1]}, [7])
            idx = run_sweep(sp, str(Path(td) / "out"), workers=1)
            self.assertEqual(idx["combos"][0]["status"], "failed")
            self.assertIn("grid path", idx["combos"][0]["error"])

    def test_refuses_version_mix(self):
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"))
            base = str(Path(td) / "base.json")
            trace_base(base, str(Path(td) / "t.jsonl"))
            sp = str(Path(td) / "spec.json")
            write_spec(sp, base, {"policy.name": ["swap_remote", "hot_cold"]}, [7])
            run_sweep(sp, str(Path(td) / "out"), workers=1)
            b0 = Path(td) / "out" / "combos" / "0000"
            m = json.loads((b0 / "manifest.json").read_text(encoding="utf-8"))
            m["rmemfab_version"] = "0.0-test"
            (b0 / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
            with self.assertRaises(ComparisonRefused) as c:
                compare_runs([str(b0), str(Path(td) / "out" / "combos" / "0001")])
            self.assertIn("versions differ", str(c.exception))


if __name__ == "__main__":
    unittest.main()
