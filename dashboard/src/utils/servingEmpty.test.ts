import test from 'node:test'
import assert from 'node:assert/strict'
import type { ScenarioConfig } from '../types/scenario.ts'
import { servingEmptyMessage } from './servingEmpty.ts'

function snapshot(nodes: Array<{ compute?: { tokens_per_second?: number } }>): ScenarioConfig {
  return {
    nodes: nodes.map((n, i) => ({ id: `node-${i}`, role: 'compute' as const, ...(n.compute ? { compute: n.compute } : {}) }))
  } as ScenarioConfig
}

test('mock mode keeps the demo message', () => {
  assert.match(servingEmptyMessage(true, null), /Demo runs predate/)
})

test('memory-only scenario says compute is missing, not re-run', () => {
  const msg = servingEmptyMessage(false, snapshot([{}, {}]))
  assert.match(msg, /no compute configuration/)
  assert.doesNotMatch(msg, /Re-run/)
})

test('compute-configured run without serving says re-run to record', () => {
  const msg = servingEmptyMessage(false, snapshot([{ compute: { tokens_per_second: 10 } }]))
  assert.match(msg, /produced before the serving section existed/)
  assert.match(msg, /Re-run/)
})

test('missing snapshot is honest about the unknown', () => {
  for (const snap of [null, undefined, {} as ScenarioConfig]) {
    const msg = servingEmptyMessage(false, snap)
    assert.match(msg, /snapshot is missing/)
    assert.doesNotMatch(msg, /Re-run/)
  }
})
