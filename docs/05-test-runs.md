# Test-Run Catalog — every family, what it proves, how to reproduce it

`./runs` is gitignored, so nothing here depends on committed bundles. Every
family below reproduces with the command shown (deterministic: same scenario
+ seed ⇒ byte-identical summary). Fair-compare pairs are called out; the
guard refuses everything else and names the first differing field.

Conventions: `run` = `PYTHONPATH=src .venv/bin/python -m rmemfab run`
(or the installed `rmemfab` entry point). All seeds are the scenario
defaults unless `--seed` is shown.

## 1. Duel — three policies, one fabric (`duel-*`)

The demo spine. Stock scenario, three policies, same seed 7.

```bash
rmemfab run examples/eight-node-rdma-pool.json --policy local_only --out runs/duel-local-only
rmemfab run examples/eight-node-rdma-pool.json --policy swap_remote --out runs/duel-swap
rmemfab run examples/eight-node-rdma-pool.json --policy hot_cold --out runs/duel-hot-cold
rmemfab compare runs/duel-swap runs/duel-hot-cold   # fair
```

Measured: swap and hot_cold tie byte-identical on this workload
(p50 7.16 µs, p99 89.6 µs, 194,278 accesses, 58.0/42.0 local/remote
split). `local_only` serves zero accesses — the working set does not
fit local DRAM, so the dashboard renders its time metrics as "—"
instead of a lying "0 ns". The tie is the honest setup for the
what-if: on identical hardware the policies are indistinguishable,
which is exactly why Maya constrains the fabric next.

## 2. Contention what-if — 50 Gbps clone (`maya-contention-*`)

Same 8-node pool, every link 200 → 50 Gbps (`bandwidth_bytes_per_ns`
25 → 6.25). Committed as `examples/maya-contention-50gbps.json`
(repro verified: scenario_hash + p50/p99/count identical).

```bash
rmemfab run examples/maya-contention-50gbps.json --policy swap_remote --out runs/maya-contention-swap
rmemfab run examples/maya-contention-50gbps.json --policy predictive_prefetch --out runs/maya-contention-prefetch
rmemfab run examples/maya-contention-50gbps-aggr.json --out runs/maya-contention-aggr
rmemfab compare runs/maya-contention-swap runs/maya-contention-prefetch   # fair
```

Measured: p99 89.6 → 343.3 µs (3.8× tail blowup from bandwidth
alone). Gentle prefetch (127 issued, 89% accuracy) vs swap: no tail
split — reported as-is. Aggressive prefetch (degree 4, 41% accuracy,
212 MB wasted) also holds p99 flat here; the damage shows under
pressure (family 4). Cross-fabric compare (`duel-swap` vs
`maya-contention-swap`) is correctly refused — the demo's guard beat.

## 3. Prefetch fixture — stock hypothesis test (`maya-prefetch-*`)

The stock `examples/policy-prefetch-failure.json` asks: does aggressive
prefetching help the mean and hurt the tail? Run exactly as filed:

```bash
rmemfab run examples/policy-prefetch-failure.json --out runs/maya-prefetch-aggr
rmemfab run examples/policy-prefetch-failure.json --policy hot_cold --out runs/maya-prefetch-simple
rmemfab compare runs/maya-prefetch-aggr runs/maya-prefetch-simple   # fair
```

Measured: hypothesis does NOT materialize on this workload —
p50/p95/p99 identical at 44.2 µs, 76 prefetches at 47% accuracy.
Kept in the catalog as a negative result: the engine reports what
happens, and we report what the engine says.

## 4. Stressed crossover — pressure + prefetch (`maya-stressed-*`)

50 Gbps links with 4× request pressure (concurrency 8 → 32, arrival
4 → 16/s). Committed as `examples/maya-stressed.json`.

```bash
rmemfab run examples/maya-stressed.json --policy swap_remote --out runs/maya-stressed-swap
rmemfab run examples/maya-stressed-aggr.json --out runs/maya-stressed-aggr
rmemfab compare runs/maya-stressed-swap runs/maya-stressed-aggr   # fair
```

(The aggressive twin is `examples/maya-stressed.json` with `policy`
set to `{name: predictive_prefetch, params: {degree: 4, stride: 1,
max_in_flight: 256}}` — the same patch the assistant proposes on the
"What should I test next?" prompt.)

Measured: prefetch improves local-hit 34.0 → 35.9% but its 352
prefetches at 27% accuracy dump 537 MB of mostly-wasted traffic onto
the stressed fabric — mean latency +8.4% (16.65 → 18.04 ms), total
stall +3.3%. p99 is quantized flat at 343.3 µs on both: the effect
lives in the mean and stall, and that is what we claim. This is the
"no free lunch" beat: better locality, worse congestion.

## 5. Trace replay — measured data (`phase2-replay-opt`)

Real vLLM block-table trace (`examples/traces/20261029T202303Z-opt-125m`),
three policies, same seed. Provenance: measured.

```bash
rmemfab run examples/phase2-replay-opt.json --policy swap_remote --out runs/replay-swap
rmemfab run examples/phase2-replay-opt.json --policy hot_cold --out runs/replay-hot
rmemfab run examples/phase2-replay-opt.json --policy frequency_aware --out runs/replay-freq
```

Measured (Test 3 log): p50 1.69M → 1.33M → 0.74M ns across
swap → hot_cold → frequency_aware; local-hit 0.007 → 0.098 → 0.288;
migration 4.90 → 4.30 GB. Three policies rank monotonically on a
measured trace — the flagship fair-compare.

## 6. Fault drill (`phase5-fault-recovery`)

Node failure + halved link + 2% packet loss, then recovery.

```bash
rmemfab run examples/phase5-fault-recovery.json --out runs/fault
```

Measured: 2 degraded windows, 4 requests stalled, 4 lost / 4 retried,
9.67 GB retransmitted; rerun bit-for-bit identical. Never claim
drain-to-complete (0 in-window completions — the window is short by
design).

## 7. Serving telemetry (`phase7-compute-serving`)

Compute-aware engine: TTFT/TPOT/ITL + prefill/decode service time.

```bash
rmemfab run examples/phase7-compute-serving.json --policy swap_remote --out runs/serving-swap
rmemfab run examples/phase7-compute-serving.json --policy hot_cold --out runs/serving-hot
```

Populates the dashboard Serving view (TTFT timelines, request
pacing). Memory-only bundles predate the serving section and say so
honestly instead of showing zeros.

## 8. Cost knee (`test5-pool-*`), guard baseline (`test7`), overflow (`phase1`)

- `test5-pool-{1,8,64}gib`: pool-capacity sweep sketching the cost
  knee (Test 5 log). Capacity-constrained scenarios generated during
  the test drive; parameters in `docs/03-test-drive.md`.
- `test7-clean-baseline`: the no-fault control the fault drill is
  compared against (same seed, faults removed).
- `phase1-overflow`: deliberately undersized local tier; proves the
  remote path engages. `examples/phase1-overflow.json`, seed 7.

## 9. NL-drafted runs (`llm-kv-cache-growth-*`)

Scenarios drafted from plain English in the Scenario Builder ("1 node
with 64 GB local DRAM and a 256 GB shared remote pool…"), reviewed in
the JSON editor, submitted from the dashboard. Seeds 42, policy
predictive_prefetch. The scenario JSON rides in each bundle, so every
drafted run stays reproducible and auditable.

## Fair-compare quick reference

| Pair | Verdict | Why |
| ---- | ------- | --- |
| duel-swap ↔ duel-hot-cold | fair | same scenario + seed, policy differs |
| contention-swap ↔ contention-prefetch | fair | same 50 Gbps scenario + seed |
| stressed-swap ↔ stressed-aggr | fair | same stressed scenario + seed |
| replay swap ↔ hot ↔ freq | fair | same trace + seed |
| duel-swap ↔ contention-swap | **refused** | fabric differs (200 vs 50 Gbps) |
| any cross-seed / cross-scenario pair | **refused** | guard names first difference |
