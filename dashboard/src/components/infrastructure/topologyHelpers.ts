import type { ScenarioConfig } from '../../types/scenario'
import type { MetricSummary } from '../../types/telemetry'

export interface TopologySummary {
  hasScenario: boolean
  computeNodes: NonNullable<ScenarioConfig['nodes']>
  memoryPoolNodes: NonNullable<ScenarioConfig['nodes']>
  links: NonNullable<ScenarioConfig['fabric']['links']>
  totalLocalMemoryBytes: number
  totalRemoteMemoryBytes: number
  fabricUtilization: number | null
}

export function deriveTopologySummary(
  scenario?: ScenarioConfig | null,
  metrics?: MetricSummary | null
): TopologySummary {
  if (!scenario) {
    return {
      hasScenario: false,
      computeNodes: [],
      memoryPoolNodes: [],
      links: [],
      totalLocalMemoryBytes: 0,
      totalRemoteMemoryBytes: 0,
      fabricUtilization: metrics?.fabric_utilization ?? null
    }
  }

  const nodes = scenario.nodes || []
  const computeNodes = nodes.filter((n) => n.role === 'compute')
  const memoryPoolNodes = nodes.filter((n) => n.role === 'memory')
  const links = scenario.fabric?.links || []

  const totalLocalMemoryBytes = computeNodes.reduce(
    (acc, n) => acc + (n.local_memory?.capacity_bytes || 0),
    0
  )
  const totalRemoteMemoryBytes = memoryPoolNodes.reduce(
    (acc, n) => acc + (n.remote_memory?.capacity_bytes || 0),
    0
  )

  const fabricUtilization = metrics?.fabric_utilization ?? null

  return {
    hasScenario: true,
    computeNodes,
    memoryPoolNodes,
    links,
    totalLocalMemoryBytes,
    totalRemoteMemoryBytes,
    fabricUtilization
  }
}
