# Sample engine output (for dashboard development)

Real bundles from real runs — build frontend types against these files, not
against assumptions. Regenerate any time with the commands below; outputs are
deterministic (same scenario + seed ⇒ byte-identical results).

- `synthetic/` — tiny synthetic KV run (275 events, 5 series points).
  Self-contained: re-run with
  `rmemfab run examples/sample-outputs/synthetic/scenario.json --out /tmp/x`
- `trace/` — 5-op micro-trace replay (15 events, 10 series points).
  Inputs: `trace/input.json` + `trace/trace.jsonl` (trace paths resolve
  relative to the scenario file). Re-run with
  `rmemfab run examples/sample-outputs/trace/input.json --out /tmp/x`
  Bundle (output record) is in `trace/bundle/`.

Provenance: generated 2026-11-01 by rmemfab 0.1.0, seed 7, policy
swap_remote. Run IDs `5810d9205417-s7-swap_remote` (synthetic) and
`0a304bc81d9a-116cdc0a-s7-swap_remote` (trace).

## Contracts

- `summary.json` + `manifest.json` → `RunDetail` shape, PRODUCT-SPEC §4.
- `series.jsonl` → one `SeriesPoint` per sampling tick:
  `{t_ns, accesses, evictions, completed, degraded,
  local_used_pages{node→n}, pool_used_pages, pools_used_pages{pool→n},
  link_bytes{link→n}}`.
  Counters are per-window deltas; occupancy/bytes are point-in-time;
  `degraded` is the count of active fault windows at the tick (0 when
  the scenario configures no faults).
  There is no per-window latency — do not render latency from series.
- `summary.json` carries a `degraded` section:
  `{windows[{type, target, start_ns, end_ns, …}], stalled_requests,
  loss_events, retransmissions, retransmit_bytes, retransmit_delay_ns,
  stalled_transfers, stalled_bytes}` — all zeros/empty without faults.
- `events.jsonl` → one `SimEvent` per line:
  `{event, time_ns, seq, run_id, node?, request_id?, data}`,
  ordered by `(time_ns, seq)`, per `SPECS/events.md`.
  Page-lifecycle rows are aggregate (`pages`, `bytes`, no `page_id`):
  render them as aggregate rows, never invent page identities.
- Absent `events.jsonl` means a summary-only run (`no_events`): render the
  `summary-only run` empty state, not an error.
- `run_id` is deterministic (`<scenario-hash>-s<seed>-<policy>`, plus trace
  hash for replays): resubmitting a scenario returns the same id.

## Live API

The same bundles are served over HTTP (`rmemfab serve`, default
http://127.0.0.1:8000, interactive docs at `/docs`): `GET /runs`,
`GET /runs/{id}`, `GET /runs/{id}/series?downsample=N`,
`GET /runs/{id}/events?…` (paged), `GET /runs/{id}/stream` (SSE replay),
`POST /runs/compare` (refuses unless controlled), `GET /runs/{id}/export`.
Full endpoint list: PRODUCT-SPEC §5.
