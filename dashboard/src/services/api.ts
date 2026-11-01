/**
 * RmemFab API Client Service Layer
 * Directly connected to the FastAPI Run API (docs/API.md, PRODUCT-SPEC §4, §5)
 * and supporting an explicit Mock Telemetry Provider for offline demonstration.
 */

import type { ScenarioConfig } from '../types/scenario'
import type {
  SimulationRun,
  KpiMetric,
  RunSummary,
  RunDetail,
  SeriesPoint,
  EventsResponse,
  ComparisonVerdict,
  ValidateResponse,
  TraceProfile
} from '../types/telemetry'
import { adaptRunSummaryToSimulationRun } from '../types/telemetry'
import { MOCK_SIMULATION_RUNS, LLAMA_70B_CXL_SCENARIO } from './mockData'
import { validateScenario } from '../utils/validation'

export type { ValidateResponse } from '../types/telemetry'

export interface ApiStatus {
  connected: boolean
  url: string
  version?: string
  rmemfab_version?: string
  schema_versions?: Record<string, string>
  replay_supported?: boolean
  faults_supported?: boolean
  message: string
}

export interface SubmitRunOptions {
  no_events?: boolean
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

  /**
   * Health and capability flags from GET /health
   */
  public async checkHealth(): Promise<ApiStatus> {
    if (this.useMock) {
      return {
        connected: false,
        url: this.baseUrl,
        message: 'Mock Telemetry Mode active (Standalone presentation)'
      }
    }

    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      })

      if (res.ok) {
        let data: Record<string, unknown> | null = null
        try {
          data = (await res.json()) as Record<string, unknown>
        } catch {
          return {
            connected: false,
            url: this.baseUrl,
            message: 'FastAPI /health returned non-JSON response'
          }
        }

        // Strictly verify health contract:
        // {"status": "ok", "rmemfab_version": "...", "schema_versions": {...}, "replay_supported": bool, "faults_supported": bool}
        const hasValidStatus = data && typeof data === 'object' && data.status === 'ok'
        const hasVersion = typeof data?.rmemfab_version === 'string' && data.rmemfab_version.trim().length > 0
        const schemaVersions = data?.schema_versions as Record<string, string> | undefined
        const hasSchemas = schemaVersions && typeof schemaVersions === 'object' && typeof schemaVersions.config === 'string'
        const hasReplay = typeof data?.replay_supported === 'boolean'
        const hasFaults = typeof data?.faults_supported === 'boolean'

        if (!hasValidStatus || !hasVersion || !hasSchemas || !hasReplay || !hasFaults) {
          return {
            connected: false,
            url: this.baseUrl,
            message: `FastAPI responded at ${this.baseUrl}/health but payload violated health contract (missing required version or capability fields)`
          }
        }

        const rmemfab_version = data.rmemfab_version as string
        const replay_supported = data.replay_supported as boolean
        const faults_supported = data.faults_supported as boolean

        return {
          connected: true,
          url: this.baseUrl,
          version: rmemfab_version,
          rmemfab_version,
          schema_versions: schemaVersions,
          replay_supported,
          faults_supported,
          message: `Connected to FastAPI Run API (rmemfab v${rmemfab_version})`
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

  /**
   * Authoritative server validation: POST /scenarios/validate
   */
  public async validateScenarioBackend(scenario: ScenarioConfig): Promise<ValidateResponse> {
    if (this.useMock) {
      const local = validateScenario(scenario)
      return {
        valid: local.isValid,
        errors: local.errors.map((e) => ({ path: e.field, message: e.message })),
        warnings: [],
        assumed: []
      }
    }

    try {
      const res = await fetch(`${this.baseUrl}/scenarios/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
        signal: AbortSignal.timeout(4000)
      })

      if (res.ok) {
        return (await res.json()) as ValidateResponse
      }

      let errorMsg = `HTTP ${res.status}`
      try {
        const errJson = await res.json()
        errorMsg = errJson.detail || JSON.stringify(errJson)
      } catch {
        errorMsg = res.statusText || errorMsg
      }

      return {
        valid: false,
        errors: [{ path: 'root', message: `Server validation request failed: ${errorMsg}` }],
        warnings: [],
        assumed: []
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error'
      return {
        valid: false,
        errors: [{ path: 'root', message: `Cannot reach validation endpoint: ${msg}` }],
        warnings: [],
        assumed: []
      }
    }
  }

  /**
   * List simulation runs: GET /runs
   */
  public async getRuns(params?: { limit?: number; policy?: string; status?: string }): Promise<SimulationRun[]> {
    if (!this.useMock) {
      try {
        const query = new URLSearchParams()
        if (params?.limit) query.set('limit', String(params.limit))
        if (params?.policy) query.set('policy', params.policy)
        if (params?.status) query.set('status', params.status)
        const qs = query.toString() ? `?${query.toString()}` : ''

        const res = await fetch(`${this.baseUrl}/runs${qs}`, { signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          let liveData: unknown
          try {
            liveData = await res.json()
          } catch (jsonErr) {
            throw new Error(`FastAPI /runs returned malformed non-JSON data: ${jsonErr instanceof Error ? jsonErr.message : 'Parse error'}`, { cause: jsonErr })
          }

          if (Array.isArray(liveData)) {
            // Live data returns RunSummary[]
            return liveData.map((row: RunSummary) => adaptRunSummaryToSimulationRun(row, null, null))
          }
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

  /**
   * Get single run detail with full metrics & series: GET /runs/{id}
   */
  public async getRun(id: string): Promise<SimulationRun | undefined> {
    if (this.useMock) {
      return this.cachedRuns.find((r) => r.id === id)
    }

    try {
      const detailRes = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(4000)
      })
      if (!detailRes.ok) {
        if (detailRes.status === 404) return undefined
        throw new Error(`Failed to fetch run ${id}: HTTP ${detailRes.status}`)
      }
      const detail = (await detailRes.json()) as RunDetail

      // Also attempt to fetch series downsampled
      let series: SeriesPoint[] = []
      try {
        const seriesRes = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(id)}/series?downsample=2000`, {
          signal: AbortSignal.timeout(4000)
        })
        if (seriesRes.ok) {
          series = (await seriesRes.json()) as SeriesPoint[]
        }
      } catch {
        // Series optional / summary-only
      }

      // Synthesize RunSummary base from detail
      const sum = (detail.summary as Record<string, unknown>) || {}
      const summaryStrip: RunSummary = {
        run_id: detail.run_id,
        scenario_name: typeof sum.scenario === 'string' ? sum.scenario : null,
        scenario_hash: (typeof sum.scenario_hash === 'string' ? sum.scenario_hash : (typeof detail.manifest?.scenario_hash === 'string' ? detail.manifest.scenario_hash : null)),
        seed: typeof sum.seed === 'number' ? sum.seed : null,
        policy: {
          requested: (sum.policy as Record<string, string>)?.requested ?? null,
          effective: (sum.policy as Record<string, string>)?.effective ?? null,
          fallback_reason: (sum.policy as Record<string, string>)?.fallback_reason ?? null
        },
        status: detail.status,
        error: detail.error || null,
        arrived: (sum.requests as Record<string, number>)?.arrived ?? null,
        completed: (sum.requests as Record<string, number>)?.completed ?? null,
        rejected: (sum.requests as Record<string, number>)?.rejected ?? null,
        p50: ((sum.access as Record<string, unknown>)?.latency_ns as Record<string, number>)?.p50 ?? null,
        p95: ((sum.access as Record<string, unknown>)?.latency_ns as Record<string, number>)?.p95 ?? null,
        remote_read_bytes: (sum.traffic as Record<string, number>)?.remote_read_bytes ?? null,
        migration_bytes: (sum.traffic as Record<string, number>)?.migration_bytes ?? null,
        created_at: typeof sum.created_at === 'string' ? sum.created_at : null,
        is_demo: false
      }

      return adaptRunSummaryToSimulationRun(summaryStrip, detail, series)
    } catch (err) {
      throw new Error(`Cannot retrieve run ${id} from live backend: ${err instanceof Error ? err.message : 'Error'}`, { cause: err })
    }
  }

  /**
   * Get run series data: GET /runs/{id}/series?downsample=N
   */
  public async getRunSeries(id: string, downsample: number = 2000): Promise<SeriesPoint[]> {
    if (this.useMock) {
      return []
    }
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(id)}/series?downsample=${downsample}`, {
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    return (await res.json()) as SeriesPoint[]
  }

  /**
   * Get run events paged: GET /runs/{id}/events
   */
  public async getRunEvents(
    id: string,
    params?: { types?: string; t0?: number; t1?: number; request_id?: string; limit?: number; cursor?: string }
  ): Promise<EventsResponse> {
    if (this.useMock) {
      return { events: [], next_cursor: null, summary_only: true }
    }
    const query = new URLSearchParams()
    if (params?.types) query.set('types', params.types)
    if (params?.t0 !== undefined) query.set('t0', String(params.t0))
    if (params?.t1 !== undefined) query.set('t1', String(params.t1))
    if (params?.request_id) query.set('request_id', params.request_id)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.cursor) query.set('cursor', params.cursor)
    const qs = query.toString() ? `?${query.toString()}` : ''

    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(id)}/events${qs}`, {
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    return (await res.json()) as EventsResponse
  }

  /**
   * Guarded comparison: POST /runs/compare
   */
  public async compareRuns(ids: string[], multi_seed?: boolean): Promise<ComparisonVerdict> {
    if (this.useMock) {
      return {
        verdict: 'fair',
        mode: multi_seed ? 'multi_seed' : 'same_seed',
        directional: true
      }
    }

    const res = await fetch(`${this.baseUrl}/runs/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, multi_seed: !!multi_seed }),
      signal: AbortSignal.timeout(5000)
    })

    if (res.ok) {
      return (await res.json()) as ComparisonVerdict
    }

    if (res.status === 422) {
      const body = await res.json()
      if (body.detail && typeof body.detail === 'object' && body.detail.verdict === 'refused') {
        return body.detail
      }
      if (body.verdict === 'refused') {
        return body
      }
      return { verdict: 'refused', reason: typeof body.detail === 'string' ? body.detail : JSON.stringify(body) }
    }

    throw new Error(`Comparison API failed: HTTP ${res.status}`)
  }

  /**
   * Export run zip bundle: GET /runs/{id}/export
   */
  public async exportRunZip(id: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(id)}/export`, {
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`)
    return await res.blob()
  }

  /**
   * Trace API operations: GET /traces, POST /traces, DELETE /traces/{id}
   */
  public async getTraces(): Promise<TraceProfile[]> {
    if (this.useMock) return []
    const res = await fetch(`${this.baseUrl}/traces`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    return (await res.json()) as TraceProfile[]
  }

  public async getOverviewKpis(): Promise<KpiMetric[]> {
    const runs = await this.getRuns()
    const completed = runs.filter((r) => r.status === 'completed')

    if (completed.length === 0) {
      return [
        {
          title: 'Completed Runs',
          value: 0,
          subtitle: runs.length === 0 ? 'No simulation runs recorded' : `0 of ${runs.length} runs completed`,
          trend: { value: 'Awaiting completion', isPositive: false }
        },
        {
          title: 'Median Access Latency',
          value: '—',
          subtitle: 'No latency measurements available'
        },
        {
          title: 'Remote Hit Ratio',
          value: '—',
          subtitle: 'No hit ratio data available'
        },
        {
          title: 'Fabric Utilization',
          value: '—',
          subtitle: 'No utilization measurements recorded'
        }
      ]
    }

    // Extract valid, measured values only (never treat null as 0)
    const validP50 = completed
      .map((r) => r.metrics.latency_ns?.p50)
      .filter((v): v is number => typeof v === 'number' && !isNaN(v))
      .sort((a, b) => a - b)

    let medianLatencyStr = '—'
    let medianSubtitle = 'No access latency measurements'
    if (validP50.length > 0) {
      const mid = Math.floor(validP50.length / 2)
      const medianVal = validP50.length % 2 !== 0
        ? validP50[mid]
        : (validP50[mid - 1] + validP50[mid]) / 2
      medianLatencyStr = `${medianVal.toFixed(1)} ns`
      medianSubtitle = `Median p50 across ${validP50.length} completed run${validP50.length > 1 ? 's' : ''}`
    }

    const validHitRatios = completed
      .map((r) => r.metrics.remote_hit_ratio)
      .filter((v): v is number => typeof v === 'number' && !isNaN(v))

    let hitRatioStr = '—'
    let hitSubtitle = 'No remote hit ratio measurements'
    if (validHitRatios.length > 0) {
      const avgHit = validHitRatios.reduce((a, b) => a + b, 0) / validHitRatios.length
      hitRatioStr = `${(avgHit * 100).toFixed(1)}%`
      hitSubtitle = `Average across ${validHitRatios.length} completed run${validHitRatios.length > 1 ? 's' : ''}`
    }

    const validUtils = completed
      .map((r) => r.metrics.fabric_utilization)
      .filter((v): v is number => typeof v === 'number' && !isNaN(v))

    let utilStr = '—'
    let utilSubtitle = 'No fabric link utilization recorded'
    if (validUtils.length > 0) {
      const avgUtil = validUtils.reduce((a, b) => a + b, 0) / validUtils.length
      utilStr = `${(avgUtil * 100).toFixed(1)}%`
      utilSubtitle = `Average peak across ${validUtils.length} run${validUtils.length > 1 ? 's' : ''}`
    }

    return [
      {
        title: 'Completed Runs',
        value: completed.length,
        subtitle: `${completed.length} of ${runs.length} runs completed`,
        trend: { value: `${new Set(completed.map((r) => r.policy_name)).size} unique policies`, isPositive: true }
      },
      {
        title: 'Median Access Latency',
        value: medianLatencyStr,
        subtitle: medianSubtitle
      },
      {
        title: 'Remote Hit Ratio',
        value: hitRatioStr,
        subtitle: hitSubtitle
      },
      {
        title: 'Fabric Utilization',
        value: utilStr,
        subtitle: utilSubtitle
      }
    ]
  }

  public getDefaultScenario(): ScenarioConfig {
    return JSON.parse(JSON.stringify(LLAMA_70B_CXL_SCENARIO))
  }

  /**
   * Submit scenario to run simulation: POST /runs
   * Backend body contract: { scenario: dict, no_events?: bool } -> 202 { run_id, status, error? }
   */
  public async submitScenario(
    scenario: ScenarioConfig,
    options?: SubmitRunOptions
  ): Promise<{ success: boolean; status: 'completed' | 'failed' | 'accepted'; message: string; runId?: string; error?: string }> {
    // In mock mode, local validation is authoritative
    if (this.useMock) {
      const validation = validateScenario(scenario)
      if (!validation.isValid) {
        return {
          success: false,
          status: 'failed',
          message: `Validation failed: ${validation.errors[0].message} (${validation.errors[0].field})`
        }
      }

      // Demo mode: create an illustrative run entry with explicit is_demo: true
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
        is_demo: true,
        metrics: {
          latency_ns: { p50: 125, p90: 160, p95: 185, p99: 250, mean: 130, max: 320 },
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
        status: 'completed',
        message: `[Demo Mode] Scenario submitted locally (Demo Run ID: ${newRunId}). Connect FastAPI in Settings for real DES runs.`,
        runId: newRunId
      }
    }

    // In LIVE mode:
    // Do NOT let incomplete frontend validator reject scenario before POST /runs or POST /scenarios/validate!
    // Server validation is the final authority.
    try {
      const payload = {
        scenario,
        no_events: options?.no_events ?? false
      }

      const res = await fetch(`${this.baseUrl}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (res.status === 202 || res.ok) {
        let data: Record<string, unknown> | null = null
        try {
          data = (await res.json()) as Record<string, unknown>
        } catch (jsonErr) {
          return {
            success: false,
            status: 'failed',
            message: `FastAPI responded with HTTP ${res.status} but returned malformed non-JSON: ${jsonErr instanceof Error ? jsonErr.message : 'Parse error'}`
          }
        }

        const runId = data && typeof data.run_id === 'string' && data.run_id.trim().length > 0
          ? data.run_id.trim()
          : undefined

        if (!runId) {
          return {
            success: false,
            status: 'failed',
            message: 'FastAPI responded with 202 Accepted but did not provide a valid run_id in the response.'
          }
        }

        const status = data.status === 'failed' ? 'failed' : (data.status === 'completed' ? 'completed' : 'accepted')
        const runError = typeof data.error === 'string' ? data.error : undefined

        if (status === 'failed') {
          return {
            success: false,
            status: 'failed',
            message: `Simulation failed: ${runError || 'Diverged during execution'}`,
            runId,
            error: runError
          }
        }

        return {
          success: true,
          status,
          message: status === 'completed'
            ? `Simulation completed successfully (Run ID: ${runId})`
            : `Simulation accepted and dispatched (Run ID: ${runId})`,
          runId
        }
      }

      let errorDetail = ''
      try {
        const errData = (await res.json()) as Record<string, unknown>
        interface ErrorItem {
          path?: string
          message?: string
          msg?: string
          loc?: Array<string | number>
        }

        if (Array.isArray(errData.detail)) {
          errorDetail = (errData.detail as ErrorItem[])
            .map((e) => `${e.path || e.loc?.join('.') || 'error'}: ${e.message || e.msg}`)
            .join(', ')
        } else if (Array.isArray(errData)) {
          errorDetail = (errData as ErrorItem[])
            .map((e) => `${e.path || 'error'}: ${e.message || e.msg}`)
            .join(', ')
        } else {
          errorDetail = typeof errData.detail === 'string' ? errData.detail : (typeof errData.message === 'string' ? errData.message : JSON.stringify(errData))
        }
      } catch {
        errorDetail = res.statusText || 'Server error'
      }

      return {
        success: false,
        status: 'failed',
        message: `FastAPI rejected submission (HTTP ${res.status}): ${errorDetail}`
      }
    } catch (err) {
      return {
        success: false,
        status: 'failed',
        message: `Cannot reach FastAPI backend at ${this.baseUrl}: ${
          err instanceof Error ? err.message : 'Connection refused'
        }`
      }
    }
  }
}

export const apiClient = new RmemFabApiClient()
