# Simulation model

This document defines the timing model that the RmemFab core implements. It is deliberately analytical: the goal is to expose the sensitivity of AI memory workloads to tier latency, fabric bandwidth, queueing, placement, and failure — not to reproduce hardware cycle by cycle.

## Units and conventions

| Quantity | Unit |
| :--- | :--- |
| Virtual time | integer nanoseconds (`time_ns`) |
| Capacity and transfer size | bytes |
| Latency | nanoseconds |
| Bandwidth | bytes per nanosecond (B/ns) |
| Queue depth | bytes |
| Rates (arrivals) | events per second, converted to inter-arrival nanoseconds |
| Seed | unsigned 64-bit integer |

Bandwidth conversion: `1 GB/s = 1 byte/ns`. A 200 Gbps link is `200e9 / 8 = 25` bytes/ns. A 400 GB/s memory bus is `400` bytes/ns.

All timestamps are relative to simulation start (`t = 0`). Wall-clock time is never used for ordering or decisions.

## Discrete-event loop

The scheduler uses a priority queue ordered by `(time_ns, sequence_id)`.

```text
initialize state and first events
while queue not empty and clock <= end_time:
    event = pop minimum (time_ns, sequence_id)
    clock = event.time_ns
    apply event state changes
    schedule follow-up events
finalize streaming aggregates
```

Rules:

1. Events at the same virtual time execute in increasing `sequence_id`.
2. `sequence_id` is monotonic and assigned at scheduling time.
3. Simulated work takes zero wall-clock time; only virtual time advances.
4. The engine may run as fast as the host allows, but must not let host timing influence results.
5. Telemetry is emitted while the run proceeds; aggregates must be independent of buffering.

Why lexicographic ordering: it makes tie-breaking explicit and reproducible even when multiple subsystems schedule events for the same nanosecond.

## Event types

The canonical event set is documented in [`SPECS/events.md`](../SPECS/events.md). At a high level:

- Request lifecycle: `request_arrival`, `prefill_begin`, `prefill_end`, `decode_step`, `request_complete`.
- Memory: `page_allocate`, `page_access`, `page_hit`, `page_miss`, `page_evict`, `page_migrate_begin`, `page_migrate_end`, `page_free`.
- Fabric: `transfer_begin`, `transfer_complete`, `link_congested`, `link_degraded`, `link_restored`, `transfer_dropped`.
- Prefetch: `prefetch_issue`, `prefetch_complete`, `prefetch_used`, `prefetch_wasted`.
- Faults: `node_fail`, `node_recover`, `fault_injected`.
- Control: `run_start`, `sampling_tick`, `run_end`, `metric_snapshot`.

## Memory access timing

An access to a page has three possible outcomes:

1. **Local hit:** the page is resident in the local tier. Cost is the local tier read latency plus local bandwidth service time.
2. **Remote hit:** the page is resident in remote memory. Cost is the remote tier access time plus fabric transit (with queueing).
3. **Miss:** the page is not resident anywhere. The policy may migrate, fetch, or fail the access. The cost depends on the chosen action.

For an access of `n` bytes on tier `x`:

```text
service_ns   = n / bandwidth_x
local_cost   = latency_x + service_ns
```

For a transfer of `n` bytes over link `l`:

```text
earliest_start = max(now, link_free_at_l)
start          = earliest_start + queue_delay_l(now)
service_ns     = n / bandwidth_l
complete       = start + latency_l + service_ns
link_free_at_l = start + service_ns
```

`queue_delay_l` is zero when the link has a single FIFO server and no backlog. With a byte-limited in-flight window, the queue delay is modeled as `backlog_bytes / bandwidth_l`. This is a fluid approximation; it ignores packetization and head-of-line blocking at sub-byte scales.

The engine supports two fabric modes:

- **Fluid FIFO (default):** each link is a byte server with a queue and an in-flight limit. Deterministic and fast.
- **Congestion events (optional):** externally scheduled bandwidth degradation or loss events, used for fault experiments. These are explicit events, not stochastic per-packet drops unless a seeded loss stream is enabled.

## Page model

Pages are the unit of placement and accounting:

- `page_size_bytes` is configurable (for example 4 KiB, 64 KiB, or 2 MiB).
- A page has an abstract identifier (trace-provided or generated), an owner context, and a size.
- A page is resident in exactly one tier at a time unless the policy is explicitly replicating.
- Migration creates a transfer event and a state transition; the old copy is invalidated on completion.
- Eviction frees capacity and may write back if the page is dirty.

Capacity accounting is exact per tier. A policy request that would exceed capacity must either evict, fail, or be rejected by the memory model; the engine never silently overcommits.

## Cache model

Optional cache tiers sit between compute and remote memory. A cache tier has:

- Capacity and associativity (fully associative by default).
- Page granularity.
- A replacement policy (LRU baseline).
- A hit latency and a bandwidth.

Cache hits avoid fabric transit. Cache fills consume fabric bandwidth. The policy engine may issue prefetches into the cache; prefetches that are never used are counted as wasted work.

## Workload model

Synthetic workloads are parameterized by model shape and serving behavior:

| Parameter | Meaning |
| :--- | :--- |
| `layers` | number of transformer layers |
| `attention_heads` / `kv_heads` | attention geometry (GQA/MQA supported) |
| `head_dim` | dimension per head |
| `context_tokens` | generated context length |
| `batch_size` | concurrent sequences |
| `dtype_bytes` | bytes per KV element (for example 2 for FP16) |
| `arrival_rate` | requests per second or explicit arrival schedule |
| `phase_mix` | fraction of prefill vs decode work |

KV cache size approximation for one sequence:

```text
kv_bytes_per_token = 2 * layers * kv_heads * head_dim * dtype_bytes
kv_bytes           = kv_bytes_per_token * context_tokens
```

The factor of 2 accounts for key and value tensors. This is the standard dense-attention estimate; the simulator exposes it as a configurable model rather than a hard-coded fact.

Decode generates a sequence of accesses whose working set grows with context. Prefill produces a large, mostly sequential burst. MoE routing activates `top_k` experts per token; the simulator models expert parameter pages as a working set with bursty reuse. See [WORKLOADS.md](WORKLOADS.md).

## Fault model

Faults are explicit and logged:

- **Node failure:** the node's local memory becomes unavailable. Pages that were only local are lost or must be recovered from remote replicas; accesses fail or stall according to policy.
- **Node recovery:** capacity returns after a configured repair time; state may be restored or empty depending on scenario settings.
- **Link degradation:** bandwidth is reduced and latency increased for a configured interval.
- **Packet loss:** modeled as retransmission delay proportional to the configured loss rate, or as dropped transfers in a discrete-loss mode.

Failure timing can be:

- **Explicit:** a list of `(time_ns, target, action)` entries.
- **Stochastic:** exponential or Weibull inter-arrival times drawn from the `faults` stream.

All fault events appear in the telemetry and run manifest.

## Statistics

The telemetry layer computes streaming statistics:

- Counts, sums, min/max.
- Histograms with configurable bucket boundaries for latency.
- Exact percentiles within configured accuracy bounds; exact sorting only when explicitly requested for small runs.
- Time-bucketed series for utilization, occupancy, and throughput.

Reported metrics are defined in [POLICIES.md](POLICIES.md) and summarized in the README.

Warm-up: samples before `warmup_ns` are excluded from steady-state metrics but remain in the event log.

Confidence: stochastic scenarios should be repeated with multiple seeds. The comparison tool reports mean and spread across seeds, not a single run.

## Reproducibility

For each run, the manifest records:

- RmemFab version and schema version.
- Canonical scenario JSON and its SHA-256 hash.
- Seed and per-stream derived seeds.
- Input trace file hashes.
- Policy name and implementation version.
- Start/end virtual time and event count.
- Output artifact paths.

Canonicalization sorts object keys and normalizes numeric formatting before hashing. Two scenarios that differ only in whitespace or key order must produce the same hash.

## Validation plan

The simulator is only useful if its predictions are credible. The validation approach is:

1. **Analytical sanity checks:** compare against closed-form results for simple queues, single-tier LRU, and uniform-access workloads.
2. **Trace replay:** replay captured traces with known behavior and confirm the simulator reproduces measured hit ratios and transfer volumes.
3. **Hardware calibration:** run controlled microbenchmarks on CXL/RDMA hardware, fit latency/bandwidth/queue parameters, and compare simulated versus measured latency distributions.
4. **Error reporting:** publish error bounds per workload class instead of claiming universal accuracy.

Until calibrated, results should be treated as relative comparisons between policies, not absolute predictions.

## Limitations

- No cycle-accurate CPU/GPU modeling.
- No packet-level network simulation.
- No kernel or allocator internals; traces approximate them.
- Fluid queueing ignores per-packet head-of-line effects.
- Page replacement is analytical; hardware prefetchers and TLB effects are abstracted.
- Thermal throttling, ECC, and physical topology details are out of scope unless explicitly modeled.

These limitations are intentional. They keep runs fast and results explainable, and they are documented so users can judge when a more detailed model is needed.
