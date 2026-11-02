import { describe, it } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareComparisonChartData } from '../../utils/comparisonMetrics.ts'
import { validateRunSummary } from '../../services/contractValidators.ts'
import { adaptRunSummaryToSimulationRun } from '../../types/telemetry.ts'
import type { SimulationRun, RunSummary } from '../../types/telemetry.ts'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

describe('Stage 3 — Simulator Data Integrity, Migration Terminology & API Contract Parity', () => {
  describe('1. Migration Volume Metric Mapping Parity', () => {
    it('maps migration_bytes directly to migrationGb preserving numerical accuracy without proactive inflation', () => {
      const mockRun: SimulationRun = {
        id: 'run-test-1',
        scenario_name: 'test-scenario',
        scenario_hash: 'sha256:abc',
        workload_profile: 'kv_cache_decode',
        policy_name: 'hot_cold',
        policy_display_name: 'hot_cold',
        seed: 42,
        duration_ns: 1000000,
        status: 'completed',
        created_at: '2026-11-02T12:00:00Z',
        metrics: {
          latency_ns: { p50: 100, p90: 150, p95: 200, p99: 300, mean: 120, max: 400 },
          stall_time_ns: 0,
          local_hit_ratio: 0.9,
          remote_hit_ratio: 0.1,
          miss_ratio: 0.0,
          remote_traffic_bytes: 4294967296, // 4.0 GiB
          remote_write_bytes: 1073741824, // 1.0 GiB
          migration_bytes: 2147483648, // 2.0 GiB
          fabric_utilization: 0.25,
          peak_queue_depth_bytes: 1024,
          total_accesses: 50000
        },
        time_series: [],
        bottleneck: { severity: 'low', primary_bottleneck: 'none', explanation: 'ok', suggested_policy_tuning: 'none' }
      }

      const { trafficData } = prepareComparisonChartData([mockRun])
      assert.strictEqual(trafficData.length, 1)
      assert.strictEqual(trafficData[0].name, 'hot_cold')
      assert.strictEqual(trafficData[0].remoteTrafficGb, 4.0)
      assert.strictEqual(trafficData[0].migrationGb, 2.0)
    })

    it('preserves null for migrationGb when simulation did not measure migration', () => {
      const mockRunNull: SimulationRun = {
        id: 'run-test-null',
        scenario_name: 'test-null',
        scenario_hash: 'sha256:null',
        workload_profile: 'kv_cache_decode',
        policy_name: 'local_only',
        policy_display_name: 'local_only',
        seed: 42,
        duration_ns: 1000000,
        status: 'completed',
        created_at: '2026-11-02T12:00:00Z',
        metrics: {
          latency_ns: { p50: 100, p90: 150, p95: 200, p99: 300, mean: 120, max: 400 },
          stall_time_ns: 0,
          local_hit_ratio: 1.0,
          remote_hit_ratio: 0.0,
          miss_ratio: 0.0,
          remote_traffic_bytes: null,
          remote_write_bytes: null,
          migration_bytes: null,
          fabric_utilization: null,
          peak_queue_depth_bytes: null,
          total_accesses: null
        },
        time_series: [],
        bottleneck: { severity: 'low', primary_bottleneck: 'none', explanation: 'ok', suggested_policy_tuning: 'none' }
      }

      const { trafficData } = prepareComparisonChartData([mockRunNull])
      assert.strictEqual(trafficData[0].migrationGb, null)
      assert.strictEqual(trafficData[0].remoteTrafficGb, null)
    })
  })

  describe('2. FastAPI Contract Parity — RunSummary and remote_write_bytes', () => {
    it('validates authentic FastAPI strip response including remote_write_bytes', () => {
      const rawBackendStrip = {
        run_id: '5a20bdf5956f-s42-swap_remote',
        scenario_name: 'llama-70b-cxl-overcommit',
        scenario_hash: 'sha256:88fb85',
        seed: 42,
        policy: { requested: 'swap_remote', effective: 'swap_remote', fallback_reason: null },
        status: 'completed',
        error: null,
        arrived: 200,
        completed: 200,
        rejected: 0,
        p50: 110,
        p95: 5362,
        remote_read_bytes: 2736000000,
        remote_write_bytes: 849000000,
        migration_bytes: 2736000000,
        created_at: '2026-11-02T10:00:00Z'
      }

      const summary = validateRunSummary(rawBackendStrip)
      assert.strictEqual(summary.run_id, '5a20bdf5956f-s42-swap_remote')
      assert.strictEqual(summary.remote_read_bytes, 2736000000)
      assert.strictEqual(summary.remote_write_bytes, 849000000)
      assert.strictEqual(summary.migration_bytes, 2736000000)
      assert.strictEqual(summary.status, 'completed')
    })
  })

  describe('3. Telemetry Adapter Fidelity', () => {
    it('adapts RunSummary into SimulationRun preserving remote_write_bytes and migration_bytes', () => {
      const summary: RunSummary = {
        run_id: 'test-adapter-1',
        scenario_name: 'llama-70b',
        scenario_hash: 'sha256:123',
        seed: 42,
        policy: { requested: 'hot_cold', effective: 'hot_cold', fallback_reason: null },
        status: 'completed',
        error: null,
        arrived: 50,
        completed: 50,
        rejected: 0,
        p50: 120,
        p95: 44206,
        remote_read_bytes: 2760000000,
        remote_write_bytes: 920000000,
        migration_bytes: 2760000000,
        created_at: '2026-11-02T10:00:00Z'
      }

      const run = adaptRunSummaryToSimulationRun(summary)
      assert.strictEqual(run.metrics.remote_traffic_bytes, 2760000000)
      assert.strictEqual(run.metrics.remote_write_bytes, 920000000)
      assert.strictEqual(run.metrics.migration_bytes, 2760000000)
    })
  })

  describe('4. Settings Backend Startup Command Veracity', () => {
    it('contains the verified factory command for create_app', () => {
      const settingsPath = path.resolve(__dirname, '../settings/SettingsView.tsx')
      const content = fs.readFileSync(settingsPath, 'utf-8')

      // Must include verified factory command
      assert.ok(
        content.includes('python -m uvicorn rmemfab.api.app:create_app --factory --host 127.0.0.1 --port 8000'),
        'SettingsView must contain the correct factory command'
      )
      // Must NOT contain the broken module attribute command
      assert.ok(
        !content.includes('uvicorn rmemfab.api.app:app'),
        'SettingsView must not contain broken uvicorn rmemfab.api.app:app command'
      )
    })
  })

  describe('5. Policy Comparison Terminology Veracity', () => {
    it('uses Memory Migration Volume without Proactive Migration label', () => {
      const comparisonPath = path.resolve(__dirname, 'PolicyComparisonView.tsx')
      const content = fs.readFileSync(comparisonPath, 'utf-8')

      assert.ok(
        content.includes('Remote Memory Traffic & Memory Migration Volume (GiB)'),
        'Must contain Memory Migration Volume title'
      )
      assert.ok(
        content.includes('name="Memory Migration Volume (GiB)"'),
        'Must contain Memory Migration Volume Bar label'
      )
      assert.ok(
        !content.includes('Proactive Migration'),
        'Must not contain misleading "Proactive Migration" label'
      )
    })
  })
})
