"""Phase 5 faults: validation, degradation, loss, failure/recovery, replay."""
import json
import tempfile
import unittest
from pathlib import Path

from support import load_example, read_jsonl, run_engine, tmp_scenario, write_tmp_scenario
from rmemfab.config.scenario import ScenarioError, build_scenario, load_raw, validate
from rmemfab.core.engine import Engine
from rmemfab.memory.servers import Server
from rmemfab.telemetry.summary import canonical
from rmemfab.trace.replay import ReplayDivergence, ReplayEngine

UNIT = 4096
HEADER = {"type": "header", "trace_version": "0.1", "source": "test"}


def micro_trace(rows):
    import tempfile as _tf
    f = _tf.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
    f.write(json.dumps(HEADER) + "\n")
    for r in rows:
        f.write(json.dumps(r) + "\n")
    f.close()
    return f.name


def op(ts, op, page, req="r0", nbytes=UNIT):
    return {"ts_ns": ts, "op": op, "page_id": page, "request_id": req, "bytes": nbytes}


def trace_scenario(trace_path, faults=None, event_log=False):
    raw = load_example("phase1-overflow.json")
    raw["name"] = "fault-test"
    raw["page_size_bytes"] = UNIT
    raw["duration_ns"] = 10_000_000_000
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["metrics"]["sample_interval_ns"] = 1_000_000_000
    raw["nodes"][0]["local_memory"]["capacity_bytes"] = 2 * UNIT
    raw["nodes"][1]["remote_memory"]["capacity_bytes"] = 16 * UNIT
    raw["workload"] = {"type": "trace", "path": trace_path}
    raw["output"] = {"format": "jsonl", "include_event_log": event_log}
    if faults is not None:
        raw["faults"] = faults
    return write_tmp_scenario(raw)


def run_trace(path, outdir, event_log=False):
    sc = build_scenario(load_raw(path), base_dir=str(Path(path).parent))
    return ReplayEngine(sc, sc.trace, outdir, event_log=event_log).run()


def synth_with_faults(faults):
    return tmp_scenario("phase1-overflow.json",
                        lambda raw: raw.update({"faults": faults}))


class TestRescale(unittest.TestCase):
    def test_rescale_stretches_unfinished_fluid(self):
        s = Server(10.0)
        s.admit(0.0, 0.0, 100)   # free_at = 10
        s.rescale(5.0, 4.0)      # 6ns of work left -> 12ns at half rate
        self.assertAlmostEqual(s.free_at, 16.0)
        self.assertAlmostEqual(s.busy_ns, 16.0)
        self.assertAlmostEqual(s.backlog_bytes(4.0), 60.0)

    def test_rescale_idle_is_free(self):
        s = Server(10.0)
        s.admit(0.0, 0.0, 100)
        s.rescale(5.0, 20.0)
        self.assertAlmostEqual(s.free_at, 10.0)
        self.assertAlmostEqual(s.busy_ns, 10.0)
        self.assertEqual(s.bw, 5.0)


class TestFaultValidation(unittest.TestCase):
    def test_unknown_targets_rejected(self):
        raw = load_example("phase1-overflow.json")
        raw["faults"] = {"node_failures": [{"time_ns": 1, "node": "nope", "repair_ns": 1}],
                         "link_degradations": [],
                         "packet_loss": {"enabled": False, "ppm": 0}}
        errors, _, _ = validate(raw, for_run=True)
        self.assertTrue(any("nope" in e for e in errors), errors)
        raw["faults"] = {"node_failures": [],
                         "link_degradations": [{"start_ns": 1, "end_ns": 2, "link": "nope"}],
                         "packet_loss": {"enabled": False, "ppm": 0}}
        errors, _, _ = validate(raw, for_run=True)
        self.assertTrue(any("nope" in e for e in errors), errors)

    def test_bad_window_rejected(self):
        raw = load_example("phase1-overflow.json")
        raw["faults"] = {"node_failures": [],
                         "link_degradations": [{"start_ns": 5, "end_ns": 5,
                                                "link": "node-0-cxl"}],
                         "packet_loss": {"enabled": False, "ppm": 0}}
        errors, _, _ = validate(raw, for_run=True)
        self.assertTrue(any("end_ns" in e for e in errors), errors)

    def test_overlap_rejected(self):
        raw = load_example("phase1-overflow.json")
        raw["faults"] = {
            "node_failures": [{"time_ns": 1, "node": "node-0", "repair_ns": 10},
                              {"time_ns": 5, "node": "node-0", "repair_ns": 10}],
            "link_degradations": [], "packet_loss": {"enabled": False, "ppm": 0}}
        errors, _, _ = validate(raw, for_run=True)
        self.assertTrue(any("overlapping" in e for e in errors), errors)

    def test_stochastic_process_warns(self):
        raw = load_example("phase1-overflow.json")
        raw["faults"] = {"node_failures": [], "link_degradations": [],
                         "packet_loss": {"enabled": False, "ppm": 0},
                         "node_failure_process": {"enabled": True, "mtbf_ns": 10}}
        errors, warnings, _ = validate(raw, for_run=True)
        self.assertEqual(errors, [])
        self.assertTrue(any("node_failure_process" in w for w in warnings), warnings)


class TestEngineFaults(unittest.TestCase):
    def test_pristine_has_no_fault_model(self):
        sc = build_scenario(load_example("phase1-overflow.json"))
        self.assertIsNone(Engine(sc, None, event_log=False).faults)

    def test_degradation_slows_link(self):
        deg = {"node_failures": [],
               "link_degradations": [{"start_ns": 0, "end_ns": 10_000_000_000,
                                      "link": "node-0-cxl", "bandwidth_factor": 0.5,
                                      "latency_factor": 2.0}],
               "packet_loss": {"enabled": False, "ppm": 0}}
        base, _ = run_engine(tmp_scenario("phase1-overflow.json"), tempfile.mkdtemp(),
                             event_log=False)
        slow, _ = run_engine(synth_with_faults(deg), tempfile.mkdtemp(), event_log=False)
        lb = base["links"]["node-0-cxl"]
        ls = slow["links"]["node-0-cxl"]
        self.assertGreater(ls["busy_ns"], lb["busy_ns"])
        self.assertGreater(slow["access"]["latency_ns"]["mean"],
                           base["access"]["latency_ns"]["mean"])
        self.assertEqual(len(slow["degraded"]["windows"]), 1)

    def test_loss_counters_and_determinism(self):
        loss = {"node_failures": [], "link_degradations": [],
                "packet_loss": {"enabled": True, "ppm": 1_000_000}}
        path = synth_with_faults(loss)
        a, _ = run_engine(path, tempfile.mkdtemp(), event_log=False)
        b, _ = run_engine(path, tempfile.mkdtemp(), event_log=False)
        self.assertGreater(a["degraded"]["loss_events"], 0)
        self.assertGreater(a["degraded"]["retransmit_bytes"], 0)
        self.assertEqual(canonical(a), canonical(b))

    def test_node_failure_parks_and_recovers(self):
        out = tempfile.mkdtemp()
        summary, _ = run_engine(tmp_scenario("phase5-fault-recovery.json"), out)
        self.assertGreater(summary["degraded"]["stalled_requests"], 0)
        ev = read_jsonl(str(Path(out) / "events.jsonl"))
        fail = [e for e in ev if e["event"] == "node_fail"]
        rec = [e for e in ev if e["event"] == "node_recover"]
        self.assertEqual(len(fail), 1)
        self.assertEqual(fail[0]["time_ns"], 4_000_000_000)
        self.assertEqual(fail[0]["data"]["recovery_ns"], 5_000_000_000)
        self.assertEqual(len(rec), 1)
        self.assertEqual(rec[0]["time_ns"], 5_000_000_000)
        deg = [e for e in ev if e["event"] == "link_degraded"]
        self.assertEqual(deg[0]["time_ns"], 3_000_000_000)
        for m in summary["memory"].values():
            self.assertGreaterEqual(m["final_used_pages"], 0)
        for p in summary["pools"].values():
            self.assertGreaterEqual(p["final_used_pages"], 0)

    def test_permanent_failure_rejects_cleanly(self):
        perm = {"node_failures": [{"time_ns": 1_000_000_000, "node": "node-0",
                                   "reason": "permanent"}],
                "link_degradations": [], "packet_loss": {"enabled": False, "ppm": 0}}
        summary, _ = run_engine(synth_with_faults(perm), tempfile.mkdtemp(),
                                event_log=False)
        # Unrecoverable: immediate reject, nothing parked.
        self.assertEqual(summary["degraded"]["stalled_requests"], 0)
        self.assertGreater(summary["requests"]["rejected"], 0)
        self.assertIn("node_failed", summary["requests"]["reject_reasons"])
        for m in summary["memory"].values():
            self.assertGreaterEqual(m["final_used_pages"], 0)
            self.assertLessEqual(m["final_used_pages"], m["capacity_pages"])
        for p in summary["pools"].values():
            self.assertGreaterEqual(p["final_used_pages"], 0)


class TestReplayFaults(unittest.TestCase):
    def test_replay_degradation_and_loss(self):
        tp = micro_trace([op(10, "alloc", "a"), op(20, "alloc", "b"),
                          op(30, "alloc", "c"),
                          op(100, "read", "a"), op(200, "read", "b"), op(300, "read", "c")])
        faults = {"node_failures": [],
                  "link_degradations": [{"start_ns": 0, "end_ns": 10_000_000_000,
                                         "link": "node-0-cxl",
                                         "bandwidth_factor": 0.5}],
                  "packet_loss": {"enabled": True, "ppm": 1_000_000}}
        path = trace_scenario(tp, faults)
        a, _ = run_trace(path, tempfile.mkdtemp())
        b, _ = run_trace(path, tempfile.mkdtemp())
        self.assertGreater(a["degraded"]["loss_events"], 0)
        self.assertEqual(len(a["degraded"]["windows"]), 1)
        self.assertEqual(canonical(a), canonical(b))

    def test_replay_node_down_halts_with_row(self):
        tp = micro_trace([op(10, "alloc", "a"), op(5_000_000_000, "read", "a")])
        faults = {"node_failures": [{"time_ns": 1_000_000_000, "node": "node-0",
                                     "repair_ns": 8_000_000_000}],
                  "link_degradations": [], "packet_loss": {"enabled": False, "ppm": 0}}
        path = trace_scenario(tp, faults)
        sc = build_scenario(load_raw(path), base_dir=str(Path(path).parent))
        with self.assertRaises(ReplayDivergence) as cm:
            ReplayEngine(sc, sc.trace, tempfile.mkdtemp(), event_log=False).run()
        self.assertIn("row 3", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
