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
        for name in ("llama-70b-cxl.json", "eight-node-rdma-pool.json",
                     "phase1-overflow.json", "policy-prefetch-failure.json"):
            errors, _, _ = validate(load_example(name))
            self.assertEqual(errors, [], name)

    def test_unknown_profile_rejected_for_run(self):
        raw = load_example("eight-node-rdma-pool.json")
        raw["workload"]["profile"] = "moe"
        with self.assertRaises(ScenarioError) as cm:
            build_scenario(raw)
        self.assertTrue(any("profile" in e and "not implemented" in e
                            for e in cm.exception.errors))

    def test_eight_node_example_builds(self):
        sc = build_scenario(load_example("eight-node-rdma-pool.json"))
        self.assertEqual(sc.name, "eight-node-rdma-pool")
        self.assertEqual(sc.policy_effective, "frequency_aware")

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

    def test_unknown_policy_name_is_rejected(self):
        # cost_aware is not in the policy contract: requesting it is a hard
        # schema error, not a silent fallback.
        raw = load_example("llama-70b-cxl.json")
        raw["policy"] = {"name": "cost_aware"}
        with self.assertRaises(ScenarioError) as cm:
            build_scenario(raw)
        self.assertTrue(any("policy.name" in e and "cost_aware" in e
                            for e in cm.exception.errors))

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
