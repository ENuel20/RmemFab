"""Serving model: serialized compute service time, TTFT/TPOT/ITL from boundaries.

compute.tokens_per_second (already schema-legal, previously ignored) adds an
explicit compute service term: prompt/tps at prefill, 1/tps per decode step,
serialized after memory service. Unset means memory-only, exactly as before.
"""
import json
import tempfile
import unittest

from support import load_example, run_engine, tmp_scenario

UNIT = 1 << 20
TPS = 50_000.0  # 20us per token
PROMPT, GEN = 64, 4


def base_mutator(raw):
    raw["page_size_bytes"] = UNIT
    raw["duration_ns"] = 500_000_000
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["metrics"]["sample_interval_ns"] = 100_000_000
    raw["nodes"][0]["local_memory"]["capacity_bytes"] = 64 * UNIT
    raw["seed"] = 7
    raw["workload"]["requests"]["arrival_rate_per_second"] = 10.0
    raw["workload"]["requests"]["prompt_tokens"] = PROMPT
    raw["workload"]["requests"]["generated_tokens"] = GEN
    raw["policy"] = {"name": "swap_remote"}
    raw["output"] = {"format": "jsonl", "include_event_log": True}


def with_compute(raw):
    base_mutator(raw)
    raw["nodes"][0]["compute"] = {
        "accelerators": 1, "tokens_per_second": TPS,
        "provenance": {"kind": "assumed",
                       "source": "test_serving experiment default",
                       "method": "Round throughput figure, not a measurement."}}


def run(raw_mutator, **kw):
    out = tempfile.mkdtemp(prefix="rmemfab-serving-")
    path = tmp_scenario("phase1-overflow.json", mutator=raw_mutator)
    summary, _ = run_engine(path, out, **kw)
    return summary, out


def read_events(out):
    rows = []
    with open(f"{out}/events.jsonl", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


class TestServingModel(unittest.TestCase):
    def test_absent_compute_omits_serving_section(self):
        # No compute configured: no serving key at all, so pre-serving
        # summaries stay byte-identical (Test 1 sha stability).
        summary, _ = run(base_mutator, event_log=False)
        self.assertNotIn("serving", summary)

    def test_compute_independent_of_memory_config(self):
        def slow(raw):
            with_compute(raw)

        def fast(raw):
            with_compute(raw)
            raw["nodes"][0]["local_memory"]["bandwidth_bytes_per_ns"] *= 4

        slow_s, _ = run(slow, event_log=False)
        fast_s, _ = run(fast, event_log=False)
        self.assertEqual(slow_s["serving"]["compute_ns"],
                         fast_s["serving"]["compute_ns"])
        # Memory term moved while compute stood still.
        self.assertNotEqual(slow_s["requests"]["latency_ns"]["mean"],
                            fast_s["requests"]["latency_ns"]["mean"])

    def test_compute_accounting_matches_events(self):
        summary, out = run(with_compute)
        unit = 1.0 / TPS * 1e9
        starts = steps = 0
        for e in read_events(out):
            if e.get("event") == "prefill_begin":
                starts += 1
            elif e.get("event") == "decode_step":
                steps += 1
        expect = starts * PROMPT * unit + steps * unit
        self.assertAlmostEqual(summary["serving"]["compute_ns"], expect,
                               delta=expect * 1e-9 + 1.0)
        self.assertGreater(summary["requests"]["completed"], 0)

    def test_ttft_tpot_match_event_boundaries(self):
        summary, out = run(with_compute)
        arrivals, first_ends, step_durs = {}, {}, []
        for e in read_events(out):
            rid = e.get("request_id", "")
            if e.get("event") == "request_arrival":
                arrivals[rid] = e["time_ns"]
            elif e.get("event") == "decode_step":
                step_durs.append(e["data"]["step_ns"])
                if rid not in first_ends:
                    first_ends[rid] = e["time_ns"] + e["data"]["step_ns"]
        ttfts = [first_ends[r] - arrivals[r] for r in first_ends
                 if r in arrivals]
        serving = summary["serving"]
        self.assertEqual(serving["ttft_ns"]["count"], len(ttfts))
        self.assertAlmostEqual(serving["ttft_ns"]["mean"],
                               sum(ttfts) / len(ttfts), delta=1.0)
        self.assertEqual(serving["tpot_ns"],
                         summary["decode_step_latency_ns"]["mean"])
        self.assertGreater(len(step_durs), 0)


if __name__ == "__main__":
    unittest.main()
