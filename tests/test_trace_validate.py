"""Validator corpus: crafted defects rejected, real traces judged honestly."""
import unittest
from pathlib import Path

from support import REPO
from rmemfab.cli import main as cli_main
from rmemfab.trace.validate import TraceError, load_trace

FIX = REPO / "tests" / "fixtures" / "traces"
OPT = REPO / "examples" / "traces" / "20261029T202303Z-opt-125m" / "kv_trace.jsonl"
GLIMMER = REPO / "examples" / "traces" / "20261030T000445Z-muse-glimmer-derived" / "kv_trace.jsonl"


class TestCorpus(unittest.TestCase):
    def expect_error(self, name, fragment, **kw):
        with self.assertRaises(TraceError) as cm:
            load_trace(FIX / name, **kw)
        self.assertTrue(any(fragment in e for e in cm.exception.errors),
                        f"{name}: expected {fragment!r} in {cm.exception.errors}")
    def test_valid_minimal(self):
        vt = load_trace(FIX / "valid-min.jsonl")
        self.assertEqual(vt.report["stats"]["ops"], 4)
        self.assertEqual(vt.unit_bytes, 1024)

    def test_header_only_is_valid_and_empty(self):
        vt = load_trace(FIX / "header-only.jsonl")
        self.assertEqual(vt.report["stats"]["ops"], 0)
        self.assertIsNone(vt.unit_bytes)

    def test_write_before_alloc_rejected(self):
        self.expect_error("write-before-alloc.jsonl", "write of unallocated page")

    def test_negative_ts_rejected(self):
        self.expect_error("negative-ts.jsonl", "ts_ns must be an integer >= 0")

    def test_free_without_alloc_rejected(self):
        self.expect_error("free-without-alloc.jsonl", "free of unallocated page")

    def test_double_alloc_rejected(self):
        self.expect_error("double-alloc.jsonl", "double alloc")

    def test_ops_after_free_rejected(self):
        self.expect_error("ops-after-free.jsonl", "read of unallocated page")

    def test_bad_json_names_line(self):
        self.expect_error("bad-json.jsonl", ":2: malformed JSON")

    def test_unordered_accepted_with_sort_and_reported(self):
        vt = load_trace(FIX / "unordered-valid.jsonl", sort=True)
        self.assertGreater(vt.report["stats"]["reordered_steps"], 0)
        ts = [o["ts"] for o in vt.ops]
        self.assertEqual(ts, sorted(ts))

    def test_unordered_rejected_without_sort(self):
        self.expect_error("unordered-valid.jsonl", "out of order", sort=False)

    def test_mixed_units_need_round_bytes(self):
        self.expect_error("mixed-units.jsonl", "mixed alloc sizes")
        vt = load_trace(FIX / "mixed-units.jsonl", round_bytes=True)
        self.assertTrue(vt.report["normalization"]["round_bytes"])

    def test_observed_placement_ignored_and_reported(self):
        vt = load_trace(FIX / "observed-placement.jsonl")
        self.assertEqual(vt.report["stats"]["ops"], 3)
        self.assertEqual(vt.report["stats"]["ignored_policy_ops"], 1)
        self.assertTrue(any("never replayed" in w or "recomputes" in w
                            for w in vt.report["warnings"]))

    def test_time_scale_applies(self):
        vt = load_trace(FIX / "valid-min.jsonl", time_scale=2.0)
        self.assertEqual([o["ts"] for o in vt.ops], [0, 20, 40, 60])

    def test_node_mismatch_rejected(self):
        import json
        import tempfile
        rows = [{"type": "header", "trace_version": "0.1", "source": "test"},
                {"ts_ns": 0, "op": "alloc", "page_id": "p1", "bytes": 1024, "node": "n0"},
                {"ts_ns": 10, "op": "free", "page_id": "p1", "bytes": 1024, "node": "n0"}]
        tf = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        tf.write("\n".join(json.dumps(r) for r in rows) + "\n")
        tf.close()
        with self.assertRaises(TraceError) as cm:
            load_trace(tf.name, node="other-node")
        self.assertTrue(any("node" in e for e in cm.exception.errors))
        load_trace(tf.name, node="n0")  # matching node passes


class TestCollectedTraces(unittest.TestCase):
    def test_opt_valid_with_known_stats(self):
        vt = load_trace(OPT)
        st = vt.report["stats"]
        self.assertEqual(st["ops"], 4540)
        self.assertEqual(st["pages"], 136)
        self.assertEqual(st["requests"], 4)
        self.assertEqual(vt.unit_bytes, 589824)
        self.assertEqual(st["reordered_steps"], 93)

    def test_glimmer_rejected_for_negative_ts(self):
        with self.assertRaises(TraceError) as cm:
            load_trace(GLIMMER)
        self.assertIn("ts_ns", cm.exception.errors[0])

    def test_cli_trace_validate_exits(self):
        self.assertEqual(cli_main(["trace-validate", str(OPT)]), 0)
        self.assertEqual(cli_main(["trace-validate", str(GLIMMER)]), 1)


if __name__ == "__main__":
    unittest.main()
