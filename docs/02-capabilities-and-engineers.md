# What RmemFab Can Do + How It Helps Real Engineers

Refreshed 2026-11-02 for Phase 5 (was: local-only audit, 2026-11-01).
Part 1 = capability inventory (all implemented, 197/197 green,
live-verified). Part 2 = engineer workflows with real commands. Honest
boundaries at the end.

---

# Part 1 — Capabilities

## 1. Deterministic discrete-event simulation core

- Scenario-driven runs: one versioned JSON object describes hardware,
  workload, policy, output. Same scenario + seed ⇒ byte-identical results;
  the API reuses this for idempotent run IDs.
- Strict validation first: unknown fields rejected; unreachable pools,
  isolated nodes, and self-links are hard errors; unrunnable features fail
  with reasons instead of silently degrading.
- Canonical run bundles: `scenario.json`, `summary.json`, `manifest.json`
  (hashes, seed, assumptions, warnings, limitations, routes),
  `series.jsonl`, `events.jsonl`, `README.md` — zippable via the API.

## 2. N-tier placement over a routed link graph

- Multiple pools, named switches, peer locals as tiers; static
  shortest-path routing with deterministic ties, routes recorded in the
  manifest. Tiers are endpoints, never transit.
- Path-based contention: every transfer occupies each hop link + crossed
  switches + destination tier, with per-link directional bytes and
  per-switch telemetry.
- Single-owner placement: pages live in exactly one tier; foreign pages
  yield first on eviction; non-owner touches read through; unroutable
  touches diverge naming the row. No fake coherence.
- `choose_tier` policy hook over every reachable tier (id, kind, free
  pages, hops, path latency); nearest-with-space default.

## 3. Five policies + comparison science

- `local_only`, `swap_remote`, `hot_cold`, `frequency_aware` (LRU-K),
  `predictive_prefetch`, each with documented, tested semantics.
- Guarded comparison: same seed + identical scenario except policy, else
  refused naming the first differing field. Multi-seed mode reports mean ±
  95% CI; n=1 reports no interval rather than fiction.
- Sweeps (grid × seeds, parallel workers), sensitivity analyses, CSV/JSON
  export; examples ship in `examples/sweeps/`.

## 4. Trace replay with an honest contract

- Canonical JSONL with lifecycle validation (alloc → touch → free, uniform
  alloc sizes, integer timestamps). Invalid traces rejected with row
  numbers — including the Glimmer-derived trace, correctly refused.
- Two replayable traces in-repo: measured vLLM/OPT-125M capture (4,540 ops)
  and a Baseten Muse batch-sweep derivation (22,116 ops, 72 requests) with
  raw log + manifest + SHAs.
- Replay shares engine timing rules by construction (spill-on-alloc,
  fetch-on-demand, dirty-only writeback, clean evictions move 0 bytes).

## 5. Synthetic KV workloads + cost model

- `kv_cache_decode` with GQA/MQA-style geometry, Poisson arrivals,
  prefill/decode mix, per-node sharding — no model names in `src/`.
- Baseten generator for production-like request distributions.
- Parametric cost model reported beside performance (capacity, traffic,
  migration, prefetch terms).

## 6. HTTP API + dashboard contract + assistant

- `rmemfab serve` on localhost: validate, versioned what-if patches,
  idempotent run submit, run detail with the saved scenario, decimated
  series, paged/filtered events, SSE virtual-time stream, guarded
  compare, bundle export, capped trace upload with profiles.
- Real sample bundles + `docs/API.md` + 37 API/assistant contract tests
  for frontend work.
- Baseten-backed NL→scenario draft (validated before storage; invalid
  drafts returned with errors, never runnable) and telemetry-grounded chat
  (plain or SSE; live-verified exact against ground truth).
- Suggestion→rerun loop: chat `suggest_patch` returns validated patch
  blocks, `POST /assistant/apply` (patch or NL → version → run →
  guarded compare) and `POST /assistant/rollback` (audited rerun).

## 7. Deterministic fault injection (Phase 5)

- Link degradation windows (exact bandwidth rescale + latency factor),
  packet loss with persistent retransmission (RTO = 2× path latency,
  dedicated RNG stream), node failure/recovery (park-to-resume or clean
  `node_failed` reject), endpoint stall.
- Degraded-mode telemetry: `summary.degraded` (windows, stalls, loss/retx
  counters), per-tick `degraded` series flag, fault events, manifest
  notes. Demo: `examples/phase5-fault-recovery.json`.

---

# Part 2 — How real engineers use it

## Capacity planner: "how much remote pool for p95 < X?"

Sweep pool capacity over the Baseten trace and read the knee:

```bash
# 8, 32, 128 GiB in raw bytes (--set values are JSON-decoded)
rmemfab sweep examples/phase2-replay-baseten.json \
  --set nodes.1.remote_memory.capacity_bytes=8589934592,34359738368,137438953472 \
  --seeds 7 --workers 3 --out /tmp/cap
for d in /tmp/cap/*/; do
  python3 -c "import json; s=json.load(open('$d/summary.json'));
print('$d', 'p95=', s['access']['latency_ns']['p95'],
      'pool_peak=', s['pools']['remote-pool']['peak_used_pages'])"
done
```

Note the guard refuses cross-config compares (honest: it certifies policy
claims, not hardware claims). For capacity planning, read each run's
`summary.json` directly (`access.latency_ns.p95`,
`pools.<id>.peak_used_pages`, `traffic.*`) or export CSVs and plot the
p95-vs-capacity knee plus the cost model's $/GB line. The manifest records
every assumption behind each number.

## Performance engineer: "which policy, and what does it cost in traffic?"

```bash
rmemfab run examples/phase2-replay-opt.json --policy swap_remote \
  --out /tmp/pol/swap --quiet --no-events
rmemfab run examples/phase2-replay-opt.json --policy hot_cold \
  --out /tmp/pol/hc --quiet --no-events
rmemfab compare /tmp/pol/swap /tmp/pol/hc
```

Same seed + trace ⇒ verdict `fair`: hit ratios, p50/p95/p99, remote-read
and migration bytes, prefetch accuracy side by side. The prefetch-failure
harness (`examples/policy-prefetch-failure.json`) answers "did prefetching
help or congest the fabric" with wasted-prefetch bytes — the number that
kills bad prefetcher proposals in review.

## Fabric architect: "star vs spine-leaf? what if I double bandwidth?"

- Baseline vs topology: run `examples/two-node-switch.json` and
  `examples/ntier-spine-leaf.json`; compare per-link `bytes_in/out`,
  per-switch `bytes_served`, queue depths, and migration matrices.
- What-if via API: `POST /scenarios/version` with
  `[{op: replace, path: /fabric/links/0/bandwidth_bytes_per_ns, value: N}]`
  → fetch → `POST /runs` → `GET /runs/{id}/stream` for the replay.
  Bandwidth, latency, bisection caps, and pool counts are all patchable;
  every variant is a content-hashed, re-runnable version.

## Resilience engineer: "what happens when the link degrades?"

```bash
rmemfab run examples/phase5-fault-recovery.json --out /tmp/fault --quiet
```

A degraded link (3–6s), a node outage (4–5s, requests park then drain),
and 2% loss with retransmission. Read `summary.degraded` for windows,
stalls, and retx counters; `series.jsonl` shows the per-tick degraded
flag (1 link-only, 2 during overlap); `events.jsonl` carries
`link_degraded/restored`, `node_fail/recover`, `transfer_lost`. Reruns
are byte-identical, so the fault drill is reproducible.

## ML serving engineer: "will my serving distribution fit?"

Upload a request log (`POST /traces`, validated, profiled), convert to the
canonical format (Baseten/Muse path ships as the reference), replay with
`examples/phase2-replay-baseten.json` as the template. Tune
per-node `concurrency` and watch `requests.rejected` + reject reasons for
the admission cliff; tune local capacity and watch the local/remote hit
split move. Arrival overlap and congestion come from the trace's own
timestamps, not from averages.

## Researcher: "give me an artifact I can cite"

Every run is a self-describing bundle: inputs hashed, seed pinned,
assumptions/warnings/limitations embedded, provenance labeled
(measured/derived/synthetic, never mixed). Re-run any figure with one
command; export the bundle as the paper artifact. Multi-seed sweeps give
CIs instead of single-point claims.

## Platform / FinOps: "perf per dollar?"

The cost model sits next to every performance number: capacity $/GiB/s,
traffic $, migration $, prefetch waste $. Compare "bigger local tier" vs
"faster fabric" vs "smarter policy" in one table. (Parametric today —
calibrate against your price book before procurement decisions.)

## Frontend/integrator (Ravin's path)

`rmemfab serve` → `/docs` interactive spec → build types against
`examples/sample-outputs/` → wire `GET /runs/{id}/series|events|stream`.
`docs/API.md` is the integration guide; `tests/test_api.py` is the
executable contract.

## What it will NOT tell you (use the right tool instead)

Per-request compute (GEMM/attention) time, sub-page/TLB effects,
packet-level congestion control, power/thermals, stochastic failure
processes, or multi-model colocation interference. See
`01-limitations.md`. Frame RmemFab answers as memory-placement answers —
that is what it models exactly, and judges reward the honesty.
