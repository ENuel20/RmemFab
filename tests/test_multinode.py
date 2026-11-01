"""Multi-node: switch contention, per-node policy/admission, replay sharding."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from support import REPO, load_example, write_tmp_scenario
from rmemfab.config.scenario import ScenarioError, build_scenario, load_raw
from rmemfab.core.engine import Engine
from rmemfab.trace.replay import ReplayDivergence, ReplayEngine
from rmemfab.trace.validate import load_trace

UNIT = 4096
HEADER = {"type": "header", "trace_version": "0.1", "source": "test"}


def two_node_synthetic(duration_ns=500_000_000, switch=None, arrival=10.0,
                       local_pages=64, policy="swap_remote"):
    raw = load_example("phase1-overflow.json")
    raw["name"] = "multinode-test"
    raw["page_size_bytes"] = UNIT
    raw["duration_ns"] = duration_ns
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["metrics"]["sample_interval_ns"] = 500_000_000
    n0 = raw["nodes"][0]
    n0["local_memory"]["capacity_bytes"] = local_pages * UNIT
    n1 = copy.deepcopy(n0)
    n1["id"] = "node-1"
    raw["nodes"] = [n0, n1, raw["nodes"][1]]
    l0 = raw["fabric"]["links"][0]
    l1 = copy.deepcopy(l0)
    l1["id"] = "node-1-cxl"
    l1["from"] = "node-1"
    raw["fabric"]["links"] = [l0, l1]
    if switch is not None:
        raw["fabric"]["switch"] = switch
    raw["workload"]["requests"]["arrival_rate_per_second"] = arrival
    raw["workload"]["requests"]["prompt_tokens"] = 64
    raw["workload"]["requests"]["generated_tokens"] = 4
    raw["policy"] = {"name": policy}
    raw["output"] = {"format": "jsonl", "include_event_log": False}
    return write_tmp_scenario(raw)


def run_synth(path, outdir):
    sc = build_scenario(load_raw(path), base_dir=str(Path(path).parent))
    summary, _ = Engine(sc, outdir, event_log=False).run()
    return summary


def micro_trace(path, rows):
    Path(path).write_text("\n".join([json.dumps(HEADER)] + [json.dumps(r) for r in rows]) + "\n",
                          encoding="utf-8")


def op(ts, op, page, req="r0", nbytes=UNIT, node=None):
    r = {"ts_ns": ts, "op": op, "page_id": page, "request_id": req, "bytes": nbytes}
    if node is not None:
        r["node"] = node
    return r


def two_node_trace_base(path, trace_path, local_pages=2, pool_pages=16, policy="swap_remote",
                        switch=None):
    raw = load_example("phase1-overflow.json")
    raw["name"] = "multinode-replay-test"
    raw["page_size_bytes"] = UNIT
    raw["duration_ns"] = 10_000_000_000
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["metrics"]["sample_interval_ns"] = 1_000_000_000
    n0 = raw["nodes"][0]
    n0["local_memory"]["capacity_bytes"] = local_pages * UNIT
    n1 = copy.deepcopy(n0)
    n1["id"] = "node-1"
    raw["nodes"] = [n0, n1, raw["nodes"][1]]
    raw["nodes"][2]["remote_memory"]["capacity_bytes"] = pool_pages * UNIT
    l0 = raw["fabric"]["links"][0]
    l1 = copy.deepcopy(l0)
    l1["id"] = "node-1-cxl"
    l1["from"] = "node-1"
    raw["fabric"]["links"] = [l0, l1]
    if switch is not None:
        raw["fabric"]["switch"] = switch
    raw["policy"] = {"name": policy}
    raw["workload"] = {"type": "trace", "path": trace_path}
    raw["output"] = {"format": "jsonl", "include_event_log": False}
    Path(path).write_text(json.dumps(raw), encoding="utf-8")


def run_replay(path, outdir):
    sc = build_scenario(load_raw(path), base_dir=str(Path(path).parent))
    summary, _ = ReplayEngine(sc, sc.trace, outdir, event_log=False).run()
    return summary


class SwitchContention(unittest.TestCase):
    def test_tight_switch_queues_and_reports(self):
        with tempfile.TemporaryDirectory() as td:
            fat = run_synth(two_node_synthetic(
                switch={"bandwidth_bytes_per_ns": 1e9, "latency_ns": 0}), td + "/fat")
            thin = run_synth(two_node_synthetic(
                switch={"bandwidth_bytes_per_ns": 1.0, "latency_ns": 5}), td + "/thin")
            self.assertIsNotNone(thin["switch"])
            self.assertGreater(thin["switch"]["bytes_served"], 0)
            self.assertGreater(thin["switch"]["max_queue_bytes"], 0)
            # Same workload, tighter bisection: strictly slower mean reads.
            self.assertGreater(thin["access"]["latency_ns"]["mean"],
                               fat["access"]["latency_ns"]["mean"])
            self.assertGreater(thin["access"]["stall_ns"], fat["access"]["stall_ns"])

    def test_no_switch_leaves_numbers_and_warns(self):
        with tempfile.TemporaryDirectory() as td:
            p = two_node_synthetic()
            sc = build_scenario(load_raw(p))
            self.assertTrue(any("fabric.switch" in w for w in sc.warnings), sc.warnings)
            s = run_synth(p, td + "/o")
            self.assertIsNone(s["switch"])

    def test_switch_schema_rejects_bad_block(self):
        with tempfile.TemporaryDirectory() as td:
            p = two_node_synthetic(switch={"latency_ns": 1})
            with self.assertRaises(ScenarioError) as c:
                build_scenario(load_raw(p))
            self.assertIn("switch", str(c.exception))


class PerNodeSynthetic(unittest.TestCase):
    def test_requests_shard_and_metrics_add_up(self):
        with tempfile.TemporaryDirectory() as td:
            s = run_synth(two_node_synthetic(), td + "/o")
            m0, m1 = s["memory"]["node-0"], s["memory"]["node-1"]
            self.assertGreater(m0["reads"], 0)
            self.assertGreater(m1["reads"], 0)
            self.assertEqual(m0["reads"] + m1["reads"], s["access"]["count"])
            self.assertEqual(m0["local_hits"] + m1["local_hits"], s["access"]["local_hits"])
            self.assertAlmostEqual(m0["stall_ns"] + m1["stall_ns"], s["access"]["stall_ns"])
            self.assertEqual(m0["in_flight_at_end"] + m1["in_flight_at_end"],
                             s["requests"]["in_flight_at_end"])

    def test_policy_instances_are_independent(self):
        with tempfile.TemporaryDirectory() as td:
            sc = build_scenario(load_raw(two_node_synthetic(policy="hot_cold")))
            e = Engine(sc, td + "/o", event_log=False)
            p0, p1 = e.policies["node-0"], e.policies["node-1"]
            self.assertIsNot(p0, p1)
            p0.observe_batch({"a": 5}, 1)
            self.assertEqual(p0.band("a"), 2)
            self.assertEqual(p1.band("a"), 0)  # untouched: knows nothing of a

    def test_multinode_deterministic(self):
        with tempfile.TemporaryDirectory() as td:
            p = two_node_synthetic(policy="frequency_aware",
                                   switch={"bandwidth_bytes_per_ns": 10.0})
            a = run_synth(p, td + "/a")
            b = run_synth(p, td + "/b")
            self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))


class MultiNodeReplay(unittest.TestCase):
    def test_explicit_nodes_split_placement(self):
        rows = [op(10, "alloc", "a", req="r0", node="node-0"),
                op(20, "alloc", "b", req="r1", node="node-1"),
                op(30, "read", "a", req="r0", node="node-0"),
                op(40, "read", "b", req="r1", node="node-1")]
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"), rows)
            two_node_trace_base(str(Path(td) / "b.json"), str(Path(td) / "t.jsonl"))
            s = run_replay(str(Path(td) / "b.json"), td + "/o")
            self.assertEqual(s["memory"]["node-0"]["reads"], 1)
            self.assertEqual(s["memory"]["node-1"]["reads"], 1)
            self.assertEqual(s["access"]["local_hits"], 2)

    def test_missing_nodes_shard_by_request(self):
        rows = [op(10, "alloc", "a", req="r0"), op(20, "alloc", "b", req="r1"),
                op(30, "read", "a", req="r0"), op(40, "read", "b", req="r1")]
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"), rows)
            two_node_trace_base(str(Path(td) / "b.json"), str(Path(td) / "t.jsonl"))
            s = run_replay(str(Path(td) / "b.json"), td + "/o")
            # r0 -> node-0, r1 -> node-1 (first-seen round-robin).
            self.assertEqual(s["memory"]["node-0"]["reads"], 1)
            self.assertEqual(s["memory"]["node-1"]["reads"], 1)

    def test_unknown_node_rejected_with_row(self):
        rows = [op(10, "alloc", "a", req="r0", node="node-9")]
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"), rows)
            two_node_trace_base(str(Path(td) / "b.json"), str(Path(td) / "t.jsonl"))
            with self.assertRaises(ScenarioError) as c:
                build_scenario(load_raw(str(Path(td) / "b.json")))
            self.assertIn("node-9", str(c.exception))

    def _add_peer_link(self, scen_path):
        raw = json.loads(Path(scen_path).read_text(encoding="utf-8"))
        raw["fabric"]["links"].append(
            {"id": "l-peer", "from": "node-0", "to": "node-1",
             "latency_ns": 10, "bandwidth_bytes_per_ns": 48,
             "bidirectional": True})
        Path(scen_path).write_text(json.dumps(raw), encoding="utf-8")

    def test_cross_node_touch_reads_through(self):
        # Single-owner placement: a non-owner touch fetches over the static
        # route without moving the page (no divergence, no install).
        rows = [op(10, "alloc", "a", req="r0", node="node-0"),
                op(20, "read", "a", req="r0", node="node-1"),
                op(30, "read", "a", req="r0", node="node-1")]
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"), rows)
            two_node_trace_base(str(Path(td) / "b.json"), str(Path(td) / "t.jsonl"))
            self._add_peer_link(str(Path(td) / "b.json"))
            s = run_replay(str(Path(td) / "b.json"), td + "/o")
            self.assertEqual(s["memory"]["node-1"]["reads"], 2)
            self.assertEqual(s["memory"]["node-1"]["local_hits"], 0)
            self.assertEqual(s["access"]["bypass_reads"], 2)
            self.assertEqual(s["links"]["l-peer"]["bytes_in"], 2 * UNIT)
            self.assertEqual(s["links"]["l-peer"]["bytes_out"], 0)

    def test_shard_mismatch_reads_through(self):
        # Alloc under r0 (shard 0), touch under r1 (shard 1): the read runs
        # on node-1 and fetches from the page's home tier.
        rows = [op(10, "alloc", "a", req="r0"),
                op(20, "read", "a", req="r1")]
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"), rows)
            two_node_trace_base(str(Path(td) / "b.json"), str(Path(td) / "t.jsonl"))
            self._add_peer_link(str(Path(td) / "b.json"))
            s = run_replay(str(Path(td) / "b.json"), td + "/o")
            self.assertEqual(s["memory"]["node-1"]["reads"], 1)
            self.assertEqual(s["access"]["bypass_reads"], 1)

    def test_replay_switch_binds(self):
        # Same-timestamp remote fetches from both nodes serialize on a thin switch.
        rows = [op(10, "alloc", "a", req="r0", node="node-0"),
                op(10, "alloc", "b", req="r1", node="node-1"),
                op(10, "alloc", "c", req="r0", node="node-0"),
                op(10, "alloc", "d", req="r1", node="node-1"),
                op(20, "read", "a", req="r0", node="node-0"),
                op(20, "read", "b", req="r1", node="node-1")]
        with tempfile.TemporaryDirectory() as td:
            micro_trace(str(Path(td) / "t.jsonl"), rows)
            two_node_trace_base(str(Path(td) / "a.json"), str(Path(td) / "t.jsonl"),
                                local_pages=1, pool_pages=16,
                                switch={"bandwidth_bytes_per_ns": 1e9})
            two_node_trace_base(str(Path(td) / "b.json"), str(Path(td) / "t.jsonl"),
                                local_pages=1, pool_pages=16,
                                switch={"bandwidth_bytes_per_ns": 0.5})
            fat = run_replay(str(Path(td) / "a.json"), td + "/fat")
            thin = run_replay(str(Path(td) / "b.json"), td + "/thin")
            self.assertGreater(thin["switch"]["bytes_served"], 0)
            self.assertGreater(thin["access"]["latency_ns"]["mean"],
                               fat["access"]["latency_ns"]["mean"])


if __name__ == "__main__":
    unittest.main()
