# Policies

A policy decides where pages live, what to evict, what to migrate, and what to prefetch. It is the main experimental variable in RmemFab.

## Policy interface

Policies are pure decision functions. They observe simulator state and return decisions; the memory model applies them. This separation keeps policy code testable and prevents accidental state mutation.

Illustrative interface (Python):

```python
class MemoryPolicy(Protocol):
    name: str
    version: str

    def on_access(self, ctx: AccessContext) -> list[Decision]:
        """Called when a page is accessed."""

    def on_pressure(self, ctx: PressureContext) -> list[Decision]:
        """Called when a tier exceeds its capacity watermark."""

    def on_tick(self, ctx: TickContext) -> list[Decision]:
        """Called on periodic sampling ticks."""

    def on_fault(self, ctx: FaultContext) -> list[Decision]:
        """Called when a node or link fails or recovers."""
```

`Decision` variants:

| Decision | Meaning |
| :--- | :--- |
| `Keep(page)` | Leave the page where it is. |
| `Fetch(page, source, destination)` | Bring the page into a tier. |
| `Migrate(page, destination)` | Move the page; invalidate the source on completion. |
| `Evict(page, writeback)` | Remove the page, optionally writing back dirty data. |
| `Prefetch(page, destination, confidence)` | Fetch ahead of demand. |
| `NoOp(page, reason)` | Explicitly do nothing; useful for telemetry. |

Contexts contain read-only views:

- Current virtual time.
- Page identity, size, state, and last-access metadata.
- Tier capacities, occupancy, and watermarks.
- Recent access history (bounded window).
- Fabric state: latency, bandwidth, queue depth.
- Policy parameters and its own seeded random stream.

Policies cannot:

- Read or write files or the network.
- Depend on wall-clock time.
- Spawn threads.
- Mutate scenario state directly.

## N-tier destination choice (`choose_tier`)

Spill and eviction destinations are policy decisions. The engine offers every reachable remote tier as a candidate `(tier_id, kind, free_pages, hops, path_latency_ns)` with `kind` in `{"pool", "peer"}`, and calls `choose_tier(candidates)`; the default picks nearest by `(hops, latency, id)` — the cheapest reachable home. No built-in policy overrides it yet (see ROADMAP: N-tier policy optimization is deferred), so all placement today is nearest-with-space.

Victim order is fixed across policies: foreign pages parked on this tier yield first (ordered by the policy's `victim_key`), then domestic pages. Placement stays single-owner: a page lives in exactly one tier, and a non-owner touch reads through without moving the page.

## Built-in policies

### Local-only (baseline)

All pages must fit in local memory. On pressure, evict according to a configured replacement policy. There is no remote capacity. This establishes the lower bound on cost and the failure point for a workload.

Expected behavior: near-optimal latency until capacity is exceeded, then eviction or failure.

### Swap-to-remote (baseline)

Treats remote memory as a slower backing store:

- Evict local pages to remote memory on pressure.
- Fetch them back on access.
- No proactive migration or prefetch.

This is the simplest remote-memory policy and the natural foil for smarter ones. It often shows a latency cliff when the working set churns.

### Hot/cold migration

Implemented (`hot_cold`, swap substrate). Classifies pages by lifetime touch count: at least `hot_threshold` touches is hot, at most `cold_threshold` is cold, the rest neutral. Eviction takes cold first, then neutral, then hot (LRU-K order within a band); remote reads install locally unless the page is cold (cold reads bypass, staying remote).

Parameters: `k` (default 2), `hot_threshold` (default 3), `cold_threshold` (default 1); requires `0 <= cold_threshold < hot_threshold`.

Failure modes to test: thresholds too aggressive cause thrashing; thresholds too conservative leave hot data remote. EWMA decay, tick promotion, and minimum residency are not implemented; bands are recomputed from observation state on every decision, so behavior is a deterministic function of the op stream.

### Frequency-aware eviction

Implemented (`frequency_aware`, swap substrate, LRU-K). Victims are ordered by K-th-last-touch, so once-touched streaming pages are evicted before genuinely reused ones even when the streaming touch is more recent. K=1 degenerates to plain LRU.

Parameters: `k` (default 2, must be >= 1).

This policy is useful for KV caches where old pages may become hot again, and for MoE experts with skewed popularity. ARC-style adaptive replacement and segmented LRU are future variants, not implemented.

### Predictive prefetching

Implemented (`predictive_prefetch`, swap substrate with LRU victims). Replay follows trailing-integer stride: on a touch of page `blk20572` with stride -1, it fetches `blk20571` (then `blk20570` at degree 2) when the successor is allocated but not local. Synthetic runs anticipate per-request KV growth under the same cap. Prefetches share the demand fabric with no priority lane, so aggressive settings visibly congest.

Parameters: `degree` (default 1), `stride` (default 1, any nonzero integer; negative strides scan descending ids), `max_in_flight` (default 64), `on_hit` (default true; when false, only remote misses trigger prefetch).

Accuracy = touched-after-issue / issued, counted only at strictly later timestamps. Never-touched prefetches are reported as wasted bytes, never hidden; cap/pressure refusals count as skipped. Confidence thresholds, cancellation, and expert-sequence prediction are not implemented.

Prefetching can reduce latency or make congestion worse. The comparison engine reports both hit-rate improvement and wasted prefetch traffic.

### Cost-aware / custom

Not implemented. The cost model (`capacity` + `transfer` + `migration` + `prefetch` + `wasted_prefetch`, all optional rates) already prices policy traffic, but no policy optimizes against it yet.

Custom policies register via `register` in `src/rmemfab/policies/` without modifying the engines.

## Comparison protocol

A valid policy comparison holds everything else constant:

1. Same scenario file, except the `policy` block.
2. Same seed and trace hash.
3. Same warm-up and measurement window.
4. Same metric definitions and percentile settings.
5. Same RmemFab version.

For stochastic scenarios, run multiple seeds (for example 10–30) and report:

- Mean and standard deviation across seeds.
- Confidence interval for the primary metric.
- Worst-case seed behavior, not just the average.

A policy is considered better only if the improvement exceeds the run-to-run spread.

## Metrics

| Metric | Definition |
| :--- | :--- |
| Mean access latency | Total access completion time divided by access count |
| p50 / p95 / p99 latency | Percentiles of access completion latency |
| Stall time | Time requests spend waiting on memory beyond the local-hit baseline |
| Local hit ratio | Local hits divided by accesses |
| Remote hit ratio | Remote hits divided by accesses |
| Miss ratio | Accesses requiring fetch or recomputation divided by accesses |
| Remote traffic | Bytes read from and written to remote tiers |
| Migration volume | Bytes moved by migration decisions |
| Prefetch accuracy | Used prefetches divided by issued prefetches |
| Fabric utilization | Busy time or bytes served divided by capacity over the window |
| Queue depth | Time-weighted in-flight bytes per link |
| Throughput | Completed requests or tokens per virtual second |
| Cost | Configured capacity + transfer + migration + prefetch + wasted-prefetch cost model |

All metrics are emitted per run and per time bucket. Comparisons use the same window.

## Parameter sweeps

The sweep runner varies one or more dimensions while holding the rest fixed:

- Fabric latency and bandwidth.
- Local-to-remote capacity ratio.
- Page size.
- Prefetch depth and confidence.
- Hot/cold thresholds.
- Failure rate and repair time.

Each sweep point is an independent run with a recorded manifest. The dashboard displays sensitivity curves and highlights cliffs — regions where a small parameter change causes a large metric change.

## Avoiding misleading results

- **Cache pollution:** a prefetch policy that improves average latency may hurt p99 by displacing demand pages. Always report tails.
- **Warm-up bias:** early accesses may not represent steady state. Exclude a configured warm-up window.
- **Trace reuse:** replaying the same trace for every policy is fair, but it cannot reveal policy-induced changes in future access patterns. Document this limitation.
- **Simulator feedback loops:** if a policy changes latency, it can change request arrival timing. Decide whether arrivals are open-loop (fixed schedule) or closed-loop (throughput-dependent) and state it in the scenario.
- **Cherry-picked seeds:** report the seed set and the spread, not a single favorable run.

## Adding a policy

1. Implement the interface in `src/rmemfab/policies/` (`MemoryPolicy` in `base.py`).
2. Declare `KNOWN_PARAMS` with defaults and validate bounds in `__init__` (raise `ValueError` naming the bad parameter).
3. Register the policy name with `@register` and add it to `IMPLEMENTED_POLICIES` in `config/scenario.py`.
4. Add unit tests for decisions on small traces (`tests/test_policies.py`).
5. Add a comparison scenario under `examples/`.
6. Document expected behavior, parameters, and failure modes here.
