import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LLAMA_70B_CXL_SCENARIO } from '../../services/mockData.ts'
import { validateScenario } from '../../utils/validation.ts'

describe('Scenario Builder Llama-70B Preset Audit and Validation Parity', () => {
  it('1. Preserves workload geometry, hardware capacity, topology, seed, and duration', () => {
    assert.equal(LLAMA_70B_CXL_SCENARIO.name, 'llama-70b-cxl')
    assert.equal(LLAMA_70B_CXL_SCENARIO.seed, 42)
    assert.equal(LLAMA_70B_CXL_SCENARIO.duration_ns, 60000000000)
    assert.equal(LLAMA_70B_CXL_SCENARIO.warmup_ns, 5000000000)
    assert.equal(LLAMA_70B_CXL_SCENARIO.page_size_bytes, 2097152)

    // 4 compute nodes + 1 memory node
    assert.equal(LLAMA_70B_CXL_SCENARIO.nodes.length, 5)
    const computeNodes = LLAMA_70B_CXL_SCENARIO.nodes.filter((n) => n.role === 'compute')
    assert.equal(computeNodes.length, 4)
    for (const node of computeNodes) {
      assert.equal(node.local_memory?.capacity_bytes, 549755813888) // 512 GiB
      assert.equal(node.local_memory?.latency_ns, 90)
      assert.equal(node.local_memory?.bandwidth_bytes_per_ns, 400)
      assert.equal(node.compute?.accelerator, 'H100-80GB')
      assert.equal(node.compute?.accelerators, 8)
      assert.equal(node.compute?.accelerator_memory_bytes, 85899345920)
    }

    const poolNode = LLAMA_70B_CXL_SCENARIO.nodes.find((n) => n.role === 'memory')
    assert.ok(poolNode)
    assert.equal(poolNode.remote_memory?.capacity_bytes, 4398046511104) // 4 TiB
    assert.equal(poolNode.remote_memory?.latency_ns, 180)
    assert.equal(poolNode.remote_memory?.bandwidth_bytes_per_ns, 48)

    // 4 fabric links
    assert.equal(LLAMA_70B_CXL_SCENARIO.fabric.links.length, 4)

    // Workload
    assert.equal(LLAMA_70B_CXL_SCENARIO.workload.type, 'synthetic')
    if (LLAMA_70B_CXL_SCENARIO.workload.type === 'synthetic') {
      assert.equal(LLAMA_70B_CXL_SCENARIO.workload.profile, 'kv_cache_decode')
      assert.equal(LLAMA_70B_CXL_SCENARIO.workload.model?.name, 'llama-3-70b')
      assert.equal(LLAMA_70B_CXL_SCENARIO.workload.model?.layers, 80)
      assert.equal(LLAMA_70B_CXL_SCENARIO.workload.model?.attention_heads, 64)
      assert.equal(LLAMA_70B_CXL_SCENARIO.workload.model?.kv_heads, 8)
      assert.equal(LLAMA_70B_CXL_SCENARIO.workload.model?.head_dim, 128)
      assert.equal(LLAMA_70B_CXL_SCENARIO.workload.model?.dtype_bytes, 2)
      assert.equal(LLAMA_70B_CXL_SCENARIO.workload.requests?.concurrency, 16)
      assert.equal(LLAMA_70B_CXL_SCENARIO.workload.requests?.prompt_tokens, 4096)
      assert.equal(LLAMA_70B_CXL_SCENARIO.workload.requests?.generated_tokens, 512)
    }
  })

  it('2. Policy hot_cold uses only supported parameters without unsupported engine fields', () => {
    assert.equal(LLAMA_70B_CXL_SCENARIO.policy.name, 'hot_cold')
    assert.deepEqual(LLAMA_70B_CXL_SCENARIO.policy.params, {
      hot_threshold: 8,
      cold_threshold: 1
    })

    const params = LLAMA_70B_CXL_SCENARIO.policy.params as Record<string, unknown>
    // Ensure tick_ns, min_residency_ns, and max_migrations_per_tick are eliminated
    assert.equal(params.tick_ns, undefined, 'tick_ns must not be present in policy params')
    assert.equal(params.min_residency_ns, undefined, 'min_residency_ns must not be present in policy params')
    assert.equal(params.max_migrations_per_tick, undefined, 'max_migrations_per_tick must not be present in policy params')
  })

  it('3. Every hardware component and fabric link carries explicit assumed provenance', () => {
    let provenanceCount = 0

    for (const node of LLAMA_70B_CXL_SCENARIO.nodes) {
      if (node.local_memory) {
        provenanceCount++
        const p = node.local_memory.provenance
        assert.ok(p, `node ${node.id} local_memory missing provenance`)
        assert.equal(p.kind, 'assumed')
        assert.notEqual(p.kind, 'measured', 'Assumed hardware must never be marked measured')
        assert.ok(p.source, `node ${node.id} local_memory missing source`)
        assert.ok(p.method, `node ${node.id} local_memory missing method`)
        assert.ok(typeof p.uncertainty_pct === 'number', `node ${node.id} local_memory missing uncertainty_pct`)
      }

      if (node.compute) {
        provenanceCount++
        const p = node.compute.provenance
        assert.ok(p, `node ${node.id} compute missing provenance`)
        assert.equal(p.kind, 'assumed')
        assert.notEqual(p.kind, 'measured', 'Assumed hardware must never be marked measured')
        assert.ok(p.source, `node ${node.id} compute missing source`)
        assert.ok(p.method, `node ${node.id} compute missing method`)
        assert.ok(typeof p.uncertainty_pct === 'number', `node ${node.id} compute missing uncertainty_pct`)
      }

      if (node.remote_memory) {
        provenanceCount++
        const p = node.remote_memory.provenance
        assert.ok(p, `node ${node.id} remote_memory missing provenance`)
        assert.equal(p.kind, 'assumed')
        assert.notEqual(p.kind, 'measured', 'Assumed hardware must never be marked measured')
        assert.ok(p.source, `node ${node.id} remote_memory missing source`)
        assert.ok(p.method, `node ${node.id} remote_memory missing method`)
        assert.ok(typeof p.uncertainty_pct === 'number', `node ${node.id} remote_memory missing uncertainty_pct`)
      }
    }

    for (const link of LLAMA_70B_CXL_SCENARIO.fabric.links) {
      provenanceCount++
      const p = link.provenance
      assert.ok(p, `fabric link ${link.id} missing provenance`)
      assert.equal(p.kind, 'assumed')
      assert.notEqual(p.kind, 'measured', 'Assumed fabric link must never be marked measured')
      assert.ok(p.source, `fabric link ${link.id} missing source`)
      assert.ok(p.method, `fabric link ${link.id} missing method`)
      assert.ok(typeof p.uncertainty_pct === 'number', `fabric link ${link.id} missing uncertainty_pct`)
    }

    // 4 compute nodes * 2 + 1 remote-pool * 1 + 4 links = 13 provenance blocks
    assert.equal(provenanceCount, 13, 'Expected exactly 13 explicit provenance definitions')
  })

  it('4. Preset passes authorative JSON schema and topological validation', () => {
    const result = validateScenario(LLAMA_70B_CXL_SCENARIO)
    assert.equal(result.isValid, true, `Validation failed: ${JSON.stringify(result.errors)}`)
    assert.equal(result.errors.length, 0)
  })

  it('5. Preset is recognized as executable by the backend engine (kv_cache_decode)', () => {
    const isSynthetic = LLAMA_70B_CXL_SCENARIO.workload.type === 'synthetic'
    const profile = isSynthetic ? LLAMA_70B_CXL_SCENARIO.workload.profile : undefined
    const isProfileExecutable = LLAMA_70B_CXL_SCENARIO.workload.type === 'trace' || profile === 'kv_cache_decode'
    assert.equal(isProfileExecutable, true, 'Llama-70B CXL preset must be executable')
  })
})

