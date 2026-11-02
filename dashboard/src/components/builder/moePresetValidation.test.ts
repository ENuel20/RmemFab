import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MOE_RDMA_SCENARIO } from '../../services/mockData.ts'
import { validateScenario } from '../../utils/validation.ts'

describe('Scenario Builder MoE Preset and Backend Validation Parity', () => {
  it('1. MoE preset preserves original workload identity (profile: moe)', () => {
    assert.equal(MOE_RDMA_SCENARIO.workload.type, 'synthetic')
    if (MOE_RDMA_SCENARIO.workload.type === 'synthetic') {
      assert.equal(MOE_RDMA_SCENARIO.workload.profile, 'moe')
      assert.equal(MOE_RDMA_SCENARIO.workload.model?.family, 'mixtral')
      assert.equal(MOE_RDMA_SCENARIO.workload.model?.experts, 8)
      assert.equal(MOE_RDMA_SCENARIO.workload.model?.top_k, 2)
    }
  })

  it('2. MoE preset uses supported output format (jsonl, not parquet)', () => {
    assert.equal(MOE_RDMA_SCENARIO.output?.format, 'jsonl')
  })

  it('3. MoE preset uses only implemented frequency_aware policy parameters (k=2)', () => {
    assert.equal(MOE_RDMA_SCENARIO.policy.name, 'frequency_aware')
    assert.deepEqual(MOE_RDMA_SCENARIO.policy.params, { k: 2 })
    // Ensure deprecated / unknown parameters are removed
    assert.equal((MOE_RDMA_SCENARIO.policy.params as Record<string, unknown>).history_length, undefined)
    assert.equal((MOE_RDMA_SCENARIO.policy.params as Record<string, unknown>).protect_fraction, undefined)
    assert.equal((MOE_RDMA_SCENARIO.policy.params as Record<string, unknown>).migration_watermark, undefined)
    assert.equal((MOE_RDMA_SCENARIO.policy.params as Record<string, unknown>).max_migrations_per_tick, undefined)
  })

  it('4. Hardware components carry explicit provenance with kind: assumed', () => {
    for (const node of MOE_RDMA_SCENARIO.nodes) {
      if (node.local_memory) {
        assert.ok(node.local_memory.provenance, `node ${node.id} local_memory missing provenance`)
        assert.equal(node.local_memory.provenance.kind, 'assumed')
        assert.ok(node.local_memory.provenance.source)
        assert.ok(node.local_memory.provenance.method)
      }
      if (node.compute) {
        assert.ok(node.compute.provenance, `node ${node.id} compute missing provenance`)
        assert.equal(node.compute.provenance.kind, 'assumed')
        assert.ok(node.compute.provenance.source)
        assert.ok(node.compute.provenance.method)
      }
      if (node.remote_memory) {
        assert.ok(node.remote_memory.provenance, `node ${node.id} remote_memory missing provenance`)
        assert.equal(node.remote_memory.provenance.kind, 'assumed')
        assert.ok(node.remote_memory.provenance.source)
        assert.ok(node.remote_memory.provenance.method)
      }
    }

    if (MOE_RDMA_SCENARIO.fabric?.links) {
      for (const link of MOE_RDMA_SCENARIO.fabric.links) {
        assert.ok(link.provenance, `fabric link ${link.id} missing provenance`)
        assert.equal(link.provenance.kind, 'assumed')
        assert.ok(link.provenance.source)
        assert.ok(link.provenance.method)
      }
    }
  })

  it('5. MoE preset passes JSON schema validation', () => {
    const result = validateScenario(MOE_RDMA_SCENARIO)
    assert.equal(result.isValid, true, `Validation errors: ${result.errors.map((e) => `${e.path}: ${e.message}`).join(', ')}`)
    assert.equal(result.errors.length, 0)
  })

  it('6. Frontend distinguishes schema validity from backend engine executability', () => {
    const isSynthetic = MOE_RDMA_SCENARIO.workload.type === 'synthetic'
    const profile = isSynthetic ? MOE_RDMA_SCENARIO.workload.profile : undefined

    // Conforms to SPECS/config.schema.json
    const schemaValidation = validateScenario(MOE_RDMA_SCENARIO)
    assert.equal(schemaValidation.isValid, true)

    // But is NOT executable by backend discrete-event engine (only kv_cache_decode is implemented)
    const isProfileExecutable = MOE_RDMA_SCENARIO.workload.type === 'trace' || profile === 'kv_cache_decode'
    assert.equal(isProfileExecutable, false)
  })
})

