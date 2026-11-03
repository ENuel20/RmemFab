# RmemFab 3-Minute Demo Script (locked)

Every beat below maps to a verified run or refusal in `./runs`.
Rehearsal tracker at the bottom — the demo is not ready until the full
script runs clean 3 times in a row.

## Pre-demo checklist (2 min before)

- Backend: `PYTHONPATH=src .venv/bin/python -m rmemfab serve` → `:8000`,
  default `./runs` (26 runs: duel trio, maya contention/prefetch/
  stressed families, phase1/2/5/7, test5/7 — catalogued in
  `docs/05-test-runs.md`). `curl
  http://127.0.0.1:8000/health` → `{"status":"ok",...}`.
- Dashboard: `npm run dev` in `dashboard/` → `:5173`, badge reads
  **Live Data** (not Demo Dataset).
- `.env` Baseten key in place (assistant beats need it).
- Runs view shows the IDs below. If any are missing, the backend is
  pointed at the wrong runs dir — stop and fix that first.

## The script (180 s)

### Beat 1 — Question (0:00–0:20)
Show **Runs**. Say: "An engineer asks: which memory policy serves this
LLM trace best — and can I trust the answer?" Point at the two
`phase2-replay-opt` runs: `a7dc887f…` (swap) and `4c62fd7d…` (hot/cold).

### Beat 2 — NL draft → run (0:20–0:50) — PENDING Test 6 Step 5
**Scenario Builder** → draft box → the two-node prompt → version stored
→ submit → new run appears in Runs. Say: "Plain English becomes a
validated, runnable scenario — invalid drafts come back with errors,
never silently repaired."

### Beat 3 — Fair compare (0:50–1:20)
**Policy Comparison** → select `a7dc887f…` + `4c62fd7d…` → green
"Scientifically Fair Benchmark". Read: p50 1.69M → 1.33M ns, local-hit
0.007 → 0.098, migration 4.90 → 4.30 GB. Add `72279be3…`
(frequency_aware, p50 739k): three policies rank monotonically on the
measured trace. Say: "Same trace, same seed, only the policy differs."

### Beat 4 — What-if via assistant (1:20–1:45)
**Assistant** (context `4c62fd7d…`): "Recommend testing frequency_aware
instead of hot_cold…" → validated patch card → **Apply & run** → new
version + run + `Compare: fair`. Say: "The AI proposes; the server
validates, runs, and compares — nothing runs until you apply it."

### Beat 5 — Fault drill (1:45–2:15)
**Runs** → `phase5-fault-recovery` (`043424bff09d`) → degraded panel:
2 windows · 4 stalled · 4 lost / 4 retried, 9.67 GB retransmitted.
Series flags 0→1→2→1→0; events `node_fail/recover`,
`link_degraded/restored`. Say: "Kill a node, halve a link, lose 2% of
packets — four requests park, zero die, and the rerun is bit-for-bit
identical." Never claim drain-to-complete (0 completions in-window both
runs — the window is too short either way).

### Beat 6 — Guard refusal (2:15–2:35)
**Policy Comparison** → select `4c62fd7d…` + `852d62a4…` (Test 1
synthetic) → red "Comparison Refused", first difference named. Say:
"When the setup isn't identical, RmemFab refuses to compare instead of
lying."

### Beat 7 — Rollback (2:35–3:00) — PENDING Test 6 Step 4
**Assistant** → Rollback → to `72279be3ed8e79bd` → **Rollback & run** →
new audited version, same run_id (idempotent dedup, no duplicate). Say:
"Every experiment is reproducible by construction — and every undo is
audited, nothing overwritten." Close: "Deterministic science, honest
guards, AI that assists instead of deciding."

## Lines never to cross (from `docs/01-limitations.md`)

- Absolute latencies are placement evidence, not hardware predictions.
- Cost figures are illustrative units, never dollars.
- Single seed = directional, no confidence intervals.
- Measured / derived / synthetic provenance never mixed.

## Rehearsal tracker

- [ ] Run-through 1 (date, result, notes)
- [ ] Run-through 2 (date, result, notes)
- [ ] Run-through 3 (date, result, notes)
