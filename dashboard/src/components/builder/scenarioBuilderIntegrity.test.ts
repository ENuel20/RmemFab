import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  generateUniqueId,
  renameNodeWithLinkCascade,
  isStructurallyValidScenario,
  IMPLEMENTED_POLICIES
} from './scenarioBuilderUtils.ts'
import { LLAMA_70B_CXL_SCENARIO } from '../../services/mockData.ts'
import type { ScenarioConfig } from '../../types/scenario.ts'

describe('Scenario Builder Integrity & State Safety Helpers', () => {
  describe('generateUniqueId', () => {
    it('generates initial id with count 0 when pool is empty', () => {
      const id = generateUniqueId('node', [])
      assert.strictEqual(id, 'node-0')
    })

    it('generates next sequential id when consecutive ids exist', () => {
      const id = generateUniqueId('node', ['node-0', 'node-1', 'node-2'])
      assert.strictEqual(id, 'node-3')
    })

    it('fills deleted id holes to avoid unbounded id expansion', () => {
      // If node-1 was deleted from [node-0, node-1, node-2], next should safely be node-1
      const id = generateUniqueId('node', ['node-0', 'node-2'])
      assert.strictEqual(id, 'node-1')
    })

    it('avoids colliding with arbitrary prefixes', () => {
      const linkId = generateUniqueId('link', ['link-0', 'link-1'])
      assert.strictEqual(linkId, 'link-2')

      const poolId = generateUniqueId('remote-pool', ['remote-pool-0'])
      assert.strictEqual(poolId, 'remote-pool-1')
    })
  })

  describe('renameNodeWithLinkCascade', () => {
    const baseScenario: ScenarioConfig = {
      name: 'test-scenario',
      version: '0.1',
      nodes: [
        {
          id: 'compute-0',
          role: 'compute',
          local_memory: { capacity_bytes: 1024, latency_ns: 90, bandwidth_bytes_per_ns: 400 },
          compute: { accelerator: 'H100-80GB', accelerators: 8, accelerator_memory_bytes: 85899345920 }
        },
        {
          id: 'compute-1',
          role: 'compute',
          local_memory: { capacity_bytes: 1024, latency_ns: 90, bandwidth_bytes_per_ns: 400 },
          compute: { accelerator: 'H100-80GB', accelerators: 8, accelerator_memory_bytes: 85899345920 }
        },
        {
          id: 'remote-pool-0',
          role: 'memory',
          remote_memory: { capacity_bytes: 4096, latency_ns: 180, bandwidth_bytes_per_ns: 48 }
        }
      ],
      fabric: {
        links: [
          {
            id: 'link-0',
            from: 'compute-0',
            to: 'remote-pool-0',
            latency_ns: 180,
            bandwidth_bytes_per_ns: 48,
            bidirectional: true
          },
          {
            id: 'link-1',
            from: 'compute-1',
            to: 'remote-pool-0',
            latency_ns: 180,
            bandwidth_bytes_per_ns: 48,
            bidirectional: true
          }
        ]
      },
      workload: {
        type: 'synthetic',
        profile: 'kv_cache_decode',
        model: { layers: 80, kv_heads: 8, head_dim: 128 },
        requests: { arrival_rate_per_second: 10, concurrency: 16 }
      },
      policy: {
        name: 'swap_remote',
        params: {}
      }
    }

    it('cascades compute node rename to referencing links (from endpoint)', () => {
      const res = renameNodeWithLinkCascade(baseScenario, 'compute-0', 'compute-primary')
      assert.strictEqual(res.error, undefined)
      assert.strictEqual(res.updatedScenario.nodes[0].id, 'compute-primary')
      // link-0 'from' should cascade to compute-primary
      assert.strictEqual(res.updatedScenario.fabric.links[0].from, 'compute-primary')
      assert.strictEqual(res.updatedScenario.fabric.links[0].to, 'remote-pool-0')
      // link-1 should remain unaffected
      assert.strictEqual(res.updatedScenario.fabric.links[1].from, 'compute-1')
    })

    it('cascades memory pool rename to referencing links (to endpoint)', () => {
      const res = renameNodeWithLinkCascade(baseScenario, 'remote-pool-0', 'cxl-pool-central')
      assert.strictEqual(res.error, undefined)
      assert.strictEqual(res.updatedScenario.nodes[2].id, 'cxl-pool-central')
      assert.strictEqual(res.updatedScenario.fabric.links[0].to, 'cxl-pool-central')
      assert.strictEqual(res.updatedScenario.fabric.links[1].to, 'cxl-pool-central')
    })

    it('rejects duplicate node identifiers', () => {
      const res = renameNodeWithLinkCascade(baseScenario, 'compute-0', 'compute-1')
      assert.ok(res.error)
      assert.strictEqual(res.error, "Node identifier 'compute-1' already exists")
      assert.deepStrictEqual(res.updatedScenario, baseScenario)
    })

    it('rejects empty or whitespace-only identifiers', () => {
      const res1 = renameNodeWithLinkCascade(baseScenario, 'compute-0', '')
      assert.strictEqual(res1.error, 'Node identifier cannot be empty')

      const res2 = renameNodeWithLinkCascade(baseScenario, 'compute-0', '   ')
      assert.strictEqual(res2.error, 'Node identifier cannot be empty')
    })

    it('returns unchanged scenario when target ID equals existing ID', () => {
      const res = renameNodeWithLinkCascade(baseScenario, 'compute-0', 'compute-0')
      assert.strictEqual(res.error, undefined)
      assert.deepStrictEqual(res.updatedScenario, baseScenario)
    })
  })

  describe('isStructurallyValidScenario', () => {
    it('accepts valid LLAMA_70B_CXL_SCENARIO preset', () => {
      assert.strictEqual(isStructurallyValidScenario(LLAMA_70B_CXL_SCENARIO), true)
    })

    it('rejects primitive values, null, undefined and arrays', () => {
      assert.strictEqual(isStructurallyValidScenario(null), false)
      assert.strictEqual(isStructurallyValidScenario(undefined), false)
      assert.strictEqual(isStructurallyValidScenario('scenario'), false)
      assert.strictEqual(isStructurallyValidScenario(123), false)
      assert.strictEqual(isStructurallyValidScenario([]), false)
    })

    it('rejects scenario missing required high-level structures', () => {
      assert.strictEqual(isStructurallyValidScenario({ name: 'missing-nodes' }), false)
      assert.strictEqual(isStructurallyValidScenario({ name: 'no-fabric', nodes: [] }), false)
      assert.strictEqual(isStructurallyValidScenario({ name: 'no-workload', nodes: [], fabric: { links: [] } }), false)
      assert.strictEqual(
        isStructurallyValidScenario({
          name: 'no-policy',
          nodes: [],
          fabric: { links: [] },
          workload: { type: 'trace' }
        }),
        false
      )
    })
  })

  describe('IMPLEMENTED_POLICIES Integrity', () => {
    it('contains all 5 backend executable simulation policies', () => {
      const expected = ['hot_cold', 'frequency_aware', 'swap_remote', 'local_only', 'predictive_prefetch']
      for (const policy of expected) {
        assert.ok(
          IMPLEMENTED_POLICIES.includes(policy),
          `Expected IMPLEMENTED_POLICIES to include ${policy}`
        )
      }
    })

    it('does not include unimplemented cost_aware policy', () => {
      assert.strictEqual(IMPLEMENTED_POLICIES.includes('cost_aware'), false)
    })
  })
})

