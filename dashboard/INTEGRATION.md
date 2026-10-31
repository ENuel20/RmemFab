# RmemFab — Frontend to FastAPI Backend Integration Guide

This document defines the exact contract, assumed endpoints, data models, error semantics, and developer checklist for connecting the React + Vite frontend dashboard to Onana's FastAPI discrete-event simulator backend.

---

## 1. Architecture Overview

```
┌─────────────────────────────────┐           HTTP REST           ┌────────────────────────────────┐
│   RmemFab React Dashboard       │ ────────────────────────────> │  FastAPI Simulation Backend    │
│   (TypeScript / Vite / Recharts)│ <──────────────────────────── │  (rmemfab.api.app:app)         │
│   Port: 5173                    │                               │  Port: 8000                    │
└─────────────────────────────────┘                               └────────────────┬───────────────┘
                                                                                   │
                                                                          Spawns / Executes
                                                                                   │
                                                                                   ▼
                                                                  ┌────────────────────────────────┐
                                                                  │  Discrete-Event Simulator (DES)│
                                                                  │  Virtual Clock (ns precision)  │
                                                                  └────────────────────────────────┘
```

The frontend operates in two distinct modes:
1. **Mock Telemetry Mode (Standalone Demo)**: Uses verified static runs and local validation. Useful for offline demonstrations, UI development, and testing.
2. **Live Backend Mode (FastAPI)**: Dispatches scenarios directly to `POST /runs`, queries `GET /runs`, and inspects live run metrics. **Live mode never falls back silently to mock data.**

---

## 2. Assumed REST Endpoints

### 2.1 Health Probe
- **Method / Path:** `GET /health`
- **Purpose:** Verifies that the FastAPI daemon is online and responsive.
- **Frontend Timeout:** 3,000 ms (`AbortSignal.timeout(3000)`)
- **Expected Success Response (HTTP 200 OK):**
```json
{
  "status": "ok",
  "version": "0.1"
}
```
- **Error Behavior:**
  - If unreachable or non-200, frontend reports: `FastAPI backend is unreachable at <baseUrl>`. Mode is **not** altered automatically.

---

### 2.2 Submit Simulation Run
- **Method / Path:** `POST /runs`
- **Purpose:** Validates and queues a simulation scenario for execution.
- **Request Headers:** `Content-Type: application/json`
- **Request Body:** Full `ScenarioConfig` object strictly complying with `SPECS/config.schema.json` (Draft 2020-12).
- **Expected Success Response (HTTP 200 OK or HTTP 201 Created):**
```json
{
  "id": "run-llama-cxl-001",
  "status": "queued",
  "message": "Simulation scenario accepted"
}
```
*(Note: Frontend accepts either `"id"` or `"run_id"` as the run identifier string).*

- **Expected Error Responses:**
  - **HTTP 422 Unprocessable Entity:** Validation error in scenario schema.
    ```json
    {
      "detail": "Invalid node configuration: local_memory missing on node-0"
    }
    ```
  - **HTTP 500 Internal Server Error:** Engine crash or simulation initialization failure.
    ```json
    {
      "detail": "Failed to initialize topology graph: cycle detected"
    }
    ```
- **Frontend Safeguards:**
  - Rejects submission before sending if client-side validation detects schema or semantic errors.
  - Locks submission button (`isSubmitting = true`) with animated spinner to prevent duplicate requests.
  - If HTTP 200 is returned without `id` or `run_id`, frontend flags a contract discrepancy error.
  - Automatically triggers `GET /runs` to refresh run history on confirmed submission.

---

### 2.3 List Simulation Runs
- **Method / Path:** `GET /runs`
- **Purpose:** Fetches all historical and completed simulation runs for telemetry display, filtering, and policy comparison.
- **Frontend Timeout:** 4,000 ms (`AbortSignal.timeout(4000)`)
- **Expected Success Response (HTTP 200 OK):**
```json
[
  {
    "id": "run-llama-cxl-swap",
    "scenario_name": "llama-70b-cxl-swap",
    "scenario_hash": "sha256:4a8f9b...",
    "workload_profile": "kv_cache_decode",
    "policy_name": "swap_remote",
    "policy_display_name": "Swap to Remote (LRU)",
    "seed": 42,
    "duration_ns": 60000000000,
    "status": "completed",
    "created_at": "2026-10-29T10:15:00Z",
    "metrics": {
      "latency_ns": {
        "p50": 184.2,
        "p90": 268.4,
        "p95": 312.8,
        "p99": 448.1,
        "mean": 196.4,
        "max": 620.0
      },
      "stall_time_ns": 4120000000,
      "local_hit_ratio": 0.684,
      "remote_hit_ratio": 0.281,
      "miss_ratio": 0.035,
      "remote_traffic_bytes": 142800000000,
      "migration_bytes": 48200000000,
      "fabric_utilization": 0.748,
      "peak_queue_depth_bytes": 48200000,
      "total_accesses": 4280000
    },
    "time_series": [
      {
        "time_ns": 1000000000,
        "time_formatted": "1.0s",
        "p50_latency_ns": 182.0,
        "p95_latency_ns": 310.0,
        "p99_latency_ns": 440.0,
        "local_occupancy_bytes": 480000000000,
        "remote_occupancy_bytes": 1200000000000,
        "fabric_bandwidth_bytes_per_ns": 38.2,
        "fabric_utilization_pct": 79.5,
        "queue_depth_bytes": 42000000,
        "migrations_active": 18
      }
    ],
    "bottleneck": {
      "severity": "high",
      "primary_bottleneck": "CXL Host Link Bandwidth Saturation",
      "explanation": "Page swap traffic between local DDR5 and remote CXL pool saturates link-0.",
      "suggested_policy_tuning": "Migrate to hot_cold policy with access frequency tracking."
    },
    "scenario_snapshot": { ... }
  }
]
```

---

### 2.4 Get Run Details (Optional / Supported)
- **Method / Path:** `GET /runs/{id}`
- **Purpose:** Fetches full telemetry, time series, and bottleneck analysis for a specific run.

---

## 3. Policy Comparison Scientific Fairness Contract

When two or more runs are compared in the **Policy Comparison** tab, the frontend runs a 4-point scientific validation check:
1. **Random Seed:** Both runs must share the exact same PRNG seed (`r.seed`).
2. **Workload Profile & Model:** Both runs must share the exact workload profile and identical model/requests parameters (`layers`, `heads`, `experts`, `top_k`, `concurrency`, `arrival_rate`).
3. **Simulation Duration:** Both runs must have identical virtual clock duration (`r.duration_ns`).
4. **Hardware & Fabric Topology:** Both runs must have an identical node list (roles, memory capacities, latencies, bandwidths) and fabric link topology (routing, link latency, bandwidth).

If snapshots are missing on any run, the UI displays **`CANNOT VERIFY`** with explanatory notes, preventing inaccurate comparisons.

---

## 4. Integration Checklist for Backend Developer (Onana)

- [ ] **FastAPI Entrypoint:** Ensure the backend can be launched via:
  ```bash
  uvicorn rmemfab.api.app:app --host 0.0.0.0 --port 8000 --reload
  ```
- [ ] **CORS Middleware Enabled:** Enable CORS for the frontend development server:
  ```python
  from fastapi.middleware.cors import CORSMiddleware

  app.add_middleware(
      CORSMiddleware,
      allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
      allow_credentials=True,
      allow_methods=["*"],
      allow_headers=["*"],
  )
  ```
- [ ] **Scenario Validation:** Ensure scenario ingestion uses Pydantic models validated against `SPECS/config.schema.json`.
- [ ] **Run ID Generation:** Ensure `POST /runs` returns `{ "id": "<unique_run_id>" }` on HTTP 200/201.
- [ ] **Scenario Snapshot Persistence:** Ensure each run returned by `GET /runs` retains the `scenario_snapshot` matching the submitted scenario configuration, which powers fairness checks.
- [ ] **Status Life-cycle:** Use `"completed"`, `"running"`, or `"failed"`.

