"""Normative metric definitions: reads-only denominator, both windows."""
import tempfile
import unittest

from support import load_example, read_jsonl, run_engine, tmp_scenario


class TestDenominator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp(prefix="rmemfab-metrics-")
        path = tmp_scenario("phase1-overflow.json")
        cls.summary, _ = run_engine(path, cls.out, event_log=False)
        cls.series = read_jsonl(f"{cls.out}/series.jsonl")

    def test_writes_excluded_from_hit_ratios(self):
        a = self.summary["access"]
        w = self.summary["writes"]
        self.assertGreater(w["count"], 0)
        self.assertEqual(a["count"], a["local_hits"] + a["remote_hits"] + a["misses"])

    def test_series_counts_all_ops(self):
        a = self.summary["access"]
        w = self.summary["writes"]
        series_ops = sum(row["accesses"] for row in self.series)
        self.assertEqual(series_ops, a["total_accesses_incl_warmup"] + w["total_incl_warmup"])

    def test_steady_within_all(self):
        a = self.summary["access"]
        self.assertLessEqual(a["count"], a["total_accesses_incl_warmup"])
        self.assertLessEqual(a["latency_ns"]["count"], a["latency_all_ns"]["count"])

    def test_all_local_means_unit_ratio(self):
        def shrink(raw):
            raw["duration_ns"] = 2_000_000_000
            raw["warmup_ns"] = 0
            raw["metrics"]["warmup_ns"] = 0
        out = tempfile.mkdtemp(prefix="rmemfab-llama-")
        summary, _ = run_engine(tmp_scenario("llama-70b-cxl.json", mutator=shrink), out, event_log=False)
        a = summary["access"]
        self.assertEqual(a["local_hit_ratio"], 1.0)
        self.assertEqual(summary["traffic"]["remote_read_bytes"], 0)


if __name__ == "__main__":
    unittest.main()
