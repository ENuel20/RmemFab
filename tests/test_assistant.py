"""Assistant endpoints with a mocked provider (no network).

Draft and chat call Baseten through rmemfab.api.app.BasetenClient; these
tests replace it with fakes and pin the server-side contracts: validate
before store, honest failures, grounded context, SSE framing.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_api import tiny_synth

try:
    from fastapi.testclient import TestClient
    from rmemfab.api import create_app
    import rmemfab.api.app as appmod
    from rmemfab.api.providers import (ProviderError, ProviderNotConfigured)
    HAVE_API = True
except ImportError:
    HAVE_API = False


class FakeClient:
    model = "fake-muse"
    content = None
    chunks = None

    def __init__(self, *a, **k):
        pass

    def chat(self, messages, **kw):
        FakeClient.seen_messages = messages
        return {"content": FakeClient.content, "usage": {"total_tokens": 7},
                "model": "fake-muse"}

    def chat_stream(self, messages, **kw):
        FakeClient.seen_messages = messages
        yield from FakeClient.chunks


@unittest.skipUnless(HAVE_API, "rmemfab[api] not installed")
class AssistantContract(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        app = create_app(runs_dir=str(Path(self.td.name) / "runs"),
                         traces_dir=str(Path(self.td.name) / "traces"))
        self.c = TestClient(app)
        self.patch = mock.patch.object(appmod, "BasetenClient", FakeClient)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_draft_valid_stores_version(self):
        FakeClient.content = json.dumps(tiny_synth())
        r = self.c.post("/scenarios/draft",
                        json={"prompt": "small two-tier swap setup"})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("version", body)
        self.assertEqual(body["scenario"]["policy"]["name"], "swap_remote")
        # Stored: usable as a version parent.
        r = self.c.post("/scenarios/version", json={
            "parent_version": body["version"],
            "patch": [{"op": "replace", "path": "/seed", "value": 11}]})
        self.assertEqual(r.status_code, 200)

    def test_draft_non_json_rejected(self):
        FakeClient.content = "not json {{{"
        r = self.c.post("/scenarios/draft", json={"prompt": "x"})
        self.assertEqual(r.status_code, 422)
        self.assertIn("not JSON", r.json()["detail"]["error"])

    def test_draft_invalid_scenario_rejected_with_errors(self):
        bad = tiny_synth()
        del bad["nodes"]
        FakeClient.content = json.dumps(bad)
        r = self.c.post("/scenarios/draft", json={"prompt": "x"})
        self.assertEqual(r.status_code, 422)
        body = r.json()["detail"]
        self.assertIn("scenario", body)
        self.assertGreater(len(body["errors"]), 0)

    def test_draft_without_key_is_503(self):
        class NoKey:
            def __init__(self, *a, **k):
                raise ProviderNotConfigured("nope")
        with mock.patch.object(appmod, "BasetenClient", NoKey):
            r = self.c.post("/scenarios/draft", json={"prompt": "x"})
        self.assertEqual(r.status_code, 503)

    def test_chat_answers_from_run_telemetry(self):
        r = self.c.post("/runs", json={"scenario": tiny_synth()})
        rid = r.json()["run_id"]
        FakeClient.chunks = [
            {"choices": [{"delta": {"content": "p95 is "}}]},
            {"choices": [{"delta": {"content": "445ns."}}]}]
        r = self.c.post("/assistant/chat", json={
            "messages": [{"role": "user", "content": "what is p95?"}],
            "context": {"run_id": rid}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["content"], "p95 is 445ns.")
        self.assertIn(rid, FakeClient.seen_messages[0]["content"])

    def test_chat_ignores_usage_only_chunks(self):
        FakeClient.chunks = [
            {"choices": []},
            {"choices": [{"delta": {"content": "ok"}}]},
            {"choices": [{"delta": {}}]}]
        r = self.c.post("/assistant/chat", json={"messages": []})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["content"], "ok")

    def test_chat_streams_sse(self):
        FakeClient.chunks = [{"choices": [{"delta": {"content": "hi"}}]}]
        r = self.c.post("/assistant/chat", json={
            "messages": [{"role": "user", "content": "hi"}], "stream": True})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.text.rstrip().endswith("data: [DONE]"))
        self.assertIn("data: {", r.text)

    def test_chat_unknown_run_is_404(self):
        r = self.c.post("/assistant/chat", json={
            "messages": [], "context": {"run_id": "nope"}})
        self.assertEqual(r.status_code, 404)

    def test_provider_error_is_502(self):
        class Boom(FakeClient):
            def chat_stream(self, messages, **kw):
                raise ProviderError("down")
                yield
        with mock.patch.object(appmod, "BasetenClient", Boom):
            r = self.c.post("/assistant/chat", json={"messages": []})
        self.assertEqual(r.status_code, 502)

    def _seed_version(self, policy="swap_remote"):
        r = self.c.post("/scenarios/version",
                        json={"scenario": tiny_synth(policy)})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["version"]

    def test_apply_patch_from_version_runs(self):
        v1 = self._seed_version()
        r = self.c.post("/assistant/apply", json={
            "parent_version": v1, "note": "bump seed",
            "patch": [{"op": "replace", "path": "/seed", "value": 11}]})
        self.assertEqual(r.status_code, 202, r.text)
        body = r.json()
        self.assertNotEqual(body["version"], v1)
        self.assertEqual(body["status"], "completed")
        self.assertEqual(len(body["changes"]), 1)
        # Stored version is the patched scenario.
        r = self.c.get(f"/scenarios/version/{body['version']}")
        self.assertEqual(r.json()["scenario"]["seed"], 11)
        self.assertEqual(r.json()["parent_version"], v1)

    def test_apply_rejects_invalid_patch(self):
        v1 = self._seed_version()
        r = self.c.post("/assistant/apply", json={
            "parent_version": v1,
            "patch": [{"op": "remove", "path": "/nodes"}]})
        self.assertEqual(r.status_code, 422)
        self.assertIn("errors", r.json()["detail"])

    def test_apply_rejects_noop_and_bad_combo(self):
        v1 = self._seed_version()
        r = self.c.post("/assistant/apply", json={
            "parent_version": v1,
            "patch": [{"op": "replace", "path": "/seed", "value": 7}]})
        self.assertEqual(r.status_code, 422)
        r = self.c.post("/assistant/apply", json={
            "parent_version": v1, "parent_run_id": "x",
            "patch": [{"op": "replace", "path": "/seed", "value": 8}]})
        self.assertEqual(r.status_code, 422)
        r = self.c.post("/assistant/apply", json={"parent_version": v1})
        self.assertEqual(r.status_code, 422)

    def test_apply_from_run_compares_fairly(self):
        r = self.c.post("/runs", json={"scenario": tiny_synth("swap_remote")})
        rid = r.json()["run_id"]
        r = self.c.post("/assistant/apply", json={
            "parent_run_id": rid, "note": "try local_only",
            "patch": [{"op": "replace", "path": "/policy/name",
                       "value": "local_only"}]})
        self.assertEqual(r.status_code, 202, r.text)
        body = r.json()
        self.assertEqual(body["status"], "completed")
        self.assertIsNotNone(body["compare"])
        self.assertEqual(body["compare"]["verdict"], "fair")

    def test_apply_instruction_uses_model(self):
        v1 = self._seed_version()
        new = tiny_synth("swap_remote", seed=13)
        FakeClient.content = json.dumps(new)
        r = self.c.post("/assistant/apply", json={
            "parent_version": v1, "instruction": "use seed 13"})
        self.assertEqual(r.status_code, 202, r.text)
        body = r.json()
        self.assertEqual(body["model"], "fake-muse")
        self.assertEqual(body["status"], "completed")
        r = self.c.get(f"/scenarios/version/{body['version']}")
        self.assertEqual(r.json()["scenario"]["seed"], 13)

    def test_rollback_reruns_version(self):
        v1 = self._seed_version()
        r = self.c.post("/assistant/apply", json={
            "parent_version": v1,
            "patch": [{"op": "replace", "path": "/seed", "value": 11}]})
        v2 = r.json()["version"]
        r = self.c.post("/assistant/rollback", json={
            "to_version": v1, "from_version": v2, "note": "seed 11 was worse"})
        self.assertEqual(r.status_code, 202, r.text)
        body = r.json()
        self.assertEqual(body["status"], "completed")
        self.assertNotEqual(body["version"], v1)
        rec = self.c.get(f"/scenarios/version/{body['version']}").json()
        self.assertEqual(rec["rollback_to"], v1)
        self.assertEqual(rec["scenario"]["seed"], 7)

    def test_rollback_unknown_is_404(self):
        r = self.c.post("/assistant/rollback", json={"to_version": "nope"})
        self.assertEqual(r.status_code, 404)

    def _run_id(self):
        r = self.c.post("/runs", json={"scenario": tiny_synth()})
        return r.json()["run_id"]

    def test_chat_suggest_patch_valid(self):
        rid = self._run_id()
        FakeClient.chunks = [{"choices": [{"delta": {"content":
            "Try seed 8.\n```patch\n"
            '[{"op": "replace", "path": "/seed", "value": 8}]\n```'}}]}]
        r = self.c.post("/assistant/chat", json={
            "messages": [{"role": "user", "content": "what should I try?"}],
            "context": {"run_id": rid}, "suggest_patch": True})
        self.assertEqual(r.status_code, 200, r.text)
        sp = r.json()["suggested_patch"]
        self.assertTrue(sp["valid"], sp)
        self.assertEqual(sp["ops"][0]["value"], 8)
        self.assertEqual(len(sp["changes"]), 1)

    def test_chat_suggest_patch_invalid(self):
        rid = self._run_id()
        FakeClient.chunks = [{"choices": [{"delta": {"content":
            "```patch\n"
            '[{"op": "remove", "path": "/nodes"}]\n```'}}]}]
        r = self.c.post("/assistant/chat", json={
            "messages": [], "context": {"run_id": rid},
            "suggest_patch": True})
        self.assertEqual(r.status_code, 200, r.text)
        sp = r.json()["suggested_patch"]
        self.assertFalse(sp["valid"])
        self.assertGreater(len(sp["errors"]), 0)

    def test_chat_suggest_patch_absent_is_none(self):
        rid = self._run_id()
        FakeClient.chunks = [{"choices": [{"delta": {"content": "looks fine"}}]}]
        r = self.c.post("/assistant/chat", json={
            "messages": [], "context": {"run_id": rid},
            "suggest_patch": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["suggested_patch"])

    def test_chat_suggest_patch_sees_scenario(self):
        # Patch paths verify against the scenario, so the model must see it:
        # without the scenario in context it can only guess paths from
        # telemetry field names (e.g. /policy/requested, which is rejected).
        rid = self._run_id()
        FakeClient.chunks = [{"choices": [{"delta": {"content": "ok"}}]}]
        r = self.c.post("/assistant/chat", json={
            "messages": [], "context": {"run_id": rid},
            "suggest_patch": True})
        self.assertEqual(r.status_code, 200, r.text)
        system = FakeClient.seen_messages[0]["content"]
        self.assertIn("Run scenario JSON", system)
        # policy.name exists only in the scenario, never in telemetry.
        self.assertIn('"name": "swap_remote"', system)

    def test_chat_suggest_patch_needs_run_and_no_stream(self):
        r = self.c.post("/assistant/chat", json={
            "messages": [], "suggest_patch": True})
        self.assertEqual(r.status_code, 422)
        rid = self._run_id()
        r = self.c.post("/assistant/chat", json={
            "messages": [], "context": {"run_id": rid},
            "suggest_patch": True, "stream": True})
        self.assertEqual(r.status_code, 422)


if __name__ == "__main__":
    unittest.main()
