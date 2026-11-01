"""Schema drift guard, fixture validity, run-only gating, provenance, hashing."""
import copy
import json
import unittest

from support import REPO, load_example
from rmemfab.config.scenario import (
    ScenarioError,
    build_scenario,
    scenario_hash,
    validate,
)


class TestSchemaDrift(unittest.TestCase):
    def test_bundled_copy_matches_repo_specs(self):
        a = json.loads((REPO / "SPECS" / "config.schema.json").read_text(encoding="utf-8"))
        b = json.loads((REPO / "src" / "rmemfab" / "config" / "config.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(a, b)


class TestFixtures(unittest.TestCase):
    def test_all_examples_validate(self):
        for name in ("llama-70b-cxl.json", "moe-remote-tiering.json",
                     "phase1-overflow.json", "policy-prefetch-failure.json"):
            errors, _, _ = validate(load_example(name))
            self.assertEqual(errors, [], name)

    def test_moe_profile_rejected_for_run(self):
        with self.assertRaises(ScenarioError) as cm:
            build_scenario(load_example("moe-remote-tiering.json"))
        self.assertTrue(any("profile" in e for e in cm.exception.errors))

    def test_trace_workload_builds_with_valid_path(self):
        raw = load_example("phase2-replay-opt.json")
        sc = build_scenario(raw, base_dir=str(REPO / "examples"))
        self.assertEqual(sc.workload_type, "trace")
        self.assertEqual(sc.trace.report["stats"]["ops"], 4540)

    def test_trace_workload_missing_path_errors(self):
        raw = load_example("phase1-overflow.json")
        raw["workload"] = {"type": "trace", "path": "traces/does-not-exist.jsonl"}
        errors, _, _ = validate(raw, for_run=True, base_dir=str(REPO / "examples"))
        self.assertTrue(any("not found" in e for e in errors))

    def test_hot_cold_now_runs_natively(self):
        # Phase 3 implemented hot_cold: the llama example no longer falls back.
        sc = build_scenario(load_example("llama-70b-cxl.json"))
        self.assertEqual(sc.policy_requested, "hot_cold")
        self.assertEqual(sc.policy_effective, "hot_cold")
        self.assertIsNone(sc.fallback_reason)

    def test_later_policy_falls_back_and_strict_refuses(self):
        raw = load_example("llama-70b-cxl.json")
        raw["policy"] = {"name": "cost_aware"}
        sc = build_scenario(raw)
        self.assertEqual(sc.policy_requested, "cost_aware")
        self.assertEqual(sc.policy_effective, "swap_remote")
        self.assertTrue(sc.fallback_reason)
        with self.assertRaises(ScenarioError):
            build_scenario(raw, strict_policy=True)

    def test_policy_override(self):
        sc = build_scenario(load_example("phase1-overflow.json"), policy="local_only")
        self.assertEqual(sc.policy_effective, "local_only")


class TestProvenance(unittest.TestCase):
    def test_assumed_is_allowed_missing_is_not(self):
        raw = load_example("llama-70b-cxl.json")
        errors, _, assumed = validate(raw, require_provenance=True)
        self.assertEqual(errors, [])
        self.assertGreater(len(assumed), 0)
        bad = copy.deepcopy(raw)
        del bad["nodes"][0]["local_memory"]["provenance"]
        errors, _, _ = validate(bad, require_provenance=True)
        self.assertTrue(any("provenance" in e for e in errors))
        errors, warnings, _ = validate(bad, require_provenance=False)
        self.assertEqual(errors, [])
        self.assertTrue(any("provenance" in w for w in warnings))


class TestCanonicalHash(unittest.TestCase):
    def test_insensitive_to_whitespace_and_key_order(self):
        raw = load_example("phase1-overflow.json")
        rev = json.loads(json.dumps(raw), object_pairs_hook=dict)
        rev = {k: rev[k] for k in reversed(list(rev.keys()))}
        self.assertEqual(scenario_hash(raw), scenario_hash(rev))

    def test_sensitive_to_one_value(self):
        raw = load_example("phase1-overflow.json")
        other = copy.deepcopy(raw)
        other["seed"] = raw["seed"] + 1
        self.assertNotEqual(scenario_hash(raw), scenario_hash(other))


if __name__ == "__main__":
    unittest.main()
