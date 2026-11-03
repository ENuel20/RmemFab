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
    p99: null,
    mean: null,
    max: null,
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

test('7. Per-window fabric bandwidth is derived from recorded link bytes over measured window duration', () => {
  const summary = createMinimalSummary('live-run-107')
  const detail: RunDetail = {
    run_id: 'live-run-107',
    status: 'completed',
    summary: {},
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
      link_bytes: { 'l0': 0 }
    },
    {
      t_ns: 1000000,
      accesses: 25,
      evictions: 1,
      completed: 24,
      local_used_pages: { 'node-0': 8 },
      pool_used_pages: 20,
      link_bytes: { 'l0': 3000, 'l1': 1000 }
    }
  ]

  const run = adaptRunSummaryToSimulationRun(summary, detail, rawSeries)

  assert.equal(run.time_series.length, 2)
  // First point has no prior timestamp: no rate exists, never defaulted
  assert.equal(run.time_series[0].fabric_bandwidth_bytes_per_ns, undefined)
  // (3000 + 1000) bytes / 1000000 ns = 0.004 bytes/ns
  assert.equal(run.time_series[1].fabric_bandwidth_bytes_per_ns, 0.004)
})

test('8. Serving telemetry maps TTFT/TPOT/ITL/compute from detail, null when the run predates it', () => {
  const summary = createMinimalSummary('live-run-107')
  const detail: RunDetail = {
    run_id: 'live-run-107',
    status: 'completed',
    summary: {
      serving: {
        ttft_ns: { p50: 1000, p95: 2000, p99: 3000, mean: 1500, count: 4 },
        tpot_ns: 250,
        itl_ns: { p50: 200, p95: 400, p99: 500 },
        compute_ns: 8000,
        compute_prefill_ns: 6000,
        compute_decode_ns: 2000
      },
      requests: { latency_ns: { mean: 5000, count: 4 } }
    },
    manifest: {},
    error: null
  }

  const run = adaptRunSummaryToSimulationRun(summary, detail, [])
  assert.equal(run.serving?.ttft_p50, 1000)
  assert.equal(run.serving?.ttft_p99, 3000)
  assert.equal(run.serving?.ttft_mean, 1500)
  assert.equal(run.serving?.ttft_count, 4)
  assert.equal(run.serving?.tpot_ns, 250)
  assert.equal(run.serving?.itl_p99, 500)
  assert.equal(run.serving?.compute_ns, 8000)
  assert.equal(run.serving?.compute_prefill_ns, 6000)
  assert.equal(run.serving?.compute_decode_ns, 2000)
  assert.equal(run.serving?.request_latency_mean, 5000)
  assert.equal(run.serving?.request_latency_count, 4)

  // Runs produced before the serving section existed stay null, never zero-filled.
  const legacy = adaptRunSummaryToSimulationRun(summary, { ...DetailWithoutServing(detail) }, [])
  assert.equal(legacy.serving, null)
})

function DetailWithoutServing(detail: RunDetail): RunDetail {
  const summary = { ...(detail.summary as Record<string, unknown>) }
  delete summary.serving
  return { ...detail, summary }
}
test('9. List-strip tail latency (p99/mean/max) populates percentiles without detail fetch', () => {
  const summary = createMinimalSummary('live-run-108', {
    p50: 120, p95: 350, p99: 980, mean: 140, max: 1500
  })

  const run = adaptRunSummaryToSimulationRun(summary, null, [])

  assert.equal(run.metrics.latency_ns.p50, 120)
  assert.equal(run.metrics.latency_ns.p95, 350)
  assert.equal(run.metrics.latency_ns.p99, 980)
  assert.equal(run.metrics.latency_ns.mean, 140)
  assert.equal(run.metrics.latency_ns.max, 1500)
})

test('10. Recorded per-window latency maps to series points; empty windows stay undefined', () => {
  const summary = createMinimalSummary('live-run-109')
  const detail: RunDetail = {
    run_id: 'live-run-109',
    status: 'completed',
    summary: {},
    manifest: {},
    error: null
  }
  const base = {
    accesses: 10,
    evictions: 0,
    completed: 10,
    local_used_pages: { 'node-0': 5 },
    pool_used_pages: 15,
    link_bytes: {}
  }
  const rawSeries: SeriesPoint[] = [
    { t_ns: 0, ...base },
    {
      t_ns: 1000000, ...base,
      latency_ns: { count: 4, mean: 150, min: 100, max: 300, p50: 120, p95: 280, p99: 300 }
    },
    {
      t_ns: 2000000, ...base,
      latency_ns: { count: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 }
    }
  ]

  const run = adaptRunSummaryToSimulationRun(summary, detail, rawSeries)

  assert.equal(run.time_series.length, 3)
  // No recorded window stats: nothing mapped (test 3 behaviour preserved)
  assert.equal(run.time_series[0].p50_latency_ns, undefined)
  assert.equal(run.time_series[0].p99_latency_ns, undefined)
  // Recorded window: exact passthrough
  assert.equal(run.time_series[1].p50_latency_ns, 120)
  assert.equal(run.time_series[1].p95_latency_ns, 280)
  assert.equal(run.time_series[1].p99_latency_ns, 300)
  // Empty window: count 0 means no measurement, never a zero line
  assert.equal(run.time_series[2].p50_latency_ns, undefined)
  assert.equal(run.time_series[2].p95_latency_ns, undefined)
  assert.equal(run.time_series[2].p99_latency_ns, undefined)
})
