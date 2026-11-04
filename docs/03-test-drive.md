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
- Status: done
- Commands: 3 variants of `examples/eight-node-rdma-pool.json`
  (kv_cache_decode, GQA-32L, seed 7) with pool 1/8/64 GiB +
  illustrative `cost_model` (unit currency) → `/tmp/test5_cap*.json`
  → `runs/dc713d4f278a-…`, `runs/4ecc41fbdb31-…`,
  `runs/92263171338d-…` (8 nodes × 0.38 GiB local, 25 arrivals each)
- Dashboard: Runs → three `test5-pool-*` rows; detail → requests
  rejected 9/1/0, pool peak pages 484/3881/4138, summary `cost`
  block (capacity/transfer/migration/total). Guard correctly refuses
  cross-capacity compares (`nodes.8.remote_memory.capacity_bytes
  (1073741824 vs 8589934592)`, exit 2) — read summaries directly
- Insight: the knee is in admission, not p50 (identical 7156 ns all
  three): 1 GiB rejects 9/25 ("remote pool exhausted"), 8 GiB
  rejects 1, 64 GiB zero — but 8→64 buys nothing else while
  migration explodes 2.4→139 GB once the pool can absorb churn, and
  cost total doubles 23.4→51.2 units on the migration term. Cost
  prices used GiB·seconds + measured bytes, parametric/illustrative
  (limitation 20 — never dollars). Warning recorded: no
  fabric.switch ⇒ unbounded bisection assumed
- Tweak: raise `arrival_rate_per_second` to push the reject cliff
  right; or raise `migration_per_gib` and watch the model flip the
  recommendation against big pools
- Pitch line: "Eight gibibytes ends the rejection cliff — sixty-four
  buys nothing but a migration bill. The cost model prices the churn
  your capacity plan would otherwise hide."

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
- Status: done
- Commands: `rmemfab run examples/phase5-fault-recovery.json --out
  runs/043424bff09d-s7-swap_remote` + repeat to /tmp → all 4 files
  byte-identical; clean baseline (faults zeroed, `/tmp/test7_clean.json`)
  → `runs/0f6c854d47ec-s7-swap_remote`
- Dashboard: Runs → `phase5-fault-recovery` detail → degraded panel
  (2 windows · 4 stalled · 4 lost/4 retried, 9.67 GB, RTO 3600 ns);
  series flag strip 0→1→2→1→0; events `link_degraded/restored`,
  `node_fail/recover`, `transfer_lost` ×4, `request_stalled` ×4
  (adapter path verified — no fix needed)
- Insight: drill is survival + telemetry, honestly: node 4–5s +
  link 3–6s (½ bw, 2× lat) + 2% loss ⇒ 4 parked (0 rejected),
  4 retransmitted, access mean +5.5% vs clean, 13% fewer accesses
  in-window. 0 completions in BOTH runs = 10 s window too short for
  this workload, not a fault effect — present park-not-reject, never
  drain-to-complete. Deterministic faults: rerun diff clean
- Tweak: stretch `duration_ns` 2× and watch parked requests drain to
  completed; or raise loss ppm and watch retx bytes climb linearly
- Pitch line: "Kill a node, halve a link, lose 2% of packets — four
  requests park, zero die, every byte retransmitted, and the rerun
  is bit-for-bit identical."

## Detour 3 — Per-window latency + tail strips adopted (after Test 7)
- Branch-lane agent's feature arrived in main's tree mid-drive at user
  order (engine `win_read` histogram per series row; strip +p99/mean/
  max; dashboard mappings + validators; `TestWindowLatency` ×4).
  Triaged green: backend 204/204, dashboard 60/60, tsc/eslint clean.
- Determinism intact: fresh double-run byte-identical on all 4 files;
  `summary.json` still sha256 `5b6ce4d94d1714c7` (Test 1 claim stands,
  no re-baseline). Only NEW `series.jsonl` rows gain `latency_ns`;
  old bundles validate unchanged. Empty windows map to gaps, never
  zero lines; count-0 carries no fake values.
- Dashboard: history gains a p95 column; p99 lights up from the strip;
  the "honestly absent" per-window percentile notes in Detours 1–2 now
  apply to old bundles only.
- Pitch line: "The gap the log called honestly absent is now honestly
  filled — recorded windows, gaps where idle, old runs untouched."

## Merge — serving into main (user-ordered all-on-main)
- Branch `exp/serving-model` merged as `121dc08` + sha-stability fix
  `e169036` (serving section gated on compute config; memory-only
  summaries byte-identical). Triaged on merged tip: backend 208/208,
  dashboard 61/61, tsc/eslint clean. Test 1 summary sha
  `5b6ce4d94d1714c7` re-confirmed stable.
- Refreshed 7 synthetic demo bundles with the merged engine (same
  run_ids, byte-identical summaries, recorded windows now present).
  Replay runs intentionally untouched (replay engine records no
  windows — honest fallback remains). Serving runs
  `16b2b1fa46bd`/`f36daf2ebfcb` seeded by branch lane (dirs renamed
  to match inner run_ids after a reseed left stale names); full
  serving section (ttft/tpot/itl/compute) verified via API.
- Pitch line: "One main, one dashboard — memory science and serving
  telemetry side by side, every old number intact."

## Detour 4 — assistant always proposes (retry-on-empty + permit reframe)
- Symptom: "Propose one policy change ... emit a patch block" on the
  eight-node duel returned an empty bubble — provider returned zero
  content bytes though the constructed request was valid (14KB prompt,
  scenario attached). Same failure shape as an earlier silent drop.
- Root cause: `chat_stream` capped output at `max_tokens=2000` while
  the non-streaming `chat()` used 8000. Muse Spark is a reasoning
  model: on the heavy suggest prompt (telemetry + suffix + full
  scenario JSON) it spent the whole 2000-token budget on hidden
  reasoning and emitted zero content tokens. Short Q&A prompts fit,
  which is why only propose-patch went blank. The codebase already
  knew this failure shape (`providers.py` names it for `chat()`).
- Fix (server-side, dashboard untouched): stream budget raised to
  8000 to match `chat()`; `/assistant/chat` non-streaming retries
  one empty completion immediately and returns an explicit 502 with
  chunk/finish-reason diagnostics if the retry is also empty — blank
  bubbles are now impossible. Suggest
  suffix reframed from blanket caution to permit-to-propose: it names
  the real scenario paths to verify against (/policy/name,
  /policy/params, /seed), states that a directional suggestion the
  user will run and compare is itself the safe action (server
  revalidates before anything runs), and reserves refusal for false
  premises (a policy the run did not use).
- Added 3 contract tests: retry-once recovery, persistent-empty 502,
  suffix names /policy/name. Full gates re-run (backend + dashboard
  + tsc/eslint).
- Tweak: if the duel's tied policies make a proposal feel arbitrary,
  say which direction to test (e.g. "raise the hot/cold threshold")
  — the patch pins /policy/params instead.
- Pitch line: "The assistant always leaves you with a next experiment
  — and the server checks the patch before anything runs."

## Maya rehearsal — contention what-if + prefetch crossover (all measured)
- Base `duel-swap` @200 Gbps: p50 7.2us, p99 89.6us. Constrained
  clone @50 Gbps (`maya-contention-swap`): p99 343.3us — 3.8x tail
  blowup from bandwidth alone; guard correctly refused cross-fabric
  compare until workload/hardware held fixed (description-mismatch
  refusal quoted verbatim in session).
- Stressed pair (50 Gbps, 4x pressure): aggressive prefetch
  (degree 4, 352 issued, 27% accuracy, 537MB wasted) vs swap —
  local-hit +2pp but mean latency +8.4% (16.65ms -> 18.04ms) and
  stall +3.3%. Fixture hypothesis inverted honestly: prefetch helps
  locality, hurts the mean under contention; p99 quantized flat at
  343.3us on both. Gentle prefetch (127 issued, 89% accuracy) and
  the stock `policy-prefetch-failure` pair showed no tail split —
  reported as-is, not forced.
- Act 6 verified: `rmemfab export <bundle> --out <dir> --format csv`
  writes summary.csv + series.csv; scenario.json rides in the bundle.
- Pitch line: "Cut the fabric to 50 gigabits and the tail quadruples;
  turn prefetch aggressive and the mean gets 8% worse — the dashboard
  shows you which knob did it."

## Detour 5 — NL draft failed silently, then opaquely (fixed both ends)
- User's Maya prompt failed with bare "draft failed validation":
  dashboard formatter returned the headline and discarded the
  server's per-field errors. Fixed `apiErrorMessage` to append up to
  5 field errors (+N more); moved it to leaf `apiErrors.ts` so the
  node test runner can import it (api.ts has bare imports); 3 new
  dashboard tests, 81/81 green, tsc/eslint clean.
- Revealed cause: model invented 8 `metrics.*` fields (p99 knobs,
  contention, utilization) from "show me p99" — but the schema
  allows only percentiles/sample_interval_ns/warmup_ns, and the old
  SYSTEM prompt named `metrics{}` without defining it. Fixed prompt
  to name allowed fields + "things the user wants to SEE are outputs,
  never config". Endpoint now repairs once: validation errors go
  back to the model with a fix-only-these instruction before any
  422. 2 new backend tests (scripted invalid->valid, prompt pins
  fields); assistant suite 26/26.
- Pitch line: "The AI drafts the experiment, the validator checks it,
  and when the first draft is wrong it fixes itself before you see
  an error."

## Detour 6 — dashboard rejected switch link endpoints the server accepts
- Maya draft (64GB local / 256GB remote, predictive_prefetch, p50/95/99
  percentiles) passed server validation but the builder flagged both
  links: client check 2A tested endpoints against node ids only,
  while the server allows `node_ids | switches` (legacy single
  switch implicitly `switch-0`). Fixed `validation.ts` to mirror the
  server set; regression test 7 covers named + legacy forms.
- Dashboard 82/82, tsc/eslint clean.
- Pitch line: "The validator argued with itself — now both sides read
  the same rulebook."

## Detour 7 — draft hit "reasoning consumed the budget" (auto-escalation)
- Long draft prompts exhausted the 8000-token output budget in hidden
  reasoning before any JSON, surfacing a raw provider error. Default
  draft budget raised to 16000; on empty-content the server retries
  once at double tokens instead of failing. Other provider errors
  still 502 honestly. 2 new backend tests; assistant+API 49/49.
- Pitch line: "When the model thinks too long, the server gives it
  more room instead of giving you an error."

## Detour 8 — draft invented hot_cold params (prompt now teaches them)
- Ambitious MoE draft failed on `policy.params: hot_cold needs
  k >= 1 and 0 <= cold_threshold < hot_threshold` — and the repair
  turn couldn't fix it, because SYSTEM never described any policy's
  params. Prompt now names every policy's valid params + defaults
  and says local_only/swap_remote take none. 1 new backend test;
  assistant+API 50/50.
- Pitch line: "The model stopped guessing knobs once we told it the
  knobs exist."
