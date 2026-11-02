import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateRunSummary,
  validateRunSummaryList,
  validateRunDetail,
  validateSeriesPoints,
  validateTraceProfile,
  validateDraftResponse,
  validateChatResponse,
  validateApplyResponse,
  validateRollbackResponse,
  validateVersionDetail,
  ContractError
} from './contractValidators.ts'

test('1. validateRunSummary validates compliant RunSummary object', () => {
  const raw = {
    run_id: '5810d9205417-s7-swap_remote',
    scenario_name: 'phase1-overflow',
    scenario_hash: '5810d9205417',
    seed: 7,
    policy: {
      requested: 'swap_remote',
      effective: 'swap_remote',
      fallback_reason: null
    },
    status: 'completed',
    error: null,
    arrived: 3,
    completed: 3,
    rejected: 0,
    p50: 445.66,
    p95: 445.66,
    remote_read_bytes: 258342912,
    migration_bytes: 66322432,
    created_at: '2026-11-01T13:55:00+00:00'
  }

  const validated = validateRunSummary(raw)
  assert.equal(validated.run_id, '5810d9205417-s7-swap_remote')
  assert.equal(validated.status, 'completed')
  assert.equal(validated.seed, 7)
  assert.equal(validated.p50, 445.66)
})

test('2. validateRunSummary rejects missing or invalid required fields', () => {
  // Not an object
  assert.throws(() => validateRunSummary('not-an-object'), ContractError)

  // Missing run_id
  assert.throws(() => validateRunSummary({ status: 'completed', policy: { effective: 'swap_remote' } }), (err) => {
    assert.ok(err instanceof ContractError)
    assert.ok(err.message.includes("missing valid non-empty 'run_id'"))
    return true
  })

  // Invalid status
  assert.throws(() => validateRunSummary({ run_id: 'run-1', status: 'unknown_status', policy: { effective: 'swap_remote' } }), (err) => {
    assert.ok(err instanceof ContractError)
    assert.ok(err.message.includes('invalid status'))
    return true
  })

  // Missing policy
  assert.throws(() => validateRunSummary({ run_id: 'run-1', status: 'completed' }), (err) => {
    assert.ok(err instanceof ContractError)
    assert.ok(err.message.includes("missing 'policy' object"))
    return true
  })
})

test('3. validateRunSummaryList rejects non-array or malformed array items', () => {
  assert.throws(() => validateRunSummaryList({ runs: [] }), (err) => {
    assert.ok(err instanceof ContractError)
    assert.ok(err.message.includes('Expected Array of RunSummary'))
    return true
  })

  const malformedList = [
    { run_id: 'valid-1', status: 'completed', policy: { effective: 'hot_cold' } },
    { run_id: '', status: 'completed', policy: { effective: 'hot_cold' } } // empty run_id
  ]
  assert.throws(() => validateRunSummaryList(malformedList), ContractError)
})

test('4. validateRunDetail validates compliant RunDetail and rejects malformed shapes', () => {
  const validDetail = {
    run_id: 'run-123',
    status: 'completed',
    summary: { access: { count: 100 } },
    manifest: { seed: 42 },
    error: null
  }
  const result = validateRunDetail(validDetail, 'run-123')
  assert.equal(result.run_id, 'run-123')
  assert.equal(result.status, 'completed')

  // Mismatched run_id
  assert.throws(() => validateRunDetail(validDetail, 'different-id'), (err) => {
    assert.ok(err instanceof ContractError)
    assert.ok(err.message.includes('Mismatched run_id'))
    return true
  })

  // Invalid status
  assert.throws(() => validateRunDetail({ run_id: 'run-123', status: 'bogus' }), ContractError)

  // Saved scenario passes through for the Infrastructure topology view
  const withScenario = validateRunDetail(
    { ...validDetail, scenario: { name: 'x', nodes: [], fabric: { links: [] } } }, 'run-123')
  assert.equal((withScenario.scenario as { name: string }).name, 'x')
  const withoutScenario = validateRunDetail(validDetail, 'run-123')
  assert.equal(withoutScenario.scenario, null)
})

test('5. validateSeriesPoints validates compliant series and rejects missing counters', () => {
  const validSeries = [
    {
      t_ns: 10000000,
      accesses: 10,
      evictions: 0,
      completed: 10,
      local_used_pages: { 'node-0': 5 },
      pool_used_pages: 15,
      link_bytes: { 'node-0-cxl': 4096 }
    }
  ]
  const result = validateSeriesPoints(validSeries, 'run-123')
  assert.equal(result.length, 1)
  assert.equal(result[0].t_ns, 10000000)

  // Non-array
  assert.throws(() => validateSeriesPoints({ points: [] }, 'run-123'), ContractError)

  // Missing accesses counter
  const missingCounter = [
    {
      t_ns: 10000000,
      evictions: 0,
      completed: 10,
      local_used_pages: { 'node-0': 5 },
      pool_used_pages: 15,
      link_bytes: {}
    }
  ]
  assert.throws(() => validateSeriesPoints(missingCounter, 'run-123'), (err) => {
    assert.ok(err instanceof ContractError)
    assert.ok(err.message.includes("missing numeric 'accesses'"))
    return true
  })
})


test('6. validateTraceProfile accepts full profiles, rejects missing counts', () => {
  const full = {
    trace_id: 'abc123', filename: 'w.jsonl', sha256: 'abc123def',
    provenance: 'derived', limitation_note: 'geometry-derived',
    counts: { alloc: 1, read: 2, write: 0, free: 1, migrate: 0 },
    requests: 1, footprint_bytes: 4096, workload_path: 'traces/uploads/abc123.jsonl',
    normalized_pages: 2,
    validation: { errors: [], warnings: ['w'] },
    normalization: { unit_bytes: 4096 }
  }
  const p = validateTraceProfile(full)
  assert.equal(p.trace_id, 'abc123')
  assert.equal(p.workload_path, 'traces/uploads/abc123.jsonl')
  assert.equal(p.counts.read, 2)
  assert.throws(() => validateTraceProfile({ ...full, counts: { alloc: 1 } }), ContractError)
  assert.throws(() => validateTraceProfile({ trace_id: 'x' }), ContractError)
})

test('7. validateDraftResponse accepts drafts, rejects missing scenario', () => {
  const draft = {
    scenario: { name: 'x' }, version: 'v1', parent_version: null,
    validation: { warnings: [], assumed: ['a'] }, model: 'm', usage: {}
  }
  assert.equal(validateDraftResponse(draft).version, 'v1')
  assert.throws(() => validateDraftResponse({ ...draft, scenario: null }), ContractError)
  assert.throws(() => validateDraftResponse({ ...draft, model: 7 }), ContractError)
})

test('8. validateChatResponse handles absent, valid, and invalid patches', () => {
  const base = { content: 'hi', model: 'm', run_id: 'r1' }
  assert.equal(validateChatResponse(base).suggested_patch, null)
  const none = validateChatResponse({ ...base, suggested_patch: null })
  assert.equal(none.suggested_patch, null)
  const good = validateChatResponse({
    ...base,
    suggested_patch: {
      ops: [{ op: 'replace', path: '/seed', value: 8 }],
      valid: true, errors: [], warnings: [], changes: [{ path: '/seed' }]
    }
  })
  assert.equal(good.suggested_patch?.valid, true)
  assert.equal(good.suggested_patch?.ops?.length, 1)
  const bad = validateChatResponse({
    ...base,
    suggested_patch: { ops: null, valid: false, errors: [{ path: '', message: 'bad' }] }
  })
  assert.equal(bad.suggested_patch?.valid, false)
  assert.throws(() => validateChatResponse({
    ...base, suggested_patch: { ops: [{ op: 'merge', path: '/x' }], valid: true, errors: [] }
  }), ContractError)
})

test('9. validateApplyResponse and validateRollbackResponse pin shapes', () => {
  const apply = {
    version: 'v2', parent_version: 'v1', parent_run_id: 'r1',
    run_id: 'r2', status: 'completed',
    compare: { verdict: 'fair', mode: 'same_seed' },
    validation: { warnings: [], assumed: [] },
    changes: [{ path: '/seed' }]
  }
  const a = validateApplyResponse(apply)
  assert.equal(a.compare?.verdict, 'fair')
  assert.throws(() => validateApplyResponse({ ...apply, compare: { verdict: 'maybe' } }), ContractError)
  const refused = validateApplyResponse({ ...apply, compare: { verdict: 'refused', reason: 'x' } })
  assert.equal(refused.compare?.reason, 'x')
  const rb = {
    version: 'v3', run_id: 'r3', status: 'completed',
    to_version: 'v1', from_version: 'v2',
    validation: { warnings: [], assumed: [] }
  }
  assert.equal(validateRollbackResponse(rb).to_version, 'v1')
  assert.throws(() => validateRollbackResponse({ ...rb, to_version: 5 }), ContractError)
})

test('10. validateVersionDetail accepts records, rejects missing scenario', () => {
  const rec = {
    version: 'v1', parent_version: null, note: 'n',
    rollback_to: null, scenario: { name: 'x' }
  }
  const v = validateVersionDetail(rec)
  assert.equal(v.version, 'v1')
  assert.equal(v.note, 'n')
  assert.throws(() => validateVersionDetail({ version: 'v1' }), ContractError)
})
