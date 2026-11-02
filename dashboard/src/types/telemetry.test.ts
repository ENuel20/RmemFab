import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adaptRunSummaryToSimulationRun,
  type RunSummary,
  type RunDetail,
  type SeriesPoint
} from './telemetry.ts'

function createMinimalSummary(id: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: id,
    scenario_name: null,
    scenario_hash: null,
    seed: null,
    policy: { name: 'hot_cold', display_name: 'Hot/Cold Tiering' },
    status: 'completed',
    error: null,
    arrived: null,
    completed: null,
    rejected: null,
    p50: null,
    p95: null,
    remote_read_bytes: null,
    migration_bytes: null,
    created_at: null,
    is_demo: false,
    ...overrides
  }
}

test('1. Missing measurements in engine summary remain null/unavailable, never fabricated as 0', () => {
  const summary = createMinimalSummary('live-run-101')
  const detail: RunDetail = {
    run_id: 'live-run-101',
    status: 'completed',
    summary: {},
    manifest: {},
    error: null
  }

  const run = adaptRunSummaryToSimulationRun(summary, detail, [])

  assert.equal(run.metrics.latency_ns.p50, null)
  assert.equal(run.metrics.latency_ns.p95, null)
  assert.equal(run.metrics.latency_ns.p99, null)
  assert.equal(run.metrics.latency_ns.mean, null)
  assert.equal(run.metrics.fabric_utilization, null)
  assert.equal(run.metrics.local_hit_ratio, null)
  assert.equal(run.metrics.remote_hit_ratio, null)
  assert.equal(run.metrics.miss_ratio, null)
  assert.equal(run.metrics.remote_traffic_bytes, null)
  assert.equal(run.metrics.migration_bytes, null)
  assert.equal(run.metrics.stall_time_ns, null)
  assert.equal(run.metrics.peak_queue_depth_bytes, null)
})

test('2. Missing timestamps, seeds, and scenario metadata remain null (no new Date(), no default 0/42)', () => {
  const summary = createMinimalSummary('live-run-102')
  const detail: RunDetail = {
    run_id: 'live-run-102',
    status: 'completed',
    summary: {},
    manifest: {},
    error: null
  }

  const run = adaptRunSummaryToSimulationRun(summary, detail, [])

  assert.equal(run.created_at, null)
  assert.equal(run.seed, null)
  assert.equal(run.duration_ns, null)
  assert.equal(run.scenario_name, null)
  assert.equal(run.scenario_hash, null)
  assert.equal(run.scenario_snapshot, null)
  assert.equal(run.bottleneck, null)
})

test('3. No per-window latency or summary utilization is fabricated into time series points', () => {
  const summary = createMinimalSummary('live-run-103', { p50: 120, p95: 350 })
  const detail: RunDetail = {
    run_id: 'live-run-103',
    status: 'completed',
    summary: {
      access: { latency_ns: { p50: 120, p95: 350, p99: 980, mean: 140 } },
      fabric_utilization: 0.75,
      peak_queue_depth_bytes: 8192
    },
    manifest: {},
    error: null
  }
  const rawSeries: SeriesPoint[] = [
    {
      t_ns: 0,
      accesses: 10,
      evictions: 0,
      completed: 10,
      local_used_pages: { 'node-0': 5 },
      pool_used_pages: 15,
      link_bytes: {}
    },
    {
      t_ns: 1000000,
      accesses: 25,
      evictions: 1,
      completed: 24,
      local_used_pages: { 'node-0': 8 },
      pool_used_pages: 20,
      link_bytes: {}
    }
  ]

  const run = adaptRunSummaryToSimulationRun(summary, detail, rawSeries)

  assert.equal(run.time_series.length, 2)
  for (const point of run.time_series) {
    // Latency must NOT be fabricated per-window from summary
    assert.equal(point.p50_latency_ns, undefined)
    assert.equal(point.p95_latency_ns, undefined)
    assert.equal(point.p99_latency_ns, undefined)

    // Summary utilization & queue depth must NOT be repeated in series points
    assert.equal(point.fabric_utilization_pct, undefined)
    assert.equal(point.queue_depth_bytes, undefined)
    assert.equal(point.migrations_active, undefined)
  }
})

test('4. Failed simulation status and error explanation are preserved', () => {
  const summary = createMinimalSummary('live-run-failed', {
    status: 'failed',
    error: 'OutOfMemory: DRAM exhausted on node 0'
  })
  const detail: RunDetail = {
    run_id: 'live-run-failed',
    status: 'failed',
    summary: null,
    manifest: null,
    error: 'OutOfMemory: DRAM exhausted on node 0'
  }

  const run = adaptRunSummaryToSimulationRun(summary, detail, [])

  assert.equal(run.status, 'failed')
  assert.equal(run.error, 'OutOfMemory: DRAM exhausted on node 0')
  assert.equal(run.bottleneck, null)
})

test('5. LIVE and DEMO runs remain strictly distinguishable', () => {
  const liveSummary = createMinimalSummary('live-run-104', { is_demo: false })
  const liveRun = adaptRunSummaryToSimulationRun(liveSummary, null, [])
  assert.equal(liveRun.is_demo, false)

  const demoSummary = createMinimalSummary('demo-run-105', { is_demo: true })
  const demoRun = adaptRunSummaryToSimulationRun(demoSummary, null, [])
  assert.equal(demoRun.is_demo, true)
})

test('6. Memory occupancy bytes are derived when page size is known, or remain null when unknown', () => {
  const summary = createMinimalSummary('live-run-106')
  const rawSeries: SeriesPoint[] = [
    {
      t_ns: 0,
      accesses: 10,
      evictions: 0,
      completed: 10,
      local_used_pages: { 'node-0': 10 },
      pool_used_pages: 20,
      link_bytes: {}
    }
  ]

  // With page size 4096 in manifest
  const detailWithPageSize: RunDetail = {
    run_id: 'live-run-106',
    status: 'completed',
    summary: {},
    manifest: { page_size_bytes: 4096 },
    error: null
  }
  const runWithPageSize = adaptRunSummaryToSimulationRun(
    summary,
    detailWithPageSize,
    rawSeries
  )
  assert.equal(runWithPageSize.time_series[0].local_occupancy_bytes, 10 * 4096)
  assert.equal(runWithPageSize.time_series[0].remote_occupancy_bytes, 20 * 4096)

  // Without page size
  const detailWithoutPageSize: RunDetail = {
    run_id: 'live-run-106',
    status: 'completed',
    summary: {},
    manifest: {},
    error: null
  }
  const runWithoutPageSize = adaptRunSummaryToSimulationRun(
    summary,
    detailWithoutPageSize,
    rawSeries
  )
  assert.equal(runWithoutPageSize.time_series[0].local_occupancy_bytes, null)
  assert.equal(runWithoutPageSize.time_series[0].remote_occupancy_bytes, null)
})

test('7. Fabric bandwidth is accurately calculated from link_bytes delta and interval', () => {
  const summary = createMinimalSummary('live-run-107')
  const detail: RunDetail = {
    run_id: 'live-run-107',
    status: 'completed',
    summary: {},
    manifest: {},
    error: null
  }
  const seriesWithLinkBytes: SeriesPoint[] = [
    {
      t_ns: 100000000,
      accesses: 100,
      evictions: 0,
      completed: 100,
      local_used_pages: { 'node-0': 10 },
      pool_used_pages: 0,
      link_bytes: { 'node-0-cxl': 0, 'node-1-cxl': 0 }
    },
    {
      t_ns: 200000000,
      accesses: 200,
      evictions: 5,
      completed: 195,
      local_used_pages: { 'node-0': 10 },
      pool_used_pages: 5,
      // 5,000,000,000 bytes over 100,000,000 ns = 50.0 GB/s (bytes/ns)
      link_bytes: { 'node-0-cxl': 3000000000, 'node-1-cxl': 2000000000 }
    }
  ]

  const run = adaptRunSummaryToSimulationRun(summary, detail, seriesWithLinkBytes)
  assert.equal(run.time_series[0].fabric_bandwidth_bytes_per_ns, 0)
  assert.equal(run.time_series[1].fabric_bandwidth_bytes_per_ns, 50.0)
})
