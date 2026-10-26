# Hardware models

RmemFab uses parameterized timing models, not hardware emulation. Every number below is a starting preset that must be replaced with measured values for a specific system before drawing absolute conclusions.

## Parameters per memory tier

| Parameter | Symbol | Meaning |
| :--- | :--- | :--- |
| Capacity | `C` | Usable bytes in the tier |
| Latency | `L` | One-way access latency in nanoseconds |
| Bandwidth | `B` | Sustained bytes per nanosecond |
| Page size | `S` | Granularity for placement and accounting |
| Read/write asymmetry | `rw` | Optional multipliers for reads vs writes |
| Occupancy cost | `c_occ` | Cost per byte-second, for the cost model |
| Transfer cost | `c_xfer` | Cost per byte moved |

A simple access of `n` bytes on a tier takes `L + n/B`. Real hardware has more structure; the model exposes only the first-order effects.

## Parameters per fabric link

| Parameter | Symbol | Meaning |
| :--- | :--- | :--- |
| Latency | `L_l` | One-way transit latency in nanoseconds |
| Bandwidth | `B_l` | Bytes per nanosecond |
| In-flight limit | `Q_l` | Maximum unacknowledged bytes |
| Queue depth | `D_l` | Maximum queued bytes before backpressure |
| Reliability | `loss` | Optional packet/transfer loss rate |

Transfer completion for `n` bytes:

```text
start          = max(now, link_free_at) + backlog / B_l
service        = n / B_l
complete       = start + L_l + service
link_free_at   = start + service
```

This is a fluid FIFO approximation. It captures bandwidth saturation and queuing delay, but not per-packet head-of-line blocking.

## Presets

The presets are intentionally broad ranges. They are useful for sensitivity analysis, not procurement decisions.

### Local DRAM

| Property | Typical range |
| :--- | :--- |
| Latency | 80–100 ns |
| Bandwidth | 200–800 GB/s per socket |
| Capacity | 256 GiB–2 TiB per node |
| NUMA | Modeled as multiple local tiers or links |

DDR5 and HBM-based systems differ substantially. Use the measured latency and bandwidth of the target platform.

### CXL-attached memory

| Property | Typical range |
| :--- | :--- |
| Latency | ~170–250 ns (local DRAM plus CXL hop) |
| Bandwidth | 32–64 GB/s per port (CXL.mem) |
| Capacity | Hundreds of GiB to multiple TiB per pool |
| Topology | Direct-attached or switched CXL fabric |
| Protocol | CXL 2.0/3.0 memory semantics |

CXL adds a protocol hop and, in switched configurations, additional fabric latency. Contention on a shared port can dominate when multiple hosts access the same pool.

### RDMA remote memory

| Property | Typical range |
| :--- | :--- |
| Latency | ~1.5–3 µs |
| Bandwidth | 100–400 Gbps per port |
| Capacity | Node memory exposed over the fabric |
| Protocol | RoCEv2 or InfiniBand |
| Topology | Leaf-spine or direct links |

RDMA is attractive for capacity and cold data, less so for hot pages because of the microsecond-scale latency. It is also sensitive to congestion and to the number of outstanding requests.

### Local NVMe swap

| Property | Typical range |
| :--- | :--- |
| Latency | ~10–100 µs |
| Bandwidth | Device-dependent |
| Use | Baseline only |

NVMe is included as a comparison baseline, not as a target tier for hot AI working sets.

## Model equations

### Effective access latency

For a hit in tier `t`:

```text
latency_hit = L_t + n / B_t
```

For a remote fetch over link `l` to tier `t`:

```text
latency_fetch = queue_delay(l) + L_l + n / B_l + L_t + n / B_t
```

For a migration, add write-back and invalidation costs if the source page is dirty.

### Utilization and queueing

For a link with capacity `B_l` and offered load `lambda * n` bytes per nanosecond:

```text
utilization = offered_load / B_l
```

At `utilization >= 1`, the fluid queue grows without bound until backpressure or the in-flight limit applies. The simulator reports sustained saturation as a bottleneck rather than pretending the transfer completes instantly.

### Capacity pressure

For tier `t` with occupancy `O_t` and capacity `C_t`:

```text
pressure = O_t / C_t
```

Policies receive pressure events at configured watermarks (for example 80%, 90%, 95%). Watermarks are scenario parameters so users can study how early action changes outcomes.

### Cost model

Optional, for comparing designs:

```text
cost = sum_t(c_occ_t * byte_seconds_t) + sum_l(c_xfer_l * bytes_l)
```

Cost coefficients are user-supplied. The simulator does not assume cloud pricing.

## Calibration checklist

Before trusting absolute numbers:

1. **Measure local memory:** latency and bandwidth for the target socket, including NUMA effects.
2. **Measure CXL:** load and store latency at several concurrency levels; bandwidth per port; behavior under contention.
3. **Measure RDMA:** round-trip latency, message-size scaling, bandwidth at different queue depths, congestion behavior.
4. **Measure the workload:** capture real KV-cache and expert-access traces; do not rely only on synthetic generators.
5. **Fit the model:** choose latency/bandwidth/queue parameters that reproduce the measured curves.
6. **Validate:** compare simulated and measured distributions on a held-out trace; report error.
7. **Record the fit:** store the parameters and calibration trace hashes with the scenario.

## Sources of error

- Real interconnects have protocol overhead that a single latency number cannot capture.
- Concurrency changes effective latency dramatically; a single-hop number is not enough.
- CXL and RDMA contention depend on topology and other tenants.
- GPU memory hierarchies (HBM, L2, on-chip SRAM) are abstracted unless explicitly modeled.
- Software overhead (allocator, page faults, copy engines) is not included by default.

RmemFab is designed to make these assumptions visible, not to hide them. Every parameter is in the scenario file, and every result should be reported with the scenario hash and version.
