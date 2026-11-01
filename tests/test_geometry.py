"""Geometry: every model shape is a parameter set, not a code path."""
import unittest

from rmemfab.workloads.geometry import (
    GeometryError,
    LayerClass,
    pages_for,
    read_span,
    resolve_layer_classes,
)

PAGE = 2 * 1024 * 1024


class TestLegacyDense(unittest.TestCase):
    def test_standard_formula(self):
        classes, src = resolve_layer_classes(
            {"layers": 80, "kv_heads": 8, "head_dim": 128, "dtype_bytes": 2})
        self.assertEqual(src, "legacy_dense")
        self.assertEqual(len(classes), 1)
        self.assertEqual(classes[0].kv_bytes_per_token, 2 * 80 * 8 * 128 * 2)
        self.assertIsNone(classes[0].window_tokens)

    def test_missing_keys_error_names_field(self):
        with self.assertRaises(GeometryError) as cm:
            resolve_layer_classes({"layers": 80})
        self.assertTrue(any("kv_heads" in e for e in cm.exception.errors))


class TestLayerClasses(unittest.TestCase):
    def test_explicit_classes_used_verbatim(self):
        classes, src = resolve_layer_classes({"layer_classes": [
            {"name": "full", "layers": 13, "kv_bytes_per_token": 13312},
            {"name": "sliding", "layers": 39, "kv_bytes_per_token": 39936, "window_tokens": 2048},
            {"name": "linear", "layers": 69, "kv_bytes_per_token": 0},
        ]})
        self.assertEqual(src, "layer_classes")
        self.assertEqual([c.name for c in classes], ["full", "sliding", "linear"])
        self.assertEqual(classes[2].kv_bytes_per_token, 0)

    def test_invalid_classes_rejected(self):
        with self.assertRaises(GeometryError):
            resolve_layer_classes({"layer_classes": []})
        with self.assertRaises(GeometryError):
            resolve_layer_classes({"layer_classes": [{"name": "x", "layers": 0,
                                                      "kv_bytes_per_token": 1}]})
        with self.assertRaises(GeometryError):
            resolve_layer_classes({"layer_classes": [
                {"name": "x", "layers": 1, "kv_bytes_per_token": 1},
                {"name": "x", "layers": 1, "kv_bytes_per_token": 1}]})


class TestFootprints(unittest.TestCase):
    def test_pages_ceil(self):
        self.assertEqual(pages_for(8192, 327680, PAGE), 1280)
        self.assertEqual(pages_for(0, 327680, PAGE), 0)
        self.assertEqual(pages_for(8192, 0, PAGE), 0)

    def test_window_span_is_suffix(self):
        k = LayerClass("sliding", 39, 39936, 2048)
        lo, hi = read_span(8192, k, PAGE)
        self.assertEqual(hi, pages_for(8192, 39936, PAGE))
        self.assertEqual(lo, pages_for(8192 - 2048, 39936, PAGE))
        self.assertGreater(lo, 0)

    def test_full_span_starts_at_zero(self):
        k = LayerClass("dense", 80, 327680, None)
        self.assertEqual(read_span(8192, k, PAGE)[0], 0)

    def test_windowed_class_reads_suffix_end_to_end(self):
        """Sparse validation: a windowed class keeps the full footprint but
        reads only the trailing window each decode step."""
        import tempfile
        from support import load_example, run_engine, write_tmp_scenario
        unit = 1 << 20
        raw = load_example("phase1-overflow.json")
        raw["name"] = "windowed-sparse"
        raw["page_size_bytes"] = unit
        raw["duration_ns"] = 1_000_000_000
        raw["warmup_ns"] = 0
        raw["metrics"]["warmup_ns"] = 0
        raw["nodes"][0]["local_memory"]["capacity_bytes"] = 16 * unit
        raw["nodes"][1]["remote_memory"]["capacity_bytes"] = 1 << 30
        raw["policy"] = {"name": "local_only"}
        raw["workload"] = {
            "type": "synthetic", "profile": "kv_cache_decode",
            "model": {"layer_classes": [{"name": "sliding", "layers": 39,
                                         "kv_bytes_per_token": unit, "window_tokens": 4}]},
            "requests": {"arrival_process": "poisson", "arrival_rate_per_second": 10.0,
                         "prompt_tokens": 8, "generated_tokens": 1, "concurrency": 1},
        }
        raw["output"] = {"format": "jsonl", "include_event_log": False}
        summary, _ = run_engine(write_tmp_scenario(raw), tempfile.mkdtemp())
        # Footprint is full context (prompt 8 + token 1 = 9 pages)...
        self.assertEqual(summary["memory"]["node-0"]["peak_used_pages"], 9)
        # ...but every decode step reads only the 4 trailing-window pages.
        self.assertGreater(summary["access"]["count"], 0)
        self.assertEqual(summary["access"]["count"] % 4, 0)
        self.assertEqual(summary["access"]["local_hit_ratio"], 1.0)

    def test_different_geometries_different_footprints(self):
        toks, page = 8192, PAGE
        uniform = pages_for(toks, 327680, page)
        hybrid = pages_for(toks, 13312, page) + pages_for(toks, 39936, page)
        sparse = pages_for(toks, 0, page) + pages_for(toks, 147456, page)
        self.assertEqual(hybrid, pages_for(toks, 13312 + 39936, page))
        self.assertLess(sparse, uniform)
        self.assertLess(hybrid, uniform)


if __name__ == "__main__":
    unittest.main()
