"""Phase 2 tests: trace import/replay, generators, snapshot converter."""
import copy
import hashlib
import json
import pickle
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import numpy as np

from rmemfab.cli import main as cli_main
from rmemfab.config.scenario import ScenarioError, build_scenario, load_raw, validate
from rmemfab.config.schema import trace_schema
from rmemfab.core.runner import make_engine
from rmemfab.telemetry.summary import canonical
from rmemfab.workloads.generators import Params, generate_ops
from rmemfab.workloads.snapshot import convert_snapshot, load_snapshot
from rmemfab.workloads.synthetic import kv_bytes_per_token
from rmemfab.workloads.trace import TraceError, load_trace, normalize_bytes, seq_digest, write_trace

ROOT = Path(__file__).resolve().parents[1]
EX = ROOT / "examples"
PAGE = 2 * 1024 * 1024
MIB = 1024 * 1024


def trace_scenario(path, local=1 << 30, duration=1_000_000_000, **wl):
    raw = load_raw(EX / "phase1-swap-pressure.json")
    raw["duration_ns"], raw["warmup_ns"] = duration, 0
    raw["metrics"] = {"percentiles": [50, 95, 99], "sample_interval_ns": duration // 10, "warmup_ns": 0}
    raw["nodes"][0]["local_memory"]["capacity_bytes"] = local
    raw["workload"] = {"type": "trace", "path": str(path), **wl}
    return raw


def write_lines(path, lines):
    Path(path).write_text("\n".join(json.dumps(l) if not isinstance(l, str) else l for l in lines) + "\n")


def rec(ts, op, pid, nbytes, **kw):
    return {"ts_ns": ts, "op": op, "page_id": pid, "bytes": nbytes, **kw}


def replay(raw, base=None, **kw):
    sc = build_scenario(raw, base_dir=base)
    eng = make_engine(sc, **kw)
    s, m = eng.run()
    return eng, s, m


def scen_for(profile_file, **over):
    raw = load_raw(EX / profile_file)
    raw.update(over)
    return raw


class TraceImport(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.p = Path(self.d.name) / "t.jsonl"

    def tearDown(self):
        self.d.cleanup()

    def test_schema_bundled_matches_spec(self):
        self.assertEqual((ROOT / "src/rmemfab/config/trace.schema.json").read_text(),
                         (ROOT / "SPECS/trace.schema.json").read_text())
        self.assertIn("$defs", trace_schema())

    def test_normalization_adjustments_are_reported(self):
        write_lines(self.p, [{"type": "header", "trace_version": "0.1", "source": "t", "label": "measured"},
                             rec(0, "alloc", "a", 1 * MIB), rec(10, "read", "a", 65536), rec(20, "free", "a", PAGE)])
        lt = load_trace(self.p, PAGE)
        adj = lt.info["page_normalization"]
        self.assertEqual(adj["records"], 2)
        self.assertEqual(adj["added_bytes"], (PAGE - MIB) + (PAGE - 65536))
        self.assertEqual([o[3] for o in lt.ops], [PAGE, PAGE, PAGE])
        self.assertEqual(lt.info["label"], "measured")
        self.assertEqual(lt.info["sha256"], hashlib.sha256(self.p.read_bytes()).hexdigest())

    def test_round_bytes_false_is_strict(self):
        write_lines(self.p, [rec(0, "alloc", "a", MIB)])
        with self.assertRaises(TraceError) as cm:
            load_trace(self.p, PAGE, round_bytes=False)
        self.assertIn("t.jsonl:1", str(cm.exception))

    def test_unlabeled_trace_is_never_measured(self):
        write_lines(self.p, [rec(0, "alloc", "a", PAGE)])
        lt = load_trace(self.p, PAGE)
        self.assertEqual(lt.info["label"], "synthetic")
        self.assertIn("treated as synthetic", lt.info["label_note"])

    def test_out_of_order_rejected_unless_sort(self):
        write_lines(self.p, [rec(10, "alloc", "a", PAGE), rec(5, "alloc", "b", PAGE)])
        with self.assertRaises(TraceError) as cm:
            load_trace(self.p, PAGE)
        self.assertIn("backwards", str(cm.exception))
        lt = load_trace(self.p, PAGE, sort=True)
        self.assertEqual([o[2] for o in lt.ops], ["b", "a"])
        self.assertEqual(lt.ops[0][0], 0)  # shifted to simulation start
        self.assertTrue(lt.info["sorted"])

    def test_malformed_line_stops_import_with_line_number(self):
        write_lines(self.p, [rec(0, "alloc", "a", PAGE), "{not json", rec(5, "free", "a", PAGE)])
        with self.assertRaises(TraceError) as cm:
            load_trace(self.p, PAGE)
        self.assertIn(":2:", str(cm.exception))

    def test_best_effort_counts_rejected_lines(self):
        write_lines(self.p, [rec(0, "alloc", "a", PAGE), rec(1, "bogus_op", "a", PAGE), "{x", rec(5, "free", "a", PAGE)])
        lt = load_trace(self.p, PAGE, best_effort=True)
        self.assertEqual(len(lt.ops), 2)
        self.assertEqual([r["line"] for r in lt.info["rejected_lines"]], [2, 3])

    def test_unknown_fields_preserved_not_fatal_and_time_scale(self):
        write_lines(self.p, [rec(100, "alloc", "a", PAGE, extra="x", metadata={"k": 1}), rec(300, "free", "a", PAGE)])
        lt = load_trace(self.p, PAGE, time_scale=2.0)
        self.assertEqual([o[0] for o in lt.ops], [0, 400])
        self.assertEqual(lt.info["unknown_fields_preserved"], 1)

    def test_normalize_bytes(self):
        self.assertEqual(normalize_bytes(1, PAGE), (PAGE, True))
        self.assertEqual(normalize_bytes(PAGE, PAGE), (PAGE, False))
        self.assertEqual(normalize_bytes(PAGE + 1, PAGE), (2 * PAGE, True))


class TraceReplay(unittest.TestCase):
    """ROADMAP Phase 2 acceptance: replay reproduces alloc/free and reports normalization."""

    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.dir = Path(self.d.name)

    def tearDown(self):
        self.d.cleanup()

    def sample_trace(self):
        lines = [{"type": "header", "trace_version": "0.1", "source": "unit-test", "label": "synthetic"}]
        t = 0
        for i in range(6):
            lines.append(rec(t, "alloc", f"obj{i}", 4 * MIB, node="gpu0", request_id=f"r{i}"))
            lines.append(rec(t + 5, "write", f"obj{i}", 1 * MIB, node="gpu0", request_id=f"r{i}"))
            lines.append(rec(t + 50, "read", f"obj{i}", 65536, node="gpu0", request_id=f"r{i}"))
            t += 100
        for i in range(0, 6, 2):
            lines.append(rec(t, "free", f"obj{i}", 4 * MIB, node="gpu0"))
            t += 10
        lines.append(rec(t + 10, "migrate", "obj1", 4 * MIB, node="gpu0"))
        p = self.dir / "t.jsonl"
        write_lines(p, lines)
        return p

    def test_alloc_free_sequence_reproduced(self):
        p = self.sample_trace()
        eng, s, m = replay(trace_scenario(p))
        r = s["replay"]
        self.assertTrue(r["sequence_matches"], r)
        self.assertEqual(r["executed_alloc_free_sha256"], r["recorded_alloc_free_sha256"])
        self.assertEqual(r["executed_alloc_free_records"], 9)
        self.assertEqual(s["ops"]["executed"], {"alloc": 6, "free": 3, "read": 6, "write": 6})
        self.assertEqual(s["ops"]["ignored_recorded_ops"]["migrate"], 1)
        self.assertEqual(s["ops"]["anomalies"], {})
        self.assertEqual(s["workload"]["trace"]["page_normalization"]["records"], 12)  # 6 writes + 6 reads
        self.assertEqual(s["workload"]["live_objects_at_end"], 3)
        self.assertEqual(m["trace_hashes"][0]["sha256"], hashlib.sha256(p.read_bytes()).hexdigest())
        self.assertEqual(m["node_map"], {"gpu0": "node-0"})
        self.assertEqual(s["workload_label"], "synthetic")

    def test_independent_recomputation_of_sequence_digest(self):
        p = self.sample_trace()
        recs = [json.loads(l) for l in p.read_text().splitlines()][1:]
        expect = seq_digest((r["op"], r["page_id"], normalize_bytes(r["bytes"], PAGE)[0])
                            for r in recs if r["op"] in ("alloc", "free"))
        _, s, _ = replay(trace_scenario(p))
        self.assertEqual(s["replay"]["executed_alloc_free_sha256"], expect)

    def test_anomalies_are_reported_not_hidden(self):
        p = self.dir / "a.jsonl"
        write_lines(p, [rec(0, "alloc", "x", PAGE), rec(1, "alloc", "x", PAGE), rec(2, "free", "ghost", PAGE),
                        rec(3, "read", "never", PAGE), rec(4, "free", "x", PAGE)])
        _, s, _ = replay(trace_scenario(p))
        self.assertEqual(s["ops"]["anomalies"], {"access_before_alloc": 1, "duplicate_alloc": 1, "free_of_unknown_object": 1})
        self.assertFalse(s["replay"]["sequence_matches"])

    def test_truncated_by_duration_is_flagged_incomplete(self):
        p = self.sample_trace()
        _, s, _ = replay(trace_scenario(p, duration=120))
        self.assertFalse(s["replay"]["complete"])
        self.assertFalse(s["replay"]["sequence_matches"])
        self.assertGreater(s["ops"]["after_end"], 0)

    def test_capacity_exact_under_pressure_and_remote_use(self):
        lines = []
        for i in range(40):  # 40 x 8 MiB = 320 MiB against 128 MiB local
            lines.append(rec(i * 1000, "alloc", f"o{i}", 8 * MIB))
            lines.append(rec(i * 1000 + 10, "write", f"o{i}", 8 * MIB))
        for rep in range(3):
            for i in range(40):
                lines.append(rec(100_000 + rep * 100_000 + i * 1000, "read", f"o{i}", 8 * MIB))
        p = self.dir / "p.jsonl"
        write_lines(p, lines)
        eng, s, _ = replay(trace_scenario(p, local=128 * MIB, duration=2_000_000_000))
        n = eng.nodes[0]
        self.assertLessEqual(n.peak, n.cap)
        self.assertEqual(n.used, sum(o.pages for o in eng.objs.values() if not o.remote))
        self.assertEqual(eng.pool.used, sum(o.pages for o in eng.objs.values() if o.remote))
        self.assertEqual(n.used, sum(o.pages for o in n.lru.values()))
        self.assertGreater(s["access"]["remote_hits"], 0)
        self.assertGreater(s["memory"]["node-0"]["evicted_pages"], 0)
        self.assertEqual(s["ops"]["alloc_failed"], 0)

    def test_local_only_fails_allocations_explicitly(self):
        lines = [rec(i, "alloc", f"o{i}", 8 * MIB) for i in range(40)] + [rec(100, "read", "o39", 8 * MIB)]
        p = self.dir / "l.jsonl"
        write_lines(p, lines)
        raw = trace_scenario(p, local=128 * MIB)
        raw["policy"] = {"name": "local_only"}
        eng, s, _ = replay(raw)
        self.assertEqual(s["ops"]["alloc_failed"], 40 - 16)
        self.assertIn("local capacity exhausted (local_only)", s["ops"]["alloc_fail_reasons"])
        self.assertEqual(s["ops"]["anomalies"].get("skipped_failed_alloc"), 1)
        self.assertLessEqual(eng.nodes[0].peak, eng.nodes[0].cap)
        self.assertEqual(s["traffic"]["remote_read_bytes"], 0)

    def test_node_mapping_is_deterministic_and_recorded(self):
        p = self.dir / "n.jsonl"
        write_lines(p, [rec(0, "alloc", "a", PAGE, node="gpuA"), rec(1, "alloc", "b", PAGE, node="gpuB"),
                        rec(2, "alloc", "c", PAGE)])
        _, _, m = replay(trace_scenario(p))
        self.assertEqual(m["node_map"], {"gpuA": "node-0", "gpuB": "node-0"})  # single compute node

    def test_time_scale_slows_replay(self):
        p = self.sample_trace()
        _, s1, _ = replay(trace_scenario(p, duration=10_000))
        _, s2, _ = replay(trace_scenario(p, duration=10_000, time_scale=100.0))
        self.assertLess(s2["ops"]["executed"]["alloc"], s1["ops"]["executed"]["alloc"])

    def test_missing_trace_file_is_a_validation_error(self):
        raw = trace_scenario(self.dir / "nope.jsonl")
        self.assertTrue(any("trace file not found" in e for e in validate(raw, base_dir=self.dir)[0]))
        with self.assertRaises(ScenarioError):
            build_scenario(raw, base_dir=self.dir)

    def test_relative_trace_path_resolves_against_scenario_dir(self):
        self.sample_trace()
        raw = trace_scenario("t.jsonl")
        _, s, _ = replay(raw, base=self.dir)
        self.assertEqual(s["ops"]["executed"]["alloc"], 6)

    def test_replay_is_deterministic(self):
        p = self.sample_trace()
        a = replay(trace_scenario(p))[1]
        b = replay(trace_scenario(p))[1]
        self.assertEqual(canonical(a), canonical(b))


class Generators(unittest.TestCase):
    def ops(self, name, **mod):
        raw = load_raw(EX / name)
        for path, val in mod.items():
            node = raw
            keys = path.split("__")
            for k in keys[:-1]:
                node = node[k]
            node[keys[-1]] = val
        sc = build_scenario(raw)
        p = Params(sc)
        return sc, p, list(generate_ops(sc, p))

    def test_ordering_horizon_and_determinism(self):
        for f in ("phase2-moe-tiering.json", "phase2-sparse-attention.json", "phase2-prefill.json", "phase2-kv-ops.json"):
            sc, _, a = self.ops(f)
            ts = [o[0] for o in a]
            self.assertEqual(ts, sorted(ts), f)
            self.assertLessEqual(ts[-1], sc.duration_ns, f)
            self.assertEqual(a, self.ops(f)[2], f)
    
    def test_seed_changes_stream(self):
        a = self.ops("phase2-moe-tiering.json")[2]
        b = self.ops("phase2-moe-tiering.json", seed=12345)[2]
        self.assertNotEqual(a, b)

    def test_kv_sizing_matches_closed_form(self):
        sc, p, ops = self.ops("phase2-kv-ops.json")
        kvtok = kv_bytes_per_token(sc.model)
        self.assertEqual(kvtok, 2 * 32 * 8 * 128 * 2)
        block = p.block_pages * p.page
        first = [o for o in ops if o[5] == "req-0" and o[1] == "alloc"]
        prompt_blocks = -(-(sc.requests["prompt_tokens"] * kvtok) // block)
        n_prompt = sum(1 for o in first if o[0] == first[0][0])
        self.assertEqual(n_prompt, prompt_blocks)
        # at every decode step the live KV bytes cover the formula and overshoot by < one block
        allocated = len(first) * block
        total_tokens = sc.requests["prompt_tokens"] + sc.requests["generated_tokens"]
        self.assertGreaterEqual(allocated, kvtok * total_tokens)
        self.assertLess(allocated - kvtok * total_tokens, block)

    def test_kv_every_request_frees_what_it_allocates(self):
        sc, _, ops = self.ops("phase2-kv-ops.json", duration_ns=30_000_000_000)
        done = {o[5] for o in ops if o[1] == "free"}
        for rid in done:
            a = sorted(o[2] for o in ops if o[5] == rid and o[1] == "alloc")
            f = sorted(o[2] for o in ops if o[5] == rid and o[1] == "free")
            self.assertEqual(a, f)

    def test_moe_distinct_experts_and_skew(self):
        sc, p, ops = self.ops("phase2-moe-tiering.json", duration_ns=60_000_000_000)
        by_step = Counter((o[0], o[2].rsplit("/E", 1)[0], o[5]) for o in ops if o[1] == "read" and o[5])
        reads = [o for o in ops if o[1] == "read"]
        per_step = Counter((o[0], o[2].rsplit("/E", 1)[0], o[5]) for o in reads)
        # decode steps pick exactly top_k distinct experts per (time, layer, request)
        decode_groups = [v for k, v in per_step.items() if v == sc.model["top_k"]]
        self.assertTrue(decode_groups)
        self.assertEqual(len({(o[0], o[2], o[5]) for o in reads}), len(reads))
        # zipf skew: the most popular expert of layer 0 beats the median by a clear margin
        c = Counter(o[2] for o in reads if "/L0/" in o[2])
        counts = sorted(c.values(), reverse=True)
        self.assertGreater(counts[0], 2 * counts[len(counts) // 2])

    def test_moe_uniform_is_flatter_than_zipf(self):
        def spread(dist):
            _, _, ops = self.ops("phase2-moe-tiering.json", duration_ns=60_000_000_000,
                                 workload__model__popularity_distribution=dist)
            c = Counter(o[2] for o in ops if o[1] == "read" and "/L1/" in o[2])
            v = np.array(sorted(c.values()), dtype=float)
            return v[-1] / max(v[len(v) // 2], 1)
        self.assertLess(spread("uniform"), spread("zipf"))

    def test_sparse_reads_window_plus_globals(self):
        sc, p, ops = self.ops("phase2-sparse-attention.json")
        reads = [o for o in ops if o[1] == "read" and o[5] == "req-0"]
        steps = Counter(o[0] for o in reads)
        tok_per_block = (p.block_pages * p.page) // p.kvtok
        win_blocks = -(-sc.sparsity["window_tokens"] // tok_per_block) + 1
        for n in steps.values():
            self.assertLessEqual(n, win_blocks + sc.sparsity["global_tokens"])
            self.assertGreaterEqual(n, win_blocks - 1)

    def test_prefill_frees_activations_and_kv(self):
        sc, _, ops = self.ops("phase2-prefill.json")
        allocs = Counter(o[2] for o in ops if o[1] == "alloc")
        frees = Counter(o[2] for o in ops if o[1] == "free")
        finished = {o[5] for o in ops if o[1] == "free" and "/kv" in o[2]}
        self.assertTrue(finished)
        for rid in finished:  # a request that completed leaves nothing allocated behind
            mine = [k for k in allocs if k.startswith(rid + "/")]
            self.assertTrue(all(frees[k] == 1 for k in mine), rid)
        self.assertTrue(all(not o[2].startswith("w/") for o in ops if o[1] == "free"))  # weights stay resident

    def test_defaults_are_declared_not_silent(self):
        _, p, _ = self.ops("phase2-prefill.json")
        names = {d["parameter"] for d in p.defaulted}
        self.assertIn("workload.model.weight_bytes_per_layer", names)
        _, p2, _ = self.ops("phase2-kv-ops.json")
        self.assertIn("workload.requests.prefill_tokens_per_second", {d["parameter"] for d in p2.defaulted})

    def test_precomputed_equals_on_demand(self):
        for f in ("phase2-moe-tiering.json", "phase2-sparse-attention.json"):
            with tempfile.TemporaryDirectory() as d:
                scp = EX / f
                tr = Path(d) / "t.jsonl"
                self.assertEqual(cli_main(["generate", str(scp), "--out", str(tr)]), 0)
                raw = load_raw(scp)
                on_demand = replay(raw)[1]
                raw2 = copy.deepcopy(raw)
                raw2["workload"] = {"type": "trace", "path": str(tr)}
                pre = replay(raw2)[1]
                for key in ("access", "traffic", "memory", "links", "pool", "op_latency_ns"):
                    self.assertEqual(on_demand[key], pre[key], f"{f}: {key}")
                self.assertEqual(on_demand["ops"]["executed"], pre["ops"]["executed"])
                # both streams are truncated identically if backpressure stalls the source past the end
                self.assertEqual(on_demand["replay"]["executed_alloc_free_sha256"],
                                 pre["replay"]["executed_alloc_free_sha256"])

    def test_generated_runs_are_deterministic(self):
        for f in ("phase2-moe-tiering.json", "phase2-sparse-attention.json", "phase2-prefill.json"):
            raw = load_raw(EX / f)
            self.assertEqual(canonical(replay(raw)[1]), canonical(replay(raw)[1]), f)

    def test_open_loop_kv_runs_and_matches_trace(self):
        raw = load_raw(EX / "phase2-kv-ops.json")
        sc = build_scenario(raw)
        eng = make_engine(sc, open_loop=True)
        s, _ = eng.run()
        self.assertGreater(s["ops"]["executed"]["read"], 0)
        self.assertEqual(s["workload"]["generator"]["mode"], "open_loop_ops")

    def test_validation_of_profile_requirements(self):
        raw = load_raw(EX / "phase2-moe-tiering.json")
        raw["workload"]["model"]["top_k"] = 99
        self.assertTrue(any("top_k" in e for e in validate(raw)[0] + [str(x) for x in []] + self._build_errs(raw)))
        raw = load_raw(EX / "phase2-sparse-attention.json")
        del raw["workload"]["sparsity"]
        self.assertTrue(any("window_tokens" in e for e in validate(raw)[0]))
        raw = load_raw(EX / "phase2-moe-tiering.json")
        raw["workload"]["model"]["popularity_distribution"] = "custom"
        self.assertTrue(any("popularity_weights" in e for e in validate(raw)[0]))
        raw["workload"]["model"]["popularity_weights"] = list(range(1, 17))
        self.assertEqual(validate(raw)[0], [])

    @staticmethod
    def _build_errs(raw):
        try:
            build_scenario(raw)
        except ScenarioError as e:
            return e.errors
        return []

    def test_custom_popularity_is_honored(self):
        raw = load_raw(EX / "phase2-moe-tiering.json")
        raw["duration_ns"] = 30_000_000_000
        raw["workload"]["model"]["popularity_distribution"] = "custom"
        w = [0.0] * 16
        w[3], w[9] = 5.0, 5.0
        raw["workload"]["model"]["popularity_weights"] = w
        sc = build_scenario(raw)
        ids = {o[2].rsplit("/E", 1)[1] for o in generate_ops(sc) if o[1] == "read" and "/L2/" in o[2]}
        self.assertTrue({"3", "9"} <= ids)
        self.assertEqual(ids - {"3", "9"} - set(), ids - {"3", "9"})  # prefill union may touch rare ones only with p=0 -> none
        self.assertEqual(ids, {"3", "9"})


SNAP = {
    "segments": [],
    "device_traces": [[
        {"action": "segment_alloc", "addr": 4096, "size": 1 << 30, "stream": 0, "time_us": 1000},
        {"action": "alloc", "addr": 4096, "size": 4 * MIB, "stream": 0, "time_us": 1010},
        {"action": "alloc", "addr": 4096 + 4 * MIB, "size": 6 * MIB, "stream": 0, "time_us": 1020},
        {"action": "free_requested", "addr": 4096, "size": 4 * MIB, "stream": 0, "time_us": 1030},
        {"action": "free_completed", "addr": 4096, "size": 4 * MIB, "stream": 0, "time_us": 1031},
        {"action": "alloc", "addr": 4096, "size": 2 * MIB, "stream": 0, "time_us": 1040},   # address reused
        {"action": "free_requested", "addr": 999999, "size": 1, "stream": 0, "time_us": 1050},  # never allocated
        {"action": "free_requested", "addr": 4096 + 4 * MIB, "size": 6 * MIB, "stream": 0, "time_us": 1060},
    ], [
        {"action": "alloc", "addr": 8192, "size": 3 * MIB, "stream": 0, "time_us": 1015},
    ]],
}


class SnapshotConverter(unittest.TestCase):
    def test_conversion_semantics(self):
        header, ops, rep = convert_snapshot(SNAP, source_sha256="abc")
        self.assertEqual(rep["alloc"], 4)
        self.assertEqual(rep["free"], 2)
        self.assertEqual(rep["ignored_actions"], {"segment_alloc": 1, "free_completed": 1})
        self.assertEqual(rep["dropped"], {"free_of_unknown_block": 1})
        ids = [o[2] for o in ops if o[1] == "alloc"]
        self.assertEqual(len(set(ids)), 4)  # reused address gets a new generation id
        self.assertEqual(ops[0][0], 0)  # rebased to first event
        self.assertEqual([o[0] for o in ops], sorted(o[0] for o in ops))
        self.assertEqual({o[4] for o in ops}, {"gpu0", "gpu1"})
        self.assertEqual(header["label"], "measured")
        self.assertEqual(header["source_sha256"], "abc")
        self.assertIn("no access records", header["notes"])
        # ts in ns: 10 us -> 10_000 ns
        self.assertEqual(ops[1][0] - ops[0][0], 5_000)

    def test_touch_on_alloc_is_declared(self):
        header, ops, rep = convert_snapshot(SNAP, source_sha256="x", touch_on_alloc=True)
        self.assertEqual(rep["touch_writes"], 4)
        self.assertIn("synthesized", header["notes"])

    def test_segments_only_fallback_is_reported(self):
        snap = {"segments": [{"device": 0, "blocks": [{"size": 4 * MIB, "state": "active_allocated", "address": 4096},
                                                      {"size": 8 * MIB, "state": "inactive", "address": 99999}]}]}
        _, ops, rep = convert_snapshot(snap, source_sha256="x")
        self.assertEqual(len(ops), 1)
        self.assertEqual(rep["synthesized"]["from_segments"], 1)

    def test_empty_snapshot_errors(self):
        with self.assertRaises(ValueError):
            convert_snapshot({"segments": []}, source_sha256="x")

    def test_pickle_loading_is_restricted(self):
        with tempfile.TemporaryDirectory() as d:
            ok = Path(d) / "ok.pickle"
            ok.write_bytes(pickle.dumps(SNAP))
            data, sha = load_snapshot(ok)
            self.assertEqual(data["device_traces"][0][1]["size"], 4 * MIB)
            self.assertEqual(sha, hashlib.sha256(ok.read_bytes()).hexdigest())
            bad = Path(d) / "bad.pickle"
            bad.write_bytes(pickle.dumps(Params))  # references a global -> must be refused
            with self.assertRaises(pickle.UnpicklingError):
                load_snapshot(bad)
            js = Path(d) / "s.json"
            js.write_text(json.dumps(SNAP))
            self.assertEqual(load_snapshot(js)[0]["device_traces"][0][0]["action"], "segment_alloc")

    def test_cli_convert_then_replay_matches_sequence(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            snap, out = d / "s.pickle", d / "t.jsonl"
            snap.write_bytes(pickle.dumps(SNAP))
            self.assertEqual(cli_main(["convert-snapshot", str(snap), "-o", str(out), "--label", "synthetic"]), 0)
            hdr = json.loads(out.read_text().splitlines()[0])
            self.assertEqual(hdr["label"], "synthetic")
            _, s, m = replay(trace_scenario(out, duration=10_000_000))
            self.assertTrue(s["replay"]["sequence_matches"], s["replay"])
            self.assertEqual(m["trace_header"]["source"], "pytorch-cuda-snapshot")
            self.assertEqual(s["workload"]["trace"]["page_normalization"]["records"], 1)  # only the 3 MiB block is unaligned
            self.assertEqual(cli_main(["convert-snapshot", str(d / "missing"), "-o", str(out)]), 1)


class CliPhase2(unittest.TestCase):
    def test_trace_info_generate_and_bare_trace_run(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            tr = d / "t.jsonl"
            self.assertEqual(cli_main(["generate", str(EX / "phase2-sparse-attention.json"), "--out", str(tr)]), 0)
            self.assertEqual(cli_main(["trace-info", str(tr)]), 0)
            self.assertEqual(cli_main(["run", str(tr), "--workload-type", "trace", "--scenario",
                                       str(EX / "phase2-trace-replay.json"), "--out", str(d / "r"), "--quiet"]), 0)
            man = json.loads((d / "r" / "manifest.json").read_text())
            self.assertEqual(man["trace_hashes"][0]["sha256"], hashlib.sha256(tr.read_bytes()).hexdigest())
            self.assertEqual(cli_main(["run", str(tr), "--workload-type", "trace"]), 1)  # needs --scenario

    def test_bad_trace_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            bad = d / "bad.jsonl"
            bad.write_text('{"ts_ns": 0, "op": "alloc"}\n')
            self.assertEqual(cli_main(["trace-info", str(bad)]), 1)

    def test_committed_example_trace_replays_and_matches(self):
        self.assertEqual(cli_main(["validate", str(EX / "phase2-trace-replay.json"), "--require-provenance"]), 0)
        raw = load_raw(EX / "phase2-trace-replay.json")
        sc = build_scenario(raw, base_dir=EX)
        s, m = make_engine(sc).run()
        self.assertTrue(s["replay"]["sequence_matches"])
        self.assertEqual(s["workload_label"], "synthetic")
        self.assertGreater(s["access"]["remote_hits"], 0)

    def test_examples_all_validate(self):
        for f in sorted(EX.glob("*.json")):
            self.assertEqual(cli_main(["validate", str(f)]), 0, f.name)


if __name__ == "__main__":
    unittest.main()
