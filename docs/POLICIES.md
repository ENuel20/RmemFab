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

Classifies pages by recent access frequency and moves hot pages local and cold pages remote:

- Maintain an exponentially weighted access counter per page.
- On a tick or pressure event, promote pages above a hot threshold if local capacity allows.
- Demote pages below a cold threshold.
- Avoid migration storms with hysteresis and a minimum residency time.

Parameters: hot/cold thresholds, EWMA decay, tick interval, minimum residency, maximum migrations per tick.

Failure modes to test: thresholds too aggressive cause thrashing; thresholds too conservative leave hot data remote.

### Frequency-aware eviction

Protects pages that are likely to be reused even if they were not touched recently:

- Variants: LRU-K, ARC-style adaptive replacement, or a segmented LRU.
- Tracks access counts in a bounded history.
- Evicts pages with low estimated reuse probability.

Parameters: history length, K, segment sizes, adaptation rate.

This policy is useful for KV caches where old pages may become hot again, and for MoE experts with skewed popularity.

### Predictive prefetching

Issues prefetches before demand:

- Detects patterns: sequential strides, per-request KV growth, expert activation sequences.
- Estimates confidence and only prefetches above a threshold.
- Cancels or deprioritizes unused prefetches.
- Accounts for prefetch bandwidth competing with demand traffic.

Parameters: confidence threshold, lookahead depth, maximum in-flight prefetches, cancellation policy.

Prefetching can reduce latency or make congestion worse. The comparison engine reports both hit-rate improvement and wasted prefetch traffic.

### Cost-aware / custom

Weighs latency, bandwidth, migration cost, and a configured cost model. Useful for exploring trade-offs such as "minimize p99 latency" versus "minimize remote traffic" versus "minimize cost per million tokens".

Custom policies can be registered from an entry point without modifying the core.

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
| Cost | Configured capacity + transfer + migration cost model |

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

1. Implement the interface in `src/rmemfab/policies/`.
2. Add a Pydantic parameter model with defaults and bounds.
3. Register the policy name.
4. Add unit tests for decisions on small synthetic traces.
5. Add a comparison scenario under `examples/`.
6. Document expected behavior, parameters, and failure modes here.
