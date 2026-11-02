import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  adaptRunSummaryToSimulationRun,
  type RunSummary
} from './telemetry.ts'
import { deriveTopologySummary } from '../components/infrastructure/topologyHelpers.ts'
import { validateRunDetail } from '../services/contractValidators.ts'

describe('LIVE Telemetry and Scenario Snapshot Regression Suite', () => {
  // Realistic fixture matching confirmed backend GET /runs/{id} response
  const realisticLiveRunFixture = {
    run_id: '5810d9205417-s7-swap_remote',
    status: 'completed',
    error: null,
    manifest: {
      rmemfab_version: '0.1.0',
      scenario_hash: '5810d92054177767d4e3c651460f03b731485b534b165cee95b9cb7dc3307d51',
      seed: 7,
      percentile_method: 'upper_bucket_edge:growth=1.01',
      page_size_bytes: 2097152
    },
    scenario: {
      name: 'phase1-overflow',
      seed: 7,
      duration_ns: 500000000,
      nodes: [
        {
          id: 'node-0',
          role: 'compute',
          local_memory: {
            capacity_bytes: 2147483648,
            latency_ns: 90,
            bandwidth_bytes_per_ns: 400
          }
        },
        {
          id: 'remote-pool',
          role: 'memory',
          remote_memory: {
            capacity_bytes: 4398046511104,
            latency_ns: 180,
            bandwidth_bytes_per_ns: 48
          }
        }
      ],
      fabric: {
        links: [
          {
            id: 'node-0-cxl',
            from: 'node-0',
            to: 'remote-pool',
            latency_ns: 180,
            bandwidth_bytes_per_ns: 48
          }
        ]
      },
      workload: { type: 'synthetic', profile: 'llama' },
      policy: { name: 'swap_remote' }
    },
    summary: {
      scenario: 'phase1-overflow',
      seed: 7,
      access: {
        latency_ns: {
          p50: 445.66,
          p95: 890.12,
          p99: 1240.50,
          mean: 467.08,
          max: 437762.67
        },
        local_hit_ratio: 0.01203,
        remote_hit_ratio: 0.98797,
        miss_ratio: 0.0,
        stall_ns: 23321618.67,
        count: 63840
      },
      links: {
        'node-0-cxl': {
          utilization: 0.006764,
          max_queue_bytes: 22020096,
          bytes_in: 258342912,
          bytes_out: 66322432
        }
      },
      memory: {
        'node-0': {
          bandwidth_utilization: 0.000039,
          capacity_pages: 64
        }
      },
      pool: {
        utilization: 0.013528,
        capacity_pages: 268435456
      },
      traffic: {
        remote_read_bytes: 258342912,
        migration_bytes: 66322432
      }
    }
  }

  it('preserves scenario through validateRunDetail contract validator', () => {
    const validated = validateRunDetail(realisticLiveRunFixture, realisticLiveRunFixture.run_id)
    assert.ok(validated.scenario, 'Scenario should be preserved by validateRunDetail')
    const sc = validated.scenario as { name?: string; nodes?: unknown[] }
    assert.equal(sc.name, 'phase1-overflow')
    assert.equal(sc.nodes?.length, 2)
  })

  it('maps scenario nodes and fabric links through adapter to Infrastructure topology', () => {
    const validated = validateRunDetail(realisticLiveRunFixture, realisticLiveRunFixture.run_id)
    const summaryStrip: RunSummary = {
      run_id: validated.run_id,
      scenario_name: 'phase1-overflow',
      scenario_hash: null,
      seed: 7,
      policy: { requested: 'swap_remote', effective: 'swap_remote', fallback_reason: null },
      status: 'completed',
      error: null,
      arrived: 63840,
      completed: 63840,
      rejected: 0,
      p50: 445.66,
      p95: 890.12,
      remote_read_bytes: 258342912,
      migration_bytes: 66322432,
      created_at: null,
      is_demo: false
    }

    const run = adaptRunSummaryToSimulationRun(summaryStrip, validated, [])
    assert.ok(run.scenario_snapshot, 'run.scenario_snapshot must be populated from detail.scenario')
    assert.equal(run.scenario_snapshot.nodes.length, 2)
    assert.equal(run.scenario_snapshot.fabric.links.length, 1)

    // Verify it feeds Infrastructure topology extraction
    const topology = deriveTopologySummary(run.scenario_snapshot, run.metrics)
    assert.equal(topology.hasScenario, true)
    assert.equal(topology.computeNodes.length, 1)
    assert.equal(topology.computeNodes[0].id, 'node-0')
    assert.equal(topology.memoryPoolNodes.length, 1)
    assert.equal(topology.memoryPoolNodes[0].id, 'remote-pool')
    assert.equal(topology.links.length, 1)
    assert.equal(topology.links[0].id, 'node-0-cxl')
    assert.equal(topology.totalLocalMemoryBytes, 2147483648)
    assert.equal(topology.totalRemoteMemoryBytes, 4398046511104)
    assert.equal(topology.fabricUtilization, 0.006764)
  })

  it('maps p50, p95 and p99 correctly from nested summary.access.latency_ns', () => {
    const validated = validateRunDetail(realisticLiveRunFixture, realisticLiveRunFixture.run_id)
    const summaryStrip: RunSummary = {
      run_id: validated.run_id,
      scenario_name: 'phase1-overflow',
      scenario_hash: null,
      seed: 7,
      policy: { requested: 'swap_remote', effective: 'swap_remote', fallback_reason: null },
      status: 'completed',
      error: null,
      arrived: null,
      completed: null,
      rejected: null,
      p50: null,
      p95: null,
      remote_read_bytes: null,
      migration_bytes: null,
      created_at: null
    }

    const run = adaptRunSummaryToSimulationRun(summaryStrip, validated, [])
    assert.equal(run.metrics.latency_ns.p50, 445.66)
    assert.equal(run.metrics.latency_ns.p95, 890.12)
    assert.equal(run.metrics.latency_ns.p99, 1240.50)
    assert.equal(run.metrics.latency_ns.mean, 467.08)
    assert.equal(run.metrics.latency_ns.max, 437762.67)
  })

  it('maps local and remote hit ratios correctly from nested summary.access', () => {
    const validated = validateRunDetail(realisticLiveRunFixture, realisticLiveRunFixture.run_id)
    const summaryStrip: RunSummary = {
      run_id: validated.run_id,
      scenario_name: 'phase1-overflow',
      scenario_hash: null,
      seed: 7,
      policy: { requested: 'swap_remote', effective: 'swap_remote', fallback_reason: null },
      status: 'completed',
      error: null,
      arrived: null,
      completed: null,
      rejected: null,
      p50: null,
      p95: null,
      remote_read_bytes: null,
      migration_bytes: null,
      created_at: null
    }

    const run = adaptRunSummaryToSimulationRun(summaryStrip, validated, [])
    assert.equal(run.metrics.local_hit_ratio, 0.01203)
    assert.equal(run.metrics.remote_hit_ratio, 0.98797)
    assert.equal(run.metrics.miss_ratio, 0.0)
  })

  it('keeps metric meanings distinct: fabric link utilization vs memory bandwidth utilization vs pool utilization', () => {
    const validated = validateRunDetail(realisticLiveRunFixture, realisticLiveRunFixture.run_id)
    const summaryStrip: RunSummary = {
      run_id: validated.run_id,
      scenario_name: 'phase1-overflow',
      scenario_hash: null,
      seed: 7,
      policy: { requested: 'swap_remote', effective: 'swap_remote', fallback_reason: null },
      status: 'completed',
      error: null,
      arrived: null,
      completed: null,
      rejected: null,
      p50: null,
      p95: null,
      remote_read_bytes: null,
      migration_bytes: null,
      created_at: null
    }

    const run = adaptRunSummaryToSimulationRun(summaryStrip, validated, [])
    // Fabric link utilization strictly from summary.links (0.006764)
    assert.equal(run.metrics.fabric_utilization, 0.006764)
    // Memory bandwidth utilization strictly from summary.memory (0.000039)
    assert.equal(run.metrics.memory_bandwidth_utilization, 0.000039)
    // Remote pool utilization strictly from summary.pool (0.013528)
    assert.equal(run.metrics.pool_utilization, 0.013528)

    // Verify none are confused with each other
    assert.notEqual(run.metrics.fabric_utilization, run.metrics.memory_bandwidth_utilization)
    assert.notEqual(run.metrics.fabric_utilization, run.metrics.pool_utilization)
  })

  it('preserves zero fabric utilization as a valid measured zero, not unavailable', () => {
    const zeroUtilFixture = JSON.parse(JSON.stringify(realisticLiveRunFixture))
    zeroUtilFixture.summary.links['node-0-cxl'].utilization = 0.0

    const validated = validateRunDetail(zeroUtilFixture, zeroUtilFixture.run_id)
    const summaryStrip: RunSummary = {
      run_id: validated.run_id,
      scenario_name: 'phase1-overflow',
      scenario_hash: null,
      seed: 7,
      policy: { requested: 'swap_remote', effective: 'swap_remote', fallback_reason: null },
      status: 'completed',
      error: null,
      arrived: null,
      completed: null,
      rejected: null,
      p50: null,
      p95: null,
      remote_read_bytes: null,
      migration_bytes: null,
      created_at: null
    }

    const run = adaptRunSummaryToSimulationRun(summaryStrip, validated, [])
    assert.strictEqual(run.metrics.fabric_utilization, 0.0)
    assert.notEqual(run.metrics.fabric_utilization, null)
  })

  it('preserves genuinely missing fields as null rather than fabricating zero', () => {
    const missingFieldsFixture = JSON.parse(JSON.stringify(realisticLiveRunFixture))
    delete missingFieldsFixture.summary.access.latency_ns.p99
    delete missingFieldsFixture.summary.access.local_hit_ratio
    delete missingFieldsFixture.summary.links
    delete missingFieldsFixture.summary.memory
    delete missingFieldsFixture.summary.pool

    const validated = validateRunDetail(missingFieldsFixture, missingFieldsFixture.run_id)
    const summaryStrip: RunSummary = {
      run_id: validated.run_id,
      scenario_name: 'phase1-overflow',
      scenario_hash: null,
      seed: 7,
      policy: { requested: 'swap_remote', effective: 'swap_remote', fallback_reason: null },
      status: 'completed',
      error: null,
      arrived: null,
      completed: null,
      rejected: null,
      p50: null,
      p95: null,
      remote_read_bytes: null,
      migration_bytes: null,
      created_at: null
    }

    const run = adaptRunSummaryToSimulationRun(summaryStrip, validated, [])
    assert.equal(run.metrics.latency_ns.p99, null)
    assert.equal(run.metrics.local_hit_ratio, null)
    assert.equal(run.metrics.fabric_utilization, null)
    assert.equal(run.metrics.memory_bandwidth_utilization, null)
    assert.equal(run.metrics.pool_utilization, null)
  })

  it('keeps existing demo mode and live mode flags intact', () => {
    const liveRun = adaptRunSummaryToSimulationRun(
      { run_id: 'live-1', policy: { requested: 'hot_cold', effective: 'hot_cold', fallback_reason: null }, status: 'completed', error: null, arrived: null, completed: null, rejected: null, p50: null, p95: null, remote_read_bytes: null, migration_bytes: null, created_at: null, seed: null, scenario_name: null, scenario_hash: null, is_demo: false },
      null,
      null
    )
    assert.equal(liveRun.is_demo, false)
    assert.equal(liveRun.policy_display_name, 'hot_cold')

    const demoRun = adaptRunSummaryToSimulationRun(
      { run_id: 'demo-1', policy: { requested: 'hot_cold', effective: 'hot_cold', fallback_reason: null }, status: 'completed', error: null, arrived: null, completed: null, rejected: null, p50: null, p95: null, remote_read_bytes: null, migration_bytes: null, created_at: null, seed: null, scenario_name: null, scenario_hash: null, is_demo: true },
      null,
      null
    )
    assert.equal(demoRun.is_demo, true)
    assert.equal(demoRun.policy_display_name, '[Demo] hot_cold')
  })
})
