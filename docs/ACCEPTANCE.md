# Acceptance criteria

> A requirement is met only when a reproducible command or test demonstrates it. Prose, screenshots, and co-pilot answers are not evidence.

This document converts the project requirements into executable checks. It is deliberately strict: the demo is allowed to be small, but it is not allowed to be unverifiable.

The commands below are planned CLI/API surfaces. Until they exist, each check is the contract the first implementation milestone must satisfy. A check that cannot be run is marked **contract only** and blocks the demo.

## Summary

| ID | Requirement | Primary evidence | Status |
| :--- | :--- | :--- | :--- |
| A1 | Quantitative correctness | Closed-form, invariant, and overflow tests | contract only |
| A2 | Configurable assumptions | Provenance audit + sensitivity diff | contract only |
| A3 | Fair policy comparisons | Comparison guard + seed spread | contract only |
| A4 | Workload realism | KV formula test + one measured trace | contract only |
| A5 | Explainability | Causal chain + attribution sums | contract only |
| A6 | Reproducibility | Byte-identical rerun in CI | contract only |
| A7 | Decision-oriented interface | Unmoderated user task | contract only |
| A8 | Show where a policy fails | Paired runs + mechanism explanation | contract only |

## Metric definitions

These definitions are normative. A run that uses a different denominator or transfer unit is not comparable to another run and the comparison guard must reject it.

- **Hit ratio.** `local_hit`, `remote_hit`, and `miss` are fractions of page **read accesses** and must sum to 1.0 within rounding. Allocations, frees, evictions, migrations, prefetches, and background events are not in the denominator. Report `page_allocations` separately. A run that reports `local_hit < 1.0` together with `remote_read = 0` has the wrong denominator, not a real remote hit.
- **Traffic.** `remote_read` is bytes transferred from remote to local; `remote_write` is bytes transferred from local to remote. `migration` is bytes moved by a policy decision and is a subset of remote traffic when the policy fetches on demand. Report `remote_read_demand` and `remote_read_migration` separately when both exist. `evicted` is bytes removed from a tier; a clean eviction contributes 0 to `remote_write`. Equal values are allowed only when the policy makes them equal by construction, and the summary must state that.
- **Transfer unit.** `page_size_bytes` is the allocation granularity; `transfer_bytes` is the fabric service unit. They may differ, but the run must report both and link utilization must use `transfer_bytes`. A 4 KiB transfer with 2 MiB pages must be declared, not inferred from the counters.
- **Warmup.** `latency[all]` includes every sample in `[0, duration_ns)`. `latency[steady_state]` includes only samples in `[warmup_ns, duration_ns)`. When the two are identical, the summary must print both sample counts; identical counts mean no samples fell in the warmup window, not that the filter was skipped.
- **Throughput.** Requests per second and tokens per second use `duration_ns - warmup_ns` as the denominator and count only requests completed in that window.
- **Percentiles.** The interpolation method (nearest-rank or linear) is recorded in the manifest and must be identical across compared runs.

## A1 — Quantitative correctness

The simulator must compute access times, transfer durations, queueing, cache misses, and capacity consistently. A shared resource must not behave as if it has unlimited capacity.

### A1.1 Single-tier closed form

Target command:

```bash
rmemfab check --case single-tier-closed-form
```

Pass condition: for `N` consecutive accesses of `n` bytes on a tier with latency `L` and bandwidth `B`, each hit latency equals `L + n/B` within 1 ns, and total service time equals `N * n / B` within 1 ns.

### A1.2 Queue saturation

Target command:

```bash
rmemfab check --case queue-saturation
```

Pass condition: with one link of bandwidth `B` and an idle start, `k` back-to-back transfers of `n` bytes complete at `L + i*n/B` for `i = 1..k` within 1 ns. Doubling the offered bytes on a saturated link must increase both completion time and time-weighted queue depth; neither may stay flat or decrease.

### A1.3 Backlog is not double-counted

Target command:

```bash
rmemfab check --case backlog-invariant --property
```

Pass condition: the transfer start time satisfies exactly one queueing definition. If `link_free_at` is authoritative, `start = max(now, link_free_at)`. If a byte backlog is authoritative, `start = now + backlog/B`. No code path may add both. Property test: for random event sequences, `start` is never earlier than either model predicts, and the two models agree within 1 ns when the link is idle.

This check exists because `docs/SIMULATION-MODEL.md` currently shows both a `link_free_at` term and a `backlog/B` term in the same equation. Resolve that before implementing the fabric.

### A1.4 Shared-resource accounting

Target command:

```bash
rmemfab check --case shared-pool
```

Pass condition: when multiple compute nodes access one remote pool, either

1. the pool is modeled as a shared byte server and aggregate service never exceeds its bandwidth, or
2. the scenario explicitly declares links independent and the limitation is surfaced in the manifest and UI.

Silent oversubscription fails. Absolute pool queue depths are not reportable until this is resolved.

### A1.5 Exact capacity

Target command:

```bash
rmemfab check --case capacity-accounting
```

Pass condition: occupancy never exceeds tier capacity; every allocation, eviction, migration, and free changes occupancy by the exact byte count; a policy request that would overcommit is rejected, evicted, or failed explicitly, never silently granted.

### A1.6 Remote path is exercised

Target commands:

```bash
rmemfab run examples/phase1-overflow.json --out runs/overflow
rmemfab summary runs/overflow
```

The scenario's local tier is deliberately smaller than one request's KV cache, so the pool must be used.

Pass condition: the run completes with `remote_read > 0`, `migration > 0`, and at least one `page_migrate_begin` / `page_migrate_end` pair when event logging is enabled. `local_hit + remote_hit + miss = 1` within rounding, using the read-access denominator from the metric definitions. A run whose local tier cannot hold one request but reports `remote_read = 0` fails; fix the workload, policy, or accounting before accepting Phase 1.

## A2 — Configurable assumptions and provenance

Every hardware or workload value must be traceable to a measurement, a source, or an explicit assumption.

### A2.1 Provenance completeness

Target command:

```bash
rmemfab validate examples/llama-70b-cxl.json --require-provenance
```

Pass condition: every `memoryTier`, `compute`, and `link` used in a scenario intended for absolute claims has `provenance.kind` plus `source` and `method`. The validator warns, with field paths, for values that are assumed and not declared. `assumed` is allowed; hiding an assumption is not.

### A2.2 One-parameter sensitivity

Target command:

```bash
rmemfab sweep examples/llama-70b-cxl.json --set fabric.links[0].latency_ns=180,240 --same-seed
```

Pass condition: changing one parameter produces a metric diff that names the changed path and the affected metrics. Metrics that should not depend on the parameter must not move. The diff is machine-readable, not a sentence written by the co-pilot.

### A2.3 Assumptions surface

Target command:

```bash
rmemfab assumptions runs/<run-id>
```

Pass condition: the output lists every `assumed` value, its uncertainty, and the scenario-level `assumptions` strings. The dashboard renders the same list next to the verdict. A result whose assumptions are not visible is not demo-ready.

## A3 — Fair policy comparisons

### A3.1 Comparison guard

Target command:

```bash
rmemfab compare runs/baseline runs/candidate
```

Pass condition: the comparison is rejected if any field outside `policy` differs, including seed, trace hash, warm-up, metric percentiles, and RmemFab version. The error names the first differing field. If the guard cannot prove sameness, it refuses rather than warning.

### A3.2 Seed spread

Target command:

```bash
rmemfab compare runs/baseline runs/candidate --seeds 1-20
```

Pass condition: the report includes mean, standard deviation, and a confidence interval for p50, p95, and p99. A policy is marked "better" only if the delta exceeds the run-to-run spread. A single-seed comparison must be labeled directional.

### A3.3 Cost of the policy itself

Pass condition: migration bytes, prefetch bytes, and wasted prefetch bytes appear in both the metrics and the cost model. A policy cannot win by moving work off the measured path.

## A4 — Workload realism

### A4.1 Provenance label end to end

Pass condition: every run manifest and dashboard states `synthetic`, `measured`, or `calibrated`, and the label survives export and share links. A synthetic workload may never be displayed as measured.

### A4.2 KV formula

Target command:

```bash
rmemfab check --case kv-sizing --model llama-3-70b --context 8192
```

Pass condition: `2 * layers * kv_heads * head_dim * dtype_bytes * context` matches the generator's reported working set within the configured rounding, and the manifest records the formula and inputs.

### A4.3 Locality changes the ranking

Target command:

```bash
rmemfab compare runs/stable-hot-set runs/shifting-hot-set --policy hot_cold
```

Pass condition: changing locality or hot-set drift changes the policy ranking for a stated reason (for example, a frequency-aware policy loses when the hot set moves faster than the history window). The explanation must cite the responsible metric.

### A4.4 Trace replay

Target command:

```bash
rmemfab run examples/traces/<trace>.jsonl --workload-type trace
```

Pass condition: replay reproduces the recorded allocation/free sequence, reports page-normalization adjustments, and matches measured hit ratio and transfer volume within a documented tolerance.

### A4.5 At least one measured trace

Pass condition: one trace captured on real hardware (for example vLLM on a Modal GPU) is committed or linked with its capture metadata and SHA-256. It does not need to be large. It must be real.

## A5 — Explainability

### A5.1 Causal chain

Target command:

```bash
rmemfab explain runs/<run-id> --request req-17
```

Pass condition: the output contains the ordered chain `request_arrival → page_access → page_miss → transfer_begin → link_congested (optional) → transfer_complete → request_complete`, with `time_ns`, `seq`, and event IDs for each step. Unknown or missing steps are reported, not filled in.

### A5.2 Attribution sums

Target command:

```bash
rmemfab explain runs/<run-id> --window 18s-27s --attribution
```

Pass condition: the added stall versus the pinned baseline is decomposed into queue, link service, tier latency, migration, and prefetch waste. The categories sum to the total within 0.1%. The decomposition is computed from events, not narrated by a model.

### A5.3 Metric-to-event links

Pass condition: every chart point and every verdict number carries a run ID and a filter that reproduces the number from the event log (or the aggregate that is derived from it). A number without a run ID is not evidence.

### A5.4 Co-pilot grounding

Pass condition: each co-pilot claim includes citations that resolve to real events, windows, or metric fields. When the requested data is absent, the co-pilot refuses or asks for a run. It never estimates a metric that the simulator did not compute.

### A5.5 Co-pilot eval set

Target command:

```bash
rmemfab eval-copilot --set evals/copilot-grounding.jsonl
```

Pass condition: at least 20 questions with expected citations; any uncited numeric claim is a failure. The eval runs before the demo and its output is committed.

## A6 — Reproducibility

### A6.1 Byte-identical rerun

Target command:

```bash
rmemfab run examples/llama-70b-cxl.json --seed 42 --out runs/a
rmemfab run examples/llama-70b-cxl.json --seed 42 --out runs/b
diff <(rmemfab summary runs/a --canonical) <(rmemfab summary runs/b --canonical)
```

Pass condition: canonical summaries are byte-identical and event ordering is identical. This runs in CI on every change to the core.

### A6.2 Canonical hash

Pass condition: two scenarios differing only in whitespace or key order produce the same SHA-256. A scenario differing in one value produces a different hash.

### A6.3 Manifest completeness

Pass condition: the manifest records RmemFab version, schema version, scenario hash, seed and per-stream seeds, trace hashes, policy name and version, event count, virtual time, and output paths.

### A6.4 Serial versus parallel

Target command:

```bash
rmemfab sweep examples/policy-prefetch-failure.json --set fabric.links[0].latency_ns=180,240 --workers 4
```

Pass condition: a sweep executed on Modal workers produces the same per-point summaries as a serial run. Worker scheduling must not affect results.

## A7 — Decision-oriented interface

### A7.1 Unmoderated user task

Test with three people who did not build the tool. Task: load a scenario, run it, identify the bottleneck tier or link, compare one policy, and export the bundle. No verbal help.

Pass condition: all three complete the task in under 10 minutes; at least two can explain the verdict in their own words. Record the sessions; failures become backlog, not excuses.

### A7.2 Verdict surface

Pass condition: a run detail screen shows, in one view: baseline delta, p50/p95/p99, the bottleneck breakdown, the time window where the cliff occurs, the assumptions/provenance panel, and an export action. A chart without a baseline delta is incomplete.

### A7.3 Failure is reachable

Pass condition: from a run, a user can open the policy-failure comparison (A8) in at most two actions. The demo must not depend on the presenter remembering a URL.

## A8 — The differentiator: show where a policy fails

This is the project's strongest claim. It is also the easiest to fake, so it gets its own checks.

### A8.1 Paired result

Target commands:

```bash
rmemfab run examples/policy-prefetch-failure.json --seed 42 --out runs/prefetch
rmemfab run examples/policy-prefetch-failure.json --seed 42 --policy hot_cold --out runs/hotcold
rmemfab compare runs/hotcold runs/prefetch
```

Pass condition: report the direction of mean latency, p99 latency, link utilization, prefetch accuracy, and wasted prefetch traffic. The hypothesis in the example is that prefetching lowers the mean and raises p99 by saturating the link. If the run rejects that hypothesis, update the example and report the honest result. Do not tune the model until the expected story appears.

### A8.2 Mechanism, not correlation

Target command:

```bash
rmemfab explain runs/prefetch --window <cliff-window> --attribution
```

Pass condition: the explanation identifies the mechanism (prefetch traffic competing with demand on a saturated link) and cites the events. "Prefetch is slower" is not an explanation.

### A8.3 The result is conditional

Pass condition: the same prefetch policy wins on a second scenario with predictable access and low link load. The pair of results proves the claim is about conditions, not about a policy being universally good.

## What is not evidence

- A screenshot without a run ID and scenario hash.
- A co-pilot paragraph without citations.
- A single-seed result presented as a conclusion for a stochastic scenario.
- A synthetic workload labeled as measured.
- An average that hides a worse tail.
- A sensitivity claim without the sweep artifacts.

## Demo definition of done

- [ ] `examples/llama-70b-cxl.json` runs end to end.
- [ ] Two policies run on the same seed and the comparison guard passes.
- [ ] `examples/policy-prefetch-failure.json` shows a policy winning one metric and losing another, with an explanation.
- [ ] The dashboard shows verdict, bottleneck, assumptions, and export.
- [ ] The bundle reproduces byte-for-byte offline; no live network is required during the demo.
- [ ] A user who did not build the tool can interpret the result without narration.

## Evidence bundle layout

Every demo claim should be backed by a directory like:

```text
runs/<run-id>/
├── scenario.json        # exact input
├── manifest.json        # versions, hashes, seeds, status
├── metrics.parquet      # summary and time windows
├── events.jsonl         # optional, streamable
├── explain.json         # causal chain and attribution
└── README.md            # one paragraph: question, result, caveat
```

Share links point at bundles, not at screenshots. The co-pilot reads bundles; it does not replace them.

## Current gaps tracked by this document

1. The queue equation in `docs/SIMULATION-MODEL.md` must resolve the `link_free_at` versus `backlog/B` ambiguity (A1.3).
2. Shared pool contention is not defined (A1.4).
3. Provenance is now accepted by the schema but not yet enforced by a validator (A2.1).
4. There is no measured trace in the repository (A4.5).
5. There is no `explain` implementation or attribution definition beyond this document (A5).
6. Determinism is specified but not yet proven in CI (A6.1).
7. The co-pilot eval set does not exist (A5.5).
8. The first Phase 1 implementation reported `local_hit = 0.666` with `remote_read = 0B`, which suggests allocations were counted in the hit-ratio denominator. The metric definitions are now normative but not yet enforced by the validator or comparison guard.
9. `examples/llama-70b-cxl.json` fits entirely in local DRAM and never exercises the pool. `examples/phase1-overflow.json` is the minimal overflow check; a realistic long-context pressure scenario still needs to be added.
