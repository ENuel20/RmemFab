"""Run API + Trace API + Scenario API (PRODUCT-SPEC section 5).

Thin HTTP wrapper over the existing engine: validation, runs, telemetry
reads, guarded comparison, export, and trace upload. The engine runs inline
on POST /runs (a job queue is the documented follow-up); the assistant
endpoint is an honest stub until the M4 thin slice.
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
                "replay_supported": True, "faults_supported": False}

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

    @app.post("/runs", status_code=202)
    def runs_submit(req: RunRequest):
        try:
            sc = build_scenario(copy.deepcopy(req.scenario))
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
                               event_log=not req.no_events)
                  if is_trace else Engine(sc, final,
                                          event_log=not req.no_events))
        try:
            engine.run()
        except ReplayDivergence as exc:
            final.mkdir(parents=True, exist_ok=True)
            (final / "failure.json").write_text(
                json.dumps({"run_id": run_id, "status": "failed",
                            "error": str(exc)}), encoding="utf-8")
            return {"run_id": run_id, "status": "failed", "error": str(exc)}
        return {"run_id": run_id, "status": "completed"}

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

    @app.post("/assistant/chat")
    def assistant_chat(_req: ChatRequest):
        raise HTTPException(
            501, "assistant is not wired yet (M4 thin slice); the simulation "
                 "API above is fully functional without it")

    return app
