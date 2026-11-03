# Submission Pack — copy-paste for the hackathon portal

> Update the bracketed fields before submitting. Everything else is final.

## One-liner

RmemFab turns "which memory policy serves my LLM workload best?" into a
reproducible experiment: describe it in English, run it deterministically,
compare policies fairly, and let grounded AI explain the result.

## What it does (for judges who skim)

- **Simulates** disaggregated memory fabrics (CXL/RDMA pools, links,
  switches, faults) running LLM KV-cache workloads — deterministic,
  seeded, byte-identical reruns.
- **Compares** placement policies (local-only, swap, hot/cold,
  frequency-aware, predictive prefetch) under identical conditions,
  with a guard that **refuses** unfair comparisons and names the
  differing field.
- **Explains** results with Meta Muse AI over Baseten: NL scenario
  drafting, telemetry-grounded Q&A, and validated what-if patches —
  the AI proposes, the server validates, nothing runs until you apply.
- **Labels provenance** on every number: measured / derived /
  synthetic / assumed are never mixed, so AI text can't launder a
  guess into a fact.

## 5-minute judge run (no key needed)

```bash
git clone https://github.com/ENuel20/RmemFab.git && cd RmemFab
python3 -m venv .venv && source .venv/bin/activate
pip install -e '.[api]'
rmemfab run examples/eight-node-rdma-pool.json --policy swap_remote --out runs/judge-swap
rmemfab run examples/eight-node-rdma-pool.json --policy hot_cold --out runs/judge-hot
rmemfab compare runs/judge-swap runs/judge-hot
make dev   # dashboard + API on http://127.0.0.1:8000
```

Then: Policy Comparison → select both runs → fair benchmark. Try
`judge-swap` vs `examples/maya-stressed.json` output and watch the
guard refuse (different fabric). Full catalog with measured numbers:
`docs/05-test-runs.md`. The AI beats need a Baseten key in `.env`
(3 copy-paste prompts in README).

## Why it can win

1. **Real result, not a dashboard of mocks:** 50 Gbps vs 200 Gbps
   quadruples p99 (89.6 → 343.3 µs); aggressive prefetch under
   pressure improves locality but worsens mean latency +8.4% —
   measured, reproducible, with an honest negative result kept in the
   catalog.
2. **The AI has a job, not a chatbot:** drafts validated scenarios,
   answers only from telemetry with exact numbers, refuses false
   premises, and emits server-validated experiment patches.
3. **Science discipline as a feature:** deterministic reruns,
   versioned scenarios, audited rollbacks, provenance labels, and a
   comparison guard that would rather refuse than lie.
4. **Partner-native:** Meta Muse Spark served on Baseten, with
   documented grounding + reliability contracts (README partner
   section, test-drive Detours 4–7).

## Honesty bounds (we claim only this)

- Latencies are placement evidence, not hardware predictions.
- Single seed = directional; no confidence intervals claimed.
- Cost figures are illustrative units, never dollars.
- Measured / derived / synthetic provenance never mixed.

## Links

- Repo: https://github.com/ENuel20/RmemFab
- Live demo: [MODAL_URL — paste after `modal deploy deploy/modal_app.py`]
- Demo video: [LINK, <3 min per docs/04-demo-script.md]
- Run catalog: docs/05-test-runs.md · Test log: docs/03-test-drive.md
