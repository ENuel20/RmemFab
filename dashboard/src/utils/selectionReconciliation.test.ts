import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  reconcileComparisonSelection,
  findDefaultComparisonPair,
  getMostRecentRun,
  reconcileSingleRunSelection
} from './selectionReconciliation.ts'
import type { SimulationRun } from '../types/telemetry.ts'

function createFakeRun(id: string, policy: string, scenarioName?: string): SimulationRun {
  return {
    id,
    scenario_name: scenarioName || id,
    scenario_hash: scenarioName || id,
    policy_name: policy,
    policy_display_name: policy,
    seed: 42,
    duration_ns: 1000000,
    status: 'completed',
    metrics: {
      latency_ns: { p50: 100, p95: 200, p99: 300 },
      local_hit_ratio: 1,
      remote_hit_ratio: 0,
      miss_ratio: 0,
      remote_traffic_bytes: 0,
      migration_bytes: 0,
      fabric_utilization: 0,
      stall_time_ns: 0
    },
    bottleneck: null,
    is_demo: false
  }
}

describe('Comparison Selection Reconciliation & State Stability', () => {
  const run1 = createFakeRun('run-live-swap', 'swap_remote')
  const run2 = createFakeRun('run-live-hotcold', 'hot_cold')
  const run3 = createFakeRun('run-live-freq', 'frequency_aware')
  const liveDataset = [run1, run2, run3]

  it('1. Selecting two LIVE runs: preserves selection and referential equality', () => {
    const selected = ['run-live-swap', 'run-live-hotcold']
    const reconciled = reconcileComparisonSelection(selected, liveDataset, false)

    // Must be identical array and referentially equal
    assert.equal(reconciled, selected)
    assert.deepEqual(reconciled, ['run-live-swap', 'run-live-hotcold'])
  })

  it('2. Deselecting and reselecting a run: honors user choice without force-reselection', () => {
    // User deselects run2, leaving only run1
    const oneSelected = ['run-live-swap']
    const reconciledOne = reconcileComparisonSelection(oneSelected, liveDataset, false)

    // Must NOT force-add run2 back
    assert.equal(reconciledOne, oneSelected)
    assert.deepEqual(reconciledOne, ['run-live-swap'])

    // User deselects all, leaving 0 runs
    const zeroSelected: string[] = []
    const reconciledZero = reconcileComparisonSelection(zeroSelected, liveDataset, false)
    assert.equal(reconciledZero, zeroSelected)
    assert.deepEqual(reconciledZero, [])

    // User re-selects run2
    const reselected = ['run-live-swap', 'run-live-hotcold']
    const reconciledBoth = reconcileComparisonSelection(reselected, liveDataset, false)
    assert.equal(reconciledBoth, reselected)
    assert.deepEqual(reconciledBoth, ['run-live-swap', 'run-live-hotcold'])
  })

  it('3. Refreshing/reloading the LIVE run dataset: does not update state when selection is unchanged', () => {
    const current = ['run-live-swap', 'run-live-hotcold']

    // Simulating multiple re-renders or dataset re-fetches
    const refreshedDataset = [...liveDataset]
    const pass1 = reconcileComparisonSelection(current, refreshedDataset, false)
    assert.equal(pass1, current, 'Pass 1 must return identical reference')

    const pass2 = reconcileComparisonSelection(pass1, refreshedDataset, false)
    assert.equal(pass2, current, 'Pass 2 must return identical reference')
  })

  it('4. Removing a run that was previously selected: prunes removed ID and keeps valid ones', () => {
    const previous = ['run-live-swap', 'run-live-hotcold', 'deleted-run-id']
    const reconciled = reconcileComparisonSelection(previous, liveDataset, false)

    assert.deepEqual(reconciled, ['run-live-swap', 'run-live-hotcold'])
    assert.equal(reconciled.includes('deleted-run-id'), false)
  })

  it('5. Initial live bootstrap: converts stale mock default IDs to available live runs once', () => {
    const initialMockDefaults = ['run-llama-cxl-swap', 'run-llama-cxl-hotcold']
    const reconciled = reconcileComparisonSelection(initialMockDefaults, liveDataset, false)

    // Replaces mock defaults with first 2 live runs
    assert.deepEqual(reconciled, ['run-live-swap', 'run-live-hotcold'])

    // But subsequent reconciliations do not create new references
    const secondPass = reconcileComparisonSelection(reconciled, liveDataset, false)
    assert.equal(secondPass, reconciled)
  })

  it('6. Stable comparison key: identical selections produce identical primitive keys avoiding loops', () => {
    const selected = ['run-live-hotcold', 'run-live-swap']
    const key1 = selected.slice().sort().join(',')
    const key2 = ['run-live-swap', 'run-live-hotcold'].slice().sort().join(',')

    assert.equal(key1, key2)
  })

  it('7. Scenario-aware pairing: pairs swap_remote and hot_cold from matching overcommit scenario', () => {
    const multiScenarioDataset = [
      createFakeRun('3cfbd2633541-s42-swap_remote', 'swap_remote', 'llama-70b-cxl'),
      createFakeRun('5a20bdf5956f-s42-swap_remote', 'swap_remote', 'llama-70b-cxl-overcommit'),
      createFakeRun('79e55a4f04f1-s42-hot_cold', 'hot_cold', 'llama-70b-cxl-overcommit'),
      createFakeRun('edc8c76dab09-s42-hot_cold', 'hot_cold', 'llama-70b-cxl')
    ]

    const pair = findDefaultComparisonPair(multiScenarioDataset)
    assert.deepEqual(pair, ['5a20bdf5956f-s42-swap_remote', '79e55a4f04f1-s42-hot_cold'])

    // Initial reconciliation should also pick this matching pair instead of naive [0, 1]
    const initialMockDefaults = ['run-llama-cxl-swap', 'run-llama-cxl-hotcold']
    const reconciled = reconcileComparisonSelection(initialMockDefaults, multiScenarioDataset, false)
    assert.deepEqual(reconciled, ['5a20bdf5956f-s42-swap_remote', '79e55a4f04f1-s42-hot_cold'])
  })

  it('8. Fallback pairing: pairs runs sharing the same scenario when overcommit is not present', () => {
    const baselineDataset = [
      createFakeRun('run-a1', 'swap_remote', 'llama-70b-cxl'),
      createFakeRun('run-b1', 'random_policy', 'other-scenario'),
      createFakeRun('run-a2', 'hot_cold', 'llama-70b-cxl')
    ]

    const pair = findDefaultComparisonPair(baselineDataset)
    assert.deepEqual(pair, ['run-a1', 'run-a2'])
  })
})

describe('Single Run Selection Reconciliation & Most Recent Ordering', () => {
  const runEarly = {
    ...createFakeRun('run-early', 'swap_remote', 'llama-70b-cxl'),
    created_at: '2026-11-02T04:29:17.000Z'
  }
  const runMid = {
    ...createFakeRun('run-mid', 'swap_remote', 'llama-70b-cxl'),
    created_at: '2026-11-02T06:56:33.000Z'
  }
  const runLatest = {
    ...createFakeRun('run-latest', 'hot_cold', 'llama-70b-cxl'),
    created_at: '2026-11-02T08:49:47.000Z'
  }
  const dataset = [runEarly, runMid, runLatest]

  it('1. getMostRecentRun handles empty array safely', () => {
    assert.equal(getMostRecentRun([]), undefined)
  })

  it('2. getMostRecentRun identifies run with newest timestamp regardless of array order', () => {
    // Reverse array order
    assert.equal(getMostRecentRun([runLatest, runEarly, runMid])?.id, 'run-latest')
    assert.equal(getMostRecentRun([runEarly, runMid, runLatest])?.id, 'run-latest')
  })

  it('3. getMostRecentRun safely falls back to first run if created_at is missing or null', () => {
    const runNoTime1 = createFakeRun('no-time-1', 'swap_remote')
    const runNoTime2 = createFakeRun('no-time-2', 'hot_cold')
    assert.equal(getMostRecentRun([runNoTime1, runNoTime2])?.id, 'no-time-1')
  })

  it('4. reconcileSingleRunSelection safely returns empty string when runs is empty', () => {
    assert.equal(reconcileSingleRunSelection('', []), '')
    assert.equal(reconcileSingleRunSelection('some-stale-id', []), '')
  })

  it('5. reconcileSingleRunSelection defaults to most recent run when no run is selected', () => {
    assert.equal(reconcileSingleRunSelection('', dataset), 'run-latest')
    assert.equal(reconcileSingleRunSelection(undefined, dataset), 'run-latest')
  })

  it('6. reconcileSingleRunSelection preserves existing valid user selection without overwriting', () => {
    // User selected runMid earlier
    assert.equal(reconcileSingleRunSelection('run-mid', dataset), 'run-mid')
    assert.equal(reconcileSingleRunSelection('run-early', dataset), 'run-early')
  })

  it('7. reconcileSingleRunSelection falls back to most recent run when previous selection is stale', () => {
    assert.equal(reconcileSingleRunSelection('deleted-stale-id', dataset), 'run-latest')
  })
})
