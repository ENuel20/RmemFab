# Roadmap

RmemFab is built spec-first so the engine, API, and dashboard can proceed independently. Each phase has a concrete acceptance criterion; a phase is not done until the criterion is demonstrated with a scenario in `examples/`.

## Phase 0 — Specification

**Status:** in this repository.

- Scenario schema, event schema, and trace schema.
- Simulation timing model and determinism contract.
- Policy interface and comparison protocol.
- Hardware presets and workload definitions.

**Done when:** schemas validate the example scenarios, and the docs agree on units, terminology, and scope.

## Phase 1 — Core engine

**Goal:** run a single scenario end to end and emit trustworthy telemetry.

Deliverables:

- Scenario loader and validator (JSON, then YAML).
- Priority-queue scheduler with deterministic tie-breaking.
- Local DRAM tier, remote pool, and one fabric link type.
- Page-granular capacity accounting and LRU eviction.
- Baseline policies: local-only and swap-to-remote.
- Streaming metrics and JSONL telemetry.
- CLI: `validate`, `run`, `summary`.
- Unit tests for timing, capacity accounting, and determinism.

**Acceptance criterion:** `rmemfab run examples/llama-70b-cxl.json` completes, produces a run manifest, and two runs with the same seed produce byte-identical metric summaries.

## Phase 2 — Workloads and traces

**Goal:** credible workload inputs.

Deliverables:

- KV-cache decode generator with GQA/MQA geometry.
- Prefill generator.
- MoE generator with configurable popularity skew.
- Sparse-attention generator.
- Trace importer for the documented JSONL format.
- Converter from PyTorch CUDA allocator snapshots.
- Trace hashing and manifest integration.

**Acceptance criterion:** replaying a captured trace reproduces its allocation/free sequence and reports page-normalization adjustments; synthetic KV estimates match the closed-form size formula.

## Phase 3 — Policies and sweeps

**Goal:** make policy comparison the primary workflow.

Deliverables:

- Hot/cold migration.
- Frequency-aware eviction (LRU-K or ARC-style).
- Predictive prefetching.
- Parameter sweep runner with parallel workers.
- Multi-seed comparison with confidence intervals.
- CSV/JSON export for analysis.

**Acceptance criterion:** a two-policy comparison on the same seed and trace reports latency, hit ratios, remote traffic, and prefetch accuracy, plus a documented sensitivity sweep.

## Phase 4 — Dashboard

**Goal:** make results explorable without reading JSON.

Deliverables:

- React/Next.js dashboard with run list and run detail.
- Latency CDF and time-series charts.
- Memory occupancy heatmap per node and tier.
- Fabric utilization and queue-depth views.
- Policy comparison view with identical-seed guarantees.
- Scenario editor with schema validation.

**Acceptance criterion:** a user can load a run, identify the bottleneck tier/link, and launch a comparison run from the UI.

## Phase 5 — Resilience and co-pilot

**Goal:** answer "what happens when it breaks" and lower the authoring barrier.

Deliverables:

- Node failure/recovery and link degradation.
- Loss and retransmission model.
- Degraded-mode metrics.
- Natural-language scenario drafting with schema validation.
- Telemetry-grounded explanations and policy suggestions.
- Explicit apply/rollback for suggested changes.

**Acceptance criterion:** a fault scenario shows recovery behavior, and every co-pilot suggestion maps to a validated scenario and a rerun with recorded results.

## Phase 6 — Validation

**Goal:** quantify how wrong the simulator is.

Deliverables:

- Microbenchmark suite for local DRAM, CXL, and RDMA.
- Calibration scripts that fit model parameters.
- Held-out trace validation.
- Published error bounds per workload class.
- A validation report committed with the calibration data hashes.

**Acceptance criterion:** simulated latency distributions fall within a documented error bound of measured distributions for at least one real CXL or RDMA setup.

## Ten-day build outline

This is a planning aid for the hackathon, not a contractual schedule.

| Day | Focus |
| :--- | :--- |
| 1 | Repository scaffold, schemas, scenario loader |
| 2 | Scheduler, local memory, remote pool, LRU |
| 3 | Fabric link model, baseline policies, CLI |
| 4 | KV-cache and prefill generators |
| 5 | MoE and sparse-attention generators; trace import |
| 6 | Migration and frequency-aware policies |
| 7 | Prefetching, sweeps, multi-seed comparison |
| 8 | Dashboard: run list, charts, comparison |
| 9 | Fault injection, co-pilot scenario drafting |
| 10 | Validation pass, demo scenario, documentation |

## Later

- Rust hot path behind the Python API for large sweeps.
- Closed-loop arrival models tied to simulated throughput.
- Cache-tier and prefetch interaction studies.
- More trace converters (NPU, custom accelerators).
- Export to standard experiment formats for publication.

## Out of scope

- Cycle-accurate hardware emulation.
- Production cluster orchestration.
- Acting on real infrastructure; RmemFab only simulates.
