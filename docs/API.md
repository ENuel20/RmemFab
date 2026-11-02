# RmemFab Run API — frontend integration guide

For dashboard developers (and their agents). This is the contract between the
deterministic engine and any UI: every shape below is served from real run
bundles on disk, and `tests/test_api.py` pins each endpoint's behavior. If
this doc and the server disagree, the server wins — then tell us so we fix
the doc.

Companion references:

- Shapes: `PRODUCT-SPEC.md` §4 (RunSummary, RunDetail, SeriesPoint, SimEvent,
  TraceProfile, ComparisonVerdict, ScenarioVersion).
- Event catalog: `SPECS/events.md`.
- Real responses to build types against: `examples/sample-outputs/` (README
  inside explains regen + frontend rules).
- Executable contract: `tests/test_api.py` (17 tests, every endpoint).
- Interactive spec: run the server, open `/docs`.

## Boot

```bash
pip install -e '.[api]'
rmemfab serve                    # http://127.0.0.1:8000
rmemfab serve --port 8123 --open # custom port + open /docs
```

No auth on localhost. CORS allows all origins (dashboard dev servers work).
Runs persist under `./runs/<run_id>/`; trace uploads under
`./traces/uploads/`. Flags `--runs-dir` / `--traces-dir` override both.

`run_id` is deterministic (`<scenario-hash>-s<seed>-<policy>`, plus the trace
hash for replays): resubmitting a scenario returns the existing run instead
of re-executing.

## Endpoints

### `GET /health`

Liveness + capability flags. The UI should gate features on the flags, not
on version strings.

```json
{"status": "ok", "rmemfab_version": "0.1.0",
 "schema_versions": {"config": "0.1", "trace": "0.1", "events": "0.1"},
 "replay_supported": true, "faults_supported": true}
```

### `POST /scenarios/validate` → `{valid, errors[], warnings[], assumed[]}`

Runs the real schema + semantic validator (`for_run=true`, so `valid` means
submittable). Errors are `{path, message}` with JSON paths
(`fabric.links[0].latency_ns`); `assumed` entries are
`{path, source, uncertainty_pct}`. Client-side checks may pre-screen, but the
submit decision MUST use this response.

### `POST /scenarios/version` → `{version, parent_version, changes[], unchanged[]}`

What-if / NL-edit primitive. Body: `{parent_version?, scenario?, patch[]}`
(one base required). Patch ops are `{op: replace|add|remove, path, value?}`
with JSON-pointer paths (`/fabric/links/0/latency_ns`). The server applies
the patch, validates the result (422 + errors if invalid), stores the version
(`version` = scenario-hash prefix), and echoes `changes: [{path, from, to}]`
plus untouched top-level keys in `unchanged[]`.
`GET /scenarios/version/{v}` fetches a stored `{version, parent_version,
scenario}` for editing or submitting (what-if loop: version → fetch → run).

### `POST /runs` → `202 {run_id, status}`

Body: `{scenario, no_events?}`. The engine runs inline (a job queue is the
documented follow-up). `status` is `completed`, or `failed` with an `error`
string when replay diverges honestly (e.g. capacity overcommit names the
row). Invalid scenarios return 422 with the validator's `[{path, message}]`.
Example: `{"run_id": "5810d9205417-s7-swap_remote", "status": "completed"}`.

### `GET /runs?limit=&policy=&status=` → `RunSummary[]`

Newest-submitted order is NOT guaranteed; sort client-side on `created_at`.
Strip shape (all nullable-in-failure fields included):

```json
{"run_id": "5810d9205417-s7-swap_remote", "scenario_name": "phase1-overflow",
 "scenario_hash": "5810d9205417…", "seed": 7,
 "policy": {"requested": "swap_remote", "effective": "swap_remote",
            "fallback_reason": null},
 "status": "completed", "error": null,
 "arrived": 3, "completed": 3, "rejected": 0,
 "p50": 445.66, "p95": 445.66,
 "remote_read_bytes": 258342912, "migration_bytes": 66322432,
 "created_at": "2026-11-01T13:55:00+00:00"}
```

`policy=hot_cold` filters by effective policy; `status=failed|completed`.
`limit` default 50, max 500.

### `GET /runs/{id}` → `{run_id, status, summary, manifest, scenario, error}`

`summary` is the full `summary.json` (`access`, `traffic`, `links`, `memory`,
`requests`, `policy`, `workload`, …), `manifest` the full `manifest.json`
(hashes, seed, assumptions, warnings, limitations, routes), and `scenario`
the saved `scenario.json` (`nodes`, `fabric`, `workload`, `policy`, …) —
render infrastructure topology from it. `summary` and `scenario` are null
on failed runs; `error` carries the divergence message. 404 for unknown ids.

### `GET /runs/{id}/series?downsample=N` → `SeriesPoint[]`

One row per sampling tick, ascending `t_ns`. Counters are per-window deltas;
occupancy/bytes are point-in-time. Default cap 2000 points (deterministic
stride sampling). There is **no per-window latency** — render latency only
from `summary.access.latency_ns`.

```json
{"t_ns": 10000000, "accesses": 0, "evictions": 0, "completed": 0,
 "local_used_pages": {"node-0": 0}, "pool_used_pages": 0,
 "pools_used_pages": {"remote-pool": 0}, "link_bytes": {"node-0-cxl": 0}}
```

### `GET /runs/{id}/events?…` → `{events[], next_cursor?, summary_only}`

Paged in `(time_ns, seq)` order. Params: `types` (comma-separated event
names), `t0`, `t1` (inclusive `time_ns` bounds), `request_id`, `limit`
(default 500, max 5000), `cursor` (opaque offset; feed `next_cursor` back).
Rows are `SimEvent`s: `{event, time_ns, seq, run_id, node?, request_id?,
data}` — see the sample `events.jsonl` and `SPECS/events.md`.
Page-lifecycle rows are aggregate (`pages`, `bytes`, no `page_id`): render
as aggregate rows, never invent page identities. `summary_only: true` with
`events: []` means the run skipped its event log — render the empty state,
not an error.

### `GET /runs/{id}/stream` → `text/event-stream`

Virtual-time replay of the stored log: `tick` events (`{"t_ns": …}`) when the
clock advances, `event` events with full `SimEvent` JSON, then a terminal
`done` (`{"summary_only": true}` when there is no log). Playback speed is a
client concern; the stream carries virtual time, not wall time.

### `POST /runs/compare` → verdict + rows, or 422

Body: `{ids[], multi_seed?}`. The guard is server-enforced: same seed,
engine version, and identical scenario except `policy` (and `seed`/`name`
under `multi_seed`), else 422
`{verdict: "refused", reason: "…first differing field…"}` — render the refusal
with the reason, never a table. Fair responses:
`{verdict: "fair", mode: "same_seed"|"multi_seed", runs[]|groups{},
metric_direction{…}, verdict_detail?}` where same-seed carries the honest
`directional: single seed, no spread estimate` label.

### `GET /runs/{id}/export` → `.zip`

Bundle archive (`<run_id>/{scenario,manifest,summary}.json`,
`series.jsonl`, `events.jsonl`?, `README.md`) per the ACCEPTANCE evidence
layout.

### Traces

- `POST /traces` (multipart `file`, 128 MiB cap) → `TraceProfile` or 422 with
  validator `{errors[]}` (invalid uploads are discarded, not kept).
- `GET /traces` → `TraceProfile[]`; `GET /traces/{id}` → one;
  `DELETE /traces/{id}` → `{trace_id, deleted: true}` (uploads only).
- `TraceProfile`: `{trace_id, filename, sha256, source?, model?, runtime?,
  capture_date?, converter?, trace_schema_version?, provenance?,
  limitation_note?, counts{alloc,read,write,free,migrate}, requests,
  footprint_bytes?, normalized_pages, validation{errors[],warnings[]},
  normalization{…}}`. `provenance` is `measured|derived|synthetic|calibrated`
  when the trace declares it, else null — never guess it client-side.
  `workload_path` is the server-side path to put in `workload.path` when
  building a trace scenario from the upload (relative to the server CWD
  by default).

### `POST /scenarios/draft` → `{scenario, version, validation, model, usage}`

Natural-language to scenario (Baseten Muse backend). Body:
`{prompt, parent_version?, max_tokens?}`. The model proposes; the server
disposes: drafts are validated with the real validator before storage, and
invalid drafts return 422 with `{error, scenario?, errors[]}` — never
silently repaired, never runnable. Valid drafts are stored as scenario
versions (usable as `parent_version` here or in `/scenarios/version`).
`503` when the provider key is not configured, `502` on provider failure.

### `POST /assistant/chat` → answer or SSE stream

Body: `{messages[], context{run_id?}, stream?, suggest_patch?}`. With
`context.run_id` the server injects a compact telemetry brief and instructs
the model to answer only from it (exact numbers, no invention); without it
the model is told no telemetry was provided. `stream: false` (default)
returns `{content, model, run_id}`; `stream: true` returns OpenAI-style SSE
chunks plus `data: [DONE]`. Unknown run → 404; missing key → 503; provider
failure → 502 (mid-stream failures arrive as a `data: {"error": …}` chunk).

With `suggest_patch: true` (requires `context.run_id`, `stream: false`)
the model is asked to also emit any recommended change as a
` ```patch ` fenced JSON-patch block; the server validates it against the
run's scenario and returns `suggested_patch: {ops, valid, errors[],
warnings[], changes?}`, or `null` when the model emitted no block. A
suggestion is data, never an action — applying it is `POST
/assistant/apply`'s job.

### `POST /assistant/apply` → `{version, run_id, status, compare?}`

Body: exactly one of `parent_run_id` / `parent_version`, exactly one of
`patch[]` (JSON-patch ops) / `instruction` (natural language), plus optional
`note`, `max_tokens`, `no_events`. The server resolves the base scenario,
derives the new one (model-proposed scenarios go through the same
validate-before-store path as `/scenarios/draft`), rejects no-op patches,
validates, stores a version linked to its parent, runs it inline, and —
for run parents where both runs completed — attaches the guarded
`compare` verdict (`fair` or `refused`, same semantics as
`POST /runs/compare`). Invalid change → 422 with validator errors and
nothing is stored or run.

### `POST /assistant/rollback` → `{version, run_id, status}`

Body: `{to_version, from_version?, note?, no_events?}`. Re-runs a stored
version as a new audited rollback version (event-addressed, so the
rollback record never collides with the original even though the scenario
is identical). The new version records `rollback_to` + `from_version`,
is re-validated, and is executed inline. Unknown version → 404.

## Errors

- `404 {"detail": "unknown run|trace|version …"}` — bad id.
- `422` — validator errors (`[{path,message}]`), bad patch, refused compare
  (`{verdict: "refused", reason}`), or invalid trace (`{errors[]}`).
  (Pydantic request-shape failures also 422 with FastAPI's default body —
  distinguish by shape.)
- `413` — trace upload over the size cap.
- `502` — provider call failed (message carries the reason, never the key).
- `503` — provider not configured (`BASETEN_API_KEY` missing).

## Minimal dashboard flow (curl)

```bash
rmemfab serve &                                   # or --port 8123
RID=$(curl -s -X POST localhost:8000/runs \
  -H 'Content-Type: application/json' \
  -d "{\"scenario\": $(cat examples/sample-outputs/synthetic/scenario.json)}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')
curl -s localhost:8000/runs/$RID | python3 -m json.tool | head -30
curl -s "localhost:8000/runs/$RID/series?downsample=50"
curl -s "localhost:8000/runs/$RID/events?limit=5"
curl -s -N localhost:8000/runs/$RID/stream | head -8
```
