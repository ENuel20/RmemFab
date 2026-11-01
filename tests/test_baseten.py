"""Baseten track, offline: converter derivation + generator shaping.

No network: the generator's transport is faked, the converter is pure.
"""
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from support import REPO


def load_script(rel):
    spec = importlib.util.spec_from_file_location(
        rel.replace("/", "_").replace(".py", ""), REPO / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gen = load_script("infra/baseten/generate.py")
conv = load_script("tools/baseten_log_to_trace.py")


def raw_row(rid="L256-C1-r0", prompt=256, comp=32, t0=1000.0, dur=0.5):
    return {"request_id": rid, "prompt_tokens": prompt,
            "completion_tokens": comp, "arrival_ts": t0,
            "first_token_ts": t0 + 0.05, "end_ts": t0 + dur,
            "ttft_ms": 50.0, "total_ms": dur * 1000,
            "finish_reason": "length", "cell": "L256-C1",
            "prompt_target_tokens": 256, "concurrency": 1}


class Converter(unittest.TestCase):
    def test_derivation_counts_and_lifecycle(self):
        from rmemfab.trace.validate import load_trace
        rows = [raw_row("r0", 64, 8, 1000.0, 0.5),
                raw_row("r1", 32, 8, 1001.0, 0.25),
                {"request_id": "rE", "error": "Timeout"}]
        out, stats = conv.convert(rows, kv_bpt=1024, page_size=4096)
        # r0: 72*1024/4096 = 18 pages; r1: 40*1024/4096 = 10 pages
        self.assertEqual(stats["pages"], 28)
        self.assertEqual(stats["rows"], 84)
        self.assertEqual(stats["requests_error"], 1)
        self.assertTrue(all(r["bytes"] == 4096 for r in out))
        with tempfile.TemporaryDirectory() as td:
            p = str(Path(td) / "t.jsonl")
            Path(p).write_text(
                json.dumps({"type": "header", "trace_version": "0.1",
                            "source": "test"}) + "\n" +
                "\n".join(json.dumps(r) for r in out) + "\n", encoding="utf-8")
            vt = load_trace(p)
            self.assertEqual(vt.report["stats"]["pages"], 28)

    def test_empty_log_raises(self):
        with self.assertRaises(ValueError):
            conv.convert([{"request_id": "x", "error": "boom"}],
                         kv_bpt=1024, page_size=4096)

    def test_kv_formula(self):
        self.assertEqual(conv.kv_bytes_per_token(32, 8, 128, 2),
                         2 * 32 * 8 * 128 * 2)


class GeneratorShaping(unittest.TestCase):
    def test_prompt_is_deterministic_and_sized(self):
        a = gen.build_prompt(256, 7)
        b = gen.build_prompt(256, 7)
        c = gen.build_prompt(256, 8)
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertGreater(len(a), 256 * 3)
        self.assertLess(len(a), 256 * 6)

    def test_one_request_row_from_fake_sse(self):
        chunks = [
            b'data: {"choices": [{"delta": {"content": "hi"}}], '
            b'"usage": {"prompt_tokens": 10, "completion_tokens": 2}}\n',
            b'data: {"choices": [{"finish_reason": "stop"}]}\n',
            b'data: [DONE]\n',
        ]

        class FakeResp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def __iter__(self): return iter(chunks)

        with mock.patch.object(gen.urllib.request, "urlopen",
                               return_value=FakeResp()):
            row = gen.one_request("KEY", "prompt", "r0")
        self.assertEqual(row["request_id"], "r0")
        self.assertEqual(row["prompt_tokens"], 10)
        self.assertEqual(row["completion_tokens"], 2)
        self.assertEqual(row["finish_reason"], "stop")
        self.assertIsNotNone(row["ttft_ms"])
        self.assertNotIn("KEY", json.dumps(row))

    def test_transport_error_becomes_row(self):
        with mock.patch.object(gen.urllib.request, "urlopen",
                               side_effect=TimeoutError("slow")):
            row = gen.one_request("KEY", "prompt", "r0")
        self.assertEqual(row["error"], "TimeoutError")


if __name__ == "__main__":
    unittest.main()
