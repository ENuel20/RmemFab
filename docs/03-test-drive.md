# RmemFab Test-Drive Log — from tests to pitch lines

One test per capability (maps to `docs/02-capabilities-and-engineers.md`).
Each entry: what we did, what the dashboard showed, the insight, the tweak,
and the one-line pitch version. Fill as we go; nothing here is written
before its test passes.

## Test 0 — Stack + Baseten live
- Status: done
- Backend `serve` on :8000, dashboard `dev` on :5173, header connected
- Baseten direct call OK: `meta-models/muse-spark-open-1026`, usage accounting live
- Insight: the free `ser` typo aside, the stack boots in two commands
- Pitch line: — (setup, not pitched)

## Test 1 — Determinism (capability §1)
- Status: done
- Commands: `rmemfab run examples/phase1-overflow.json` twice → `diff` clean,
  sha256 `5b6ce4d94d1714c7` both; `POST /runs` twice → same run_id
  `852d62a4a96d-s7-swap_remote` (idempotent dedup, no duplicate)
- Dashboard: Runs view → one run; id reads `<scenario-hash>-s<seed>-<policy>`;
  detail shows summary + manifest (seed, hashes, assumptions) + stream replay
- Insight: same scenario + seed ⇒ byte-identical results; resubmits dedup
- Tweak: change seed or one field → new run_id, visibly distinct run
- Pitch line: "Every experiment is reproducible by construction — same
  scenario plus seed gives byte-identical results, every time."

## Test 2 — N-tier placement (capability §2)
- Status: done
- Commands: `POST /runs` with `examples/ntier-spine-leaf.json` → run
  `486325b7a687-s7-swap_remote` (2 compute, 2 pools, leaf+spine, 5 links)
- Dashboard: Runs → new run; Infrastructure view → topology + per-link
  bytes + per-switch stats; manifest → recorded shortest-path routes
- Insight: all spill went to pool-b (2 hops) while pool-a (3 hops) and
  spine-0 sat idle — nearest-with-space placement, visible per-link:
  leaf-0 served 255 GB at 47.6%, spine-0 exactly 0
- Tweak: shrink pool-b capacity → spillover crosses the spine to pool-a;
  watch spine-0 go from 0 to busy (topology what-if)
- Pitch line: "Every byte is routed and counted hop by hop — data spilled
  to the nearer pool and the spine sat idle, exactly as the topology says."

## Test 3 — Policy comparison (capability §3)
- Status: done
- Commands: `rmemfab run examples/phase2-replay-opt.json --policy
  swap_remote --out runs/a7dc887fa948-6b24f887-s7-swap_remote` and same
  with `--policy hot_cold --out runs/4c62fd7d5f99-6b24f887-s7-hot_cold`
  (measured OPT-125M trace, seed 7); `rmemfab compare` on both → fair
- Dashboard: Runs → two new `phase2-replay-opt` runs; Policy Comparison
  → select both → fair table (hot_cold wins every latency + byte
  column); select the Test-1 run as partner → refusal banner naming
  the first differing field
- Insight: hot_cold beats swap_remote cleanly on the measured trace —
  p50 1.33M vs 1.69M ns (~21% lower), p95 2.92M vs 3.16M, local-hit
  0.098 vs 0.007, migration 4.30 vs 4.90 GB: less data moved AND
  faster, no tradeoff. Single seed ⇒ directional, no CI (engine says
  so). Refusal verified: vs Test-1 run → `refused: scenarios differ
  at assumptions (list len 1 vs 4)`, exit 2
- Tweak: add `--policy frequency_aware` same scenario+seed → third
  column; or rerun with `--seed 8` and watch compare refuse cross-seed
  ("pass --multi-seed")
- Pitch line: "Same measured trace, same seed, only the policy
  differs — hot/cold kept 10x more accesses local and moved 600 MB
  less. And when the setup isn't identical, RmemFab refuses to
  compare instead of lying."

## Test 4 — Trace replay (capability §4)
- Status: done
- Commands: `rmemfab trace-validate` on all three in-repo traces
  (OPT OK 4540 ops; Baseten OK 22116 ops/72 reqs; Glimmer refused,
  `ts_ns must be an integer >= 0` rows 2–25 + 1847 more, exit 1);
  `rmemfab run examples/phase2-replay-baseten.json --out
  runs/32e95e402165-061a9f7e-s7-swap_remote`
- Dashboard: Runs → new `phase2-replay-baseten` run; detail manifest
  → `trace_hashes: [061a9f7e…]` pinned to the file SHA, workload
  `trace`, corrected assumptions; Trace Library → provenance badges
  (measured emerald / derived amber) on uploaded-trace profiles
- Insight: derived ≠ second-class: the 72-request Muse batch-sweep
  replay ran clean (p50 5.4µs, local-hit 0.83, pool peak 663 pages =
  1687 live − 1024 local, exactly as the assumption predicts).
  Contrast with Test 3's OPT run (99% remote): working-set vs local
  size decides the split, visibly. Fixed one stale line in the
  example (assumption said "OPT block-table trace" on the Baseten
  scenario — provenance-mixing in writing; now correctly labeled
  derived). OPT's measured-ness lives in source/manifest/docs, not an
  explicit header label — noted, files untouched (SHA-pinned)
- Tweak: `trace-validate --time-scale 0.5` a copy to squeeze arrivals
  and watch p95 climb; or upload any JSONL via Trace Library and
  watch invalid rows rejected with row numbers
- Pitch line: "Real serving behavior in, honest verdicts out — the
  Meta model's own batch-sweep distribution replays cleanly, and a
  malformed flagship trace is refused with row numbers, not
  silently fixed."

## Test 5 — Synthetic workload + cost (capability §5)
- Status: pending
- Commands: —
- Dashboard: —
- Insight: —
- Tweak: —
- Pitch line: —

## Test 6 — Assistant loop (capability §6)
- Status: pending
- Commands: —
- Dashboard: —
- Insight: —
- Tweak: —
- Pitch line: —

## Detour — Overview honesty fixes (between Test 1 and 2)
- A pasted "demo data" analysis was debunked: numbers were live (mock has
  no 44205; 2 runs = 2 real bundles). But it exposed real bugs, fixed:
- `DEMO DATASET ACTIVE` badge was hardcoded; now mode-conditional
  (`LIVE BACKEND DATA` vs demo). Compare shortcuts + default selection no
  longer hardcode mock run IDs. List strip widened with hit ratios +
  fabric utilization so Overview KPIs populate live.
- Still honestly absent: per-window latency percentiles (engine series
  doesn't record them; the UI fallback says so).
- Pitch line: "The dashboard labels its own data source — live numbers
  say live, demo numbers say demo."

## Detour 2 — RunDetail/Infra/Compare enrichment (between Test 2 and 3)
- Symptom: occupancy chart, bandwidth chart, what-if links, infrastructure
  topology, and compare guard all empty/"unavailable" on live runs.
- Cause: live list rows are thin strips (no scenario snapshot, no series)
  and only Overview fetched detail. Backend already served everything.
- Fix: RunDetailInspector, InfrastructureView, and PolicyComparisonView
  now detail-enrich on demand in live mode (mock untouched); adapter
  derives per-window fabric bandwidth honestly from recorded link bytes
  over measured window dt (new test 7; 51/51 green).
- Stays honestly empty: per-window latency percentiles (engine never
  records them; fallback says so).
- Pitch line: "List views stay fast and thin; every deep view loads the
  full measured record on demand — nothing shown is ever filled in."

## Test 7 — Fault drill (capability §7)
- Status: pending
- Commands: —
- Dashboard: —
- Insight: —
- Tweak: —
- Pitch line: —
