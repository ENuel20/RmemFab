"""CLI exit codes and bundle layout."""
import json
import tempfile
import unittest
from pathlib import Path

from support import REPO, tmp_scenario
from rmemfab.cli import main


class TestCli(unittest.TestCase):
    def test_validate_ok(self):
        self.assertEqual(main(["validate", str(REPO / "examples" / "phase1-overflow.json")]), 0)

    def test_validate_missing_file(self):
        self.assertEqual(main(["validate", str(REPO / "examples" / "nope.json")]), 1)

    def test_validate_bad_json(self):
        p = Path(tempfile.mkdtemp()) / "bad.json"
        p.write_text("{oops", encoding="utf-8")
        self.assertEqual(main(["validate", str(p)]), 1)

    def test_run_and_summary(self):
        out = tempfile.mkdtemp(prefix="rmemfab-cli-")
        scen = tmp_scenario("phase1-overflow.json")
        self.assertEqual(main(["run", scen, "--out", out, "--quiet", "--no-events"]), 0)
        for fname in ("scenario.json", "summary.json", "manifest.json", "series.jsonl", "README.md"):
            self.assertTrue((Path(out) / fname).is_file(), fname)
        self.assertFalse((Path(out) / "events.jsonl").exists())
        self.assertEqual(main(["summary", out]), 0)
        self.assertEqual(main(["summary", out, "--canonical"]), 0)
        s = json.loads((Path(out) / "summary.json").read_text(encoding="utf-8"))
        self.assertEqual(s["scenario"], "phase1-overflow")

    def test_summary_missing_dir(self):
        self.assertEqual(main(["summary", tempfile.mkdtemp()]), 1)

    def test_run_rejects_unrunnable(self):
        self.assertEqual(main(["run", str(REPO / "examples" / "moe-remote-tiering.json"),
                               "--out", tempfile.mkdtemp(), "--quiet"]), 1)


if __name__ == "__main__":
    unittest.main()
