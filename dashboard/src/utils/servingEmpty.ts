/**
 * Empty-state copy for the Serving view.
 *
 * A missing serving section has three distinct causes, and only one of
 * them is fixed by re-running: the engine records serving telemetry only
 * when the scenario configures tokens_per_second on a compute node
 * (schema: exclusiveMinimum 0, mirrored here as > 0). Memory-only runs
 * never carry the section, however fresh the engine.
 */
import type { ScenarioConfig } from '../types/scenario'

function scenarioHasComputeTokens(snapshot: ScenarioConfig | null | undefined): boolean | null {
  if (!snapshot || !Array.isArray(snapshot.nodes)) return null
  return snapshot.nodes.some(
    (n) => typeof n.compute?.tokens_per_second === 'number' && n.compute.tokens_per_second > 0
  )
}

export function servingEmptyMessage(
  isMockMode: boolean,
  snapshot: ScenarioConfig | null | undefined
): string {
  if (isMockMode) {
    return 'Demo runs predate the serving model and carry no TTFT/TPOT record. Switch to Live mode and open a run produced by the compute-aware engine.'
  }
  const hasCompute = scenarioHasComputeTokens(snapshot)
  if (hasCompute === null) {
    return 'Serving telemetry is not available for this run: no serving section was recorded and the scenario snapshot is missing, so re-running may not help.'
  }
  if (!hasCompute) {
    return 'This scenario has no compute configuration, so the engine records no serving telemetry. Serving data (TTFT, pacing, compute time) needs tokens_per_second on a compute node — open a compute-configured run such as phase7-compute-serving.'
  }
  return 'This run was produced before the serving section existed. Re-run its scenario with the compute-aware engine to record TTFT, pacing, and compute service time.'
}
