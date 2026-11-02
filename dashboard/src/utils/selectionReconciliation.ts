import type { SimulationRun } from '../types/telemetry.ts'

/**
 * Finds a compatible pair of runs for policy comparison.
 * Prioritizes:
 * 1. A scenario containing both 'swap_remote' and 'hot_cold' (preferring overcommit scenarios).
 * 2. Any pair of runs sharing the same scenario_name or scenario_hash with different policies.
 * 3. Any pair of runs sharing the same scenario_name or scenario_hash.
 * 4. Fallback to first two runs.
 */
export function findDefaultComparisonPair(availableRuns: SimulationRun[]): [string, string] | null {
  if (availableRuns.length < 2) return null

  // Group by scenario_name or scenario_hash
  const groups = new Map<string, SimulationRun[]>()
  for (const r of availableRuns) {
    const key = r.scenario_name || r.scenario_hash || ''
    if (!key) continue
    const list = groups.get(key) || []
    list.push(r)
    groups.set(key, list)
  }

  const isSwap = (p: string) => p === 'swap_remote' || p.toLowerCase().includes('swap')
  const isHotCold = (p: string) => p === 'hot_cold' || p.toLowerCase().includes('hot')

  // 1. Prefer scenario with 'overcommit' having both swap and hot_cold
  for (const [key, list] of groups.entries()) {
    if (key.toLowerCase().includes('overcommit')) {
      const swap = list.find((r) => isSwap(r.policy_name))
      const hotCold = list.find((r) => isHotCold(r.policy_name))
      if (swap && hotCold && swap.id !== hotCold.id) {
        return [swap.id, hotCold.id]
      }
    }
  }

  // 2. Next check any group with both swap and hot_cold
  for (const [, list] of groups.entries()) {
    const swap = list.find((r) => isSwap(r.policy_name))
    const hotCold = list.find((r) => isHotCold(r.policy_name))
    if (swap && hotCold && swap.id !== hotCold.id) {
      return [swap.id, hotCold.id]
    }
  }

  // 3. Any group with at least two different policies
  for (const [, list] of groups.entries()) {
    if (list.length >= 2) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[i].policy_name !== list[j].policy_name) {
            return [list[i].id, list[j].id]
          }
        }
      }
      return [list[0].id, list[1].id]
    }
  }

  // 4. Fallback to first two runs
  return [availableRuns[0].id, availableRuns[1].id]
}

/**
 * Reconciles selected comparison run IDs against the currently available runs.
 *
 * Requirements:
 * 1. Maintain one clear source of truth for selected comparison run IDs.
 * 2. Only cause state updates when the selection actually changes (preserve referential equality).
 * 3. Prune IDs that no longer exist in the available runs dataset.
 * 4. Respect user deselection: do not force-reselect runs when a user deselects to 0 or 1 runs.
 * 5. Only auto-initialize on first entry/load when all previously selected IDs are invalid/mock
 *    and at least 2 valid live runs exist.
 */
export function reconcileComparisonSelection(
  prevSelected: string[],
  availableRuns: SimulationRun[],
  isMockMode: boolean = false
): string[] {
  if (isMockMode) {
    return prevSelected
  }

  const availableSet = new Set(availableRuns.map((r) => r.id))
  const valid = prevSelected.filter((id) => availableSet.has(id))

  // 1. If valid IDs match prevSelected in length and items, preserve reference
  if (valid.length === prevSelected.length) {
    let identical = true
    for (let i = 0; i < valid.length; i++) {
      if (valid[i] !== prevSelected[i]) {
        identical = false
        break
      }
    }
    if (identical) return prevSelected
  }

  // 2. If valid selection already has >= 2 runs, keep only the valid ones
  if (valid.length >= 2) {
    return valid
  }

  // 3. Initial load transition: all previous IDs were unknown/stale (e.g. initial mock IDs in LIVE mode)
  //    and we have at least 2 available runs to compare
  if (prevSelected.length > 0 && prevSelected.every((id) => !availableSet.has(id)) && availableRuns.length >= 2) {
    const pair = findDefaultComparisonPair(availableRuns)
    return pair ? pair : [availableRuns[0].id, availableRuns[1].id]
  }

  // 4. Otherwise preserve whatever valid IDs remain (0 or 1), honoring user deselection
  return valid
}

/**
 * Finds the most recent simulation run based on created_at timestamp,
 * safely falling back to the first available run if timestamps are missing.
 * Handles empty arrays safely.
 */
export function getMostRecentRun(availableRuns: SimulationRun[]): SimulationRun | undefined {
  if (!availableRuns || availableRuns.length === 0) return undefined
  let latestRun: SimulationRun = availableRuns[0]
  let latestTime = -Infinity

  for (const run of availableRuns) {
    if (run.created_at) {
      const t = Date.parse(run.created_at)
      if (!isNaN(t) && t > latestTime) {
        latestTime = t
        latestRun = run
      }
    }
  }

  return latestRun
}

/**
 * Reconciles a single selected run ID (e.g. for Infrastructure inspection)
 * against available runs.
 *
 * Requirements:
 * 1. Safely handle empty runs array.
 * 2. Do not overwrite a valid user selection when the runs list refreshes.
 * 3. When no run has been selected or previous selection is stale, default to the most recent run.
 */
export function reconcileSingleRunSelection(
  currentSelectedId: string | undefined | null,
  availableRuns: SimulationRun[]
): string {
  if (!availableRuns || availableRuns.length === 0) return ''
  if (currentSelectedId && availableRuns.some((r) => r.id === currentSelectedId)) {
    return currentSelectedId
  }
  const mostRecent = getMostRecentRun(availableRuns)
  return mostRecent?.id || availableRuns[0]?.id || ''
}
