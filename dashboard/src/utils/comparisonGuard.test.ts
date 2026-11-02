import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateComparisonEligibility } from './comparisonGuard.ts'
import type { SimulationRun } from '../types/telemetry.ts'
import { MOCK_SIMULATION_RUNS } from '../services/mockData.ts'

// Base helper to create a clean clone of an eligible run
function createBaseRun(id: string, policy: string): SimulationRun {
  const base = JSON.parse(JSON.stringify(MOCK_SIMULATION_RUNS[0])) as SimulationRun
  base.id = id
  base.policy_name = policy as SimulationRun['policy_name']
  base.policy_display_name = policy
  base.scenario_snapshot.policy.name = policy as SimulationRun['policy_name']
  base.scenario_snapshot.policy.params = {}
  return base
}

test('1. Two runs with identical controlled variables and different policies → eligible', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, true)
  assert.equal(result.firstDifference, null)
  assert.equal(result.reason, null)
  assert.equal(result.isSingleSeed, true)
  assert.ok(result.checks.every((c) => c.status === 'match'))
})

test('2. Different seeds → refused; first field is seed', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  runB.seed = 99
  runB.scenario_snapshot.seed = 99

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'seed')
  assert.ok(result.reason?.includes('Random Seed mismatch'))
})

test('3. Different trace SHA-256 hashes → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  runA.scenario_snapshot.workload = {
    type: 'trace',
    path: 'traces/eval.jsonl',
    trace_hash: 'sha256:1111111111111111'
  }
  runB.scenario_snapshot.workload = {
    type: 'trace',
    path: 'traces/eval.jsonl',
    trace_hash: 'sha256:2222222222222222'
  }

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'trace_hash')
  assert.ok(result.reason?.includes('Trace content SHA-256 hashes differ'))
})

test('4. Same trace path but different hashes → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  runA.scenario_snapshot.workload = {
    type: 'trace',
    path: 'traces/shared_name.jsonl',
    trace_hash: 'sha256:aaaa'
  }
  runB.scenario_snapshot.workload = {
    type: 'trace',
    path: 'traces/shared_name.jsonl',
    trace_hash: 'sha256:bbbb'
  }

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'trace_hash')
})

test('5. Missing trace hash → refused as unknown', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  runA.scenario_snapshot.workload = {
    type: 'trace',
    path: 'traces/eval.jsonl',
    trace_hash: 'sha256:aaaa'
  }
  runB.scenario_snapshot.workload = {
    type: 'trace',
    path: 'traces/eval.jsonl'
    // Missing trace_hash
  }

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'trace_hash')
  const traceCheck = result.checks.find((c) => c.id === 'trace_hash')
  assert.equal(traceCheck?.status, 'unknown')
})

test('6. Different warmup durations → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  runB.scenario_snapshot.warmup_ns = 1000000

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'warmup_ns')
})

test('7. Different percentile definitions/interpolation → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  runB.scenario_snapshot.metrics = {
    ...runB.scenario_snapshot.metrics,
    percentiles: [50, 90, 99]
  }

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'percentiles')

  // Also test interpolation difference
  const runC = createBaseRun('run-c', 'hot_cold')
  const runD = createBaseRun('run-d', 'swap_remote')
  runC.percentile_interpolation = 'linear'
  runD.percentile_interpolation = 'nearest'
  const resultInterp = evaluateComparisonEligibility([runC, runD])
  assert.equal(resultInterp.eligible, false)
  assert.equal(resultInterp.firstDifference, 'percentiles')
})

test('8. Different page sizes → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  runB.scenario_snapshot.page_size_bytes = 4096

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'page_size_bytes')
})

test('9. Different engine versions → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  runA.engine_version = '0.1.0'
  runB.engine_version = '0.2.0'

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'engine_version')
})

test('10. Different head_dim → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  if (runB.scenario_snapshot.workload.type === 'synthetic' && runB.scenario_snapshot.workload.model) {
    runB.scenario_snapshot.workload.model.head_dim = 64
  }

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'workload_config')
})

test('11. Different dtype_bytes → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  if (runB.scenario_snapshot.workload.type === 'synthetic' && runB.scenario_snapshot.workload.model) {
    runB.scenario_snapshot.workload.model.dtype_bytes = 4
  }

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'workload_config')
})

test('12. Different prompt/generated token counts → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  if (runB.scenario_snapshot.workload.type === 'synthetic' && runB.scenario_snapshot.workload.requests) {
    runB.scenario_snapshot.workload.requests.prompt_tokens = 8192
  }

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'workload_config')
})

test('13. Different non-policy scenario configuration → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  // Mutate faults in runB
  runB.scenario_snapshot.faults = {
    node_failures: [{ time_ns: 1000, node: 'node-0' }]
  }

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'canonical_scenario')
})

test('14. Missing required scenario metadata → refused as unknown', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  // Strip snapshot
  // @ts-expect-error Testing missing snapshot
  delete runB.scenario_snapshot

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.ok(result.reason?.includes('could not be verified') || result.reason?.includes('missing'))
})

test('15. Mixed DEMO/LIVE runs → refused', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  runA.is_demo = true
  runB.is_demo = false

  const result = evaluateComparisonEligibility([runA, runB])
  assert.equal(result.eligible, false)
  assert.equal(result.firstDifference, 'mode_consistency')
  assert.ok(result.reason?.includes('Mixed DEMO'))
})

test('16. Three or four compatible runs → eligible', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  const runC = createBaseRun('run-c', 'local_only')
  const runD = createBaseRun('run-d', 'frequency_aware')

  const res3 = evaluateComparisonEligibility([runA, runB, runC])
  assert.equal(res3.eligible, true)

  const res4 = evaluateComparisonEligibility([runA, runB, runC, runD])
  assert.equal(res4.eligible, true)

  // 5 runs should be rejected due to maximum 4
  const runE = createBaseRun('run-e', 'predictive_prefetch')
  const res5 = evaluateComparisonEligibility([runA, runB, runC, runD, runE])
  assert.equal(res5.eligible, false)
  assert.equal(res5.firstDifference, 'run_count')
})

test('17. Single-seed eligible comparison shows directional flag', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  const res = evaluateComparisonEligibility([runA, runB])
  assert.equal(res.eligible, true)
  assert.equal(res.isSingleSeed, true)
})

test('18. Refused comparison has eligible=false preventing UI render', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  runB.duration_ns = 999999999

  const res = evaluateComparisonEligibility([runA, runB])
  assert.equal(res.eligible, false)
  assert.equal(res.firstDifference, 'duration_ns')
})

test('19. Missing percentile arrays cannot pass the guard', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  // Remove percentiles from runB
  delete runB.scenario_snapshot.metrics?.percentiles

  const res = evaluateComparisonEligibility([runA, runB])
  assert.equal(res.eligible, false)
  assert.equal(res.firstDifference, 'percentiles')
  const percCheck = res.checks.find((c) => c.id === 'percentiles')
  assert.equal(percCheck?.status, 'unknown')
  assert.ok(percCheck?.details.includes('missing or empty'))
})

test('20. Missing is_demo provenance metadata cannot silently classify as LIVE', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  // Run with non-demo-prefix ID and no is_demo flag
  runA.id = 'arbitrary-backend-uuid-001'
  runA.policy_display_name = 'Live Hot/Cold'
  delete runA.is_demo

  runB.id = 'arbitrary-backend-uuid-002'
  runB.policy_display_name = 'Live Swap'
  delete runB.is_demo

  const res = evaluateComparisonEligibility([runA, runB])
  assert.equal(res.eligible, false)
  assert.equal(res.firstDifference, 'mode_consistency')
  const modeCheck = res.checks.find((c) => c.id === 'mode_consistency')
  assert.equal(modeCheck?.status, 'unknown')
  assert.ok(modeCheck?.details.includes('Cannot verify data source mode'))
})

test('21. Synthetic mixed with trace workload is rejected without bypassing trace hash', () => {
  const runA = createBaseRun('run-a', 'hot_cold')
  const runB = createBaseRun('run-b', 'swap_remote')
  // runA is synthetic (default), runB is trace
  runB.scenario_snapshot.workload = {
    type: 'trace',
    path: 'traces/eval.jsonl',
    trace_hash: 'sha256:12345678'
  }

  const res = evaluateComparisonEligibility([runA, runB])
  assert.equal(res.eligible, false)
  assert.equal(res.firstDifference, 'trace_hash')
  assert.ok(res.reason?.includes('Mixed workload types detected'))
})


