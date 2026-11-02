/**
 * Runtime Contract Validators for FastAPI Engine Responses
 * Validates responses against docs/API.md and PRODUCT-SPEC.md §4.
 * Rejects malformed responses with explicit ContractError instead of blind TypeScript casts.
 */

import type { RunSummary, RunDetail, SeriesPoint } from '../types/telemetry'

export class ContractError extends Error {
  constructor(endpoint: string, message: string) {
    super(`API Contract Violation on ${endpoint}: ${message}`)
    this.name = 'ContractError'
  }
}

/**
 * Validates a single RunSummary object.
 */
export function validateRunSummary(item: unknown, index?: number): RunSummary {
  const prefix = index !== undefined ? `Item at index ${index}` : 'RunSummary'
  if (!item || typeof item !== 'object') {
    throw new ContractError('GET /runs', `${prefix} is not an object`)
  }

  const obj = item as Record<string, unknown>

  if (typeof obj.run_id !== 'string' || obj.run_id.trim().length === 0) {
    throw new ContractError('GET /runs', `${prefix} missing valid non-empty 'run_id' string`)
  }

  if (obj.status !== 'completed' && obj.status !== 'failed') {
    throw new ContractError('GET /runs', `${prefix} ('${obj.run_id}') has invalid status: ${String(obj.status)} (expected 'completed' | 'failed')`)
  }

  if (!obj.policy || typeof obj.policy !== 'object') {
    throw new ContractError('GET /runs', `${prefix} ('${obj.run_id}') missing 'policy' object`)
  }

  const pol = obj.policy as Record<string, unknown>
  const effectivePolicy = typeof pol.effective === 'string' ? pol.effective : (typeof pol.requested === 'string' ? pol.requested : null)
  if (!effectivePolicy) {
    throw new ContractError('GET /runs', `${prefix} ('${obj.run_id}') policy object lacks effective/requested policy name`)
  }

  return {
    run_id: obj.run_id,
    scenario_name: typeof obj.scenario_name === 'string' ? obj.scenario_name : null,
    scenario_hash: typeof obj.scenario_hash === 'string' ? obj.scenario_hash : null,
    seed: typeof obj.seed === 'number' ? obj.seed : null,
    policy: {
      requested: typeof pol.requested === 'string' ? pol.requested : null,
      effective: typeof pol.effective === 'string' ? pol.effective : null,
      fallback_reason: typeof pol.fallback_reason === 'string' ? pol.fallback_reason : null
    },
    status: obj.status,
    error: typeof obj.error === 'string' ? obj.error : null,
    arrived: typeof obj.arrived === 'number' ? obj.arrived : null,
    completed: typeof obj.completed === 'number' ? obj.completed : null,
    rejected: typeof obj.rejected === 'number' ? obj.rejected : null,
    p50: typeof obj.p50 === 'number' ? obj.p50 : null,
    p95: typeof obj.p95 === 'number' ? obj.p95 : null,
    remote_read_bytes: typeof obj.remote_read_bytes === 'number' ? obj.remote_read_bytes : null,
    remote_write_bytes: typeof obj.remote_write_bytes === 'number' ? obj.remote_write_bytes : null,
    migration_bytes: typeof obj.migration_bytes === 'number' ? obj.migration_bytes : null,
    created_at: typeof obj.created_at === 'string' ? obj.created_at : null,
    is_demo: obj.is_demo === true
  }
}

/**
 * Validates GET /runs payload.
 */
export function validateRunSummaryList(data: unknown): RunSummary[] {
  if (!Array.isArray(data)) {
    throw new ContractError('GET /runs', `Expected Array of RunSummary, got ${typeof data}`)
  }

  return data.map((item, idx) => validateRunSummary(item, idx))
}

/**
 * Validates GET /runs/{id} payload.
 */
export function validateRunDetail(data: unknown, expectedId?: string): RunDetail {
  const endpoint = expectedId ? `GET /runs/${expectedId}` : 'GET /runs/{id}'
  if (!data || typeof data !== 'object') {
    throw new ContractError(endpoint, `Expected object, got ${typeof data}`)
  }

  const obj = data as Record<string, unknown>

  if (typeof obj.run_id !== 'string' || obj.run_id.trim().length === 0) {
    throw new ContractError(endpoint, "Missing or invalid 'run_id' in RunDetail response")
  }

  if (expectedId && obj.run_id !== expectedId) {
    throw new ContractError(endpoint, `Mismatched run_id in response: expected '${expectedId}', got '${obj.run_id}'`)
  }

  if (obj.status !== 'completed' && obj.status !== 'failed') {
    throw new ContractError(endpoint, `Invalid status in RunDetail: ${String(obj.status)} (expected 'completed' | 'failed')`)
  }

  const summary = obj.summary && typeof obj.summary === 'object' ? (obj.summary as Record<string, unknown>) : null
  const manifest = obj.manifest && typeof obj.manifest === 'object' ? (obj.manifest as Record<string, unknown>) : null
  const scenario = obj.scenario && typeof obj.scenario === 'object' ? (obj.scenario as Record<string, unknown>) : null
  const error = typeof obj.error === 'string' ? obj.error : null

  return {
    run_id: obj.run_id,
    status: obj.status,
    summary,
    manifest,
    scenario,
    error
  }
}

/**
 * Validates GET /runs/{id}/series payload.
 */
export function validateSeriesPoints(data: unknown, runId?: string): SeriesPoint[] {
  const endpoint = runId ? `GET /runs/${runId}/series` : 'GET /runs/{id}/series'
  if (!Array.isArray(data)) {
    throw new ContractError(endpoint, `Expected Array of SeriesPoint, got ${typeof data}`)
  }

  return data.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new ContractError(endpoint, `Series point at index ${idx} is not an object`)
    }
    const pt = item as Record<string, unknown>

    if (typeof pt.t_ns !== 'number' || isNaN(pt.t_ns)) {
      throw new ContractError(endpoint, `Series point at index ${idx} missing numeric 't_ns'`)
    }

    if (typeof pt.accesses !== 'number' || isNaN(pt.accesses)) {
      throw new ContractError(endpoint, `Series point at index ${idx} missing numeric 'accesses'`)
    }

    if (typeof pt.evictions !== 'number' || isNaN(pt.evictions)) {
      throw new ContractError(endpoint, `Series point at index ${idx} missing numeric 'evictions'`)
    }

    if (typeof pt.completed !== 'number' || isNaN(pt.completed)) {
      throw new ContractError(endpoint, `Series point at index ${idx} missing numeric 'completed'`)
    }

    if (!pt.local_used_pages || typeof pt.local_used_pages !== 'object') {
      throw new ContractError(endpoint, `Series point at index ${idx} missing 'local_used_pages' mapping`)
    }

    if (typeof pt.pool_used_pages !== 'number' || isNaN(pt.pool_used_pages)) {
      throw new ContractError(endpoint, `Series point at index ${idx} missing numeric 'pool_used_pages'`)
    }

    if (!pt.link_bytes || typeof pt.link_bytes !== 'object') {
      throw new ContractError(endpoint, `Series point at index ${idx} missing 'link_bytes' mapping`)
    }

    return {
      t_ns: pt.t_ns,
      accesses: pt.accesses,
      evictions: pt.evictions,
      completed: pt.completed,
      local_used_pages: pt.local_used_pages as Record<string, number>,
      pool_used_pages: pt.pool_used_pages,
      pools_used_pages: pt.pools_used_pages && typeof pt.pools_used_pages === 'object' ? (pt.pools_used_pages as Record<string, number>) : undefined,
      link_bytes: pt.link_bytes as Record<string, number>
    }
  })
}

