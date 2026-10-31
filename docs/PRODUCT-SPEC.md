# RmemFab Interactive Layer — Screen-by-Screen Product Specification

- **Status:** draft for implementation. Normative language: MUST / SHOULD / MAY.
- **Scope:** web dashboard + Run API + Muse assistant integration. Simulation math stays in the engine; this spec defines only the interactive layer.
- **Audience:** frontend implementer, backend implementer, reviewer judging demo honesty.
- **Related (authoritative for their domains):** `SPECS/config.schema.json`, `SPECS/trace.schema.json`, `SPECS/events.md`, `docs/ARCHITECTURE.md`, `docs/SIMULATION-MODEL.md`, `docs/POLICIES.md`, `docs/WORKLOADS.md`, `docs/ACCEPTANCE.md`.
- **Priorities:** P0 ships in the hackathon demo path; P1 ships if the P0 loop is green; P2 is explicitly deferred.
- **Honesty baseline:** `docs/ACCEPTANCE.md` ("What is not evidence", A4.1, A5.4) applies to every screen. Mock/illustrative data MUST be labeled at the point of display, and a fabricated number MUST NEVER appear with run/scenario identity of a real run.

## 1. Information architecture (target)

| Nav | Screen | Spec origin | PR #1 status |
| --- | ------ | ----------- | ------------ |
| Workbench | S1 Start experiment (NL + trace + builder entry) | §A experiment creation | missing — new |
| Traces | S2 Trace library (import + inspect) | §B trace explorer | missing — new |
| Scenarios | S3 Scenario builder (visual + JSON) | §C scenario builder | exists — evolve |
| Runs | S4 Runs + run detail (monitor, charts, events) | §D monitor + §E single-run | exists — evolve |
| Compare | S5 Policy/scenario comparison | §E comparison | exists — harden |
| Research | S6 Muse assistant + what-if | §F assistant + §9 mode 3 | missing — new |
| Topology | S7 Fabric topology (scenario-driven) | §5 topology | exists as static presets — must become data-driven |
| Settings | S8 Backend connection + mode | — | exists — extend honesty rules |

PR #1's Overview view folds into S1 (KPIs move to run detail / workbench recent-runs strip). No screen may be added without a data contract in §4.

## 2. Global shell and honesty rules (apply to every screen)

- **G1. Mode badge.** A persistent `DEMO` / `LIVE` indicator in the shell. DEMO = local illustrative data, no engine involved. LIVE = FastAPI backend reachable and serving engine bundles. Switching modes MUST be explicit user action; LIVE MUST NEVER silently fall back to DEMO data.
- **G2. Provenance badges.** Every metric group carries one of `measured` / `derived` / `synthetic` / `illustrative` (mock). `illustrative` is a fourth label the engine never emits; only the frontend uses it, only in DEMO mode. A synthetic workload MUST NEVER be badged `measured` (A4.1).
- **G3. Run identity.** Every number shown MUST be traceable to `{run_id, scenario_hash, seed}` visible within one click (A5.3). A number without run identity is not displayable as a result.
- **G4. Assumptions panel.** Any screen showing a verdict or comparison MUST link the run's assumed parameters (manifest `assumed_parameters` + `scenario_assumptions`) within one click (A2.3).
- **G5. States.** Every data view implements `loading` (skeleton, no fake numbers), `empty` (what to do next + CTA), `error` (what failed, run/request id, retry), `offline` (backend unreachable in LIVE mode: message + return-to-DEMO action, no silent swap).
- **G6. Units.** Bytes default to GiB with unit label; latencies auto-scale (ns/µs/ms/s) with unit label; ratios show 4 decimals. No unlabeled numbers.
- **G7. Secrets.** API keys live server-side only. The browser MUST NEVER hold the Muse API key.

## 3. Screens

### S1 — Workbench (P0)

- **Purpose.** The starting point. One screen to begin an experiment three ways: describe it, upload a trace, or build a scenario manually.
- **Layout.** Three entry cards (equal weight) + recent-runs strip below.
  1. `Describe experiment` (P0): textarea + model picker (Muse Spark default) + [Generate scenario]. Output is a scenario draft shown as a visible diff (see §7), never auto-run.
  2. `Upload trace` (P0): dropzone (JSONL/JSON/CSV). On drop → S2 import report for that file. Until trace replay lands in the engine, the CTA after import is `Inspect` (not `Run`); `Run on this trace` is disabled with reason `trace replay arrives in Phase 2`.
  3. `Build manually` (P0): opens S3 with a blank-or-preset scenario.
- **Recent runs strip.** Last N runs: `{run_id (short), scenario, policy, seed, status, p95, verdict delta if compared}`. Each links to S4. Empty state: `No runs yet — describe an experiment above`.
- **Data.** `GET /runs?limit=N` (summaries only). No metrics beyond the strip fields.
- **Muse tools.** `create_scenario`, `validate_scenario` (draft only; execution happens from S3/S6 after user review).
- **Acceptance.** (a) NL input yields a schema-valid draft or a field-level error list — no JSON hand-written. (b) Trace drop yields an import report or a rejection naming the first defect. (c) No run is created from S1 without passing through review (S3 or S6).

### S2 — Trace library (P0 import + inspect; replay P1-gated on engine)

- **Purpose.** Prove what a workload file contains before it is ever simulated. Import is a pipeline with visible outcomes, never a silent parse.
- **Layout.** Left: trace list (committed fixtures + uploads). Right: selected-trace inspector.
- **Import outcomes (exactly one, shown as a banner):** `replayable` (page-level ops: timestamps, page ids, op, bytes) / `derived-workload` (request/token-level; needs a documented generator step) / `analysis-only` (metrics useful for calibration, insufficient for replay) / `rejected` (first defect named: missing field, lifecycle violation, bad ordering).
- **Inspector sections.** Metadata (source, model, runtime, capture date, converter + schema versions, SHA-256); provenance badge + limitation note (e.g. `derived — geometry-derived KV accesses, not vLLM block-table telemetry`); event counts (alloc/read/write/free/migrate); per-request breakdown; footprint (logical working set, normalized occupancy); timeline preview (event density + first/last timestamps); validation report (errors, warnings, normalization adjustments with before/after counts).
- **Interactions.** Upload (drag/drop + picker); rescan; download original; `Use in scenario` (enabled only for `replayable` once the engine supports replay; otherwise disabled with reason); delete (uploads only).
- **Data.** `POST /traces`, `GET /traces`, `GET /traces/{id}` → `TraceProfile` (§4). Uploads MUST be size-capped by the backend (413 + message) and MUST NEVER be unpickled in the request path (pickle snapshots only via the isolated capture pipeline).
- **Muse tools.** `inspect_trace`, `get_trace_profile` (read-only; the assistant explains a trace, it cannot rewrite one).
- **Acceptance.** (a) The checked-in Glimmer derived trace shows `derived` with its limitation note. (b) A malformed file is rejected with the first defect, not ingested. (c) No screen can start a trace-backed run while the engine reports replay unsupported.

### S3 — Scenario builder (P0)

- **Purpose.** Visual + JSON editing of ONE canonical scenario object conforming to `SPECS/config.schema.json`.
- **Layout.** Tabs: General / Infrastructure / Workload / Policy / Faults / Review & JSON. Sticky footer: validation status + [Validate] [Save draft] [Run] (Run enabled only when valid AND (LIVE backend OR explicit DEMO-preview acknowledgment)).
- **Rules.** (a) The builder MUST NOT invent fields: every control maps to a schema path; policy params MUST come from the shared policy-params contract (`docs/POLICIES.md` + engine capabilities) — unknown params are badged `unimplemented by engine` and excluded from submit. (b) Provenance editing is REQUIRED for tier/link blocks (`measured|sourced|assumed` + source + method); missing provenance blocks submit when the scenario targets absolute claims and warns otherwise (A2.1). (c) Review tab shows pretty JSON (copy + download + import) and the assumption list that will accompany the run.
- **Faults tab.** Present but every control disabled with `arrives in Phase 5` until the engine supports faults; disabled values MUST NOT be submitted.
- **Data.** Client validates structurally for speed, but the SUBMIT decision uses `POST /scenarios/validate` (server runs the real schema + semantic validator). Client/server disagreement resolves in favor of the server with the server message shown.
- **Muse tools.** `create_scenario` (new draft), `update_scenario` (JSON-patch against the current draft; UI shows Modified/Unchanged lists per spec §6.3), `validate_scenario`.
- **Acceptance.** (a) Visual edits, JSON import, and NL patch produce byte-equivalent canonical scenarios for the same intent. (b) An invalid scenario cannot reach Run. (c) Assumed values are listed before launch, not discovered after.

### S4 — Runs + run detail (P0)

- **Purpose.** Watch a run over virtual time, then investigate what happened. The centerpiece screen.
- **Runs list.** Columns: run_id (short), scenario (+hash short), policy requested→effective (+fallback badge), seed, status, arrived/completed/rejected, p50/p95, remote traffic, created. Filters: policy, status, scenario. Row click → detail.
- **Run detail layout (three zones).** Left: run facts (identity block, policy block with fallback reason, assumptions panel link, [Export bundle], [Compare…], [What-if…]). Centre: charts + event stream. Right (collapsible): selection inspector + Muse context entry.
- **Centre charts (all from real bundle data ONLY):**
  - Latency distribution (summary percentiles + mean/max; P0) with window note `steady-state [warmup, duration)` + both sample counts when available.
  - Occupancy over virtual time (series: local pages per node + pool pages; P0).
  - Fabric bytes over virtual time (series `link_bytes` per link; P0) + per-link utilization table (summary `links.*`; P0).
  - Completions over virtual time (series `completed`; P1).
  - Per-window p50/p95 bands: NOT AVAILABLE from engine series output — P1, requires backend aggregation over events; MUST NOT be faked from the summary distribution.
- **Virtual-time playback (P0).** Because the DES finishes faster than it simulates, "live" monitoring is a replay of the recorded event stream over virtual time: play/pause, speed (1×/10×/100× virtual), scrub-to-time, event-type filter, request filter. Playback position drives chart cursors and the inspector. `summary mode` toggle skips per-event rendering for large runs (charts + counters only).
- **Event stream (P0, when `include_event_log`).** Paged, filterable list of `SimEvent`s in `(time_ns, seq)` order; click an event → inspector shows the record + related transfer/migration pair. Aggregate page events (`pages=N`, no `page_id`) render as aggregate rows and MUST NOT invent page identities. If the bundle has no event log, the stream shows `summary-only run` empty state, not an error.
- **Rejected-only runs.** If `completed=0`, the detail MUST lead with the rejection block (reasons + counts) and MUST NOT present latency percentiles as findings.
- **Data.** `GET /runs`, `GET /runs/{id}` (summary+manifest+assumptions), `GET /runs/{id}/series?downsample=N`, `GET /runs/{id}/events?…` (paged), `GET /runs/{id}/stream` (SSE virtual-time replay), `GET /runs/{id}/export`.
- **Muse tools.** `get_run_status`, `get_run_metrics`, `explain_events` (read-only).
- **Acceptance.** (a) The overflow fixture's detail leads with rejections while the engine cannot spill to remote. (b) Pausing/scrubbing never changes any number. (c) Every chart point links run_id + the filter reproducing it (A5.3).

### S5 — Compare (P0 guard + table; P1 charts)

- **Purpose.** Decide between policies on controlled experiments. The guard is a gate, not a banner.
- **Layout.** Run picker (2–4 runs, checkboxes; mixed DEMO/LIVE selection blocked with reason) → guard verdict → metric matrix → distribution charts.
- **Guard (P0, server-enforced).** `POST /runs/compare {ids}` compares everything except `policy.name`: seed, trace hash (content SHA, never path), warmup, percentiles, page size, engine version, scenario canonical hash minus policy. Verdict `refused` names the FIRST differing field and the comparison MUST NOT render. Verdict `fair` renders. Single-seed comparisons render with a `directional — single seed` label (A3.2); multi-seed (mean ± CI) is P1.
- **Matrix (P0).** Rows: p50/p95/p99, local/remote/miss ratios, remote read/write bytes, migration bytes, per-link utilization, stall, completions/rejections. Each cell links its run_id. Direction hints (`lower is better`) allowed; verdict prose (`X wins`) is P1 and MUST cite the mechanism metric (A8.2).
- **Charts (P1).** Grouped latency bars, stacked hit-ratio bars, traffic bars. P1 because the matrix + guard is the credible core.
- **Muse tools.** `compare_runs` (calls the same guarded endpoint; the assistant MUST NOT hand-compare numbers from two separate reads).
- **Acceptance.** (a) Comparing runs with different seeds refuses and names `seed`. (b) Comparing a DEMO run with a LIVE run is blocked. (c) The prefetch-failure pair shows the split verdict (wins mean, loses p99) with mechanism citation when the engine supports prefetch (until then the fixture row shows `policy unsupported by engine`).

### S6 — Research: Muse assistant + what-if (P0 thin slice)

- **Purpose.** Ask questions about real runs and launch controlled follow-ups. Present as a docked panel available from S4/S5 plus a full Research view for long investigations.
- **Answered-question flow (P0).** User asks → assistant calls read tools (`get_run_metrics`, `explain_events`, `get_trace_profile`) → answer with inline citations (`run_id`, metric field or event filter). Every numeric claim MUST carry a citation; missing data → explicit refusal + what to run instead (§7).
- **What-if flow (P0).** From a run: [What-if] → editable parameter form (ONE parameter by default; multi-param allowed but flagged) → assistant produces a scenario version (`parent_version`, `changes[]`, `unchanged[]` incl. trace hash, seed, warmup, duration) → user reviews → `start_simulation` → new run linked as `derived_from`. Rerun-from-zero always; no live-editing of finished runs.
- **Sweep/optimize prompts** (`find minimum bandwidth for p95 < X`) are P1: the assistant MUST answer `sweeps are not implemented` and offer the manual what-if path instead of pretending.
- **Model routing (P0).** Muse Spark for interaction/tool loop. Muse Wonder for multi-run reports: P1. Voice/Image: P2 (not in this spec's scope).
- **Data.** `POST /assistant/chat` (server holds key + tool allowlist); scenario versions via `POST /scenarios/version`.
- **Acceptance.** (a) `Why did p95 rise at t?` returns events + metric fields, or refuses. (b) A what-if run differs from its parent in exactly the stated parameter (guard-verifiable). (c) No assistant message contains a number absent from tool outputs.

### S7 — Topology (P0 data-driven; replaces static presets)

- **Purpose.** See the simulated fabric and its live occupancy at a glance.
- **Rules.** Nodes, links, capacities, bandwidths, and latencies render FROM the selected scenario; occupancy/utilization/queue overlays render FROM the selected run's summary/series. No hardcoded tiers. Node/link click → inspector (capacity, occupancy, bandwidth, latency, active transfers, queue depth, failure state when faults exist).
- **Data.** Scenario + `GET /runs/{id}` + series tail. In DEMO mode with no scenario selected, show the empty state — never preset hardware as if configured.
- **Acceptance.** Changing the scenario changes the graph; the overflow fixture shows 1 compute + 1 pool + 1 link with 0 utilization and a rejection note.

### S8 — Settings (P0)

- **Purpose.** Backend connection, mode control, schema transparency.
- **Sections.** Connection (base URL, [Test], status); Mode (DEMO/LIVE radio with consequences spelled out; switching to LIVE with unreachable backend is blocked, not silent); Schemas (linked spec versions in use: config/trace/events + engine version when connected); Danger zone (clear local drafts, clear cached uploads).
- **Acceptance.** (a) LIVE with dead backend shows `offline` and stays put. (b) Displayed schema versions match the connected backend's `/health`.

## 4. Data contracts

Shapes below mirror what the engine actually emits (PR #2 bundle layout). The frontend MUST adapt to these, not vice versa.

- **Scenario.** Exactly `SPECS/config.schema.json`. No frontend-only fields on submit (draft metadata lives client-side and is stripped).
- **RunSummary** (list + strip): `{run_id, scenario_name, scenario_hash, seed, policy:{requested,effective,fallback_reason}, status, arrived, completed, rejected, p50, p95, remote_read_bytes, migration_bytes, created_at}`.
- **RunDetail**: full `summary.json` + `manifest.json` sections: `access{count,writes,latency_ns{count,mean,min,max,p50,p95,p99},local_hits,remote_hits,bypass_reads,misses,ratios…,stall_ns,total_accesses_incl_warmup}`, `traffic{remote_read_bytes,remote_write_bytes,migration_bytes,evict_bytes,install_bytes,…}`, `links{id→{bytes_in,bytes_out,busy_ns,utilization,max_queue_bytes,…}}`, `memory{…}`, `requests{…}`, `policy{…}`, `workload{kv_formula,…}`, `assumed_parameters[]`, `scenario_assumptions[]`, `warnings[]`, `limitations[]`.
- **SeriesPoint** (from `series.jsonl`): `{t_ns, accesses, evictions, completed, local_used_pages{node→n}, pool_used_pages, link_bytes{link→n}}`. No per-window latency exists — see S4.
- **SimEvent** (from `events.jsonl` per `SPECS/events.md`): `{event, time_ns, seq, run_id, node?, request_id?, data}`. Page-lifecycle rows are currently aggregate (`pages`, `bytes`, no `page_id`) and MUST render as aggregates.
- **TraceProfile**: `{trace_id, path_or_name, sha256, source, model?, runtime?, capture_date?, converter, trace_schema_version, provenance: measured|derived|synthetic|calibrated, limitation_note?, counts{alloc,read,write,free,migrate}, requests, footprint_bytes, normalized_pages, validation{errors[],warnings[]}, normalization[]}`.
- **ComparisonVerdict**: `{verdict: fair|refused, first_diff_field?, checks[{field, status: match|mismatch|unknown, detail}], seed_spread_note}`.
- **ScenarioVersion**: `{version, parent_version?, changes[{path, from, to}], unchanged[]}` for NL/what-if diffs.

## 5. Backend API (Run API + Trace API + Scenario API)

REST + SSE. All errors are `{detail, code?, run_id?}`; 422 for validation/guard failures with the first offending field.

- `GET /health` → `{status, rmemfab_version, schema_versions{config,trace,events}, replay_supported: bool, faults_supported: bool}` (capability flags drive UI enablement).
- `POST /scenarios/validate {scenario}` → `{valid, errors[{path,message}], warnings[], assumed[]}` (runs the real validator).
- `POST /scenarios/version {parent_version?, patch[]}` → `ScenarioVersion` (+ canonical scenario).
- `POST /runs {scenario}` → `{run_id, status}` (202 accepted; engine runs inline for now, job queue later).
- `GET /runs?limit=&policy=&status=` → `RunSummary[]`.
- `GET /runs/{id}` → `RunDetail`.
- `GET /runs/{id}/series?downsample=N` → `SeriesPoint[]` (backend decimates; default ≤2000 points).
- `GET /runs/{id}/events?types=&t0=&t1=&request_id=&limit=&cursor=` → `{events: SimEvent[], next_cursor?}` (paged; default limit 500).
- `GET /runs/{id}/stream` → SSE virtual-time replay (`tick{t_ns}`, `event{…}`, `done`) for S4 playback.
- `POST /runs/compare {ids[]}` → `ComparisonVerdict` + aligned rows, or 422 naming the first differing field.
- `POST /traces` (multipart, size-capped) → `TraceProfile`; `GET /traces`; `GET /traces/{id}`; `DELETE /traces/{id}` (uploads only).
- `GET /runs/{id}/export` → bundle archive (`scenario.json`, `manifest.json`, `summary.json`, `series.jsonl`, `events.jsonl?`, `README.md`) per ACCEPTANCE.md §Evidence bundle.
- `POST /assistant/chat {messages[], context{run_id?,trace_id?,scenario_version?}}` → assistant turn with tool calls + citations (server-side Muse key, §6 allowlist).

## 6. Muse tool definitions (server-side allowlist)

| Tool | Args | Returns | Used by |
| --- | ---- | ------- | ------- |
| `inspect_trace` | `{trace_id}` | `TraceProfile` summary + first defects if any | S2, S6 |
| `get_trace_profile` | `{trace_id}` | full `TraceProfile` | S2, S6 |
| `create_scenario` | `{goal: string, trace_id?: string}` | `ScenarioVersion` draft (unvalidated until checked) | S1, S6 |
| `validate_scenario` | `{scenario}` | validator report | S1, S3, S6 |
| `update_scenario` | `{base_version, patch[{path, value}]}` | new `ScenarioVersion` + Modified/Unchanged lists | S3, S6 |
| `start_simulation` | `{scenario_version}` | `{run_id, status}` (only after `validate_scenario` passes in the same turn) | S6 |
| `get_run_status` | `{run_id}` | status + counters | S4, S6 |
| `get_run_metrics` | `{run_id, fields[]?}` | metric subset with units + windows | S4, S5, S6 |
| `compare_runs` | `{ids[]}` | `ComparisonVerdict` (same endpoint as S5; identical refusal semantics) | S5, S6 |
| `explain_events` | `{run_id, t0?, t1?, types[]?, request_id?, limit?}` | ordered events + pair links (begin/end) | S4, S6 |
| `run_sensitivity_sweep` | — | P1: NOT IMPLEMENTED. Registered name returns `unsupported` until the engine ships sweeps. | — |

The model MUST NEVER bypass `validate_scenario`, MUST NEVER submit raw simulation code, and MUST NEVER call unlisted tools. Sweeps/promises about unimplemented tools are a spec violation, not a fallback.

## 7. Grounding and honesty rules for AI output

1. Every numeric claim cites `(run_id, field)` or `(run_id, event filter)`; the UI renders citations as links.
2. Unknown/missing data → refuse + state exactly what run or input would answer it. Never estimate a simulator metric.
3. NL→scenario output is ALWAYS shown as intent → draft → Modified/Unchanged → [Review] [Edit] [Run]. Silent defaults are forbidden; each default shows its provenance (`measured|sourced|assumed`).
4. What-if output is ALWAYS a versioned scenario + a new run; the assistant MUST NOT predict the outcome before the run completes.
5. Single-seed comparisons are labeled `directional` in both UI and assistant text.
6. DEMO-mode assistant (no backend) answers only process/how-to questions and labels itself `illustrative — no run data`; it MUST NOT roleplay telemetry.

## 8. Non-functional requirements

- **Performance.** Series decimation server-side; event lists virtualized + paged; time-to-first-chart < 2s on the bundled fixtures; no full-`events.jsonl` fetch for runs over the backend's inline threshold (stream or page instead).
- **Compatibility.** Evergreen Chrome/Firefox/Safari; desktop-first (min 1280px); mobile shows run summaries read-only.
- **Accessibility.** All controls labeled; status never color-only (badge text); charts have text-table alternative (the S5 matrix pattern); keyboard-reachable playback.
- **Offline/demo.** DEMO mode fully offline; LIVE mode degrades to explicit `offline`, never to mock.

## 9. Build phasing (maps to the 7-step demo)

- **M1 — Honest shell.** S8 + G1–G7 + S5 guard/refusal + S7 data-driven + provenance everywhere. Demo risk removed before demo value added.
- **M2 — Real runs.** S4 on live bundles (charts from §4 shapes, playback via SSE replay, paged events) + S3 submit-through-backend + export. Steps 3–4 of the demo go live.
- **M3 — Traces.** S2 import/inspect; `Run on trace` stays disabled until engine replay; Glimmer fixture renders with its limitation note. Step 1 goes live (inspect).
- **M4 — Muse thin slice.** S1 NL→draft + S6 Q&A/what-if over `get_run_metrics`/`explain_events`/guarded `compare_runs`. Steps 2, 6, 7 go live. Sweeps, Wonder reports, Perfetto, 3D, voice stay out.

## 10. Out of scope (do not build)

Perfetto embed, 3D views, voice input, sweep UI, multi-seed CI display, cost-optimization advisor, user accounts, sharing links, parquet export in-browser, fault-injection UI (until engine Phase 5), trace replay execution (until engine Phase 2 — import/inspect only).
