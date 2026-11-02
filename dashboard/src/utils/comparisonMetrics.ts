import type { SimulationRun } from '../types/telemetry'

export interface LatencyComparisonPoint {
  name: string
  p50: number | null
  p95: number | null
  p99: number | null
}

export interface HitRatioComparisonPoint {
  name: string
  localHitPct: number | null
  remoteHitPct: number | null
  missPct: number | null
}

export interface TrafficComparisonPoint {
  name: string
  remoteTrafficGb: number | null
  migrationGb: number | null
  fabricUtilPct: number | null
}

export interface ComparisonChartDatasets {
  latencyData: LatencyComparisonPoint[]
  hitRatioData: HitRatioComparisonPoint[]
  trafficData: TrafficComparisonPoint[]
}

/**
 * Prepares chart datasets from selected simulation runs, preserving null values.
 * Missing measurements are never converted to zero.
 */
export function prepareComparisonChartData(selectedRuns: SimulationRun[]): ComparisonChartDatasets {
  const latencyData: LatencyComparisonPoint[] = selectedRuns.map((r) => ({
    name: r.policy_name,
    p50: r.metrics.latency_ns.p50,
    p95: r.metrics.latency_ns.p95,
    p99: r.metrics.latency_ns.p99
  }))

  const hitRatioData: HitRatioComparisonPoint[] = selectedRuns.map((r) => ({
    name: r.policy_name,
    localHitPct: r.metrics.local_hit_ratio != null
      ? parseFloat((r.metrics.local_hit_ratio * 100).toFixed(1))
      : null,
    remoteHitPct: r.metrics.remote_hit_ratio != null
      ? parseFloat((r.metrics.remote_hit_ratio * 100).toFixed(1))
      : null,
    missPct: r.metrics.miss_ratio != null
      ? parseFloat((r.metrics.miss_ratio * 100).toFixed(1))
      : null
  }))

  const trafficData: TrafficComparisonPoint[] = selectedRuns.map((r) => ({
    name: r.policy_name,
    remoteTrafficGb: r.metrics.remote_traffic_bytes != null
      ? parseFloat((r.metrics.remote_traffic_bytes / (1024 ** 3)).toFixed(1))
      : null,
    migrationGb: r.metrics.migration_bytes != null
      ? parseFloat((r.metrics.migration_bytes / (1024 ** 3)).toFixed(1))
      : null,
    fabricUtilPct: r.metrics.fabric_utilization != null
      ? parseFloat((r.metrics.fabric_utilization * 100).toFixed(1))
      : null
  }))

  return { latencyData, hitRatioData, trafficData }
}

/**
 * Returns color for tail latency (p99).
 * Missing value receives neutral muted color, not good/bad threshold.
 */
export function getTailLatencyColor(p99: number | null | undefined): string {
  if (p99 === null || p99 === undefined || isNaN(p99)) {
    return 'var(--text-muted)'
  }
  return p99 > 500 ? 'var(--accent-rose)' : 'var(--text-primary)'
}

/**
 * Returns color for fabric utilization.
 * Missing value receives neutral muted color, not good/bad threshold.
 */
export function getFabricUtilColor(util: number | null | undefined): string {
  if (util === null || util === undefined || isNaN(util)) {
    return 'var(--text-muted)'
  }
  return util > 0.7 ? 'var(--accent-rose)' : 'var(--text-primary)'
}

/**
 * Returns color for median latency (p50).
 * Missing value receives neutral muted color.
 */
export function getMedianLatencyColor(p50: number | null | undefined): string {
  if (p50 === null || p50 === undefined || isNaN(p50)) {
    return 'var(--text-muted)'
  }
  return 'var(--accent-cyan)'
}

/**
 * Returns color for local hit ratio.
 * Missing value receives neutral muted color.
 */
export function getLocalHitRatioColor(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || isNaN(ratio)) {
    return 'var(--text-muted)'
  }
  return 'var(--accent-teal)'
}

