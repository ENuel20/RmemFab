"""Run API + Trace API + Scenario API (PRODUCT-SPEC section 5).

Thin HTTP wrapper over the existing engine: validation, runs, telemetry
reads, guarded comparison, export, trace upload, and the assistant
(draft, grounded chat, apply/rollback). The engine runs inline on
POST /runs (a job queue is the documented follow-up).
"""
from __future__ import annotations

import copy
import json

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import __version__
from ..config.scenario import (ScenarioError, build_scenario, canonical_json,
                               scenario_hash, validate)
from ..core.engine import Engine
from ..sweep.compare import ComparisonRefused, compare_runs
from ..trace.replay import ReplayDivergence, ReplayEngine
from ..trace.validate import TraceError, load_trace
from .draft import (CHAT_SYSTEM, SUGGEST_SUFFIX, build_messages,
                   extract_patch_block, telemetry_brief)
from .providers import (BasetenClient, ProviderError, ProviderNotConfigured)
from .store import RunStore, TraceStore, split_error, trace_profile


class ValidateRequest(BaseModel):
    scenario: dict


class ValidateError(BaseModel):
    path: str = ""
    message: str


class ValidateResponse(BaseModel):
    valid: bool
    errors: list[ValidateError] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    assumed: list[dict] = Field(default_factory=list)


class PatchOp(BaseModel):
    op: str
    path: str
    value: object = None


class VersionRequest(BaseModel):
    parent_version: str | None = None
    scenario: dict | None = None
    patch: list[PatchOp] = Field(default_factory=list)


class RunRequest(BaseModel):
    scenario: dict
    no_events: bool = False


class CompareRequest(BaseModel):
    ids: list[str]
    multi_seed: bool = False


class ChatRequest(BaseModel):
    messages: list[dict] = Field(default_factory=list)
    context: dict = Field(default_factory=dict)
    stream: bool = False
    suggest_patch: bool = False


class ApplyRequest(BaseModel):
    parent_run_id: str | None = None
    parent_version: str | None = None
    patch: list[PatchOp] | None = None
    instruction: str | None = None
    note: str | None = None
    max_tokens: int = 8000
    no_events: bool = False


class RollbackRequest(BaseModel):
    to_version: str
    from_version: str | None = None
    note: str | None = None
    no_events: bool = False


class DraftRequest(BaseModel):
    prompt: str
    parent_version: str | None = None
    max_tokens: int = 8000


def _resolve_pointer(doc, pointer: str):
    """Split a JSON pointer into (parent, last_key). '' targets the root."""
    if pointer == "" or pointer == "/":
        return None, None
    parts = [p.replace("~1", "/").replace("~0", "~")
             for p in pointer.lstrip("/").split("/")]
    node = doc
    for raw in parts[:-1]:
        node = node[int(raw)] if isinstance(node, list) else node[raw]
    last = parts[-1]
    return node, int(last) if isinstance(node, list) else last


def _apply_patch(scenario: dict, ops: list[PatchOp]):
    """Apply replace/add/remove ops; return (new_scenario, changes)."""
    doc = copy.deepcopy(scenario)
    changes = []
    for op in ops:
        if op.op not in ("replace", "add", "remove"):
            raise ValueError(f"patch op {op.op!r}: want replace, add, or remove")
        parent, last = _resolve_pointer(doc, op.path)
        if parent is None:
            if op.op == "remove":
                raise ValueError("cannot remove the document root")
            changes.append({"path": op.path, "from": doc, "to": op.value})
            doc = copy.deepcopy(op.value)
            continue
        old = parent[last] if (
            last in parent if isinstance(parent, dict)
            else 0 <= last < len(parent)) else None
        if op.op == "remove":
            if isinstance(parent, dict):
                del parent[last]
            else:
                parent.pop(last)
            changes.append({"path": op.path, "from": old, "to": None})
        elif op.op == "replace":
            parent[last] = copy.deepcopy(op.value)
            changes.append({"path": op.path, "from": old, "to": op.value})
        else:  # add
            if isinstance(parent, dict):
                parent[last] = copy.deepcopy(op.value)
            else:
                parent.insert(last if last != "-" else len(parent),
                              copy.deepcopy(op.value))
            changes.append({"path": op.path, "from": None, "to": op.value})
    return doc, changes


def create_app(runs_dir="runs", traces_dir="traces/uploads",
               trace_max_bytes=128 * 1024 * 1024) -> FastAPI:
    runs = RunStore(runs_dir)
    traces = TraceStore(traces_dir, max_bytes=trace_max_bytes)
    versions_dir = runs.runs / "versions"
    versions_dir.mkdir(parents=True, exist_ok=True)

    app = FastAPI(title="RmemFab Run API", version=__version__)
    app.add_middleware(CORSMiddleware, allow_origins=["*"],
                       allow_methods=["*"], allow_headers=["*"])

    def _load_version(v: str) -> dict:
        p = versions_dir / f"{v}.json"
        if not p.is_file():
            raise HTTPException(404, f"unknown scenario version {v!r}")
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise HTTPException(500, f"cannot read scenario version {v!r}")

    @app.get("/health")
    def health():
        return {"status": "ok", "rmemfab_version": __version__,
                "schema_versions": {"config": "0.1", "trace": "0.1",
                                    "events": "0.1"},
                "replay_supported": True, "faults_supported": True}

    @app.post("/scenarios/validate", response_model=ValidateResponse)
    def scenarios_validate(req: ValidateRequest):
        errors, warnings, assumed = validate(
            req.scenario, for_run=True)
        return {"valid": not errors,
                "errors": [split_error(e) for e in errors],
                "warnings": warnings, "assumed": assumed}

    @app.post("/scenarios/version")
    def scenarios_version(req: VersionRequest):
        if req.parent_version is not None:
            base = _load_version(req.parent_version)["scenario"]
        elif req.scenario is not None:
            base = req.scenario
        else:
            raise HTTPException(
                422, "need parent_version or a base scenario")
        try:
            new, changes = _apply_patch(base, req.patch)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise HTTPException(422, f"bad patch: {exc}")
        errors, warnings, assumed = validate(new, for_run=True)
        if errors:
            raise HTTPException(
                422, {"errors": [split_error(e) for e in errors],
                      "warnings": warnings, "assumed": assumed})
        version = scenario_hash(new)[:16]
        (versions_dir / f"{version}.json").write_text(
            json.dumps({"version": version,
                        "parent_version": req.parent_version,
                        "scenario": json.loads(canonical_json(new))},
                       indent=2, sort_keys=True), encoding="utf-8")
        touched = {c["path"].lstrip("/").split("/", 1)[0] for c in changes}
        unchanged = sorted(k for k in new if k not in touched)
        return {"version": version, "parent_version": req.parent_version,
                "changes": changes, "unchanged": unchanged}

    @app.get("/scenarios/version/{version}")
    def scenarios_version_get(version: str):
        return _load_version(version)

    def _execute_run(scenario: dict, no_events: bool) -> dict:
        """Build, run inline, and report {run_id, status[, error]}."""
        try:
            sc = build_scenario(copy.deepcopy(scenario))
        except ScenarioError as exc:
            raise HTTPException(
                422, [split_error(e) for e in exc.errors])
        is_trace = sc.workload_type == "trace"
        try:
            probe = (ReplayEngine(sc, sc.trace, None, event_log=False)
                     if is_trace else Engine(sc, None, event_log=False))
        except (ScenarioError, ValueError) as exc:
            raise HTTPException(422, str(exc))
        run_id = probe.run_id
        final = runs.runs / run_id
        if (final / "summary.json").is_file():
            return {"run_id": run_id, "status": "completed"}
        engine = (ReplayEngine(sc, sc.trace, final,
                               event_log=not no_events)
                  if is_trace else Engine(sc, final,
                                          event_log=not no_events))
        try:
            engine.run()
        except ReplayDivergence as exc:
            final.mkdir(parents=True, exist_ok=True)
            (final / "failure.json").write_text(
                json.dumps({"run_id": run_id, "status": "failed",
                            "error": str(exc)}), encoding="utf-8")
            return {"run_id": run_id, "status": "failed", "error": str(exc)}
        return {"run_id": run_id, "status": "completed"}

    @app.post("/runs", status_code=202)
    def runs_submit(req: RunRequest):
        return _execute_run(req.scenario, req.no_events)

    @app.get("/runs")
    def runs_list(limit: int = Query(50, ge=1, le=500),
                  policy: str | None = None, status: str | None = None):
        return runs.list(limit=limit, policy=policy, status=status)

    @app.get("/runs/{run_id}")
    def runs_get(run_id: str):
        detail = runs.detail(run_id)
        if detail is None:
            raise HTTPException(404, f"unknown run {run_id!r}")
        return detail

    @app.get("/runs/{run_id}/series")
    def runs_series(run_id: str, downsample: int = Query(2000, ge=1)):
        rows = runs.series(run_id, downsample)
        if rows is None:
            raise HTTPException(404, f"unknown run {run_id!r}")
        return rows

    @app.get("/runs/{run_id}/events")
    def runs_events(run_id: str, types: str | None = None,
                    t0: int | None = None, t1: int | None = None,
                    request_id: str | None = None,
                    limit: int = Query(500, ge=1, le=5000),
                    cursor: str | None = None):
        page = runs.events(run_id, types=types, t0=t0, t1=t1,
                           request_id=request_id, limit=limit, cursor=cursor)
        if page is None:
            raise HTTPException(404, f"unknown run {run_id!r}")
        return page

    @app.get("/runs/{run_id}/stream")
    def runs_stream(run_id: str):
        if runs.bundle_dir(run_id) is None:
            raise HTTPException(404, f"unknown run {run_id!r}")
        return StreamingResponse(runs.iter_sse(run_id),
                                 media_type="text/event-stream")

    @app.post("/runs/compare")
    def runs_compare(req: CompareRequest):
        dirs = []
        for rid in req.ids:
            d = runs.bundle_dir(rid)
            if d is None:
                raise HTTPException(404, f"unknown run {rid!r}")
            dirs.append(d)
        try:
            rep = compare_runs(dirs, multi_seed=req.multi_seed)
        except ComparisonRefused as exc:
            raise HTTPException(
                422, {"verdict": "refused", "reason": str(exc)})
        if "verdict" in rep:
            rep["verdict_detail"] = rep.pop("verdict")
        return {"verdict": "fair", **rep}

    @app.get("/runs/{run_id}/export")
    def runs_export(run_id: str):
        blob = runs.export_zip(run_id)
        if blob is None:
            raise HTTPException(404, f"unknown run {run_id!r}")
        return StreamingResponse(
            iter([blob]), media_type="application/zip",
            headers={"Content-Disposition":
                     f"attachment; filename=runs_{run_id}.zip"})

    @app.post("/traces")
    async def traces_upload(file: UploadFile = File(...)):
        data = await file.read()
        if len(data) > traces.max_bytes:
            raise HTTPException(
                413, f"trace is {len(data)} bytes; cap is {traces.max_bytes}")
        trace_id, path = traces.save(file.filename or "upload.jsonl", data)
        try:
            vt = load_trace(path)
        except TraceError as exc:
            traces.discard(trace_id)
            raise HTTPException(422, {"errors": exc.errors})
        name = (traces.traces / f"{trace_id}.name").read_text(
            encoding="utf-8")
        prof = trace_profile(trace_id, name, vt)
        # Server-side path for workload.path: uploads resolve relative to the
        # server CWD by default, absolute when the server was given one.
        prof["workload_path"] = path.as_posix()
        (traces.traces / f"{trace_id}.profile.json").write_text(
            json.dumps(prof, indent=2, sort_keys=True), encoding="utf-8")
        return prof

    @app.get("/traces")
    def traces_list():
        return traces.list()

    @app.get("/traces/{trace_id}")
    def traces_get(trace_id: str):
        prof = traces.get(trace_id)
        if prof is None:
            raise HTTPException(404, f"unknown trace {trace_id!r}")
        return prof

    @app.delete("/traces/{trace_id}")
    def traces_delete(trace_id: str):
        if traces.get(trace_id) is None:
            raise HTTPException(404, f"unknown trace {trace_id!r}")
        traces.discard(trace_id)
        return {"trace_id": trace_id, "deleted": True}

    @app.post("/scenarios/draft")
    def scenarios_draft(req: DraftRequest):
        parent, parent_version = None, None
        if req.parent_version is not None:
            parent_version = req.parent_version
            parent = _load_version(req.parent_version)["scenario"]
        try:
            client = BasetenClient()
        except ProviderNotConfigured as exc:
            raise HTTPException(503, str(exc))
        try:
            out = client.chat(build_messages(req.prompt, parent),
                              max_tokens=req.max_tokens, temperature=0,
                              json_mode=True)
        except ProviderError as exc:
            raise HTTPException(502, str(exc))
        try:
            scenario = json.loads(out["content"])
        except json.JSONDecodeError:
            raise HTTPException(
                422, {"error": "model output was not JSON",
                      "raw_excerpt": out["content"][:1000]})
        if not isinstance(scenario, dict):
            raise HTTPException(
                422, {"error": "model output was not an object",
                      "raw_excerpt": out["content"][:1000]})
        errors, warnings, assumed = validate(scenario, for_run=True)
        if errors:
            raise HTTPException(
                422, {"error": "draft failed validation",
                      "scenario": scenario,
                      "errors": [split_error(e) for e in errors],
                      "warnings": warnings})
        version = scenario_hash(scenario)[:16]
        (versions_dir / f"{version}.json").write_text(
            json.dumps({"version": version, "parent_version": parent_version,
                        "scenario": json.loads(canonical_json(scenario)),
                        "draft_prompt": req.prompt,
                        "draft_model": out["model"]},
                       indent=2, sort_keys=True), encoding="utf-8")
        return {"scenario": scenario, "version": version,
                "parent_version": parent_version,
                "validation": {"warnings": warnings, "assumed": assumed},
                "model": out["model"], "usage": out["usage"]}

    @app.post("/assistant/chat")
    def assistant_chat(req: ChatRequest):
        if req.suggest_patch and req.stream:
            raise HTTPException(422, "suggest_patch needs stream=false")
        if req.suggest_patch and (req.context or {}).get("run_id") is None:
            raise HTTPException(422, "suggest_patch needs context.run_id")
        run_id = (req.context or {}).get("run_id")
        brief = None
        if run_id is not None:
            detail = runs.detail(run_id)
            if detail is None:
                raise HTTPException(404, f"unknown run {run_id!r}")
            brief = telemetry_brief(detail)
        try:
            client = BasetenClient()
        except ProviderNotConfigured as exc:
            raise HTTPException(503, str(exc))
        system = CHAT_SYSTEM + (f"\n\nRun telemetry:\n{brief}"
                                if brief is not None else
                                "\n\nNo run telemetry provided.")
        if req.suggest_patch:
            system += "\n\n" + SUGGEST_SUFFIX
            # Patch paths verify against the scenario, so the model must see
            # it: telemetry field names (policy.requested) are not scenario
            # paths (policy.name). run_id is guaranteed above when suggesting.
            scenario = runs.scenario_of(run_id)
            if scenario is not None:
                system += ("\n\nRun scenario JSON: emit patch ops as "
                           "JSON-pointer paths into this object.\n"
                           + json.dumps(scenario))
        messages = [{"role": "system", "content": system},
                    *req.messages]
        if not req.stream:
            try:
                chunks = list(client.chat_stream(messages))
            except ProviderError as exc:
                raise HTTPException(502, str(exc))
            def _delta(c):
                ch = (c.get("choices") or [{}])[0]
                return (ch.get("delta") or {}).get("content", "") or ""
            text = "".join(_delta(c) for c in chunks
                            if isinstance(c, dict))
            body = {"content": text, "model": client.model,
                    "run_id": run_id}
            if req.suggest_patch:
                body["suggested_patch"] = _suggest_patch(text, run_id)
            return body
        try:
            stream = client.chat_stream(messages)
            first = next(stream)
        except StopIteration:
            first = None
        except ProviderError as exc:
            raise HTTPException(502, str(exc))

        def generate():
            if first is not None:
                yield f"data: {json.dumps(first)}\n\n"
            try:
                for chunk in stream:
                    yield f"data: {json.dumps(chunk)}\n\n"
            except ProviderError as exc:
                yield f"data: {json.dumps({'error': str(exc)})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")

    def _suggest_patch(text: str, run_id: str):
        """Validate the model's ```patch block against the run's scenario.

        Returns None when the model emitted no block, else {ops, valid,
        errors[, changes]}. A suggestion is data, never an action: applying
        it is POST /assistant/apply's job."""
        try:
            raw_ops = extract_patch_block(text)
        except ValueError as exc:
            return {"ops": None, "valid": False,
                    "errors": [{"message": str(exc)}]}
        if raw_ops is None:
            return None
        try:
            ops = [o if isinstance(o, PatchOp) else PatchOp(**o)
                   for o in raw_ops]
        except (TypeError, ValueError) as exc:
            return {"ops": raw_ops, "valid": False,
                    "errors": [{"message": f"bad patch op: {exc}"}]}
        base = runs.scenario_of(run_id)
        if base is None:
            return {"ops": raw_ops, "valid": False,
                    "errors": [{"message": "run has no scenario"}]}
        try:
            new, changes = _apply_patch(base, ops)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            return {"ops": raw_ops, "valid": False,
                    "errors": [{"message": f"bad patch: {exc}"}]}
        errors, warnings, _ = validate(new, for_run=True)
        if errors:
            return {"ops": raw_ops, "valid": False,
                    "errors": [split_error(e) for e in errors],
                    "warnings": warnings}
        return {"ops": raw_ops, "valid": True, "errors": [],
                "warnings": warnings, "changes": changes}

    @app.post("/assistant/apply", status_code=202)
    def assistant_apply(req: ApplyRequest):
        """Apply a patch (or NL instruction) to a run/version, validate,
        store a new version, run it, and compare against the parent run."""
        if (req.parent_run_id is None) == (req.parent_version is None):
            raise HTTPException(
                422, "need exactly one of parent_run_id, parent_version")
        if req.parent_run_id is not None:
            base = runs.scenario_of(req.parent_run_id)
            if base is None:
                raise HTTPException(
                    404, f"unknown run or run has no scenario: {req.parent_run_id!r}")
        else:
            base = _load_version(req.parent_version)["scenario"]
        if (req.patch is None) == (req.instruction is None):
            raise HTTPException(422, "need exactly one of patch, instruction")
        model = usage = None
        changes: list = []
        if req.instruction is not None:
            try:
                client = BasetenClient()
            except ProviderNotConfigured as exc:
                raise HTTPException(503, str(exc))
            try:
                out = client.chat(build_messages(req.instruction, base),
                                  max_tokens=req.max_tokens, temperature=0,
                                  json_mode=True)
            except ProviderError as exc:
                raise HTTPException(502, str(exc))
            try:
                new = json.loads(out["content"])
            except json.JSONDecodeError:
                raise HTTPException(
                    422, {"error": "model output was not JSON",
                          "raw_excerpt": out["content"][:1000]})
            if not isinstance(new, dict):
                raise HTTPException(
                    422, {"error": "model output was not an object",
                          "raw_excerpt": out["content"][:1000]})
            model, usage = out["model"], out["usage"]
        else:
            try:
                new, changes = _apply_patch(base, req.patch)
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                raise HTTPException(422, f"bad patch: {exc}")
            if canonical_json(new) == canonical_json(base):
                raise HTTPException(422, "patch leaves the scenario unchanged")
        errors, warnings, assumed = validate(new, for_run=True)
        if errors:
            raise HTTPException(
                422, {"errors": [split_error(e) for e in errors],
                      "warnings": warnings, "assumed": assumed})
        version = scenario_hash(new)[:16]
        (versions_dir / f"{version}.json").write_text(
            json.dumps({"version": version,
                        "parent_version": req.parent_version,
                        "parent_run_id": req.parent_run_id, "note": req.note,
                        "instruction": req.instruction, "model": model,
                        "scenario": json.loads(canonical_json(new))},
                       indent=2, sort_keys=True), encoding="utf-8")
        res = _execute_run(new, req.no_events)
        compare = None
        if req.parent_run_id is not None and res["status"] == "completed":
            pdir = runs.bundle_dir(req.parent_run_id)
            ndir = runs.bundle_dir(res["run_id"])
            if pdir is not None and runs.status_of(pdir) == "completed":
                try:
                    rep = compare_runs([pdir, ndir])
                except ComparisonRefused as exc:
                    compare = {"verdict": "refused", "reason": str(exc)}
                else:
                    if "verdict" in rep:
                        rep["verdict_detail"] = rep.pop("verdict")
                    compare = {"verdict": "fair", **rep}
        body: dict = {"version": version,
                      "parent_version": req.parent_version,
                      "parent_run_id": req.parent_run_id,
                      "run_id": res["run_id"], "status": res["status"],
                      "compare": compare,
                      "validation": {"warnings": warnings, "assumed": assumed}}
        if changes:
            body["changes"] = changes
        if model is not None:
            body["model"] = model
            body["usage"] = usage
        if res["status"] == "failed":
            body["error"] = res.get("error")
        return body

    @app.post("/assistant/rollback", status_code=202)
    def assistant_rollback(req: RollbackRequest):
        """Re-run a stored version as a new audited rollback version."""
        target = _load_version(req.to_version)
        if req.from_version is not None:
            _load_version(req.from_version)
        scenario = copy.deepcopy(target["scenario"])
        errors, warnings, assumed = validate(scenario, for_run=True)
        if errors:
            raise HTTPException(
                422, {"errors": [split_error(e) for e in errors],
                      "warnings": warnings, "assumed": assumed})
        envelope = {"scenario": scenario, "rollback_to": req.to_version,
                    "from_version": req.from_version, "note": req.note}
        version = scenario_hash(envelope)[:16]
        (versions_dir / f"{version}.json").write_text(
            json.dumps({"version": version,
                        "parent_version": req.from_version,
                        "rollback_to": req.to_version, "note": req.note,
                        "scenario": json.loads(canonical_json(scenario))},
                       indent=2, sort_keys=True), encoding="utf-8")
        res = _execute_run(scenario, req.no_events)
        body = {"version": version, "run_id": res["run_id"],
                "status": res["status"], "to_version": req.to_version,
                "from_version": req.from_version,
                "validation": {"warnings": warnings, "assumed": assumed}}
        if res["status"] == "failed":
            body["error"] = res.get("error")
        return body

    return app
