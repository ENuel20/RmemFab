"""A6.1: byte-identical reruns (summary, manifest, events, series)."""
import filecmp
import tempfile
import unittest

from support import run_engine, tmp_scenario
from rmemfab.telemetry.summary import canonical


def tiny(raw):
    raw["duration_ns"] = 500_000_000
    raw["name"] = "tiny-det"
    raw["warmup_ns"] = 10_000_000
    raw["metrics"]["warmup_ns"] = 10_000_000
    raw.setdefault("output", {})["include_event_log"] = True


class TestDeterminism(unittest.TestCase):
    def test_rerun_is_byte_identical(self):
        path = tmp_scenario("phase1-overflow.json", tiny)
        a = tempfile.mkdtemp(prefix="rmemfab-det-a-")
        b = tempfile.mkdtemp(prefix="rmemfab-det-b-")
        sa, _ = run_engine(path, a)
        sb, _ = run_engine(path, b)
        self.assertEqual(canonical(sa), canonical(sb))
        for fname in ("summary.json", "manifest.json", "events.jsonl", "series.jsonl"):
            self.assertTrue(filecmp.cmp(f"{a}/{fname}", f"{b}/{fname}", shallow=False), fname)


if __name__ == "__main__":
    unittest.main()
