import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveTopologySummary } from './topologyHelpers.ts'
import type { ScenarioConfig } from '../../types/scenario.ts'
import type { MetricSummary } from '../../types/telemetry.ts'

describe('Topology Helpers', () => {
  it('returns empty summary when scenario is null or undefined without inventing data', () => {
    const summaryNull = deriveTopologySummary(null, null)
    assert.equal(summaryNull.hasScenario, false)
    assert.equal(summaryNull.computeNodes.length, 0)
    assert.equal(summaryNull.memoryPoolNodes.length, 0)
    assert.equal(summaryNull.links.length, 0)
    assert.equal(summaryNull.totalLocalMemoryBytes, 0)
    assert.equal(summaryNull.totalRemoteMemoryBytes, 0)
    assert.equal(summaryNull.fabricUtilization, null)

    const summaryUndefined = deriveTopologySummary(undefined, undefined)
    assert.equal(summaryUndefined.hasScenario, false)
    assert.equal(summaryUndefined.fabricUtilization, null)
  })

  it('correctly partitions compute nodes and memory pool nodes from scenario', () => {
    const mockScenario: ScenarioConfig = {
      name: 'test-cluster',
      seed: 42,
      duration_ns: 1000000,
      nodes: [
        {
          id: 'host-0',
          role: 'compute',
          local_memory: {
            capacity_bytes: 512 * 1024 * 1024 * 1024,
            latency_ns: 90,
            bandwidth_bytes_per_ns: 400
          }
        },
        {
          id: 'host-1',
          role: 'compute',
          local_memory: {
            capacity_bytes: 512 * 1024 * 1024 * 1024,
            latency_ns: 90,
            bandwidth_bytes_per_ns: 400
          }
        },
        {
          id: 'cxl-pool-0',
          role: 'memory',
          remote_memory: {
            capacity_bytes: 4096 * 1024 * 1024 * 1024,
            latency_ns: 180,
            bandwidth_bytes_per_ns: 48
          }
        }
      ],
      fabric: {
        links: [
          {
            id: 'link-0',
            from: 'host-0',
            to: 'cxl-pool-0',
            latency_ns: 180,
            bandwidth_bytes_per_ns: 48
          }
        ]
      },
      workload: { type: 'synthetic', profile: 'llama' },
      policy: { name: 'hot_cold' }
    }

    const summary = deriveTopologySummary(mockScenario, null)
    assert.equal(summary.hasScenario, true)
    assert.equal(summary.computeNodes.length, 2)
    assert.equal(summary.memoryPoolNodes.length, 1)
    assert.equal(summary.links.length, 1)
    assert.equal(summary.totalLocalMemoryBytes, 1024 * 1024 * 1024 * 1024)
    assert.equal(summary.totalRemoteMemoryBytes, 4096 * 1024 * 1024 * 1024)
  })

  it('preserves authentic fabric utilization when present and keeps null when absent', () => {
    const scenario: ScenarioConfig = {
      name: 'test-util',
      seed: 1,
      duration_ns: 1000,
      nodes: [],
      fabric: { links: [] },
      workload: { type: 'synthetic', profile: 'llama' },
      policy: { name: 'local_only' }
    }

    const metricsWithUtil: Partial<MetricSummary> = {
      fabric_utilization: 0.742
    }
    const res1 = deriveTopologySummary(scenario, metricsWithUtil as MetricSummary)
    assert.equal(res1.fabricUtilization, 0.742)

    const metricsWithoutUtil: Partial<MetricSummary> = {
      fabric_utilization: undefined
    }
    const res2 = deriveTopologySummary(scenario, metricsWithoutUtil as MetricSummary)
    assert.equal(res2.fabricUtilization, null)
  })
})
