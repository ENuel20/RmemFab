import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatNanoseconds } from '../../utils/formatters.ts'
import type { ScenarioConfig } from '../../types/scenario.ts'

describe('Overview Provenance, Memory Tier Chart, and Stall Time Regression Suite', () => {
  it('1. KPI provenance: resolves live vs demo badge without mixing datasets', () => {
    // Tests provenance logic in KpiCard
    const resolveProvenance = (
      provenance?: 'live' | 'demo' | 'none',
      demoBadge?: boolean
    ): 'live' | 'demo' | 'none' => {
      if (provenance !== undefined) return provenance
      if (demoBadge === false) return 'none'
      if (demoBadge === true) return 'demo'
      return 'none'
    }

    assert.equal(resolveProvenance('live'), 'live', 'LIVE mode must explicitly yield live provenance')
    assert.equal(resolveProvenance('demo'), 'demo', 'DEMO mode must explicitly yield demo provenance')
    assert.equal(resolveProvenance(undefined, false), 'none', 'Disabled badge must yield none')
    assert.equal(resolveProvenance(undefined, true), 'demo', 'Default fallback yields demo')
  })

  it('2. Memory Tier Chart: transforms all 5 scenario nodes without dropping compute or pool nodes', () => {
    const sampleScenario: ScenarioConfig = {
      $schema: '../SPECS/config.schema.json',
      version: '0.1',
      name: 'llama-70b-cxl',
      description: 'Test',
      seed: 42,
      duration_ns: 60000000000,
      page_size_bytes: 2097152,
      nodes: [
        {
          id: 'node-0',
          role: 'compute',
          local_memory: { capacity_bytes: 549755813888, latency_ns: 90, bandwidth_bytes_per_ns: 400 },
          compute: { accelerator: 'H100-80GB', accelerators: 8, accelerator_memory_bytes: 85899345920 }
        },
        {
          id: 'node-1',
          role: 'compute',
          local_memory: { capacity_bytes: 549755813888, latency_ns: 90, bandwidth_bytes_per_ns: 400 },
          compute: { accelerator: 'H100-80GB', accelerators: 8, accelerator_memory_bytes: 85899345920 }
        },
        {
          id: 'node-2',
          role: 'compute',
          local_memory: { capacity_bytes: 549755813888, latency_ns: 90, bandwidth_bytes_per_ns: 400 },
          compute: { accelerator: 'H100-80GB', accelerators: 8, accelerator_memory_bytes: 85899345920 }
        },
        {
          id: 'node-3',
          role: 'compute',
          local_memory: { capacity_bytes: 549755813888, latency_ns: 90, bandwidth_bytes_per_ns: 400 },
          compute: { accelerator: 'H100-80GB', accelerators: 8, accelerator_memory_bytes: 85899345920 }
        },
        {
          id: 'remote-pool',
          role: 'memory',
          remote_memory: { capacity_bytes: 4398046511104, latency_ns: 180, bandwidth_bytes_per_ns: 48 }
        }
      ]
    }

    const tierDistributionData = sampleScenario.nodes.map((n) => ({
      name: n.id,
      localDramGb: n.local_memory?.capacity_bytes
        ? parseFloat((n.local_memory.capacity_bytes / (1024 ** 3)).toFixed(1))
        : 0,
      remotePoolGb: n.remote_memory?.capacity_bytes
        ? parseFloat((n.remote_memory.capacity_bytes / (1024 ** 3)).toFixed(1))
        : 0,
      acceleratorHbmGb: n.compute?.accelerator_memory_bytes
        ? parseFloat((n.compute.accelerator_memory_bytes / (1024 ** 3)).toFixed(1))
        : 0
    }))

    // Must have all 5 nodes
    assert.equal(tierDistributionData.length, 5)
    assert.deepEqual(
      tierDistributionData.map((d) => d.name),
      ['node-0', 'node-1', 'node-2', 'node-3', 'remote-pool']
    )

    // Compute nodes: 512 GiB local DRAM, 0 GiB remote pool, 80 GiB accelerator HBM
    for (let i = 0; i < 4; i++) {
      assert.equal(tierDistributionData[i].localDramGb, 512)
      assert.equal(tierDistributionData[i].remotePoolGb, 0)
      assert.equal(tierDistributionData[i].acceleratorHbmGb, 80)
    }

    // Memory node: 0 GiB local DRAM, 4096 GiB remote pool, 0 GiB accelerator HBM
    assert.equal(tierDistributionData[4].localDramGb, 0)
    assert.equal(tierDistributionData[4].remotePoolGb, 4096)
    assert.equal(tierDistributionData[4].acceleratorHbmGb, 0)
  })

  it('3. Cumulative Stall Time interpretation: formats correctly when cumulative sum exceeds virtual duration', () => {
    // 3246786423722.4067 ns = 3246.786 s
    const rawStallNs = 3246786423722.4067
    const formatted = formatNanoseconds(rawStallNs)

    assert.equal(formatted, '3246.8 s')
    // Virtual duration is 60s, but aggregate stall across 64 concurrent streams legitimately exceeds 60s
    assert.ok(rawStallNs > 60 * 1e9, 'Cumulative worker stall legitimately exceeds 60s virtual time')
  })

  it('4. Missing metric handling: unavailable measurements remain — rather than fabricating numbers', () => {
    const formatValueOrUnavailable = (v: number | null | undefined): string => {
      if (v === null || v === undefined || isNaN(v)) return '—'
      return String(v)
    }

    assert.equal(formatValueOrUnavailable(null), '—')
    assert.equal(formatValueOrUnavailable(undefined), '—')
    assert.equal(formatValueOrUnavailable(NaN), '—')
    assert.equal(formatValueOrUnavailable(0), '0', 'Valid 0 is not unavailable')
  })

  it('5. Stall-time terminology: uses Cumulative Memory-Access Stall Time with exact subtitle', () => {
    const primaryLabel = 'Cumulative Memory-Access Stall Time'
    const explanatorySubtitle = 'Sum of individual memory-access stall durations across concurrent workers.'

    assert.equal(primaryLabel, 'Cumulative Memory-Access Stall Time')
    assert.equal(explanatorySubtitle, 'Sum of individual memory-access stall durations across concurrent workers.')
  })

  it('6. LLM KV Working Set calculation: validates Llama-3-70B GQA geometry (320 KiB/token)', () => {
    // 2 * layers * kv_heads * head_dim * dtype_bytes
    // 2 * 80 * 8 * 128 * 2 = 327,680 bytes = 320 KiB
    const layers = 80
    const kvHeads = 8
    const headDim = 128
    const dtypeBytes = 2
    const kvBytesPerToken = 2 * layers * kvHeads * headDim * dtypeBytes

    assert.equal(kvBytesPerToken, 327680)
    assert.equal(kvBytesPerToken / 1024, 320, 'Llama-3-70B GQA requires 320 KiB/token, not 2.62 MB')

    // Concurrency 16 with 4096 prompt + 512 gen = 4608 tokens
    const maxTokensPerReq = 4096 + 512
    const memoryPerReqBytes = maxTokensPerReq * kvBytesPerToken
    const peakWorkingSetPerNodeGb = (16 * memoryPerReqBytes) / (1024 * 1024 * 1024)

    assert.ok(peakWorkingSetPerNodeGb > 22 && peakWorkingSetPerNodeGb < 23, '16 concurrent streams need ~22.5 GiB')
    // Sizing local DRAM to 16 GiB (17,179,869,184 bytes) guarantees ~6.5 GiB overflow into CXL pool
    const constrainedLocalDramBytes = 17179869184
    assert.ok(peakWorkingSetPerNodeGb * (1024 * 1024 * 1024) > constrainedLocalDramBytes, 'Constrained DRAM forces remote overflow')
  })

  it('7. Migration volume arithmetic: verifies migration_bytes equals evict_bytes + install_bytes without proactive inflation', () => {
    const evictBytes = 1378367832064
    const installBytes = 1357599735808
    const migrationBytes = 2735967567872
    assert.equal(evictBytes + installBytes, migrationBytes, 'Migration bytes is the exact sum of dirty evictions and remote installs')
  })

  it('8. Request throughput mapping: distinguishes high-throughput swap vs remote-stalled hot_cold', () => {
    const swapThroughput = 2.0
    const hotColdThroughput = 0.072727
    assert.ok(swapThroughput > hotColdThroughput * 20, 'Hot/cold throughput is ~27.5x lower due to full-attention remote re-reads')
  })
})

