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


if __name__ == "__main__":
    unittest.main()
