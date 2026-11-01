import test from 'node:test'
import assert from 'node:assert/strict'
import type { SimulationRun } from '../types/telemetry.ts'
import {
  prepareComparisonChartData,
  getTailLatencyColor,
  getFabricUtilColor,
  getMedianLatencyColor,
  getLocalHitRatioColor
} from './comparisonMetrics.ts'

function createMockRun(id: string, policy: string, overrides: Partial<SimulationRun['metrics']> = {}): SimulationRun {
  return {
    id,
    scenario_name: 'llama-cxl',
    scenario_hash: 'sha256:abc',
    policy_name: policy,
    policy_display_name: policy,
    seed: 42,
    duration_ns: 1000000,
    status: 'completed',
    created_at: '2026-01-01T00:00:00Z',
    is_demo: true,
    time_series: [],
    bottleneck: null,
    metrics: {
      latency_ns: { p50: null, p95: null, p99: null, mean: null, max: null },
      stall_time_ns: null,
      local_hit_ratio: null,
      remote_hit_ratio: null,
      miss_ratio: null,
      remote_traffic_bytes: null,
      migration_bytes: null,
      fabric_utilization: null,
      peak_queue_depth_bytes: null,
      total_accesses: null,
      ...overrides
    }
  }
}

test('1. Null latency values in comparison datasets are preserved as null, never converted to 0', () => {
  const runA = createMockRun('run-a', 'hot_cold', {
    latency_ns: { p50: null, p95: null, p99: null, mean: null, max: null }
  })
  const runB = createMockRun('run-b', 'swap_remote', {
    latency_ns: { p50: 125, p95: 250, p99: 450, mean: 130, max: 500 }
  })

  const { latencyData } = prepareComparisonChartData([runA, runB])

  assert.equal(latencyData.length, 2)
  assert.equal(latencyData[0].p50, null)
  assert.equal(latencyData[0].p95, null)
  assert.equal(latencyData[0].p99, null)
  assert.notEqual(latencyData[0].p50, 0)
  assert.notEqual(latencyData[0].p95, 0)
  assert.notEqual(latencyData[0].p99, 0)

  // Verify non-null values remain intact
  assert.equal(latencyData[1].p50, 125)
  assert.equal(latencyData[1].p95, 250)
  assert.equal(latencyData[1].p99, 450)
})

test('2. Null ratios and traffic values in comparison datasets remain null/unavailable', () => {
  const runA = createMockRun('run-a', 'hot_cold', {
    local_hit_ratio: null,
    remote_hit_ratio: null,
    miss_ratio: null,
    remote_traffic_bytes: null,
    migration_bytes: null,
    fabric_utilization: null
  })
  const runB = createMockRun('run-b', 'swap_remote', {
    local_hit_ratio: 0.852,
    remote_hit_ratio: 0.123,
    miss_ratio: 0.025,
    remote_traffic_bytes: 2147483648, // 2.0 GiB
    migration_bytes: 1073741824, // 1.0 GiB
    fabric_utilization: 0.45
  })

  const { hitRatioData, trafficData } = prepareComparisonChartData([runA, runB])

  // Run A must preserve nulls
  assert.equal(hitRatioData[0].localHitPct, null)
  assert.equal(hitRatioData[0].remoteHitPct, null)
  assert.equal(hitRatioData[0].missPct, null)
  assert.equal(trafficData[0].remoteTrafficGb, null)
  assert.equal(trafficData[0].migrationGb, null)
  assert.equal(trafficData[0].fabricUtilPct, null)

  // Run B must compute accurately
  assert.equal(hitRatioData[1].localHitPct, 85.2)
  assert.equal(hitRatioData[1].remoteHitPct, 12.3)
  assert.equal(hitRatioData[1].missPct, 2.5)
  assert.equal(trafficData[1].remoteTrafficGb, 2.0)
  assert.equal(trafficData[1].migrationGb, 1.0)
  assert.equal(trafficData[1].fabricUtilPct, 45.0)
})

test('3. Missing values do not receive threshold-based status colors (receive neutral muted color)', () => {
  // Tail latency (p99)
  assert.equal(getTailLatencyColor(null), 'var(--text-muted)')
  assert.equal(getTailLatencyColor(undefined), 'var(--text-muted)')
  assert.notEqual(getTailLatencyColor(null), 'var(--accent-rose)')
  assert.notEqual(getTailLatencyColor(null), 'var(--text-primary)')

  // Fabric utilization
  assert.equal(getFabricUtilColor(null), 'var(--text-muted)')
  assert.equal(getFabricUtilColor(undefined), 'var(--text-muted)')
  assert.notEqual(getFabricUtilColor(null), 'var(--accent-rose)')
  assert.notEqual(getFabricUtilColor(null), 'var(--text-primary)')

  // Median latency (p50) & local hit ratio
  assert.equal(getMedianLatencyColor(null), 'var(--text-muted)')
  assert.equal(getLocalHitRatioColor(null), 'var(--text-muted)')
})

test('4. Numeric values receive appropriate threshold colors when validly measured', () => {
  // Tail latency threshold: > 500 ns
  assert.equal(getTailLatencyColor(750), 'var(--accent-rose)')
  assert.equal(getTailLatencyColor(200), 'var(--text-primary)')

  // Fabric utilization threshold: > 70% (0.7)
  assert.equal(getFabricUtilColor(0.85), 'var(--accent-rose)')
  assert.equal(getFabricUtilColor(0.35), 'var(--text-primary)')

  // Median latency & local hit ratio
  assert.equal(getMedianLatencyColor(140), 'var(--accent-cyan)')
  assert.equal(getLocalHitRatioColor(0.8), 'var(--accent-teal)')
})

