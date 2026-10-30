/**
 * Telemetry and Simulation Run Types
 */

import type { PolicyName, WorkloadProfile, ScenarioConfig } from './scenario'

export type RunStatus = 'completed' | 'running' | 'failed'

export interface LatencyPercentiles {
  p50: number
  p90?: number
  p95: number
  p99: number
  mean: number
  max: number
}

export interface MetricSummary {
  latency_ns: LatencyPercentiles
  stall_time_ns: number
  local_hit_ratio: number
  remote_hit_ratio: number
  miss_ratio: number
  remote_traffic_bytes: number
  migration_bytes: number
  prefetch_accuracy?: number
  fabric_utilization: number
  peak_queue_depth_bytes: number
  total_accesses: number
}

export interface TimeSeriesPoint {
  time_ns: number
  time_formatted: string
  p50_latency_ns: number
  p95_latency_ns: number
  p99_latency_ns: number
  local_occupancy_bytes: number
  remote_occupancy_bytes: number
  fabric_bandwidth_bytes_per_ns: number
  fabric_utilization_pct: number
  queue_depth_bytes: number
  migrations_active: number
}

export interface BottleneckAnalysis {
  severity: 'low' | 'medium' | 'high' | 'critical'
  primary_bottleneck: string
  explanation: string
  suggested_policy_tuning: string
}

export interface SimulationRun {
  id: string
  scenario_name: string
  scenario_hash: string
  workload_profile: WorkloadProfile
  policy_name: PolicyName
  policy_display_name: string
  seed: number
  duration_ns: number
  status: RunStatus
  created_at: string
  metrics: MetricSummary
  time_series: TimeSeriesPoint[]
  bottleneck: BottleneckAnalysis
  scenario_snapshot: ScenarioConfig
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
