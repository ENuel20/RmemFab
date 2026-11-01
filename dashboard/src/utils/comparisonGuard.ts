/**
 * Strict Scientific Comparison Guard for RmemFab
 * Implements Stage 1: Comparison eligibility and fairness gate.
 * 
 * Spec Rule: "If the guard cannot prove sameness, it refuses rather than warning."
 */

import type { SimulationRun } from '../types/telemetry'
import type { ScenarioConfig } from '../types/scenario'

export type CheckStatus = 'match' | 'mismatch' | 'unknown'

export interface FairnessCheckItem {
  id: string
  name: string
  status: CheckStatus
  details: string
}

export interface ComparisonEligibilityResult {
  eligible: boolean
  firstDifference: string | null
  reason: string | null
  checks: FairnessCheckItem[]
  isSingleSeed: boolean
}

/**
 * Normalizes and deeply compares two values, handling objects, arrays, and primitives.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) {
    return a === b
  }
  if (typeof a !== typeof b) return false

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as Record<string, unknown>).sort()
    const keysB = Object.keys(b as Record<string, unknown>).sort()
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false
      if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false
      }
    }
    return true
  }

  return false
}

/**
 * Strips out policy-specific configuration to obtain canonical non-policy scenario config.
 */
function getCanonicalNonPolicyConfig(scenario: ScenarioConfig): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(scenario)) as Record<string, unknown>
  delete copy.policy
  return copy
}

/**
 * Evaluates whether a set of simulation runs is strictly eligible for scientific comparison.
 */
export function evaluateComparisonEligibility(selectedRuns: SimulationRun[]): ComparisonEligibilityResult {
  const checks: FairnessCheckItem[] = []

  // Check run count limits (2-4 runs allowed)
  if (selectedRuns.length < 2) {
    return {
      eligible: false,
      firstDifference: null,
      reason: 'At least two runs must be selected for comparison.',
      checks: [],
      isSingleSeed: false
    }
  }

  if (selectedRuns.length > 4) {
    return {
      eligible: false,
      firstDifference: 'run_count',
      reason: `Maximum 4 runs can be compared at once (selected ${selectedRuns.length}). Please narrow selection.`,
      checks: [
        {
          id: 'run_count',
          name: 'Selection Limit',
          status: 'mismatch',
          details: `Selected ${selectedRuns.length} runs (maximum allowed is 4)`
        }
      ],
      isSingleSeed: false
    }
  }

  const firstRun = selectedRuns[0]

  // Check 1: Mode consistency (never mix Demo and Live runs)
  const isDemoRun = (run: SimulationRun): boolean => {
    if (typeof run.is_demo === 'boolean') return run.is_demo
    return (
      run.id.startsWith('demo-') ||
      run.id.startsWith('run-llama-cxl-') ||
      run.id.startsWith('run-moe-rdma-') ||
      run.id.startsWith('run-sparse-') ||
      run.policy_display_name.startsWith('[Demo]')
    )
  }

  // If a run has no is_demo flag and none of the known demo prefixes, verify whether mode can be ascertained
  const hasExplicitMode = (run: SimulationRun): boolean => {
    return (
      typeof run.is_demo === 'boolean' ||
      run.id.startsWith('demo-') ||
      run.id.startsWith('run-llama-cxl-') ||
      run.id.startsWith('run-moe-rdma-') ||
      run.id.startsWith('run-sparse-') ||
      run.policy_display_name.startsWith('[Demo]')
    )
  }

  const modeCheckItem: FairnessCheckItem = (() => {
    if (selectedRuns.some((r) => !hasExplicitMode(r))) {
      return {
        id: 'mode_consistency',
        name: 'Data Source Mode (Live vs Demo)',
        status: 'unknown',
        details: 'Cannot verify data source mode: run provenance metadata (is_demo) is missing'
      }
    }

    const demoStatuses = selectedRuns.map(isDemoRun)
    const allDemo = demoStatuses.every(Boolean)
    const allLive = demoStatuses.every((d) => !d)

    if (!allDemo && !allLive) {
      return {
        id: 'mode_consistency',
        name: 'Data Source Mode (Live vs Demo)',
        status: 'mismatch',
        details: 'Mixed DEMO mock runs and LIVE FastAPI simulation runs cannot be compared'
      }
    }

    return {
      id: 'mode_consistency',
      name: 'Data Source Mode (Live vs Demo)',
      status: 'match',
      details: allDemo ? 'All runs from Standalone Demo provider' : 'All runs from Live FastAPI engine'
    }
  })()
  checks.push(modeCheckItem)

  // Check 2: Random Seed
  const seedItem: FairnessCheckItem = (() => {
    if (selectedRuns.some((r) => typeof r.seed !== 'number')) {
      return {
        id: 'seed',
        name: 'Random Seed',
        status: 'unknown',
        details: 'Cannot verify: seed metadata missing on one or more runs'
      }
    }
    const allMatch = selectedRuns.every((r) => r.seed === firstRun.seed)
    return {
      id: 'seed',
      name: 'Random Seed',
      status: allMatch ? 'match' : 'mismatch',
      details: allMatch
        ? `Identical PRNG seed: ${firstRun.seed}`
        : `Mismatched seeds: ${selectedRuns.map((r) => `${r.policy_name} (${r.seed})`).join(' vs ')}`
    }
  })()
  checks.push(seedItem)

  // Check 3: Trace Content SHA-256 Hash
  const traceCheckItem: FairnessCheckItem = (() => {
    // First, verify that all runs have a scenario snapshot and workload definition
    if (selectedRuns.some((r) => !r.scenario_snapshot?.workload)) {
      return {
        id: 'trace_hash',
        name: 'Workload Medium & Trace Hash',
        status: 'unknown',
        details: 'Cannot verify: workload definition missing from scenario snapshot'
      }
    }

    const firstType = firstRun.scenario_snapshot.workload.type
    // If runs mix synthetic and trace, it is a mismatch on workload medium
    const typeMismatch = selectedRuns.some((r) => r.scenario_snapshot.workload.type !== firstType)
    if (typeMismatch) {
      return {
        id: 'trace_hash',
        name: 'Workload Medium & Trace Hash',
        status: 'mismatch',
        details: `Mixed workload types detected: ${selectedRuns.map((r) => `${r.policy_name} (${r.scenario_snapshot.workload.type})`).join(' vs ')}`
      }
    }

    if (firstType === 'synthetic') {
      return {
        id: 'trace_hash',
        name: 'Trace Content Hash',
        status: 'match',
        details: 'N/A: Synthetic workload generated by identical PRNG seed'
      }
    }

    // Workload is trace: verify all runs have a verified trace SHA-256 content hash
    const getHash = (r: SimulationRun): string | undefined => {
      const snap = r.scenario_snapshot
      if (snap?.workload?.type === 'trace') {
        const traceWl = snap.workload as { type: 'trace'; path: string; trace_hash?: string }
        return r.trace_hash || traceWl.trace_hash
      }
      return undefined
    }

    if (selectedRuns.some((r) => !getHash(r))) {
      return {
        id: 'trace_hash',
        name: 'Trace Content Hash',
        status: 'unknown',
        details: 'Cannot verify: trace SHA-256 content hash missing on trace workload (path equality cannot be substituted)'
      }
    }

    const firstHash = getHash(firstRun)!
    const allMatch = selectedRuns.every((r) => getHash(r) === firstHash)
    return {
      id: 'trace_hash',
      name: 'Trace Content Hash',
      status: allMatch ? 'match' : 'mismatch',
      details: allMatch
        ? `Identical trace SHA-256: ${firstHash.slice(0, 16)}...`
        : 'Trace content SHA-256 hashes differ across runs'
    }
  })()
  checks.push(traceCheckItem)

  // Check 4: Warmup Duration
  const warmupItem: FairnessCheckItem = (() => {
    const getWarmup = (r: SimulationRun): number | undefined => {
      if (r.scenario_snapshot?.warmup_ns !== undefined) return r.scenario_snapshot.warmup_ns
      if (r.scenario_snapshot?.metrics?.warmup_ns !== undefined) return r.scenario_snapshot.metrics.warmup_ns
      return undefined
    }

    if (selectedRuns.some((r) => getWarmup(r) === undefined)) {
      return {
        id: 'warmup_ns',
        name: 'Warmup Duration',
        status: 'unknown',
        details: 'Cannot verify: warmup duration metadata missing on one or more runs'
      }
    }

    const firstWarmup = getWarmup(firstRun)!
    const allMatch = selectedRuns.every((r) => getWarmup(r) === firstWarmup)
    return {
      id: 'warmup_ns',
      name: 'Warmup Duration',
      status: allMatch ? 'match' : 'mismatch',
      details: allMatch
        ? `Identical warmup: ${(firstWarmup / 1_000_000_000).toFixed(1)}s (${firstWarmup} ns)`
        : `Mismatched warmup durations: ${selectedRuns.map((r) => `${r.policy_name} (${getWarmup(r)} ns)`).join(' vs ')}`
    }
  })()
  checks.push(warmupItem)

  // Check 5: Simulation Duration
  const durationItem: FairnessCheckItem = (() => {
    if (selectedRuns.some((r) => typeof r.duration_ns !== 'number')) {
      return {
        id: 'duration_ns',
        name: 'Simulation Duration',
        status: 'unknown',
        details: 'Cannot verify: simulation duration metadata missing'
      }
    }
    const allMatch = selectedRuns.every((r) => r.duration_ns === firstRun.duration_ns)
    return {
      id: 'duration_ns',
      name: 'Simulation Duration',
      status: allMatch ? 'match' : 'mismatch',
      details: allMatch
        ? `Identical virtual duration: ${(firstRun.duration_ns / 1_000_000_000).toFixed(0)}s`
        : `Mismatched virtual durations: ${selectedRuns.map((r) => `${r.policy_name} (${r.duration_ns} ns)`).join(' vs ')}`
    }
  })()
  checks.push(durationItem)

  // Check 6: Metric Percentiles and Percentile Interpolation Method
  const percentilesItem: FairnessCheckItem = (() => {
    const getPercentiles = (r: SimulationRun): number[] | undefined => {
      const p = r.scenario_snapshot?.metrics?.percentiles
      if (Array.isArray(p) && p.length > 0) return p
      return undefined
    }

    const getInterpolation = (r: SimulationRun): string | undefined => {
      return (
        r.percentile_interpolation ||
        (r.scenario_snapshot?.metrics as { percentile_interpolation?: string } | undefined)?.percentile_interpolation
      )
    }

    // Check percentiles array: missing percentiles array cannot pass the guard
    if (selectedRuns.some((r) => !getPercentiles(r))) {
      return {
        id: 'percentiles',
        name: 'Metric Percentile Settings',
        status: 'unknown',
        details: 'Cannot verify: metric percentiles array missing or empty in scenario snapshot'
      }
    }

    const firstPerc = getPercentiles(firstRun)!
    const percMatch = selectedRuns.every((r) => deepEqual(getPercentiles(r), firstPerc))
    if (!percMatch) {
      return {
        id: 'percentiles',
        name: 'Metric Percentile Settings',
        status: 'mismatch',
        details: 'Mismatched percentile definitions across runs'
      }
    }

    // Check percentile interpolation method
    // If any run specifies an interpolation method, all runs must specify it and they must match
    const hasAnyInterpolation = selectedRuns.some((r) => getInterpolation(r) !== undefined)
    if (hasAnyInterpolation) {
      if (selectedRuns.some((r) => getInterpolation(r) === undefined)) {
        return {
          id: 'percentiles',
          name: 'Metric Percentile Settings',
          status: 'unknown',
          details: 'Cannot verify: percentile interpolation method missing on some runs'
        }
      }
      const firstInterp = getInterpolation(firstRun)
      const interpMatch = selectedRuns.every((r) => getInterpolation(r) === firstInterp)
      if (!interpMatch) {
        return {
          id: 'percentiles',
          name: 'Metric Percentile Settings',
          status: 'mismatch',
          details: `Percentile interpolation methods differ (${selectedRuns.map((r) => `${r.policy_name}:${getInterpolation(r)}`).join(' vs ')})`
        }
      }
    }

    return {
      id: 'percentiles',
      name: 'Metric Percentile Settings',
      status: 'match',
      details: `Identical percentile definitions: [${firstPerc.join(', ')}]${hasAnyInterpolation ? ` (${getInterpolation(firstRun)})` : ''}`
    }
  })()
  checks.push(percentilesItem)

  // Check 7: Page Size
  const pageSizeItem: FairnessCheckItem = (() => {
    const getPageSize = (r: SimulationRun): number | undefined => {
      return r.scenario_snapshot?.page_size_bytes
    }

    if (selectedRuns.some((r) => getPageSize(r) === undefined)) {
      return {
        id: 'page_size_bytes',
        name: 'Memory Page Size',
        status: 'unknown',
        details: 'Cannot verify: page size metadata missing in scenario snapshot'
      }
    }

    const firstPageSize = getPageSize(firstRun)!
    const allMatch = selectedRuns.every((r) => getPageSize(r) === firstPageSize)
    return {
      id: 'page_size_bytes',
      name: 'Memory Page Size',
      status: allMatch ? 'match' : 'mismatch',
      details: allMatch
        ? `Identical page size: ${firstPageSize} bytes (${(firstPageSize / 1024).toFixed(0)} KiB)`
        : `Mismatched page sizes: ${selectedRuns.map((r) => `${r.policy_name} (${getPageSize(r)} B)`).join(' vs ')}`
    }
  })()
  checks.push(pageSizeItem)

  // Check 8: Engine / RmemFab Version
  const engineVersionItem: FairnessCheckItem = (() => {
    const getVersion = (r: SimulationRun): string | undefined => {
      return r.engine_version || r.scenario_snapshot?.version
    }

    if (selectedRuns.some((r) => !getVersion(r))) {
      return {
        id: 'engine_version',
        name: 'Engine / RmemFab Version',
        status: 'unknown',
        details: 'Cannot verify: engine version metadata missing'
      }
    }

    const firstVer = getVersion(firstRun)!
    const allMatch = selectedRuns.every((r) => getVersion(r) === firstVer)
    return {
      id: 'engine_version',
      name: 'Engine / RmemFab Version',
      status: allMatch ? 'match' : 'mismatch',
      details: allMatch
        ? `Identical engine version: v${firstVer}`
        : `Mismatched engine versions: ${selectedRuns.map((r) => `${r.policy_name} (v${getVersion(r)})`).join(' vs ')}`
    }
  })()
  checks.push(engineVersionItem)

  // Check 9: Workload Configuration (parameters, model, requests)
  const workloadItem: FairnessCheckItem = (() => {
    if (selectedRuns.some((r) => !r.scenario_snapshot?.workload)) {
      return {
        id: 'workload_config',
        name: 'Workload Configuration',
        status: 'unknown',
        details: 'Cannot verify: workload snapshot configuration missing'
      }
    }

    const firstWl = firstRun.scenario_snapshot.workload
    const diffs: string[] = []

    selectedRuns.slice(1).forEach((other) => {
      const otherWl = other.scenario_snapshot.workload
      if (firstWl.type !== otherWl.type) {
        diffs.push(`Workload type (${firstWl.type} vs ${otherWl.type})`)
        return
      }

      if (firstWl.type === 'synthetic' && otherWl.type === 'synthetic') {
        if (firstWl.profile !== otherWl.profile) {
          diffs.push(`Workload profile (${firstWl.profile} vs ${otherWl.profile})`)
        }

        const m1 = firstWl.model || {}
        const m2 = otherWl.model || {}
        if (m1.layers !== m2.layers) diffs.push(`model.layers (${m1.layers ?? '?'} vs ${m2.layers ?? '?'})`)
        if (m1.attention_heads !== m2.attention_heads) diffs.push(`model.attention_heads (${m1.attention_heads ?? '?'} vs ${m2.attention_heads ?? '?'})`)
        if (m1.kv_heads !== m2.kv_heads) diffs.push(`model.kv_heads (${m1.kv_heads ?? '?'} vs ${m2.kv_heads ?? '?'})`)
        if (m1.head_dim !== m2.head_dim) diffs.push(`model.head_dim (${m1.head_dim ?? '?'} vs ${m2.head_dim ?? '?'})`)
        if (m1.dtype_bytes !== m2.dtype_bytes) diffs.push(`model.dtype_bytes (${m1.dtype_bytes ?? '?'} vs ${m2.dtype_bytes ?? '?'})`)
        if (m1.experts !== m2.experts) diffs.push(`model.experts (${m1.experts ?? '?'} vs ${m2.experts ?? '?'})`)
        if (m1.top_k !== m2.top_k) diffs.push(`model.top_k (${m1.top_k ?? '?'} vs ${m2.top_k ?? '?'})`)

        const r1 = firstWl.requests || {}
        const r2 = otherWl.requests || {}
        if (r1.concurrency !== r2.concurrency) diffs.push(`requests.concurrency (${r1.concurrency ?? '?'} vs ${r2.concurrency ?? '?'})`)
        if (r1.arrival_rate_per_second !== r2.arrival_rate_per_second) diffs.push(`requests.arrival_rate (${r1.arrival_rate_per_second ?? '?'} vs ${r2.arrival_rate_per_second ?? '?'})`)
        if (r1.prompt_tokens !== r2.prompt_tokens) diffs.push(`requests.prompt_tokens (${r1.prompt_tokens ?? '?'} vs ${r2.prompt_tokens ?? '?'})`)
        if (r1.generated_tokens !== r2.generated_tokens) diffs.push(`requests.generated_tokens (${r1.generated_tokens ?? '?'} vs ${r2.generated_tokens ?? '?'})`)
      }
    })

    if (diffs.length > 0) {
      return {
        id: 'workload_config',
        name: 'Workload Configuration',
        status: 'mismatch',
        details: `Workload parameters differ: ${diffs.join('; ')}`
      }
    }

    return {
      id: 'workload_config',
      name: 'Workload Configuration',
      status: 'match',
      details: `Identical workload profile and parameters (${firstRun.workload_profile})`
    }
  })()
  checks.push(workloadItem)

  // Check 10: Hardware & Fabric Configuration
  const hardwareItem: FairnessCheckItem = (() => {
    if (
      selectedRuns.some(
        (r) =>
          !r.scenario_snapshot ||
          !Array.isArray(r.scenario_snapshot.nodes) ||
          !r.scenario_snapshot.fabric ||
          !Array.isArray(r.scenario_snapshot.fabric.links)
      )
    ) {
      return {
        id: 'hardware_topology',
        name: 'Hardware & Fabric Configuration',
        status: 'unknown',
        details: 'Cannot verify: nodes or fabric link topology snapshot missing'
      }
    }

    const firstSnap = firstRun.scenario_snapshot
    const topoDiffs: string[] = []

    for (const other of selectedRuns.slice(1)) {
      const snap = other.scenario_snapshot

      if (snap.nodes.length !== firstSnap.nodes.length) {
        topoDiffs.push(`Node count differs (${firstSnap.nodes.length} vs ${snap.nodes.length})`)
        break
      }
      if (snap.fabric.links.length !== firstSnap.fabric.links.length) {
        topoDiffs.push(`Fabric link count differs (${firstSnap.fabric.links.length} vs ${snap.fabric.links.length})`)
        break
      }

      for (const node of firstSnap.nodes) {
        const otherNode = snap.nodes.find((n) => n.id === node.id)
        if (!otherNode) {
          topoDiffs.push(`Node "${node.id}" missing in ${other.policy_name}`)
          continue
        }
        if (otherNode.role !== node.role) {
          topoDiffs.push(`Node "${node.id}" role (${node.role} vs ${otherNode.role})`)
        }

        if (node.local_memory && otherNode.local_memory) {
          if (node.local_memory.capacity_bytes !== otherNode.local_memory.capacity_bytes) {
            topoDiffs.push(`Node "${node.id}" local capacity`)
          }
          if (node.local_memory.bandwidth_bytes_per_ns !== otherNode.local_memory.bandwidth_bytes_per_ns) {
            topoDiffs.push(`Node "${node.id}" local bandwidth`)
          }
          if (node.local_memory.latency_ns !== otherNode.local_memory.latency_ns) {
            topoDiffs.push(`Node "${node.id}" local latency`)
          }
        } else if (Boolean(node.local_memory) !== Boolean(otherNode.local_memory)) {
          topoDiffs.push(`Node "${node.id}" local memory presence mismatch`)
        }

        if (node.remote_memory && otherNode.remote_memory) {
          if (node.remote_memory.capacity_bytes !== otherNode.remote_memory.capacity_bytes) {
            topoDiffs.push(`Node "${node.id}" remote capacity`)
          }
          if (node.remote_memory.bandwidth_bytes_per_ns !== otherNode.remote_memory.bandwidth_bytes_per_ns) {
            topoDiffs.push(`Node "${node.id}" remote bandwidth`)
          }
          if (node.remote_memory.latency_ns !== otherNode.remote_memory.latency_ns) {
            topoDiffs.push(`Node "${node.id}" remote latency`)
          }
        } else if (Boolean(node.remote_memory) !== Boolean(otherNode.remote_memory)) {
          topoDiffs.push(`Node "${node.id}" remote memory presence mismatch`)
        }
      }

      for (const link of firstSnap.fabric.links) {
        const otherLink = snap.fabric.links.find((l) => l.id === link.id)
        if (!otherLink) {
          topoDiffs.push(`Link "${link.id}" missing in ${other.policy_name}`)
          continue
        }
        if (otherLink.from !== link.from || otherLink.to !== link.to) {
          topoDiffs.push(`Link "${link.id}" routing (${link.from}->${link.to} vs ${otherLink.from}->${otherLink.to})`)
        }
        if (otherLink.latency_ns !== link.latency_ns) {
          topoDiffs.push(`Link "${link.id}" latency`)
        }
        if (otherLink.bandwidth_bytes_per_ns !== link.bandwidth_bytes_per_ns) {
          topoDiffs.push(`Link "${link.id}" bandwidth`)
        }
      }
    }

    if (topoDiffs.length > 0) {
      return {
        id: 'hardware_topology',
        name: 'Hardware & Fabric Configuration',
        status: 'mismatch',
        details: `Hardware or fabric differs: ${topoDiffs.join('; ')}`
      }
    }

    return {
      id: 'hardware_topology',
      name: 'Hardware & Fabric Configuration',
      status: 'match',
      details: `Identical topology: ${firstSnap.nodes.length} nodes & ${firstSnap.fabric.links.length} fabric links`
    }
  })()
  checks.push(hardwareItem)

  // Check 11: Deep Canonical Non-Policy Scenario Configuration
  const canonicalItem: FairnessCheckItem = (() => {
    if (selectedRuns.some((r) => !r.scenario_snapshot)) {
      return {
        id: 'canonical_scenario',
        name: 'Canonical Non-Policy Scenario',
        status: 'unknown',
        details: 'Cannot verify: scenario snapshot metadata missing'
      }
    }

    const firstCanonical = getCanonicalNonPolicyConfig(firstRun.scenario_snapshot)
    let mismatchDetail: string | null = null

    for (const other of selectedRuns.slice(1)) {
      const otherCanonical = getCanonicalNonPolicyConfig(other.scenario_snapshot)
      if (!deepEqual(firstCanonical, otherCanonical)) {
        // Find which top-level property differs
        const keys = Array.from(new Set([...Object.keys(firstCanonical), ...Object.keys(otherCanonical)]))
        for (const k of keys) {
          if (!deepEqual(firstCanonical[k], otherCanonical[k])) {
            mismatchDetail = `Controlled variable in scenario.${k} differs between ${firstRun.policy_name} and ${other.policy_name}`
            break
          }
        }
        if (!mismatchDetail) {
          mismatchDetail = `Non-policy scenario configuration differs for run ${other.id}`
        }
        break
      }
    }

    if (mismatchDetail) {
      return {
        id: 'canonical_scenario',
        name: 'Canonical Non-Policy Scenario',
        status: 'mismatch',
        details: mismatchDetail
      }
    }

    return {
      id: 'canonical_scenario',
      name: 'Canonical Non-Policy Scenario',
      status: 'match',
      details: 'All non-policy scenario configuration fields are identical'
    }
  })()
  checks.push(canonicalItem)

  // Evaluate refusal or approval
  const firstFailingCheck = checks.find((c) => c.status !== 'match')
  if (firstFailingCheck) {
    return {
      eligible: false,
      firstDifference: firstFailingCheck.id,
      reason: firstFailingCheck.status === 'unknown'
        ? `Comparison refused: ${firstFailingCheck.name} could not be verified (${firstFailingCheck.details}).`
        : `Comparison refused: ${firstFailingCheck.name} mismatch (${firstFailingCheck.details}).`,
      checks,
      isSingleSeed: false
    }
  }

  return {
    eligible: true,
    firstDifference: null,
    reason: null,
    checks,
    isSingleSeed: true // Exactly 1 seed tested across all runs
  }
}

