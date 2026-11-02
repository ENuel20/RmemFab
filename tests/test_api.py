"""Run API contract: health, validate, runs, telemetry, compare, traces."""
import copy
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from support import load_example

try:
    from fastapi.testclient import TestClient
    from rmemfab.api import create_app
    HAVE_API = True
except ImportError:
    HAVE_API = False

UNIT = 4096
HEADER = {"type": "header", "trace_version": "0.1", "source": "test"}


def tiny_synth(policy="swap_remote", seed=7):
    raw = load_example("phase1-overflow.json")
    raw["page_size_bytes"] = UNIT
    raw["duration_ns"] = 500_000_000
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["metrics"]["sample_interval_ns"] = 100_000_000
    raw["nodes"][0]["local_memory"]["capacity_bytes"] = 64 * UNIT
    raw["seed"] = seed
    raw["workload"]["requests"]["arrival_rate_per_second"] = 10.0
    raw["workload"]["requests"]["prompt_tokens"] = 64
    raw["workload"]["requests"]["generated_tokens"] = 4
    raw["policy"] = {"name": policy}
    raw["output"] = {"format": "jsonl", "include_event_log": True}
    return raw


def write_trace(td, rows):
    p = str(Path(td) / "t.jsonl")
    Path(p).write_text(
        "\n".join([json.dumps(HEADER)] + [json.dumps(r) for r in rows]) + "\n",
        encoding="utf-8")
    return p


def op(ts, op, page, req="r0", nbytes=UNIT):
    return {"ts_ns": ts, "op": op, "page_id": page, "request_id": req,
            "bytes": nbytes}


def trace_scenario(trace_path, local_pages=2, pool_pages=16,
                   policy="swap_remote"):
    raw = load_example("phase1-overflow.json")
    raw["page_size_bytes"] = UNIT
    raw["duration_ns"] = 10_000_000_000
    raw["warmup_ns"] = 0
    raw["metrics"]["warmup_ns"] = 0
    raw["metrics"]["sample_interval_ns"] = 1_000_000_000
    raw["nodes"][0]["local_memory"]["capacity_bytes"] = local_pages * UNIT
    raw["nodes"][1]["remote_memory"]["capacity_bytes"] = pool_pages * UNIT
    raw["policy"] = {"name": policy}
    raw["workload"] = {"type": "trace", "path": trace_path}
    raw["output"] = {"format": "jsonl", "include_event_log": True}
    return raw


@unittest.skipUnless(HAVE_API, "rmemfab[api] not installed")
class ApiContract(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        app = create_app(runs_dir=str(Path(self.td.name) / "runs"),
                         traces_dir=str(Path(self.td.name) / "traces"))
        self.c = TestClient(app)

    def test_health_reports_capabilities(self):
        r = self.c.get("/health")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "ok")
        self.assertTrue(body["replay_supported"])
        self.assertTrue(body["faults_supported"])
        self.assertIn("config", body["schema_versions"])

    def test_validate_ok_and_broken(self):
        r = self.c.post("/scenarios/validate",
                        json={"scenario": tiny_synth()})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["valid"])
        bad = tiny_synth()
        del bad["nodes"]
        r = self.c.post("/scenarios/validate", json={"scenario": bad})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertFalse(body["valid"])
        self.assertGreater(len(body["errors"]), 0)
        self.assertIn("message", body["errors"][0])

    def test_version_patch_round_trip(self):
        base = tiny_synth()
        r = self.c.post("/scenarios/version", json={
            "scenario": base,
            "patch": [{"op": "replace",
                       "path": "/fabric/links/0/latency_ns", "value": 240}]})
        self.assertEqual(r.status_code, 200)
        v1 = r.json()
        self.assertEqual(v1["parent_version"], None)
        self.assertEqual(len(v1["changes"]), 1)
        self.assertEqual(v1["changes"][0]["path"],
                         "/fabric/links/0/latency_ns")
        self.assertEqual(v1["changes"][0]["to"], 240)
        self.assertIn("seed", v1["unchanged"])
        r = self.c.post("/scenarios/version", json={
            "parent_version": v1["version"],
            "patch": [{"op": "replace", "path": "/seed", "value": 8}]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["parent_version"], v1["version"])

    def test_version_fetch_round_trip(self):
        r = self.c.post("/scenarios/version", json={
            "scenario": tiny_synth(),
            "patch": [{"op": "replace",
                       "path": "/fabric/links/0/latency_ns", "value": 240}]})
        v = r.json()["version"]
        r = self.c.get(f"/scenarios/version/{v}")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["version"], v)
        self.assertEqual(body["scenario"]["fabric"]["links"][0]["latency_ns"],
                         240)
        self.assertEqual(self.c.get("/scenarios/version/nope").status_code,
                         404)

    def test_version_rejects_bad_patch_and_bad_result(self):
        r = self.c.post("/scenarios/version", json={
            "scenario": tiny_synth(),
            "patch": [{"op": "replace", "path": "/nope", "value": 1}]})
        self.assertEqual(r.status_code, 422)
        r = self.c.post("/scenarios/version", json={
            "scenario": tiny_synth(),
            "patch": [{"op": "remove", "path": "/nodes"}]})
        self.assertEqual(r.status_code, 422)
        self.assertIn("errors", r.json()["detail"])

    def _submit(self, scenario, **kw):
        r = self.c.post("/runs", json={"scenario": scenario, **kw})
        self.assertEqual(r.status_code, 202, r.text)
        return r.json()

    def test_run_submit_get_and_idempotent_resubmit(self):
        first = self._submit(tiny_synth())
        self.assertEqual(first["status"], "completed")
        rid = first["run_id"]
        again = self._submit(tiny_synth())
        self.assertEqual(again["run_id"], rid)
        r = self.c.get(f"/runs/{rid}")
        self.assertEqual(r.status_code, 200)
        detail = r.json()
        self.assertIn("summary", detail)
        self.assertIn("manifest", detail)
        self.assertIn("scenario", detail)
        self.assertEqual(detail["scenario"]["name"], "phase1-overflow")
        self.assertGreater(detail["summary"]["access"]["count"], 0)
        r = self.c.get("/runs/does-not-exist")
        self.assertEqual(r.status_code, 404)

    def test_run_rejects_invalid_scenario(self):
        bad = tiny_synth()
        del bad["nodes"]
        r = self.c.post("/runs", json={"scenario": bad})
        self.assertEqual(r.status_code, 422)

    def test_run_records_divergence_as_failed(self):
        tp = write_trace(self.td.name,
                         [op(10, "alloc", "a"), op(20, "alloc", "b")])
        sc = trace_scenario(tp, local_pages=1, policy="local_only")
        body = self._submit(sc)
        self.assertEqual(body["status"], "failed")
        self.assertIn("error", body)
        r = self.c.get(f"/runs/{body['run_id']}")
        self.assertEqual(r.json()["status"], "failed")

    def test_runs_list_filters(self):
        a = self._submit(tiny_synth(policy="swap_remote"))
        b = self._submit(tiny_synth(policy="hot_cold"))
        self.assertNotEqual(a["run_id"], b["run_id"])
        rows = self.c.get("/runs").json()
        self.assertGreaterEqual(len(rows), 2)
        self.assertIn("p95", rows[0])
        only = self.c.get("/runs", params={"policy": "hot_cold"}).json()
        self.assertTrue(all(r["policy"]["effective"] == "hot_cold"
                            for r in only))
        failed = self.c.get("/runs", params={"status": "failed"}).json()
        self.assertTrue(all(r["status"] == "failed" for r in failed))

    def test_series_decimation(self):
        rid = self._submit(tiny_synth())["run_id"]
        full = self.c.get(f"/runs/{rid}/series").json()
        self.assertGreater(len(full), 0)
        self.assertIn("t_ns", full[0])
        small = self.c.get(f"/runs/{rid}/series",
                           params={"downsample": 2}).json()
        self.assertLessEqual(len(small), 2)

    def test_events_paging_and_filters(self):
        rid = self._submit(tiny_synth())["run_id"]
        p1 = self.c.get(f"/runs/{rid}/events", params={"limit": 5}).json()
        self.assertEqual(len(p1["events"]), 5)
        self.assertFalse(p1["summary_only"])
        self.assertIsNotNone(p1["next_cursor"])
        p2 = self.c.get(f"/runs/{rid}/events",
                        params={"limit": 5,
                                "cursor": p1["next_cursor"]}).json()
        self.assertNotEqual(p1["events"][0]["seq"], p2["events"][0]["seq"])
        only = self.c.get(
            f"/runs/{rid}/events",
            params={"types": "transfer_begin", "limit": 50}).json()
        self.assertTrue(all(e["event"] == "transfer_begin"
                            for e in only["events"]))

    def test_summary_only_run_has_no_events(self):
        rid = self._submit(tiny_synth(), no_events=True)["run_id"]
        page = self.c.get(f"/runs/{rid}/events").json()
        self.assertTrue(page["summary_only"])
        self.assertEqual(page["events"], [])

    def test_stream_replays_and_dones(self):
        rid = self._submit(tiny_synth())["run_id"]
        r = self.c.get(f"/runs/{rid}/stream")
        self.assertEqual(r.status_code, 200)
        kinds = [ln.split("event: ")[1] for ln in r.text.splitlines()
                 if ln.startswith("event: ")]
        self.assertGreater(len(kinds), 0)
        self.assertEqual(kinds[-1], "done")
        self.assertIn("event", kinds)

    def test_compare_fair_and_refused(self):
        a = self._submit(tiny_synth(policy="swap_remote"))["run_id"]
        b = self._submit(tiny_synth(policy="hot_cold"))["run_id"]
        r = self.c.post("/runs/compare", json={"ids": [a, b]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["verdict"], "fair")
        c = self._submit(tiny_synth(policy="swap_remote", seed=9))["run_id"]
        r = self.c.post("/runs/compare", json={"ids": [a, c]})
        self.assertEqual(r.status_code, 422)
        body = r.json()["detail"]
        self.assertEqual(body["verdict"], "refused")
        self.assertIn("seed", body["reason"])

    def test_export_is_bundle_zip(self):
        rid = self._submit(tiny_synth())["run_id"]
        r = self.c.get(f"/runs/{rid}/export")
        self.assertEqual(r.status_code, 200)
        names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
        self.assertIn(f"{rid}/summary.json", names)
        self.assertIn(f"{rid}/manifest.json", names)
        self.assertIn(f"{rid}/scenario.json", names)

    def test_trace_upload_round_trip(self):
        blob = ("\n".join([json.dumps(HEADER),
                           json.dumps(op(10, "alloc", "a")),
                           json.dumps(op(20, "read", "a")),
                           json.dumps(op(30, "free", "a"))]) + "\n").encode()
        r = self.c.post("/traces", files={"file": ("w.jsonl", blob)})
        self.assertEqual(r.status_code, 200, r.text)
        prof = r.json()
        self.assertEqual(prof["counts"]["alloc"], 1)
        self.assertEqual(prof["counts"]["read"], 1)
        self.assertEqual(prof["sha256"][:16], prof["trace_id"])
        tid = prof["trace_id"]
        # The advertised path runs a real replay.
        scen = trace_scenario("placeholder", policy="swap_remote")
        scen["workload"] = {"type": "trace", "path": prof["workload_path"]}
        r = self.c.post("/runs", json={"scenario": scen})
        self.assertEqual(r.status_code, 202, r.text)
        self.assertEqual(r.json()["status"], "completed")
        self.assertEqual(self.c.get(f"/traces/{tid}").json()["trace_id"], tid)
        self.assertTrue(any(t["trace_id"] == tid
                            for t in self.c.get("/traces").json()))
        d = self.c.delete(f"/traces/{tid}")
        self.assertEqual(d.status_code, 200)
        self.assertEqual(self.c.get(f"/traces/{tid}").status_code, 404)

    def test_trace_upload_rejects_invalid(self):
        blob = ("\n".join([json.dumps(HEADER),
                           json.dumps(op(10, "read", "ghost"))]) + "\n").encode()
        r = self.c.post("/traces", files={"file": ("bad.jsonl", blob)})
        self.assertEqual(r.status_code, 422)
        self.assertIn("errors", r.json()["detail"])

if __name__ == "__main__":
    unittest.main()
