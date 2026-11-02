# RmemFab Limitations — Full Audit (2026-11-01, refreshed 2026-11-02)

Every item verified against code, tests, docs, or a live run.
Refreshed after Phase 5 (fault injection) and the honesty-bug fixes;
fixed items are kept below with their evidence, not deleted.

## Already tracked (ROADMAP deferred / manifests / warnings)

Fluid-not-packets fabric (no DCQCN/TIMELY/PFC), single-owner placement
with no coherence protocol, static shortest-path routing, `choose_tier`
hook with no optimizing policy yet. Plus PRODUCT-SPEC §10 dashboard
exclusions and manifest notes (aggregate rows, clean-evict-0-bytes,
transfers never dropped). Faults + loss are modeled since Phase 5
(explicit windows only; the stochastic failure process stays
warned-and-ignored).

## Fixed (were honesty bugs, fixed 2026-11-01)

1. `moe-remote-tiering.json` was unrunnable — replaced by runnable
   `examples/eight-node-rdma-pool.json` (kv_cache_decode,
   frequency_aware, real 58/42 spill; exit 0 in ~3s).
2. Stale "arrives in Phase 2" message — now "is not implemented", naming
   the implemented set (`config/scenario.py`).
3. Synthetic manifest pre-N-tier wording — aligned verbatim with the
   replay manifest's N-tier fabric note.
4. Phantom `cost_aware` policy — removed from both schema copies and the
   draft prompt; requesting it is now a hard schema error with a
   regression test (`tests/test_schemas.py`).

## Workload and serving realism gaps

5. Memory-stall-only timing — request latency = local accesses + fabric
   transfers; zero compute (attention/GEMM) term anywhere in `src/`. At
   small batches this understates real latency badly.
6. Fixed prompt/gen tokens, Poisson-only arrivals (`core/engine.py`,
   `workloads/synthetic.py`) — no length distributions, bursts,
   closed-loop, or trace-driven arrivals in synthetic mode.
7. No continuous batching, chunked prefill, preemption, priorities,
   deadlines, or QoS — per-node FCFS to completion. vLLM-style serving
   dynamics are out of reach.
8. No TTFT/TPOT SLO metrics in engine telemetry (access/read/request
   latencies + p50/p95/p99 only).
9. Single model per scenario — no multi-model or multi-tenant serving mixes.

## Memory-system fidelity gaps

10. No TLB, page walks, or address translation — placement is tier-level only.
11. No external fragmentation (page-rounding only), uniform page size
    enforced, no compression/dedup/zero-pages.
12. No power, thermal, DVFS, or energy modeling anywhere in `src/`.
13. Congestion limits are telemetry-only — in-flight/queue breaches counted
    (`memory/servers.py`), transfers never dropped, nothing pushes back
    on admission.
14. Allocator events ignored in replay (zero references) — fragmentation
    analysis input goes nowhere.

## Trace ecosystem gaps

15. Only JSONL + 2 converters (`tools/`); no CSV/Parquet/OTel/Perfetto/
    Chrome adapters despite the product vision.
16. Observed placement rows and tier hints ignored by design
    (`trace/validate.py`) — correct, but cross-policy trace comparison
    data is discarded.
17. `latency_ns` observations counted, never used — recorded in stats, then
    dropped.
18. Glimmer still unusable — correctly rejected
    (`tests/test_trace_validate.py`), converter unrepaired. Flagship-model
    gap for the demo story.

## Policy gaps

19. Prefetch is growth-anticipation (synth) + trailing-stride (replay) —
    no feedback loop, no ML, shares demand fabric with no priority lane
    (`policies/adaptive.py`).
20. Cost model has no calibration dataset — dollar figures are parametric;
    treat as illustrative until calibrated.
21. Unknown policy params ignored (warned) — typo'd knobs fail open,
    not closed.

## API/ops gaps

22. No auth, no rate limiting, no job queue — inline runs block a worker;
    no cancel/delete/run-retention (runs/ + versions/ grow unbounded).
23. Resubmit TOCTOU race — concurrent same-scenario POSTs can double-run.
24. SSE replays the stored log — no live execution streaming; fixed 128 MB
    trace cap; zip-only export.
25. No-op patch clobbers its parent — `POST /scenarios/version` with a
    no-change patch overwrites the parent record under the same
    content hash (`/assistant/apply` guards against this; the raw
    endpoint does not).

## Assistant gaps

26. Single-shot, no tool loop — one draft call, one chat call; no agentic
    iteration, no event drill-down, no multi-run reasoning. (Apply/
    rollback/suggest_patch close the suggestion→rerun loop without a
    loop.)
27. No usage/cost aggregation, no draft caching, no retry/backoff —
    provider failure is an immediate 502.

## Scale and determinism notes

28. Single-process Python engine, full event materialization — no event
    sampling; scale ceiling unmeasured; no checkpoint/restart.
29. Fully deterministic = zero jitter/noise — a feature for science, a
    realism gap for production fidelity.

## Dead code kept for contract stability

30. The policy-fallback/strict-policy machinery is unreachable via public
    API (the schema gate rejects unknown names first). Kept because the
    manifest/API `fallback_reason` fields are dashboard contract.

## Carried (flagged earlier, not re-audited)

README/WORKLOADS overclaims, queue-equation docs, ACCEPTANCE sweep statuses,
allocator+snapshot hash provenance, dashboard unmerged + static serving
unbuilt, Baseten spend untracked.
