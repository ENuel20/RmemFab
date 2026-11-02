/**
 * Telemetry and Simulation Run Types
 * Directly aligned with PRODUCT-SPEC §4 and backend API contract (docs/API.md)
 */

import type { PolicyName, WorkloadProfile, ScenarioConfig } from './scenario'

export type RunStatus = 'completed' | 'running' | 'failed'

// --- Authoritative Backend Models ---

export interface HealthResponse {
  status: string
  rmemfab_version: string
  schema_versions: {
    config: string
    trace: string
    events: string
    [key: string]: string
  }
  replay_supported: boolean
  faults_supported: boolean
}

export interface ValidateError {
  path: string
  message: string
}

export interface ValidateAssumed {
  path: string
  source?: string
  uncertainty_pct?: number | null
}

export interface ValidateResponse {
  valid: boolean
  errors: ValidateError[]
  warnings: string[]
  assumed: ValidateAssumed[]
}

export interface PatchOp {
  op: 'replace' | 'add' | 'remove'
  path: string
  value?: unknown
}

export interface VersionRequest {
  parent_version?: string | null
  scenario?: ScenarioConfig | null
  patch: PatchOp[]
}

export interface ScenarioVersion {
  version: string
  parent_version?: string | null
  changes: Array<{ path: string; from: unknown; to: unknown }>
  unchanged: string[]
}

export interface RunSummaryPolicy {
  requested: string | null
  effective: string | null
  fallback_reason: string | null
}

export interface RunSummary {
  run_id: string
  scenario_name: string | null
  scenario_hash: string | null
  seed: number | null
  policy: RunSummaryPolicy
  status: 'completed' | 'failed'
  error: string | null
  arrived: number | null
  completed: number | null
  rejected: number | null
  p50: number | null
  p95: number | null
  p99?: number | null
  remote_read_bytes: number | null
  remote_write_bytes?: number | null
  migration_bytes: number | null
  created_at: string | null
  is_demo?: boolean
  local_hit_ratio?: number | null
  remote_hit_ratio?: number | null
  fabric_utilization?: number | null
  scenario_snapshot?: ScenarioConfig | null
}

export interface RunDetail {
  run_id: string
  status: 'completed' | 'failed'
  summary: Record<string, unknown> | null
  manifest: Record<string, unknown> | null
  scenario?: ScenarioConfig | Record<string, unknown> | null
  error: string | null
}

export interface SeriesPoint {
  t_ns: number
  accesses: number
  evictions: number
  completed: number
  local_used_pages: Record<string, number>
  pool_used_pages: number
  pools_used_pages?: Record<string, number>
  link_bytes: Record<string, number>
}

export interface SimEvent {
  event: string
  time_ns: number
  seq: number
  run_id: string
  node?: string
  request_id?: string
  data: Record<string, unknown>
}

export interface EventsResponse {
  events: SimEvent[]
  next_cursor: string | null
  summary_only: boolean
}

export interface CompareFairResponse {
  verdict: 'fair'
  mode?: 'same_seed' | 'multi_seed'
  runs?: unknown[]
  groups?: Record<string, unknown>
  metric_direction?: Record<string, string>
  verdict_detail?: unknown
  [key: string]: unknown
}

export interface CompareRefusedResponse {
  verdict: 'refused'
  reason: string
}

export type ComparisonVerdict = CompareFairResponse | CompareRefusedResponse

export interface TraceProfile {
  trace_id: string
  filename?: string
  path_or_name?: string
  sha256: string
  source?: string
  model?: string
  runtime?: string
  capture_date?: string
  converter?: string
  trace_schema_version?: string
  provenance?: 'measured' | 'derived' | 'synthetic' | 'calibrated' | null
  limitation_note?: string | null
  counts: {
    alloc: number
    read: number
    write: number
    free: number
    migrate: number
  }
  requests: number
  footprint_bytes?: number
  normalized_pages: number
  validation: {
    errors: string[]
    warnings: string[]
  }
  normalization?: Record<string, unknown>
}

// --- Presentation & UI Compatibility Types ---

export interface LatencyPercentiles {
  p50: number | null
  p90?: number | null
  p95: number | null
  p99: number | null
  mean: number | null
  max: number | null
}

export interface MetricSummary {
  latency_ns: LatencyPercentiles
  stall_time_ns: number | null
  local_hit_ratio: number | null
  remote_hit_ratio: number | null
  miss_ratio: number | null
  remote_traffic_bytes: number | null
  remote_write_bytes?: number | null
  migration_bytes: number | null
  prefetch_accuracy?: number | null
  fabric_utilization: number | null
  peak_queue_depth_bytes: number | null
  total_accesses: number | null
  memory_bandwidth_utilization?: number | null
  pool_utilization?: number | null
  throughput_per_s?: number | null
}

export interface TimeSeriesPoint {
  time_ns: number
  time_formatted: string
  accesses?: number
  evictions?: number
  completed?: number
  local_used_pages?: Record<string, number>
  pool_used_pages?: number
  pools_used_pages?: Record<string, number>
  link_bytes?: Record<string, number>
  local_occupancy_bytes?: number | null
  remote_occupancy_bytes?: number | null
  p50_latency_ns?: number | null
  p95_latency_ns?: number | null
  p99_latency_ns?: number | null
  fabric_bandwidth_bytes_per_ns?: number | null
  fabric_utilization_pct?: number | null
  queue_depth_bytes?: number | null
  migrations_active?: number | null
}

export interface BottleneckAnalysis {
  severity: 'low' | 'medium' | 'high' | 'critical'
  primary_bottleneck: string
  explanation: string
  suggested_policy_tuning?: string
}

export interface SimulationRun {
  id: string
  scenario_name: string | null
  scenario_hash: string | null
  workload_profile?: WorkloadProfile | null
  policy_name: PolicyName | string
  policy_display_name: string
  seed: number | null
  duration_ns: number | null
  status: RunStatus
  created_at: string | null
  metrics: MetricSummary
  time_series: TimeSeriesPoint[]
  bottleneck: BottleneckAnalysis | null
  scenario_snapshot?: ScenarioConfig | null
  engine_version?: string | null
  trace_hash?: string | null
  percentile_interpolation?: string | null
  is_demo?: boolean
  error?: string | null
}

export interface KpiMetric {
  title: string
  value: string | number
  unit?: string
  subtitle: string
  trend?: {
    value: string
    isPositive: boolean
  }
}

interface EngineLatency {
  p50?: number
  p90?: number
  p95?: number
  p99?: number
  mean?: number
  max?: number
}

interface EngineAccess {
  latency_ns?: EngineLatency
  local_hits?: number
  remote_hits?: number
  misses?: number
  local_hit_ratio?: number
  remote_hit_ratio?: number
  miss_ratio?: number
  stall_ns?: number
  count?: number
}

interface EngineTraffic {
  remote_read_bytes?: number
  remote_write_bytes?: number
  migration_bytes?: number
  prefetch_accuracy?: number
}

interface EngineWorkload {
  page_size_bytes?: number
}

interface EngineLink {
  max_queue_bytes?: number
  utilization?: number
}

interface EngineSummary {
  scenario?: string
  scenario_hash?: string
  seed?: number
  access?: EngineAccess
  traffic?: EngineTraffic
  links?: Record<string, EngineLink>
  memory?: Record<string, { bandwidth_utilization?: number; capacity_pages?: number; [k: string]: unknown }>
  pool?: { utilization?: number; bytes_served?: number; [k: string]: unknown }
  pools?: Record<string, { utilization?: number; bytes_served?: number; [k: string]: unknown }>
  workload?: EngineWorkload
  workload_label?: string
  requests?: { throughput_per_s?: number; [k: string]: unknown }
  time?: { virtual_time_ns?: number }
  rmemfab_version?: string
  created_at?: string
  policy?: { requested?: string; effective?: string; fallback_reason?: string }
}

interface EngineManifest {
  rmemfab_version?: string
  scenario_hash?: string
  trace_hashes?: string[]
  percentile_method?: string
  page_size_bytes?: number
}

/**
 * Adapter converting backend RunSummary (and optional RunDetail) into SimulationRun.
 *
 * Strictly adheres to §1 of Stage 1B:
 * - Never invents missing values (missing metrics remain null, timestamps remain null, etc.).
 * - Does not copy summary values across time-series points.
 * - Does not invent per-window latency or fabric utilization for series points.
 * - Leaves scenario_snapshot and bottleneck null unless authentic data is provided by backend.
 */
export function adaptRunSummaryToSimulationRun(
  summary: RunSummary,
  detail?: RunDetail | null,
  series?: SeriesPoint[] | null
): SimulationRun {
  const sum = detail?.summary as EngineSummary | null | undefined
  const man = detail?.manifest as EngineManifest | null | undefined

  // 1. Latency percentiles: from access.latency_ns or summary strip, never defaulted to 0
  const lat = sum?.access?.latency_ns
  const p50 = typeof lat?.p50 === 'number' && !isNaN(lat.p50)
    ? lat.p50
    : (typeof summary.p50 === 'number' && !isNaN(summary.p50) ? summary.p50 : null)
  const p90 = typeof lat?.p90 === 'number' && !isNaN(lat.p90) ? lat.p90 : null
  const p95 = typeof lat?.p95 === 'number' && !isNaN(lat.p95)
    ? lat.p95
    : (typeof summary.p95 === 'number' && !isNaN(summary.p95) ? summary.p95 : null)
  const p99 = typeof lat?.p99 === 'number' && !isNaN(lat.p99)
    ? lat.p99
    : (typeof summary.p99 === 'number' && !isNaN(summary.p99) ? summary.p99 : null)
  const mean = typeof lat?.mean === 'number' && !isNaN(lat.mean) ? lat.mean : null
  const max = typeof lat?.max === 'number' && !isNaN(lat.max) ? lat.max : null

  // 2. Access counters & ratios: null if not measured
  const localHitRatio = typeof sum?.access?.local_hit_ratio === 'number' && !isNaN(sum.access.local_hit_ratio)
    ? sum.access.local_hit_ratio
    : (typeof summary.local_hit_ratio === 'number' && !isNaN(summary.local_hit_ratio) ? summary.local_hit_ratio : null)
  const remoteHitRatio = typeof sum?.access?.remote_hit_ratio === 'number' && !isNaN(sum.access.remote_hit_ratio)
    ? sum.access.remote_hit_ratio
    : (typeof summary.remote_hit_ratio === 'number' && !isNaN(summary.remote_hit_ratio) ? summary.remote_hit_ratio : null)
  const missRatio = typeof sum?.access?.miss_ratio === 'number' && !isNaN(sum.access.miss_ratio) ? sum.access.miss_ratio : null
  const stallTimeNs = typeof sum?.access?.stall_ns === 'number' && !isNaN(sum.access.stall_ns) ? sum.access.stall_ns : null
  const totalAccesses = typeof sum?.access?.count === 'number' && !isNaN(sum.access.count) ? sum.access.count : null

  // 3. Traffic volume: null if not measured
  const remoteTrafficBytes = typeof sum?.traffic?.remote_read_bytes === 'number' && !isNaN(sum.traffic.remote_read_bytes)
    ? sum.traffic.remote_read_bytes
    : (typeof summary.remote_read_bytes === 'number' && !isNaN(summary.remote_read_bytes) ? summary.remote_read_bytes : null)
  const remoteWriteBytes = typeof sum?.traffic?.remote_write_bytes === 'number' && !isNaN(sum.traffic.remote_write_bytes)
    ? sum.traffic.remote_write_bytes
    : (typeof summary.remote_write_bytes === 'number' && !isNaN(summary.remote_write_bytes) ? summary.remote_write_bytes : null)
  const migrationBytes = typeof sum?.traffic?.migration_bytes === 'number' && !isNaN(sum.traffic.migration_bytes)
    ? sum.traffic.migration_bytes
    : (typeof summary.migration_bytes === 'number' && !isNaN(summary.migration_bytes) ? summary.migration_bytes : null)
  const prefetchAccuracy = typeof sum?.traffic?.prefetch_accuracy === 'number' && !isNaN(sum.traffic.prefetch_accuracy)
    ? sum.traffic.prefetch_accuracy
    : null

  const reqSummary = sum?.requests as Record<string, unknown> | undefined
  const throughputPerS = typeof reqSummary?.throughput_per_s === 'number' && !isNaN(reqSummary.throughput_per_s)
    ? reqSummary.throughput_per_s
    : null

  // 4. Fabric utilization and queue depth: derived mathematically from link stats when present, otherwise null.
  // Note: 0.0 is a valid measured zero, not unavailable.
  let maxFabricUtil: number | null = null
  let peakQueue: number | null = null
  if (sum?.links && typeof sum.links === 'object') {
    const linkEntries = Object.values(sum.links)
    if (linkEntries.length > 0) {
      linkEntries.forEach((l) => {
        if (l && typeof l === 'object') {
          const link = l as Record<string, unknown>
          if (typeof link.max_queue_bytes === 'number' && !isNaN(link.max_queue_bytes)) {
            peakQueue = peakQueue === null ? link.max_queue_bytes : Math.max(peakQueue, link.max_queue_bytes)
          }
          if (typeof link.utilization === 'number' && !isNaN(link.utilization)) {
            maxFabricUtil = maxFabricUtil === null ? link.utilization : Math.max(maxFabricUtil, link.utilization)
          }
        }
      })
    }
  }

  // Preserve fallback to summary.fabric_utilization if not provided by links
  if (maxFabricUtil === null && typeof summary.fabric_utilization === 'number' && !isNaN(summary.fabric_utilization)) {
    maxFabricUtil = summary.fabric_utilization
  }

  // Local memory bandwidth utilization: strictly from summary.memory[node-id].bandwidth_utilization
  let maxMemBwUtil: number | null = null
  if (sum?.memory && typeof sum.memory === 'object') {
    const memEntries = Object.values(sum.memory)
    memEntries.forEach((m) => {
      if (m && typeof m === 'object') {
        const mem = m as Record<string, unknown>
        if (typeof mem.bandwidth_utilization === 'number' && !isNaN(mem.bandwidth_utilization)) {
          maxMemBwUtil = maxMemBwUtil === null ? mem.bandwidth_utilization : Math.max(maxMemBwUtil, mem.bandwidth_utilization)
        }
      }
    })
  }

  // Remote pool utilization: strictly from summary.pool.utilization or summary.pools[pool-id].utilization
  let poolUtil: number | null = null
  const poolSingle = sum?.pool as Record<string, unknown> | undefined
  if (poolSingle && typeof poolSingle.utilization === 'number' && !isNaN(poolSingle.utilization)) {
    poolUtil = poolSingle.utilization
  } else if (sum?.pools && typeof sum.pools === 'object') {
    const poolEntries = Object.values(sum.pools)
    poolEntries.forEach((p) => {
      if (p && typeof p === 'object') {
        const pool = p as Record<string, unknown>
        if (typeof pool.utilization === 'number' && !isNaN(pool.utilization)) {
          poolUtil = poolUtil === null ? pool.utilization : Math.max(poolUtil, pool.utilization)
        }
      }
    })
  }

  // 5. Time series mapping (Lossless preservation of backend SeriesPoint fields)
  // Per-window latency, queue depth, and utilization are NOT fabricated from summary values.
  const pageSize = sum?.workload?.page_size_bytes || man?.page_size_bytes
  let prevTNs: number | null = null
  const timeSeries: TimeSeriesPoint[] = (series || []).map((sp) => {
    let localOccupancy: number | null = null
    if (pageSize && sp.local_used_pages && typeof sp.local_used_pages === 'object') {
      const totalPages = Object.values(sp.local_used_pages).reduce((a, b) => a + (Number(b) || 0), 0)
      localOccupancy = totalPages * pageSize
    }
    let remoteOccupancy: number | null = null
    if (pageSize && typeof sp.pool_used_pages === 'number') {
      remoteOccupancy = sp.pool_used_pages * pageSize
    }

    // Fabric bandwidth calculation from authentic window link_bytes:
    // link_bytes is an object mapping link_id -> bytes transferred during this sampling window.
    // The window duration delta_t = sp.t_ns - prevTNs.
    // Bandwidth in GB/s (bytes/ns): sum(link_bytes) / delta_t.
    let fabricBw: number | null = null
    const deltaTNs = prevTNs !== null ? (sp.t_ns - prevTNs) : sp.t_ns
    prevTNs = sp.t_ns

    if (sp.link_bytes && typeof sp.link_bytes === 'object' && Object.keys(sp.link_bytes).length > 0 && deltaTNs > 0) {
      const totalLinkBytes = Object.values(sp.link_bytes).reduce((acc, b) => acc + (Number(b) || 0), 0)
      fabricBw = parseFloat((totalLinkBytes / deltaTNs).toFixed(3))
    }

    const timeFormatted = sp.t_ns >= 1_000_000_000
      ? `${(sp.t_ns / 1_000_000_000).toFixed(1)}s`
      : `${(sp.t_ns / 1_000_000).toFixed(0)} ms`

    return {
      time_ns: sp.t_ns,
      time_formatted: timeFormatted,
      accesses: sp.accesses,
      evictions: sp.evictions,
      completed: sp.completed,
      local_used_pages: sp.local_used_pages,
      pool_used_pages: sp.pool_used_pages,
      pools_used_pages: sp.pools_used_pages,
      link_bytes: sp.link_bytes,
      local_occupancy_bytes: localOccupancy,
      remote_occupancy_bytes: remoteOccupancy,
      fabric_bandwidth_bytes_per_ns: fabricBw
      // Per-window latency and summary utilization are intentionally omitted
    }
  })

  // 6. Identity and metadata (null when absent, never defaulted to 0 or new Date())
  const effectivePolicy = (summary.policy?.effective || summary.policy?.requested || 'unknown') as PolicyName
  const isDemo = summary.is_demo === true
  const seed = summary.seed !== undefined && summary.seed !== null ? summary.seed : (typeof sum?.seed === 'number' ? sum.seed : null)
  const durationNs = typeof sum?.time?.virtual_time_ns === 'number' ? sum.time.virtual_time_ns : null
  const createdAt = summary.created_at ?? (typeof sum?.created_at === 'string' ? sum.created_at : null)
  const scenarioHash = summary.scenario_hash ?? (typeof man?.scenario_hash === 'string' ? man.scenario_hash : null)
  const scenarioName = summary.scenario_name ?? (typeof sum?.scenario === 'string' ? sum.scenario : null)
  const runError = summary.error || (typeof detail?.error === 'string' ? detail.error : null)

  // 7. Scenario snapshot: only if authentic scenario document is present, never manufactured
  const rawScenario = detail?.scenario ||
    (detail as unknown as Record<string, unknown> | undefined)?.scenario_snapshot ||
    summary.scenario_snapshot
  const scenarioSnapshot: ScenarioConfig | null = rawScenario && typeof rawScenario === 'object' && Object.keys(rawScenario).length > 0 ? (rawScenario as ScenarioConfig) : null

  return {
    id: summary.run_id,
    scenario_name: scenarioName,
    scenario_hash: scenarioHash,
    workload_profile: (sum?.workload_label as WorkloadProfile) || null,
    policy_name: effectivePolicy,
    policy_display_name: isDemo ? `[Demo] ${effectivePolicy}` : effectivePolicy,
    seed,
    duration_ns: durationNs,
    status: summary.status === 'completed' ? 'completed' : 'failed',
    created_at: createdAt,
    is_demo: isDemo,
    engine_version: (man?.rmemfab_version as string) || (sum?.rmemfab_version as string) || null,
    trace_hash: (man?.trace_hashes as string[])?.[0] || null,
    percentile_interpolation: (man?.percentile_method as string) || null,
    error: runError,
    metrics: {
      latency_ns: { p50, p90, p95, p99, mean, max },
      stall_time_ns: stallTimeNs,
      local_hit_ratio: localHitRatio,
      remote_hit_ratio: remoteHitRatio,
      miss_ratio: missRatio,
      remote_traffic_bytes: remoteTrafficBytes,
      remote_write_bytes: remoteWriteBytes,
      migration_bytes: migrationBytes,
      prefetch_accuracy: prefetchAccuracy,
      fabric_utilization: maxFabricUtil,
      peak_queue_depth_bytes: peakQueue,
      total_accesses: totalAccesses,
      memory_bandwidth_utilization: maxMemBwUtil,
      pool_utilization: poolUtil,
      throughput_per_s: throughputPerS
    },
    time_series: timeSeries,
    bottleneck: null, // Engine does not produce heuristic bottleneck assertions
    scenario_snapshot: scenarioSnapshot
  }
}
