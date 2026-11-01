"""A1.6: the overflow fixture must exercise the remote path."""
import tempfile
import unittest

from support import read_jsonl, run_engine, tmp_scenario


def overflow_with_events(raw):
    raw.setdefault("output", {})["include_event_log"] = True


class TestOverflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp(prefix="rmemfab-overflow-")
        path = tmp_scenario("phase1-overflow.json", overflow_with_events)
        cls.summary, cls.manifest = run_engine(path, cls.out)
        cls.events = read_jsonl(f"{cls.out}/events.jsonl")

    def test_run_completes_and_requests_progress(self):
        # A1.6 requires the RUN to complete with remote traffic, not that any
        # request finishes: 1280-page working sets thrashing through a
        # 48 GB/s link need ~50 s per request against a 10 s window.
        # Progress (in flight, zero wrongful rejects) plus traffic is the check.
        r = self.summary["requests"]
        self.assertEqual(r["rejected"], 0)
        self.assertGreater(r["in_flight_at_end"] + r["queued_at_end"] + r["completed"], 0)
        self.assertGreater(self.summary["access"]["count"], 0)

    def test_remote_path_exercised(self):
        t = self.summary["traffic"]
        self.assertGreater(t["remote_read_bytes"], 0)
        self.assertGreater(t["migration_bytes"], 0)

    def test_migrate_pair_present(self):
        kinds = [e["event"] for e in self.events]
        self.assertIn("page_migrate_begin", kinds)
        self.assertIn("page_migrate_end", kinds)

    def test_ratios_sum_to_one_over_reads(self):
        a = self.summary["access"]
        total = a["local_hit_ratio"] + a["remote_hit_ratio"] + a["miss_ratio"]
        self.assertAlmostEqual(total, 1.0, places=6)
        self.assertLess(a["local_hit_ratio"], 1.0)
        self.assertEqual(a["count"], a["local_hits"] + a["remote_hits"] + a["misses"])

    def test_no_silent_grants(self):
        r = self.summary["requests"]
        self.assertEqual(r["arrived"],
                         r["completed"] + r["rejected"] + r["in_flight_at_end"] + r["queued_at_end"])


if __name__ == "__main__":
    unittest.main()
