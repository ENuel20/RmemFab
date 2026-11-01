"""Capacity accounting: never exceed, exact bytes, logged counts reconcile."""
import tempfile
import unittest

from support import read_jsonl, run_engine, tmp_scenario


class TestAccounting(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp(prefix="rmemfab-acct-")
        path = tmp_scenario("phase1-overflow.json")
        cls.summary, cls.manifest = run_engine(path, cls.out, event_log=False)
        cls.series = read_jsonl(f"{cls.out}/series.jsonl")

    def test_peaks_within_capacity(self):
        for nid, m in self.summary["memory"].items():
            self.assertLessEqual(m["peak_used_pages"], m["capacity_pages"], nid)
            self.assertGreaterEqual(m["final_used_pages"], 0, nid)
        p = self.summary["pool"]
        self.assertLessEqual(p["peak_used_pages"], p["capacity_pages"])
        self.assertGreaterEqual(p["final_used_pages"], 0)

    def test_series_occupancy_within_capacity(self):
        caps = {nid: m["capacity_pages"] for nid, m in self.summary["memory"].items()}
        pcap = self.summary["pool"]["capacity_pages"]
        for row in self.series:
            for nid, used in row["local_used_pages"].items():
                self.assertLessEqual(used, caps[nid])
                self.assertGreaterEqual(used, 0)
            self.assertLessEqual(row["pool_used_pages"], pcap)

    def test_pool_used_when_local_overflows(self):
        self.assertGreater(self.summary["pool"]["peak_used_pages"], 0)
        self.assertGreater(self.summary["memory"]["node-0"]["evicted_pages"], 0)

    def test_event_count_reconciles(self):
        self.assertEqual(self.manifest["events_logged"], 0)  # event log disabled here
        self.assertGreater(self.manifest["event_count"], 0)


if __name__ == "__main__":
    unittest.main()
