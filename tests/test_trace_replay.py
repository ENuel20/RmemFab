"""Replay: fidelity to the trace, shared rulebook with synthetic, scale."""
import copy
import filecmp
import json
import tempfile
import unittest
from pathlib import Path

from support import REPO, load_example, read_jsonl, run_engine, write_tmp_scenario
from rmemfab.config.scenario import build_scenario, load_raw
from rmemfab.trace.replay import ReplayDivergence, ReplayEngine

OPT = str(REPO / "examples" / "traces" / "20261029T202303Z-opt-125m" / "kv_trace.jsonl")
UNIT = 589824


def trace_scenario(trace_path, page_size, local_bytes, pool_bytes, duration_ns=1_000_000_000,
                   policy="swap_remote", **wl_opts):
    raw = load_example("phase1-overflow.json")
    raw["name"] = "replay-test"
    raw["page_size_bytes"] = page_size
    raw["duration_ns"] = duration_ns
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["nodes"][0]["local_memory"]["capacity_bytes"] = local_bytes
    raw["metrics"]["sample_interval_ns"] = 100_000_000
    if pool_bytes is None:
        raw["nodes"] = [raw["nodes"][0]]
        raw["fabric"]["links"] = []
    else:
        raw["nodes"][1]["remote_memory"]["capacity_bytes"] = pool_bytes
    raw["policy"] = {"name": policy}
    raw["workload"] = {"type": "trace", "path": trace_path, **wl_opts}
    raw["output"] = {"format": "jsonl", "include_event_log": True}
    return write_tmp_scenario(raw)


def run_trace(path, outdir, **kw):
    sc = build_scenario(load_raw(path), base_dir=str(Path(path).parent))
    return ReplayEngine(sc, sc.trace, outdir, **kw).run()


class TestOptReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp(prefix="rmemfab-opt-")
        scen = trace_scenario(OPT, UNIT, 16 * UNIT, 1 << 30)
        cls.summary, cls.manifest = run_trace(scen, cls.out)
        cls.events = read_jsonl(f"{cls.out}/events.jsonl")

    def test_alloc_free_sequence_preserved(self):
        kinds = [e["event"] for e in self.events]
        self.assertEqual(kinds.count("page_allocate"), 136)
        self.assertEqual(kinds.count("page_free"), 136)

    def test_remote_path_exercised(self):
        t = self.summary["traffic"]
        self.assertGreater(t["remote_read_bytes"], 0)
        self.assertGreater(t["migration_bytes"], 0)
        self.assertGreater(self.summary["access"]["stall_ns"], 0)

    def test_no_stall_without_contention(self):
        # valid-min spaces its ops apart on an idle server: every access pays
        # exactly the idle cost, so stall is exactly zero. (OPT always shows
        # stall: its 124 writes share the tier server with 4144 reads.)
        out = tempfile.mkdtemp(prefix="rmemfab-min-idle-")
        scen = trace_scenario(str(REPO / "tests" / "fixtures" / "traces" / "valid-min.jsonl"),
                              4096, 1 << 20, 1 << 20, round_bytes=True)
        summary, _ = run_trace(scen, out, event_log=False)
        self.assertEqual(summary["access"]["stall_ns"], 0)
        self.assertEqual(summary["access"]["local_hit_ratio"], 1.0)

    def test_ratios_sum_to_one(self):
        a = self.summary["access"]
        self.assertAlmostEqual(a["local_hit_ratio"] + a["remote_hit_ratio"] + a["miss_ratio"], 1.0)

    def test_manifest_records_trace(self):
        self.assertEqual(self.summary["workload_label"], "trace")
        self.assertEqual(len(self.manifest["trace_hashes"]), 1)
        tr = self.summary["trace"]
        self.assertEqual(tr["ops"], 4540)
        self.assertEqual(tr["pages"], 136)
        self.assertEqual(tr["unit_bytes"], UNIT)
        self.assertIn(self.manifest["trace_hashes"][0][:8], self.summary["run_id"])

    def test_all_local_means_unit_ratio(self):
        out = tempfile.mkdtemp(prefix="rmemfab-opt-big-")
        scen = trace_scenario(OPT, UNIT, 1 << 30, 1 << 30)
        summary, _ = run_trace(scen, out, event_log=False)
        self.assertEqual(summary["access"]["local_hit_ratio"], 1.0)
        self.assertEqual(summary["traffic"]["remote_read_bytes"], 0)

    def test_determinism(self):
        scen = trace_scenario(OPT, UNIT, 16 * UNIT, 1 << 30)
        a = tempfile.mkdtemp(prefix="rmemfab-rp-a-")
        b = tempfile.mkdtemp(prefix="rmemfab-rp-b-")
        sa, _ = run_trace(scen, a)
        sb, _ = run_trace(scen, b)
        from rmemfab.telemetry.summary import canonical
        self.assertEqual(canonical(sa), canonical(sb))
        for fname in ("summary.json", "manifest.json", "events.jsonl", "series.jsonl"):
            self.assertTrue(filecmp.cmp(f"{a}/{fname}", f"{b}/{fname}", shallow=False), fname)

    def test_overcommit_halts_with_row(self):
        scen = trace_scenario(OPT, UNIT, UNIT, UNIT)
        sc = build_scenario(load_raw(scen), base_dir=str(Path(scen).parent))
        with self.assertRaises(ReplayDivergence) as cm:
            ReplayEngine(sc, sc.trace, tempfile.mkdtemp(), event_log=False).run()
        self.assertIn("row", str(cm.exception))

    def test_beyond_duration_dropped_and_counted(self):
        out = tempfile.mkdtemp(prefix="rmemfab-opt-drop-")
        scen = trace_scenario(OPT, UNIT, 1 << 30, 1 << 30, duration_ns=100_000_000)
        summary, _ = run_trace(scen, out, event_log=False)
        self.assertGreater(summary["trace"]["dropped_beyond_duration"], 0)


class TestReplaySemantics(unittest.TestCase):
    def _inline_trace(self, ops):
        header = {"type": "header", "trace_version": "0.1", "source": "test"}
        tf = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        tf.write(json.dumps(header) + "\n")
        for o in ops:
            tf.write(json.dumps(o) + "\n")
        tf.close()
        return tf.name

    def test_single_op_replay(self):
        tp = self._inline_trace([
            {"ts_ns": 0, "op": "alloc", "page_id": "p1", "bytes": 4096, "request_id": "r"},
        ])
        scen = trace_scenario(tp, 4096, 1 << 20, 1 << 20)
        out = tempfile.mkdtemp(prefix="rmemfab-single-")
        summary, _ = run_trace(scen, out, event_log=False)
        self.assertEqual(summary["memory"]["node-0"]["peak_used_pages"], 1)
        self.assertEqual(summary["trace"]["ops"], 1)

    def test_same_timestamp_reads_batch_identically(self):
        unit = 4096
        ops = [{"ts_ns": 0, "op": "alloc", "page_id": f"p{i}", "bytes": unit,
                "request_id": "r"} for i in range(2)]
        ops += [{"ts_ns": 100, "op": "read", "page_id": f"p{i}", "bytes": unit,
                 "request_id": "r"} for i in range(2)]
        ops += [{"ts_ns": 200, "op": "free", "page_id": f"p{i}", "bytes": unit,
                 "request_id": "r"} for i in range(2)]
        tp = self._inline_trace(ops)
        raw = load_example("phase1-overflow.json")
        raw["name"] = "replay-batch"
        raw["page_size_bytes"] = unit
        raw["duration_ns"] = 1_000_000_000
        raw["warmup_ns"] = 0
        raw["metrics"]["warmup_ns"] = 0
        raw["nodes"][0]["local_memory"]["capacity_bytes"] = 1 << 20
        raw["nodes"][0]["local_memory"]["latency_ns"] = 90.0
        raw["nodes"][0]["local_memory"]["bandwidth_bytes_per_ns"] = 400.0
        raw["nodes"][1]["remote_memory"]["capacity_bytes"] = 1 << 30
        raw["policy"] = {"name": "local_only"}
        raw["workload"] = {"type": "trace", "path": tp}
        raw["output"] = {"format": "jsonl", "include_event_log": False}
        out = tempfile.mkdtemp(prefix="rmemfab-batch-")
        sc = build_scenario(load_raw(write_tmp_scenario(raw)),
                            base_dir=tempfile.gettempdir())
        summary, _ = ReplayEngine(sc, sc.trace, out, event_log=False).run()
        self.assertEqual(summary["access"]["count"], 2)
        self.assertAlmostEqual(summary["access"]["latency_ns"]["mean"],
                               90.0 + unit / 400.0, places=6)


class TestTwinDrivers(unittest.TestCase):
    """Same machine, same 8-page workload, both drivers: identical reads."""

    def test_synthetic_and_replay_agree(self):
        unit = 1 << 20
        header = {"type": "header", "trace_version": "0.1", "source": "test"}
        rows = [header]
        for i in range(9):
            rows.append({"ts_ns": 0, "op": "alloc", "page_id": f"p{i}", "bytes": unit,
                         "request_id": "r"})
        rows.append({"ts_ns": 100, "op": "write", "page_id": "p8", "bytes": unit,
                     "request_id": "r"})
        for i in range(9):
            rows.append({"ts_ns": 100, "op": "read", "page_id": f"p{i}", "bytes": unit,
                         "request_id": "r"})
        for i in range(9):
            rows.append({"ts_ns": 200, "op": "free", "page_id": f"p{i}", "bytes": unit,
                         "request_id": "r"})
        tf = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        tf.write("\n".join(json.dumps(r) for r in rows) + "\n")
        tf.close()
        machine = dict(local_bytes=16 * unit, pool_bytes=1 << 30, duration_ns=1_000_000_000)
        tscen = trace_scenario(tf.name, unit, machine["local_bytes"], machine["pool_bytes"],
                               machine["duration_ns"])
        tout = tempfile.mkdtemp(prefix="rmemfab-twin-t-")
        tsyn, _ = run_trace(tscen, tout, event_log=False)

        sraw = load_example("phase1-overflow.json")
        sraw["name"] = "twin-synthetic"
        sraw["page_size_bytes"] = unit
        sraw["duration_ns"] = machine["duration_ns"]
        sraw["warmup_ns"] = 0
        sraw["metrics"]["warmup_ns"] = 0
        sraw["nodes"][0]["local_memory"]["capacity_bytes"] = 16 * unit
        sraw["nodes"][0]["local_memory"]["latency_ns"] = 90.0
        sraw["nodes"][0]["local_memory"]["bandwidth_bytes_per_ns"] = 400.0
        sraw["nodes"][1]["remote_memory"]["capacity_bytes"] = machine["pool_bytes"]
        sraw["policy"] = {"name": "local_only"}
        sraw["workload"] = {
            "type": "synthetic", "profile": "kv_cache_decode",
            "model": {"layer_classes": [{"name": "dense", "layers": 1,
                                         "kv_bytes_per_token": unit}]},
            "requests": {"arrival_process": "poisson", "arrival_rate_per_second": 10.0,
                         "prompt_tokens": 8, "generated_tokens": 1, "concurrency": 1},
        }
        sraw["output"] = {"format": "jsonl", "include_event_log": False}
        spath = write_tmp_scenario(sraw)
        sout = tempfile.mkdtemp(prefix="rmemfab-twin-s-")
        ssyn, _ = run_engine(spath, sout)
        self.assertEqual(tsyn["access"]["count"], 9)
        # Synthetic runs an arrival process: every decode step grows to 9 pages
        # (prompt 8 + new token) and reads all 9, so reads are a positive
        # multiple of 9.
        self.assertGreater(ssyn["access"]["count"], 0)
        self.assertEqual(ssyn["access"]["count"] % 9, 0)
        self.assertEqual(tsyn["access"]["local_hit_ratio"], 1.0)
        self.assertEqual(ssyn["access"]["local_hit_ratio"], 1.0)
        self.assertEqual(tsyn["traffic"]["remote_read_bytes"], 0)
        self.assertEqual(ssyn["traffic"]["remote_read_bytes"], 0)
        self.assertAlmostEqual(tsyn["access"]["latency_ns"]["mean"],
                               ssyn["access"]["latency_ns"]["mean"], delta=1.0)


class TestScale(unittest.TestCase):
    def test_million_op_replay_completes(self):
        unit = 4096
        tf = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        tf.write(json.dumps({"type": "header", "trace_version": "0.1", "source": "test"}) + "\n")
        pages = 2000
        for i in range(pages):
            tf.write(json.dumps({"ts_ns": 0, "op": "alloc", "page_id": f"p{i}",
                                 "bytes": unit, "request_id": "r"}) + "\n")
        n_reads = 996_000
        for i in range(n_reads):
            tf.write(json.dumps({"ts_ns": 1 + i, "op": "read", "page_id": f"p{i % pages}",
                                 "bytes": unit, "request_id": "r"}) + "\n")
        for i in range(pages):
            tf.write(json.dumps({"ts_ns": 2 + n_reads, "op": "free", "page_id": f"p{i}",
                                 "bytes": unit, "request_id": "r"}) + "\n")
        tf.close()
        scen = trace_scenario(tf.name, unit, 64 << 20, 1 << 30, duration_ns=10_000_000_000)
        out = tempfile.mkdtemp(prefix="rmemfab-scale-")
        summary, _ = run_trace(scen, out, event_log=False)
        self.assertEqual(summary["access"]["count"], n_reads)
        self.assertEqual(summary["memory"]["node-0"]["peak_used_pages"], pages)


if __name__ == "__main__":
    unittest.main()
