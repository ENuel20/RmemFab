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


class TestWindowLatency(unittest.TestCase):
    """Per-window read latency is recorded (steady-state), never zero-filled."""

    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp(prefix="rmemfab-winlat-")
        path = tmp_scenario("phase1-overflow.json")
        cls.summary, _ = run_engine(path, cls.out, event_log=False)
        cls.series = read_jsonl(f"{cls.out}/series.jsonl")

    def test_rows_carry_window_latency(self):
        want = set(self.summary["access"]["latency_ns"])
        self.assertIn("count", want)
        for row in self.series:
            self.assertIn("latency_ns", row)
            self.assertEqual(set(row["latency_ns"]), want)

    def test_window_counts_sum_to_steady_reads(self):
        total = sum(row["latency_ns"]["count"] for row in self.series)
        self.assertEqual(total, self.summary["access"]["count"])

    def test_empty_windows_carry_no_fake_values(self):
        pct_keys = sorted(
            (k for k in self.summary["access"]["latency_ns"] if k.startswith("p")),
            key=lambda k: float(k[1:]))
        self.assertGreater(len(pct_keys), 0)
        seen_full = False
        for row in self.series:
            w = row["latency_ns"]
            if w["count"] == 0:
                self.assertEqual(w["mean"], 0.0)
                self.assertEqual(w["max"], 0.0)
            else:
                seen_full = True
                vals = [w[k] for k in pct_keys]
                self.assertEqual(vals, sorted(vals))
                self.assertGreater(w["max"], 0.0)
        self.assertTrue(seen_full)

    def test_window_latency_deterministic(self):
        out2 = tempfile.mkdtemp(prefix="rmemfab-winlat2-")
        path = tmp_scenario("phase1-overflow.json")
        run_engine(path, out2, event_log=False)
        with open(f"{self.out}/series.jsonl", "rb") as f1, \
                open(f"{out2}/series.jsonl", "rb") as f2:
            self.assertEqual(f1.read(), f2.read())


if __name__ == "__main__":
    unittest.main()
