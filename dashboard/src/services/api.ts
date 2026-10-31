/**
 * RmemFab API Client Service Layer
 * Abstracts telemetry access, supporting both local Mock Data Provider
 * and the planned FastAPI Run API layer.
 */

import type { ScenarioConfig } from '../types/scenario'
import type { SimulationRun, KpiMetric } from '../types/telemetry'
import { MOCK_SIMULATION_RUNS, LLAMA_70B_CXL_SCENARIO } from './mockData'
import { validateScenario } from '../utils/validation'

export interface ApiStatus {
  connected: boolean
  url: string
  version?: string
  message: string
}

class RmemFabApiClient {
  private baseUrl: string = 'http://localhost:8000'
  private useMock: boolean = true
  private cachedRuns: SimulationRun[] = [...MOCK_SIMULATION_RUNS]

  constructor() {
    const savedUrl = localStorage.getItem('rmemfab_api_url')
    if (savedUrl) this.baseUrl = savedUrl
    const savedMode = localStorage.getItem('rmemfab_use_mock')
    if (savedMode !== null) this.useMock = savedMode === 'true'
  }

  public getBaseUrl(): string {
    return this.baseUrl
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = url
    localStorage.setItem('rmemfab_api_url', url)
  }

  public isMockMode(): boolean {
    return this.useMock
  }

  public setMockMode(enabled: boolean): void {
    this.useMock = enabled
    localStorage.setItem('rmemfab_use_mock', String(enabled))
  }

  public resetToDefaults(): void {
    this.baseUrl = 'http://localhost:8000'
    this.useMock = true
    localStorage.removeItem('rmemfab_api_url')
    localStorage.removeItem('rmemfab_use_mock')
    this.cachedRuns = [...MOCK_SIMULATION_RUNS]
  }

  public async checkHealth(): Promise<ApiStatus> {
    if (this.useMock) {
      return {
        connected: false,
        url: this.baseUrl,
        message: 'Mock Telemetry Mode active (Standalone presentation)'
      }
    }

    try {
      const res = await fetch(`${this.baseUrl}/health`, { method: 'GET', signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        let version = '0.1'
        try {
          const data = await res.json()
          if (data && typeof data.version === 'string') version = data.version
        } catch {
          // keep fallback version
        }
        return {
          connected: true,
          url: this.baseUrl,
          version,
          message: 'Connected to FastAPI Run API'
        }
      }
      return {
        connected: false,
        url: this.baseUrl,
        message: `FastAPI responded with HTTP ${res.status}: ${res.statusText || 'Run API returned an error'}`
      }
    } catch (err) {
      return {
        connected: false,
        url: this.baseUrl,
        message: `FastAPI backend is unreachable at ${this.baseUrl} (${err instanceof Error ? err.message : 'Connection refused'}).`
      }
    }
  }

  public async getRuns(): Promise<SimulationRun[]> {
    if (!this.useMock) {
      try {
        const res = await fetch(`${this.baseUrl}/runs`, { signal: AbortSignal.timeout(4000) })
        if (res.ok) {
          let liveData: unknown
          try {
            liveData = await res.json()
          } catch (jsonErr) {
            throw new Error(`FastAPI /runs returned malformed non-JSON data: ${jsonErr instanceof Error ? jsonErr.message : 'Parse error'}`, { cause: jsonErr })
          }
          if (Array.isArray(liveData)) return liveData
          throw new Error('FastAPI /runs returned an unexpected non-array response')
        }
        throw new Error(`FastAPI responded with HTTP ${res.status}: ${res.statusText || 'Failed to fetch runs'}`)
      } catch (err) {
        throw new Error(
          `Live backend request failed (${this.baseUrl}/runs): ${
            err instanceof Error ? err.message : 'Unknown connection error'
          }. Switch to Mock Telemetry Mode in Settings if FastAPI backend is offline.`,
          { cause: err }
        )
      }
    }
    return Promise.resolve([...this.cachedRuns])
  }

  public async getRun(id: string): Promise<SimulationRun | undefined> {
    const runs = await this.getRuns()
    return runs.find((r) => r.id === id)
  }

  public async getOverviewKpis(): Promise<KpiMetric[]> {
    const runs = await this.getRuns()
    const completed = runs.filter((r) => r.status === 'completed')

    const medianP50 = completed.length > 0
      ? completed.reduce((acc, r) => acc + r.metrics.latency_ns.p50, 0) / completed.length
      : 142.4

    const avgRemoteHit = completed.length > 0
      ? completed.reduce((acc, r) => acc + r.metrics.remote_hit_ratio, 0) / completed.length
      : 0.242

    const avgFabricUtil = completed.length > 0
      ? completed.reduce((acc, r) => acc + r.metrics.fabric_utilization, 0) / completed.length
      : 0.426

    return [
      {
        title: 'Completed Runs',
        value: completed.length,
        subtitle: 'Across CXL & RDMA scenarios',
        trend: { value: '4 policies active', isPositive: true }
      },
      {
        title: 'Median Access Latency',
        value: `${medianP50.toFixed(1)} ns`,
        subtitle: 'p50 access completion time',
        trend: { value: '-38.6% with Hot/Cold', isPositive: true }
      },
      {
        title: 'Remote Hit Ratio',
        value: `${(avgRemoteHit * 100).toFixed(1)}%`,
        subtitle: 'Tiered working set in remote pool',
        trend: { value: '1.56 TB traffic served', isPositive: true }
      },
      {
        title: 'Fabric Utilization',
        value: `${(avgFabricUtil * 100).toFixed(1)}%`,
        subtitle: 'Peak throughput: 74.8% on swap',
        trend: { value: 'Balanced on CXL 2.0', isPositive: true }
      }
    ]
  }

  public getDefaultScenario(): ScenarioConfig {
    return JSON.parse(JSON.stringify(LLAMA_70B_CXL_SCENARIO))
  }

  public async submitScenario(scenario: ScenarioConfig): Promise<{ success: boolean; message: string; runId?: string }> {
    const validation = validateScenario(scenario)
    if (!validation.isValid) {
      return {
        success: false,
        message: `Validation failed: ${validation.errors[0].message} (${validation.errors[0].field})`
      }
    }

    if (!this.useMock) {
      try {
        const res = await fetch(`${this.baseUrl}/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scenario)
        })

        if (res.ok) {
          let data: unknown
          try {
            data = await res.json()
          } catch (jsonErr) {
            return {
              success: false,
              message: `FastAPI responded with HTTP ${res.status} but returned malformed non-JSON: ${jsonErr instanceof Error ? jsonErr.message : 'Parse error'}`
            }
          }

          const dataObj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
          const runId =
            dataObj && typeof dataObj.id === 'string' && dataObj.id.trim().length > 0
              ? dataObj.id.trim()
              : dataObj && typeof dataObj.run_id === 'string' && dataObj.run_id.trim().length > 0
              ? dataObj.run_id.trim()
              : undefined

          if (!runId) {
            return {
              success: false,
              message: 'FastAPI responded with HTTP 200 but did not provide a valid run identifier (id or run_id) in the response payload.'
            }
          }

          return {
            success: true,
            message: `Simulation successfully dispatched to FastAPI Run API (Run ID: ${runId})`,
            runId
          }
        }

        let errorDetail = ''
        try {
          const errData = await res.json()
          errorDetail = errData.detail || errData.message || JSON.stringify(errData)
        } catch {
          errorDetail = res.statusText || 'Server error'
        }
        return {
          success: false,
          message: `FastAPI rejected submission (HTTP ${res.status}): ${errorDetail}`
        }
      } catch (err) {
        return {
          success: false,
          message: `Cannot reach FastAPI backend at ${this.baseUrl}: ${
            err instanceof Error ? err.message : 'Connection refused'
          }`
        }
      }
    }

    // In demo mode: create an illustrative run entry and add to cachedRuns for dashboard preview
    const newRunId = `demo-run-${Date.now().toString(36)}`
    const demoRun: SimulationRun = {
      id: newRunId,
      scenario_name: scenario.name,
      scenario_hash: `sha256:demo-${Date.now().toString(16)}`,
      workload_profile: scenario.workload.type === 'synthetic' ? scenario.workload.profile : 'mixed',
      policy_name: scenario.policy.name,
      policy_display_name: `[Demo] ${scenario.policy.name}`,
      seed: scenario.seed,
      duration_ns: scenario.duration_ns,
      status: 'completed',
      created_at: new Date().toISOString(),
      metrics: {
        latency_ns: { p50: 125, p95: 185, p99: 250, mean: 130, max: 320 },
        stall_time_ns: 1200000,
        local_hit_ratio: 0.75,
        remote_hit_ratio: 0.22,
        miss_ratio: 0.03,
        remote_traffic_bytes: 8589934592,
        migration_bytes: 2147483648,
        fabric_utilization: 0.38,
        peak_queue_depth_bytes: 4194304,
        total_accesses: 1000000
      },
      time_series: [],
      bottleneck: {
        severity: 'low',
        primary_bottleneck: 'None (Demo Run)',
        explanation: 'Demo run generated locally for scenario validation preview.',
        suggested_policy_tuning: 'Connect to live FastAPI backend in Settings for real discrete-event simulation.'
      },
      scenario_snapshot: JSON.parse(JSON.stringify(scenario))
    }
    this.cachedRuns.unshift(demoRun)

    return {
      success: true,
      message: `[Demo Mode] Scenario submitted locally (Demo Run ID: ${newRunId}). Connect FastAPI in Settings for real DES runs.`,
      runId: newRunId
    }
  }
}

export const apiClient = new RmemFabApiClient()
