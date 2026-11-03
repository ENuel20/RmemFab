import test from 'node:test'
import assert from 'node:assert/strict'
import { validateScenario } from './validation.ts'
import { MUSE_GLIMMER_CXL_SCENARIO } from '../services/mockData.ts'

test('1. Valid baseline scenario passes schema and semantic validation', () => {
  const result = validateScenario(MUSE_GLIMMER_CXL_SCENARIO)
  assert.equal(result.isValid, true)
  assert.equal(result.errors.length, 0)
})

test('2. Missing required schema properties are caught by schema validation', () => {
  const broken = JSON.parse(JSON.stringify(MUSE_GLIMMER_CXL_SCENARIO))
  delete broken.version
  delete broken.duration_ns

  const result = validateScenario(broken)
  assert.equal(result.isValid, false)
  assert.ok(result.errors.some((e) => e.field.includes('version')))
  assert.ok(result.errors.some((e) => e.field.includes('duration_ns')))
})

test('3. Additional unauthorized properties are rejected (additionalProperties: false)', () => {
  const withExtra = JSON.parse(JSON.stringify(MUSE_GLIMMER_CXL_SCENARIO))
  withExtra.invented_field = 'not_in_specs'

  const result = validateScenario(withExtra)
  assert.equal(result.isValid, false)
  assert.ok(result.errors.some((e) => e.message.includes('not permitted by SPECS/config.schema.json') || e.field.includes('invented_field')))
})

test('4. Graph integrity: undeclared link endpoints are rejected', () => {
  const badLink = JSON.parse(JSON.stringify(MUSE_GLIMMER_CXL_SCENARIO))
  badLink.fabric.links[0].to = 'phantom-pool-99'

  const result = validateScenario(badLink)
  assert.equal(result.isValid, false)
  assert.ok(result.errors.some((e) => e.message.includes('phantom-pool-99')))
})

test('5. Self-connecting links are rejected', () => {
  const selfLink = JSON.parse(JSON.stringify(MUSE_GLIMMER_CXL_SCENARIO))
  selfLink.fabric.links[0].to = selfLink.fabric.links[0].from

  const result = validateScenario(selfLink)
  assert.equal(result.isValid, false)
  assert.ok(result.errors.some((e) => e.message.includes('Self-connecting link')))
})

test('6. Provenance schema enforcement: valid provenance passes, invalid kind is rejected', () => {
  const withValidProv = JSON.parse(JSON.stringify(MUSE_GLIMMER_CXL_SCENARIO))
  withValidProv.fabric.links[0].provenance = {
    kind: 'measured',
    source: 'bench_run_42',
    method: 'mlc_bandwidth_test',
    date: '2026-11-01'
  }

  const validRes = validateScenario(withValidProv)
  assert.equal(validRes.isValid, true)

  // Invalid kind
  const withInvalidProv = JSON.parse(JSON.stringify(withValidProv))
  withInvalidProv.fabric.links[0].provenance.kind = 'invented_kind'

  const invalidRes = validateScenario(withInvalidProv)
  assert.equal(invalidRes.isValid, false)
  assert.ok(invalidRes.errors.some((e) => e.field.includes('provenance') || e.message.includes('kind')))
})

test('7. Switch ids are legal link endpoints (named and legacy single)', () => {
  const viaSwitch = JSON.parse(JSON.stringify(MUSE_GLIMMER_CXL_SCENARIO))
  // Route the first link through a declared named switch.
  viaSwitch.fabric.switches = [{ id: 'switch-0', bandwidth_bytes_per_ns: 200 }]
  viaSwitch.fabric.links[0].to = 'switch-0'

  const named = validateScenario(viaSwitch)
  assert.equal(named.errors.filter((e) => e.message.includes('switch-0')).length, 0)

  // Legacy single-switch form carries the implicit id switch-0.
  const legacy = JSON.parse(JSON.stringify(MUSE_GLIMMER_CXL_SCENARIO))
  legacy.fabric.switch = { bandwidth_bytes_per_ns: 200 }
  legacy.fabric.links[0].to = 'switch-0'

  const legacyRes = validateScenario(legacy)
  assert.equal(legacyRes.errors.filter((e) => e.message.includes('switch-0')).length, 0)
})
