"""Agnosticism contract: no model or vendor identifiers in engine source.

Model and vendor names may appear in presets, fixtures, docs, and trace
metadata. They must never appear in `src/` semantics: tiers are numbers,
workloads are parameters.
"""
import re
import unittest
from pathlib import Path

from support import REPO

BANNED = re.compile(
    r"\b(glimmer|llama|mistral|kimi|cerebras|gpt|h100|a100|cxl|rdma|nvme|cuda"
    r"|sram|hbm|dram|nvidia|meta|anthropic|openai)\b",
    re.IGNORECASE,
)


class TestAgnostic(unittest.TestCase):
    def test_src_has_no_model_or_vendor_identifiers(self):
        hits = []
        for path in sorted((REPO / "src").rglob("*.py")):
            for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                for m in BANNED.finditer(line):
                    hits.append(f"{path.relative_to(REPO)}:{i}: {m.group(0)}")
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()
