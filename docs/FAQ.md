# FAQ

## Is RmemFab a hardware emulator?

No. It is an analytical discrete-event simulator. It models memory access timing, capacity, fabric latency/bandwidth, caching, migration, prefetching, and faults. It does not execute GPU kernels, emulate a CPU, or reproduce hardware cycle by cycle.

## Does it replace real profiling or benchmarks?

No. It complements them. Use real profiling to capture traces and calibrate the model; use RmemFab to explore policies and conditions that are too expensive or slow to test on hardware.

## Why simulate instead of benchmarking a real cluster?

- Physical CXL/RDMA setups are expensive and often shared.
- Instrumenting them reproducibly is difficult.
- Policy sweeps across latency, bandwidth, capacity, and failure conditions would take weeks on hardware.
- Simulation makes assumptions explicit and results reproducible.

The trade-off is fidelity. RmemFab is useful for relative comparisons first; absolute predictions require calibration.

## How accurate is it?

Accuracy depends on the scenario and calibration. The plan is to:

1. Validate against closed-form queueing and cache results.
2. Replay measured traces and compare hit ratios and traffic.
3. Calibrate latency/bandwidth against microbenchmarks.
4. Publish error bounds per workload class.

Until a scenario is calibrated, treat results as directional.

## What hardware does it model?

Local DRAM, CXL-attached memory, RDMA remote memory, and optional cache tiers and local NVMe swap. All parameters are configurable; the presets are starting points, not claims about specific products.

## Does it need Meta models or partner APIs?

No. The core simulator and dashboard run offline and deterministically. The AI co-pilot is an optional layer and is model-agnostic. Planned integrations use Meta open-weight models through partner inference endpoints, and GPU profiling can run on serverless infrastructure, but none of that is required to use the simulator.

## What does "deterministic" mean here?

Given the same RmemFab version, scenario, seed, and trace, a run produces the same event sequence and metrics. Randomness is partitioned into independent streams, event ties are ordered by insertion sequence, and the engine does not depend on wall-clock time or thread scheduling.

## Can I compare policies fairly?

Yes, that is the core workflow. A comparison holds the scenario, seed, trace, warm-up window, and metric definitions constant, changing only the policy. Stochastic scenarios should be repeated across multiple seeds; the tool reports spread and confidence intervals.

## What is modeled for MoE?

Expert parameter pages form a large working set. Each token activates `top_k` of `N` experts, with a configurable popularity distribution. The simulator studies whether hot experts can stay local and whether prefetching bursty expert loads helps or hurts.

## What is modeled for KV cache?

Per-request KV growth across layers, with configurable attention geometry (including GQA/MQA), dtype, batch size, and context length. The simulator tracks page allocation, reuse, eviction, and remote placement. The KV size formula is exposed so scenarios can be sanity-checked.

## Can it model multiple tenants or requests?

Yes. The mixed-serving workload combines request classes with different context lengths, priorities, and arrival processes. Interference is a first-class concern for policy evaluation.

## Does it support closed-loop workloads?

The planned model supports open-loop arrivals (fixed schedule) and closed-loop behavior where request timing depends on simulated completion. Open-loop is the default because it is easier to compare policies; closed-loop is useful when throughput feedback matters.

## What are the biggest sources of error?

- Approximating real interconnects with first-order latency/bandwidth/queue parameters.
- Synthetic workloads that do not match production access patterns.
- Fluid queueing that ignores per-packet effects.
- Software overhead (allocator, page faults, copy engines) not modeled by default.
- GPU-specific behavior that is abstracted away.

Every parameter lives in the scenario file, and results should be reported with the scenario hash and version.

## Is my trace data safe?

Do not commit production traces or user data. Strip prompts and identifiers, keep only memory behavior, and store model configuration rather than weights. The simulator does not need prompts or outputs.

## Can I add a policy or workload?

Yes. Policies and workload sources are extension points. Add a parameter model, register the name, write tests against a small trace, and document expected behavior. See [POLICIES.md](POLICIES.md) and [WORKLOADS.md](WORKLOADS.md).

## What is the license?

MIT. See [LICENSE](../LICENSE).

## Where does the name come from?

"Rmem" for remote memory; "Fab" for fabric. RmemFab is a fabric-level remote-memory simulator.
