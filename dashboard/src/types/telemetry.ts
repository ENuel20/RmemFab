/**
 * Telemetry and Simulation Run Types
 * Directly aligned with PRODUCT-SPEC §4 and backend API contract (docs/API.md)
 */

import type { PolicyName, ScenarioConfig } from './scenario'

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
  p99: number | null
  mean: number | null
  max: number | null
  local_hit_ratio: number | null
  remote_hit_ratio: number | null
  fabric_utilization: number | null
  remote_read_bytes: number | null
  migration_bytes: number | null
  created_at: string | null
  is_demo?: boolean
}

export interface RunDetail {
  run_id: string
  status: 'completed' | 'failed'
  summary: Record<string, unknown> | null
  manifest: Record<string, unknown> | null
  scenario?: ScenarioConfig | null
  error: string | null
}

export interface WindowLatency {
  count: number
  mean?: number
  min?: number
  max?: number
  p50?: number
  p90?: number
  p95?: number
  p99?: number
}

export interface SeriesPoint {
  t_ns: number
  accesses: number
  evictions: number
  completed: number
  degraded?: number
  local_used_pages: Record<string, number>
  pool_used_pages: number
  pools_used_pages?: Record<string, number>
  link_bytes: Record<string, number>
  latency_ns?: WindowLatency
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
  workload_path?: string
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
  migration_bytes: number | null
  prefetch_accuracy?: number | null
  fabric_utilization: number | null
  peak_queue_depth_bytes: number | null
  total_accesses: number | null
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
  degraded?: number
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
  suggested_policy_tuning: string
}

export interface SimulationRun {
  id: string
  scenario_name: string | null
  scenario_hash: string | null
  workload_profile?: string | null
  policy_name: PolicyName | string
  policy_display_name: string
  seed: number | null
  duration_ns: number | null
  status: RunStatus
  created_at: string | null
  metrics: MetricSummary
  time_series: TimeSeriesPoint[]
  bottleneck: BottleneckAnalysis | null
  degraded?: DegradedSummary | null
  scenario_snapshot?: ScenarioConfig | null
  serving?: ServingTelemetry | null
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
  min?: number
  count?: number
}

interface EngineServing {
  ttft_ns?: EngineLatency
  ttft_all_ns?: EngineLatency
  tpot_ns?: number
  itl_ns?: EngineLatency
  compute_ns?: number
  compute_prefill_ns?: number
  compute_decode_ns?: number
}

interface EngineRequests {
  latency_ns?: EngineLatency
  completed?: number
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
  workload?: EngineWorkload
  workload_label?: string
  serving?: EngineServing
  requests?: EngineRequests
  time?: { virtual_time_ns?: number }
  rmemfab_version?: string
  created_at?: string
  policy?: { requested?: string; effective?: string; fallback_reason?: string }
  degraded?: unknown
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
  const p50 = typeof lat?.p50 === 'number' ? lat.p50 : (typeof summary.p50 === 'number' ? summary.p50 : null)
  const p90 = typeof lat?.p90 === 'number' ? lat.p90 : null
  const p95 = typeof lat?.p95 === 'number' ? lat.p95 : (typeof summary.p95 === 'number' ? summary.p95 : null)
  const p99 = typeof lat?.p99 === 'number' ? lat.p99 : (typeof summary.p99 === 'number' ? summary.p99 : null)
  const mean = typeof lat?.mean === 'number' ? lat.mean : (typeof summary.mean === 'number' ? summary.mean : null)
  const max = typeof lat?.max === 'number' ? lat.max : (typeof summary.max === 'number' ? summary.max : null)

  // 2. Access counters & ratios: detail first, list-strip fallback, null if not measured
  const localHitRatio = typeof sum?.access?.local_hit_ratio === 'number'
    ? sum.access.local_hit_ratio
    : (typeof summary.local_hit_ratio === 'number' ? summary.local_hit_ratio : null)
  const remoteHitRatio = typeof sum?.access?.remote_hit_ratio === 'number'
    ? sum.access.remote_hit_ratio
    : (typeof summary.remote_hit_ratio === 'number' ? summary.remote_hit_ratio : null)
  const missRatio = typeof sum?.access?.miss_ratio === 'number' ? sum.access.miss_ratio : null
  const stallTimeNs = typeof sum?.access?.stall_ns === 'number' ? sum.access.stall_ns : null
  const totalAccesses = typeof sum?.access?.count === 'number' ? sum.access.count : null

  // 3. Traffic volume: null if not measured
  const remoteTrafficBytes = typeof sum?.traffic?.remote_read_bytes === 'number'
    ? sum.traffic.remote_read_bytes
    : (typeof summary.remote_read_bytes === 'number' ? summary.remote_read_bytes : null)
  const migrationBytes = typeof sum?.traffic?.migration_bytes === 'number'
    ? sum.traffic.migration_bytes
    : (typeof summary.migration_bytes === 'number' ? summary.migration_bytes : null)
  const prefetchAccuracy = typeof sum?.traffic?.prefetch_accuracy === 'number' ? sum.traffic.prefetch_accuracy : null

  // 4. Fabric utilization and queue depth: derived mathematically from link stats when present,
  // list-strip fallback for utilization, otherwise null
  let maxUtil: number | null = null
  let peakQueue: number | null = null
  if (sum?.links && typeof sum.links === 'object') {
    const linkEntries = Object.values(sum.links)
    if (linkEntries.length > 0) {
      linkEntries.forEach((l) => {
        if (l && typeof l.max_queue_bytes === 'number') {
          peakQueue = Math.max(peakQueue ?? 0, l.max_queue_bytes)
        }
        if (l && typeof l.utilization === 'number') {
          maxUtil = Math.max(maxUtil ?? 0, l.utilization)
        }
      })
    }
  }
  if (maxUtil === null && typeof summary.fabric_utilization === 'number') {
    maxUtil = summary.fabric_utilization
  }

  // 5. Time series mapping (Lossless preservation of backend SeriesPoint fields)
  // Per-window latency, queue depth, and utilization are NOT fabricated from summary values.
  // Fabric bandwidth IS derived: recorded per-link per-window bytes divided by the
  // measured window duration is rate arithmetic on recorded data, not invention.
  const pageSize = sum?.workload?.page_size_bytes || man?.page_size_bytes
  const timeSeries: TimeSeriesPoint[] = (series || []).map((sp, idx, arr) => {
    let localOccupancy: number | null = null
    if (pageSize && sp.local_used_pages && typeof sp.local_used_pages === 'object') {
      const totalPages = Object.values(sp.local_used_pages).reduce((a, b) => a + (Number(b) || 0), 0)
      localOccupancy = totalPages * pageSize
    }
    let remoteOccupancy: number | null = null
    if (pageSize && typeof sp.pool_used_pages === 'number') {
      remoteOccupancy = sp.pool_used_pages * pageSize
    }
    let bandwidth: number | undefined
    if (idx > 0 && sp.link_bytes && typeof sp.link_bytes === 'object') {
      const dt = sp.t_ns - arr[idx - 1].t_ns
      if (dt > 0) {
        bandwidth = Object.values(sp.link_bytes).reduce((a, b) => a + (Number(b) || 0), 0) / dt
      }
    }
    // Recorded per-window latency only: count 0 (warmup/idle window) or a
    // missing block maps to undefined, never to a fabricated zero line.
    const win = sp.latency_ns && typeof sp.latency_ns === 'object' && sp.latency_ns.count > 0
      ? sp.latency_ns
      : null
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

    return {
      time_ns: sp.t_ns,
      time_formatted: `${(sp.t_ns / 1_000_000).toFixed(0)} ms`,
      accesses: sp.accesses,
      evictions: sp.evictions,
      completed: sp.completed,
      local_used_pages: sp.local_used_pages,
      pool_used_pages: sp.pool_used_pages,
      pools_used_pages: sp.pools_used_pages,
      link_bytes: sp.link_bytes,
      degraded: typeof sp.degraded === 'number' ? sp.degraded : 0,
      local_occupancy_bytes: localOccupancy,
      remote_occupancy_bytes: remoteOccupancy,
      fabric_bandwidth_bytes_per_ns: bandwidth,
      p50_latency_ns: win ? num(win.p50) : undefined,
      p95_latency_ns: win ? num(win.p95) : undefined,
      p99_latency_ns: win ? num(win.p99) : undefined
      // Summary utilization is intentionally not repeated in series points
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
  const rawScenario = (detail as unknown as Record<string, unknown> | undefined)?.scenario
  const scenarioSnapshot: ScenarioConfig | null = rawScenario && typeof rawScenario === 'object' ? (rawScenario as ScenarioConfig) : null

  // 8. Serving telemetry: TTFT/TPOT/ITL/compute from the serving section.
  // Null unless the run was produced by a compute-aware engine run; runs
  // produced before the serving section existed stay null, never zero-filled.
  const num = (v: unknown): number | null => (typeof v === 'number' && !Number.isNaN(v) ? v : null)
  const sv = sum?.serving
  const serving: ServingTelemetry | null = sv && typeof sv === 'object' ? {
    ttft_p50: num(sv.ttft_ns?.p50),
    ttft_p95: num(sv.ttft_ns?.p95),
    ttft_p99: num(sv.ttft_ns?.p99),
    ttft_mean: num(sv.ttft_ns?.mean),
    ttft_count: num(sv.ttft_ns?.count),
    tpot_ns: num(sv.tpot_ns),
    itl_p50: num(sv.itl_ns?.p50),
    itl_p95: num(sv.itl_ns?.p95),
    itl_p99: num(sv.itl_ns?.p99),
    compute_ns: num(sv.compute_ns),
    compute_prefill_ns: num(sv.compute_prefill_ns),
    compute_decode_ns: num(sv.compute_decode_ns),
    request_latency_mean: num(sum?.requests?.latency_ns?.mean),
    request_latency_count: num(sum?.requests?.latency_ns?.count)
  } : null

  return {
    id: summary.run_id,
    scenario_name: scenarioName,
    scenario_hash: scenarioHash,
    workload_profile: (typeof sum?.workload_label === 'string' ? sum.workload_label : null),
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
      migration_bytes: migrationBytes,
      prefetch_accuracy: prefetchAccuracy,
      fabric_utilization: maxUtil,
      peak_queue_depth_bytes: peakQueue,
      total_accesses: totalAccesses
    },
    time_series: timeSeries,
    bottleneck: null, // Engine does not produce heuristic bottleneck assertions
    degraded: parseDegraded(sum?.degraded),
    scenario_snapshot: scenarioSnapshot,
    serving
  }
}

export interface ServingTelemetry {
  ttft_p50: number | null
  ttft_p95: number | null
  ttft_p99: number | null
  ttft_mean: number | null
  ttft_count: number | null
  tpot_ns: number | null
  itl_p50: number | null
  itl_p95: number | null
  itl_p99: number | null
  compute_ns: number | null
  compute_prefill_ns: number | null
  compute_decode_ns: number | null
  request_latency_mean: number | null
  request_latency_count: number | null
}

function parseDegraded(raw: unknown): DegradedSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (!Array.isArray(d.windows)) return null
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return {
    windows: (d.windows as unknown[]).map((w) => {
      const o = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>
      return {
        type: String(o.type ?? ''),
        target: String(o.target ?? ''),
        start_ns: num(o.start_ns),
        end_ns: typeof o.end_ns === 'number' ? o.end_ns : null,
        reason: typeof o.reason === 'string' ? o.reason : null,
        bandwidth_factor: typeof o.bandwidth_factor === 'number' ? o.bandwidth_factor : null,
        latency_factor: typeof o.latency_factor === 'number' ? o.latency_factor : null
      }
    }),
    stalled_requests: num(d.stalled_requests),
    loss_events: num(d.loss_events),
    retransmissions: num(d.retransmissions),
    retransmit_bytes: num(d.retransmit_bytes),
    retransmit_delay_ns: num(d.retransmit_delay_ns),
    stalled_transfers: num(d.stalled_transfers),
    stalled_bytes: num(d.stalled_bytes)
  }
}

// --- Assistant, versions, faults (mirror docs/API.md) ---

export interface FaultWindow {
  type: string
  target: string
  start_ns: number
  end_ns: number | null
  reason: string | null
  bandwidth_factor: number | null
  latency_factor: number | null
}

export interface DegradedSummary {
  windows: FaultWindow[]
  stalled_requests: number
  loss_events: number
  retransmissions: number
  retransmit_bytes: number
  retransmit_delay_ns: number
  stalled_transfers: number
  stalled_bytes: number
}

export interface PatchOp {
  op: 'add' | 'remove' | 'replace'
  path: string
  value?: unknown
}

export interface SplitError {
  path: string
  message: string
}

export interface DraftResponse {
  scenario: ScenarioConfig
  version: string
  parent_version: string | null
  validation: { warnings: string[]; assumed: string[] }
  model: string
  usage: Record<string, unknown>
}

export interface ChatMessage {
  role: string
  content: string
}

export interface SuggestedPatch {
  ops: PatchOp[] | null
  valid: boolean
  errors: SplitError[]
  warnings?: string[]
  changes?: Array<{ path: string; before?: unknown; after?: unknown }>
}

export interface ChatResponse {
  content: string
  model: string
  run_id: string | null
  suggested_patch?: SuggestedPatch | null
}

export interface ApplyCompare {
  verdict: 'fair' | 'refused'
  reason?: string
  mode?: string
  [key: string]: unknown
}

export interface ApplyResponse {
  version: string
  parent_version: string | null
  parent_run_id: string | null
  run_id: string
  status: string
  compare: ApplyCompare | null
  validation: { warnings: string[]; assumed: string[] }
  changes?: Array<{ path: string; before?: unknown; after?: unknown }>
  model?: string
  usage?: Record<string, unknown>
  error?: string
}

export interface RollbackResponse {
  version: string
  run_id: string
  status: string
  to_version: string
  from_version: string | null
  validation: { warnings: string[]; assumed: string[] }
  error?: string
}

export interface VersionDetail {
  version: string
  parent_version: string | null
  parent_run_id?: string | null
  rollback_to?: string | null
  note?: string | null
  instruction?: string | null
  model?: string | null
  scenario: ScenarioConfig
}
