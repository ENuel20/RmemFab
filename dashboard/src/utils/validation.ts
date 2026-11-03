/**
 * Authoritative Scenario Schema & Semantic Validation
 * Schema validation powered by Ajv (Draft 2020-12) compiling SPECS/config.schema.json.
 * Augmented with essential graph-integrity and topological semantic checks.
 */

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { CONFIG_SCHEMA } from '../specs/configSchema.ts'

export interface ValidationError {
  field: string
  message: string
}

// Instantiate AJV for Draft 2020-12
const ajv = new Ajv2020({
  allErrors: true,
  strict: false
})
addFormats(ajv)

const validateConfigSchema = ajv.compile(CONFIG_SCHEMA)

/**
 * Validates a scenario config object against SPECS/config.schema.json
 * plus indispensable semantic checks (graph integrity, role reachability).
 */
export function validateScenario(scenario: unknown): { isValid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = []

  if (!scenario || typeof scenario !== 'object') {
    return {
      isValid: false,
      errors: [{ field: 'root', message: 'Scenario must be a valid JSON object' }]
    }
  }

  // 1. Authoritative JSON Schema Validation
  const schemaValid = validateConfigSchema(scenario)
  if (!schemaValid && validateConfigSchema.errors) {
    for (const err of validateConfigSchema.errors) {
      let field = err.instancePath
      if (!field) {
        if (err.params && typeof err.params === 'object') {
          if ('missingProperty' in err.params) {
            field = `/${err.params.missingProperty}`
          } else if ('additionalProperty' in err.params) {
            field = `/${err.params.additionalProperty}`
          }
        }
      }
      if (!field) field = 'root'

      let msg = err.message || 'Schema validation failure'
      if (err.keyword === 'additionalProperties' && err.params && 'additionalProperty' in err.params) {
        msg = `Property "${err.params.additionalProperty}" is not permitted by SPECS/config.schema.json`
      }

      errors.push({ field, message: msg })
    }
  }

  // 2. Semantic Checks Outside JSON Schema
  const sc = scenario as Record<string, unknown>

  // Check 2A: Graph integrity — link endpoints must refer to declared node IDs
  if (Array.isArray(sc.nodes) && sc.fabric && typeof sc.fabric === 'object') {
    const nodes = sc.nodes as Array<Record<string, unknown>>
    const nodeIds = new Set<string>()
    for (const n of nodes) {
      if (n && typeof n.id === 'string') {
        nodeIds.add(n.id)
      }
    }

    const fabric = sc.fabric as Record<string, unknown>
    // Endpoints may name nodes or switches (server: endpoints =
    // node_ids | switches; legacy single switch is implicitly switch-0).
    const endpointIds = new Set(nodeIds)
    if (fabric.switch && typeof fabric.switch === 'object') {
      endpointIds.add('switch-0')
    }
    if (Array.isArray(fabric.switches)) {
      for (const s of fabric.switches as Array<Record<string, unknown>>) {
        if (s && typeof s.id === 'string') endpointIds.add(s.id)
      }
    }
    if (Array.isArray(fabric.links)) {
      const links = fabric.links as Array<Record<string, unknown>>
      links.forEach((l, idx) => {
        if (l && typeof l === 'object') {
          if (typeof l.from === 'string' && !endpointIds.has(l.from)) {
            errors.push({
              field: `/fabric/links/${idx}/from`,
              message: `Link source "${l.from}" does not exist in declared nodes list`
            })
          }
          if (typeof l.to === 'string' && !endpointIds.has(l.to)) {
            errors.push({
              field: `/fabric/links/${idx}/to`,
              message: `Link destination "${l.to}" does not exist in declared nodes list`
            })
          }
          if (typeof l.from === 'string' && typeof l.to === 'string' && l.from === l.to) {
            errors.push({
              field: `/fabric/links/${idx}`,
              message: `Self-connecting link from "${l.from}" to "${l.to}" is invalid`
            })
          }
        }
      })
    }

    // Check 2B: Topology role requirement — at least one compute node and at least one memory pool
    const hasCompute = nodes.some((n) => n && n.role === 'compute')
    const hasMemory = nodes.some((n) => n && n.role === 'memory')

    if (!hasCompute) {
      errors.push({
        field: '/nodes',
        message: 'Scenario must declare at least one compute node with role: "compute"'
      })
    }
    if (!hasMemory) {
      errors.push({
        field: '/nodes',
        message: 'Scenario must declare at least one memory pool node with role: "memory"'
      })
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  }
}
