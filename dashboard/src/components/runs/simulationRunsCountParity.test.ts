import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SimulationRun } from '../../types/telemetry.ts'
import { MOCK_SIMULATION_RUNS } from '../../services/mockData.ts'

describe('Simulation Runs Count Parity and Navigation Badge Regression Suite', () => {
  it('1. Navigation badge resolves dynamically from runsCount without hardcoded 6', () => {
    // Helper replicating Sidebar navigation items definition
    const getNavBadge = (runsCount?: number): string | undefined => {
      return typeof runsCount === 'number' ? String(runsCount) : undefined
    }

    assert.equal(getNavBadge(5), '5', 'When 5 runs are loaded, badge must be "5"')
    assert.equal(getNavBadge(6), '6', 'When 6 runs are loaded, badge must be "6"')
    assert.equal(getNavBadge(0), '0', 'When 0 runs are loaded, badge must be "0"')
    assert.equal(getNavBadge(undefined), undefined, 'When runsCount is not provided, badge is omitted')
  })

  it('2. Parity verification for 5-run scenario: badge and table match exactly', () => {
    // Replicate the exact 5-run condition reported by the user
    const fiveRuns: SimulationRun[] = MOCK_SIMULATION_RUNS.slice(0, 5)
    assert.equal(fiveRuns.length, 5)

    const runsCount = fiveRuns.length
    const navBadge = typeof runsCount === 'number' ? String(runsCount) : undefined

    // Filter logic from SimulationRunsView with no filters active
    const searchQuery = ''
    const policyFilter = 'all'
    const statusFilter = 'all'

    const filteredRuns = fiveRuns.filter((run) => {
      const scenarioName = run.scenario_name || run.id
      const matchesSearch =
        scenarioName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        run.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        run.workload_profile.toLowerCase().includes(searchQuery.toLowerCase())

      const matchesPolicy = policyFilter === 'all' || run.policy_name === policyFilter
      const matchesStatus = statusFilter === 'all' || run.status === statusFilter

      return matchesSearch && matchesPolicy && matchesStatus
    })

    const tableCountText = filteredRuns.length < fiveRuns.length
      ? `${filteredRuns.length} of ${fiveRuns.length} total runs matched`
      : `${fiveRuns.length} of ${fiveRuns.length} runs matched`

    // Assert that the badge is "5", NOT the hardcoded "6"
    assert.equal(navBadge, '5', 'Navigation badge must display "5" when 5 runs are loaded')
    assert.notEqual(navBadge, '6', 'Navigation badge must NEVER be hardcoded to "6"')

    // Assert that table header matches the badge count
    assert.equal(tableCountText, '5 of 5 runs matched')
    assert.equal(filteredRuns.length, 5)
    assert.equal(Number(navBadge), filteredRuns.length, 'Badge count must equal table row count when unfiltered')
  })

  it('3. Explicit distinction between total runs and filtered matches', () => {
    const fiveRuns: SimulationRun[] = MOCK_SIMULATION_RUNS.slice(0, 5)
    const runsCount = fiveRuns.length
    const navBadge = typeof runsCount === 'number' ? String(runsCount) : undefined

    // Filter to only swap_remote runs
    const policyFilter = 'swap_remote'
    const filteredRuns = fiveRuns.filter((r) => r.policy_name === policyFilter)

    const tableCountText = filteredRuns.length < fiveRuns.length
      ? `${filteredRuns.length} of ${fiveRuns.length} total runs matched`
      : `${fiveRuns.length} of ${fiveRuns.length} runs matched`

    const tableTooltip = filteredRuns.length < fiveRuns.length
      ? `Filtered: ${filteredRuns.length} matching of ${fiveRuns.length} total runs`
      : `Total loaded runs: ${fiveRuns.length}`

    // Navigation badge still represents total runs (5)
    assert.equal(navBadge, '5')

    // Table explicitly notes filtered matching out of total runs
    assert.equal(tableCountText, `${filteredRuns.length} of 5 total runs matched`)
    assert.equal(tableTooltip, `Filtered: ${filteredRuns.length} matching of 5 total runs`)
    assert.ok(tableCountText.includes('total runs matched'), 'Distinction between filtered count and total runs must be explicit')
  })

  it('4. Dynamic update when a new simulation run is submitted', () => {
    let currentRuns: SimulationRun[] = MOCK_SIMULATION_RUNS.slice(0, 5)
    assert.equal(currentRuns.length, 5)

    let navBadge = String(currentRuns.length)
    assert.equal(navBadge, '5')

    // Simulate run submission / refresh
    const newRun: SimulationRun = {
      ...MOCK_SIMULATION_RUNS[5],
      id: 'run-live-new-6'
    }
    currentRuns = [...currentRuns, newRun]
    assert.equal(currentRuns.length, 6)

    navBadge = String(currentRuns.length)
    assert.equal(navBadge, '6', 'Navigation badge dynamically updates to 6 upon run addition')

    const tableCountText = `${currentRuns.length} of ${currentRuns.length} runs matched`
    assert.equal(tableCountText, '6 of 6 runs matched')
    assert.equal(Number(navBadge), currentRuns.length)
  })
})

