# Dashboard ↔ Backend Integration

The dashboard (`React + Vite`, dev port 5173) talks to the FastAPI Run API
(`rmemfab serve`, default http://127.0.0.1:8000). The contract lives in the
repo, not in this file:

- Endpoint shapes, errors, and flows: [`docs/API.md`](../docs/API.md)
- Type-level contract: [`examples/sample-outputs/`](../examples/sample-outputs/)
  (regenerable, deterministic) and `tests/test_api.py` (executable contract)
- Event catalog: [`SPECS/events.md`](../SPECS/events.md)

## Client notes (`src/services/api.ts`)

- Live mode is the default; mock telemetry is an explicit labeled offline
  mode (Settings toggle, persisted in localStorage). Live failures throw —
  the client never falls back silently.
- `GET /health` gates features on `replay_supported` / `faults_supported`,
  not on version strings.
- Run submit is `POST /runs` → `202 {run_id, status}` (`completed` |
  `failed`); the engine runs inline, there is no `queued`/`running` state.
- Run detail (`GET /runs/{id}`) carries the saved `scenario` for the
  Infrastructure topology view (null on failed runs).
- Policy comparison defers to the server verdict: `POST /runs/compare`
  returns fair or refuses 422 with a reason; the local
  `comparisonGuard.ts` only pre-checks and explains.
- Scenario builder emits only backend-implemented options
  (`kv_cache_decode`; five policies; real `KNOWN_PARAMS` knobs). Server
  validation is authoritative on submit.

## Boot both sides

```bash
rmemfab serve --port 8000        # backend (repo root, .venv)
cd dashboard && npm install && npm run dev   # frontend → http://localhost:5173
```
