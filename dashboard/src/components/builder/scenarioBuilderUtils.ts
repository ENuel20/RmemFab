import type { ScenarioConfig, FabricLinkConfig, NodeConfig } from '../../types/scenario'

export const IMPLEMENTED_POLICIES: readonly string[] = [
  'hot_cold',
  'frequency_aware',
  'swap_remote',
  'local_only',
  'predictive_prefetch'
]

export function generateUniqueId(prefix: string, existingIds: Iterable<string>): string {
  const set = new Set(existingIds)
  let count = 0
  while (set.has(`${prefix}-${count}`)) {
    count++
  }
  return `${prefix}-${count}`
}

export function renameNodeWithLinkCascade(
  scenario: ScenarioConfig,
  oldId: string,
  newId: string
): { updatedScenario: ScenarioConfig; error?: string } {
  const trimmed = newId.trim()
  if (!trimmed) {
    return { updatedScenario: scenario, error: 'Node identifier cannot be empty' }
  }
  if (trimmed === oldId) {
    return { updatedScenario: scenario }
  }
  if (scenario.nodes.some((n) => n.id === trimmed)) {
    return { updatedScenario: scenario, error: `Node identifier '${trimmed}' already exists` }
  }

  const updatedNodes: NodeConfig[] = scenario.nodes.map((n) =>
    n.id === oldId ? ({ ...n, id: trimmed } as NodeConfig) : n
  )
  const updatedLinks: FabricLinkConfig[] = scenario.fabric.links.map((l) => {
    let next = l
    if (l.from === oldId) {
      next = { ...next, from: trimmed }
    }
    if (l.to === oldId) {
      next = { ...next, to: trimmed }
    }
    return next
  })

  return {
    updatedScenario: {
      ...scenario,
      nodes: updatedNodes,
      fabric: { ...scenario.fabric, links: updatedLinks }
    }
  }
}

export function isStructurallyValidScenario(obj: unknown): obj is ScenarioConfig {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const sc = obj as Record<string, unknown>
  if (typeof sc.name !== 'string' || !Array.isArray(sc.nodes)) return false
  if (!sc.fabric || typeof sc.fabric !== 'object' || !Array.isArray((sc.fabric as Record<string, unknown>).links)) {
    return false
  }
  if (!sc.workload || typeof sc.workload !== 'object') return false
  if (!sc.policy || typeof sc.policy !== 'object' || typeof (sc.policy as Record<string, unknown>).name !== 'string') {
    return false
  }
  return true
}

