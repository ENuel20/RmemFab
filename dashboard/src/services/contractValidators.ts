/**
 * Runtime Contract Validators for FastAPI Engine Responses
 * Validates responses against docs/API.md and PRODUCT-SPEC.md §4.
 * Rejects malformed responses with explicit ContractError instead of blind TypeScript casts.
 */

import type {
  ApplyCompare, ApplyResponse, ChatResponse, DraftResponse, PatchOp, RollbackResponse,
  RunDetail, RunSummary, SeriesPoint, SuggestedPatch, TraceProfile, VersionDetail
} from '../types/telemetry'
import type { ScenarioConfig } from '../types/scenario'

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
    p99: typeof obj.p99 === 'number' ? obj.p99 : null,
    mean: typeof obj.mean === 'number' ? obj.mean : null,
    max: typeof obj.max === 'number' ? obj.max : null,
    local_hit_ratio: typeof obj.local_hit_ratio === 'number' ? obj.local_hit_ratio : null,
    remote_hit_ratio: typeof obj.remote_hit_ratio === 'number' ? obj.remote_hit_ratio : null,
    fabric_utilization: typeof obj.fabric_utilization === 'number' ? obj.fabric_utilization : null,
    remote_read_bytes: typeof obj.remote_read_bytes === 'number' ? obj.remote_read_bytes : null,
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
  const error = typeof obj.error === 'string' ? obj.error : null
  // Saved scenario drives the Infrastructure topology view; null on failed runs.
  const scenario = obj.scenario && typeof obj.scenario === 'object'
    ? (obj.scenario as unknown as ScenarioConfig)
    : null

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

    const win = pt.latency_ns as Record<string, unknown> | undefined
    const winOk = win && typeof win === 'object' && typeof win.count === 'number'
    const winNum = (k: string): number | undefined => (winOk && typeof win[k] === 'number' ? (win[k] as number) : undefined)

    return {
      t_ns: pt.t_ns,
      accesses: pt.accesses,
      evictions: pt.evictions,
      completed: pt.completed,
      degraded: typeof pt.degraded === 'number' ? pt.degraded : undefined,
      local_used_pages: pt.local_used_pages as Record<string, number>,
      pool_used_pages: pt.pool_used_pages,
      pools_used_pages: pt.pools_used_pages && typeof pt.pools_used_pages === 'object' ? (pt.pools_used_pages as Record<string, number>) : undefined,
      link_bytes: pt.link_bytes as Record<string, number>,
      latency_ns: winOk ? {
        count: win.count as number,
        mean: winNum('mean'),
        min: winNum('min'),
        max: winNum('max'),
        p50: winNum('p50'),
        p90: winNum('p90'),
        p95: winNum('p95'),
        p99: winNum('p99')
      } : undefined
    }
  })
}

/**
 * Validates a TraceProfile payload (POST /traces, GET /traces[/{id}]).
 */
export function validateTraceProfile(data: unknown): TraceProfile {
  const endpoint = 'TraceProfile'
  if (!data || typeof data !== 'object') {
    throw new ContractError(endpoint, `Expected object, got ${typeof data}`)
  }
  const obj = data as Record<string, unknown>
  if (typeof obj.trace_id !== 'string' || typeof obj.sha256 !== 'string') {
    throw new ContractError(endpoint, "Missing 'trace_id' or 'sha256'")
  }
  const counts = obj.counts as Record<string, unknown> | undefined
  for (const k of ['alloc', 'read', 'write', 'free', 'migrate']) {
    if (typeof counts?.[k] !== 'number') {
      throw new ContractError(endpoint, `Missing numeric counts.${k}`)
    }
  }
  if (typeof obj.requests !== 'number' || typeof obj.normalized_pages !== 'number') {
    throw new ContractError(endpoint, "Missing 'requests' or 'normalized_pages'")
  }
  const validation = obj.validation as Record<string, unknown> | undefined
  if (!Array.isArray(validation?.errors) || !Array.isArray(validation?.warnings)) {
    throw new ContractError(endpoint, "Missing 'validation.errors[]/warnings[]'")
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return {
    trace_id: obj.trace_id,
    filename: str(obj.filename),
    path_or_name: str(obj.path_or_name),
    sha256: obj.sha256,
    source: str(obj.source),
    model: str(obj.model),
    runtime: str(obj.runtime),
    capture_date: str(obj.capture_date),
    converter: str(obj.converter),
    trace_schema_version: str(obj.trace_schema_version),
    provenance: (obj.provenance as TraceProfile['provenance']) ?? null,
    limitation_note: typeof obj.limitation_note === 'string' ? obj.limitation_note : null,
    counts: {
      alloc: counts.alloc as number, read: counts.read as number,
      write: counts.write as number, free: counts.free as number,
      migrate: counts.migrate as number
    },
    requests: obj.requests,
    footprint_bytes: typeof obj.footprint_bytes === 'number' ? obj.footprint_bytes : undefined,
    workload_path: str(obj.workload_path),
    normalized_pages: obj.normalized_pages,
    validation: {
      errors: validation.errors as string[],
      warnings: validation.warnings as string[]
    },
    normalization: obj.normalization && typeof obj.normalization === 'object'
      ? (obj.normalization as Record<string, unknown>) : undefined
  }
}

/**
 * Validates POST /scenarios/draft.
 */
export function validateDraftResponse(data: unknown): DraftResponse {
  const endpoint = 'POST /scenarios/draft'
  if (!data || typeof data !== 'object') {
    throw new ContractError(endpoint, `Expected object, got ${typeof data}`)
  }
  const obj = data as Record<string, unknown>
  if (!obj.scenario || typeof obj.scenario !== 'object' || typeof obj.version !== 'string') {
    throw new ContractError(endpoint, "Missing 'scenario' or 'version'")
  }
  const validation = obj.validation as Record<string, unknown> | undefined
  if (!Array.isArray(validation?.warnings) || !Array.isArray(validation?.assumed)) {
    throw new ContractError(endpoint, "Missing 'validation.warnings[]/assumed[]'")
  }
  if (typeof obj.model !== 'string') {
    throw new ContractError(endpoint, "Missing 'model'")
  }
  return {
    scenario: obj.scenario as unknown as ScenarioConfig,
    version: obj.version,
    parent_version: typeof obj.parent_version === 'string' ? obj.parent_version : null,
    validation: {
      warnings: validation.warnings as string[],
      assumed: validation.assumed as string[]
    },
    model: obj.model,
    usage: (obj.usage && typeof obj.usage === 'object'
      ? obj.usage : {}) as Record<string, unknown>
  }
}

function validateSuggestedPatch(raw: unknown, endpoint: string): SuggestedPatch | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') {
    throw new ContractError(endpoint, 'Invalid suggested_patch shape')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.valid !== 'boolean' || !Array.isArray(obj.errors)) {
    throw new ContractError(endpoint, "suggested_patch missing 'valid' or 'errors[]'")
  }
  let ops: PatchOp[] | null = null
  if (obj.ops !== null && obj.ops !== undefined) {
    if (!Array.isArray(obj.ops)) {
      throw new ContractError(endpoint, 'suggested_patch.ops must be an array or null')
    }
    ops = (obj.ops as unknown[]).map((o) => {
      const op = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
      if (op.op !== 'add' && op.op !== 'remove' && op.op !== 'replace') {
        throw new ContractError(endpoint, `Bad patch op: ${String(op.op)}`)
      }
      if (typeof op.path !== 'string') {
        throw new ContractError(endpoint, 'Patch op missing string path')
      }
      return { op: op.op, path: op.path, value: op.value }
    })
  }
  return {
    ops,
    valid: obj.valid,
    errors: (obj.errors as unknown[]).map((e) => {
      const err = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
      return { path: String(err.path ?? ''), message: String(err.message ?? '') }
    }),
    warnings: Array.isArray(obj.warnings) ? (obj.warnings as string[]) : undefined,
    changes: Array.isArray(obj.changes)
      ? (obj.changes as Array<{ path: string; before?: unknown; after?: unknown }>) : undefined
  }
}

/**
 * Validates POST /assistant/chat (non-stream).
 */
export function validateChatResponse(data: unknown): ChatResponse {
  const endpoint = 'POST /assistant/chat'
  if (!data || typeof data !== 'object') {
    throw new ContractError(endpoint, `Expected object, got ${typeof data}`)
  }
  const obj = data as Record<string, unknown>
  if (typeof obj.content !== 'string' || typeof obj.model !== 'string') {
    throw new ContractError(endpoint, "Missing 'content' or 'model'")
  }
  return {
    content: obj.content,
    model: obj.model,
    run_id: typeof obj.run_id === 'string' ? obj.run_id : null,
    suggested_patch: validateSuggestedPatch(obj.suggested_patch, endpoint)
  }
}

/**
 * Validates POST /assistant/apply.
 */
export function validateApplyResponse(data: unknown): ApplyResponse {
  const endpoint = 'POST /assistant/apply'
  if (!data || typeof data !== 'object') {
    throw new ContractError(endpoint, `Expected object, got ${typeof data}`)
  }
  const obj = data as Record<string, unknown>
  for (const k of ['version', 'run_id', 'status']) {
    if (typeof obj[k] !== 'string') {
      throw new ContractError(endpoint, `Missing '${k}'`)
    }
  }
  const validation = obj.validation as Record<string, unknown> | undefined
  if (!Array.isArray(validation?.warnings) || !Array.isArray(validation?.assumed)) {
    throw new ContractError(endpoint, "Missing 'validation.warnings[]/assumed[]'")
  }
  let compare: ApplyCompare | null = null
  if (obj.compare !== null && obj.compare !== undefined) {
    const c = obj.compare as Record<string, unknown>
    if (c.verdict !== 'fair' && c.verdict !== 'refused') {
      throw new ContractError(endpoint, "compare.verdict must be 'fair' or 'refused'")
    }
    compare = { ...c, verdict: c.verdict } as ApplyCompare
  }
  return {
    version: obj.version as string,
    parent_version: typeof obj.parent_version === 'string' ? obj.parent_version : null,
    parent_run_id: typeof obj.parent_run_id === 'string' ? obj.parent_run_id : null,
    run_id: obj.run_id as string,
    status: obj.status as string,
    compare,
    validation: {
      warnings: validation.warnings as string[],
      assumed: validation.assumed as string[]
    },
    changes: Array.isArray(obj.changes)
      ? (obj.changes as Array<{ path: string; before?: unknown; after?: unknown }>) : undefined,
    model: typeof obj.model === 'string' ? obj.model : undefined,
    usage: obj.usage && typeof obj.usage === 'object'
      ? (obj.usage as Record<string, unknown>) : undefined,
    error: typeof obj.error === 'string' ? obj.error : undefined
  }
}

/**
 * Validates POST /assistant/rollback.
 */
export function validateRollbackResponse(data: unknown): RollbackResponse {
  const endpoint = 'POST /assistant/rollback'
  if (!data || typeof data !== 'object') {
    throw new ContractError(endpoint, `Expected object, got ${typeof data}`)
  }
  const obj = data as Record<string, unknown>
  for (const k of ['version', 'run_id', 'status', 'to_version']) {
    if (typeof obj[k] !== 'string') {
      throw new ContractError(endpoint, `Missing '${k}'`)
    }
  }
  const validation = obj.validation as Record<string, unknown> | undefined
  if (!Array.isArray(validation?.warnings) || !Array.isArray(validation?.assumed)) {
    throw new ContractError(endpoint, "Missing 'validation.warnings[]/assumed[]'")
  }
  return {
    version: obj.version as string,
    run_id: obj.run_id as string,
    status: obj.status as string,
    to_version: obj.to_version as string,
    from_version: typeof obj.from_version === 'string' ? obj.from_version : null,
    validation: {
      warnings: validation.warnings as string[],
      assumed: validation.assumed as string[]
    },
    error: typeof obj.error === 'string' ? obj.error : undefined
  }
}

/**
 * Validates GET /scenarios/version/{v}.
 */
export function validateVersionDetail(data: unknown): VersionDetail {
  const endpoint = 'GET /scenarios/version/{v}'
  if (!data || typeof data !== 'object') {
    throw new ContractError(endpoint, `Expected object, got ${typeof data}`)
  }
  const obj = data as Record<string, unknown>
  if (typeof obj.version !== 'string' || !obj.scenario || typeof obj.scenario !== 'object') {
    throw new ContractError(endpoint, "Missing 'version' or 'scenario'")
  }
  const str = (v: unknown): string | null | undefined =>
    (v === null || v === undefined ? v as null | undefined
      : (typeof v === 'string' ? v : undefined))
  return {
    version: obj.version,
    parent_version: typeof obj.parent_version === 'string' ? obj.parent_version : null,
    parent_run_id: str(obj.parent_run_id),
    rollback_to: str(obj.rollback_to),
    note: str(obj.note),
    instruction: str(obj.instruction),
    model: str(obj.model),
    scenario: obj.scenario as unknown as ScenarioConfig
  }
}

