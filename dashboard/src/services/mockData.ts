/**
 * Authentic Mock Telemetry and Scenario Presets
 * Generated according to SPECS/config.schema.json, examples/llama-70b-cxl.json,
 * and discrete-event simulation models.
 */

import type { ScenarioConfig } from '../types/scenario'
import type { SimulationRun, TimeSeriesPoint } from '../types/telemetry'

export const LLAMA_70B_CXL_SCENARIO: ScenarioConfig = {
  $schema: '../SPECS/config.schema.json',
  version: '0.1',
  name: 'llama-70b-cxl',
  description: 'Four compute nodes serving Llama-3-70B with a shared CXL-attached memory pool. Compares a hot/cold placement policy against local-only and swap baselines.',
  seed: 42,
  duration_ns: 60000000000,
  warmup_ns: 5000000000,
  page_size_bytes: 2097152,
  nodes: [
    {
      id: 'node-0',
      role: 'compute',
      local_memory: {
        capacity_bytes: 549755813888,
        latency_ns: 90,
        bandwidth_bytes_per_ns: 400
      },
      compute: {
        accelerator: 'H100-80GB',
        accelerators: 8,
        accelerator_memory_bytes: 85899345920
      }
    },
    {
      id: 'node-1',
      role: 'compute',
      local_memory: {
        capacity_bytes: 549755813888,
        latency_ns: 90,
        bandwidth_bytes_per_ns: 400
      },
      compute: {
        accelerator: 'H100-80GB',
        accelerators: 8,
        accelerator_memory_bytes: 85899345920
      }
    },
    {
      id: 'node-2',
      role: 'compute',
      local_memory: {
        capacity_bytes: 549755813888,
        latency_ns: 90,
        bandwidth_bytes_per_ns: 400
      },
      compute: {
        accelerator: 'H100-80GB',
        accelerators: 8,
        accelerator_memory_bytes: 85899345920
      }
    },
    {
      id: 'node-3',
      role: 'compute',
      local_memory: {
        capacity_bytes: 549755813888,
        latency_ns: 90,
        bandwidth_bytes_per_ns: 400
      },
      compute: {
        accelerator: 'H100-80GB',
        accelerators: 8,
        accelerator_memory_bytes: 85899345920
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
        bandwidth_bytes_per_ns: 48,
        in_flight_bytes: 16777216,
        queue_depth_bytes: 67108864,
        bidirectional: true
      },
      {
        id: 'node-1-cxl',
        from: 'node-1',
        to: 'remote-pool',
        latency_ns: 180,
        bandwidth_bytes_per_ns: 48,
        in_flight_bytes: 16777216,
        queue_depth_bytes: 67108864,
        bidirectional: true
      },
      {
        id: 'node-2-cxl',
        from: 'node-2',
        to: 'remote-pool',
        latency_ns: 180,
        bandwidth_bytes_per_ns: 48,
        in_flight_bytes: 16777216,
        queue_depth_bytes: 67108864,
        bidirectional: true
      },
      {
        id: 'node-3-cxl',
        from: 'node-3',
        to: 'remote-pool',
        latency_ns: 180,
        bandwidth_bytes_per_ns: 48,
        in_flight_bytes: 16777216,
        queue_depth_bytes: 67108864,
        bidirectional: true
      }
    ]
  },
  workload: {
    type: 'synthetic',
    profile: 'kv_cache_decode',
    model: {
      name: 'llama-3-70b',
      family: 'llama',
      layers: 80,
      attention_heads: 64,
      kv_heads: 8,
      head_dim: 128,
      dtype_bytes: 2
    },
    requests: {
      arrival_rate_per_second: 8,
      concurrency: 16,
      prompt_tokens: 4096,
      generated_tokens: 512,
      phase_mix: {
        prefill: 0.1,
        decode: 0.9
      }
    }
  },
  policy: {
    name: 'hot_cold',
    params: {
      hot_threshold: 8,
      cold_threshold: 1,
      tick_ns: 1000000,
      min_residency_ns: 10000000,
      max_migrations_per_tick: 64
    }
  },
  faults: {
    node_failures: [],
    link_degradations: [],
    packet_loss: {
      enabled: false,
      ppm: 0
    }
  },
  metrics: {
    percentiles: [50, 95, 99],
    sample_interval_ns: 100000000,
    warmup_ns: 5000000000
  },
  output: {
    format: 'jsonl',
    path: 'runs/llama-70b-cxl',
    include_event_log: true
  }
}

export const MOE_RDMA_SCENARIO: ScenarioConfig = {
  $schema: '../SPECS/config.schema.json',
  version: '0.1',
  name: 'moe-remote-tiering',
  description: 'Eight compute nodes running a Mixtral-style MoE workload over RDMA remote memory, with a node failure and a degraded link.',
  seed: 7,
  duration_ns: 120000000000,
  warmup_ns: 10000000000,
  page_size_bytes: 2097152,
  nodes: [
    {
      id: 'node-0',
      role: 'compute',
      local_memory: {
        capacity_bytes: 274877906944,
        latency_ns: 95,
        bandwidth_bytes_per_ns: 300
      },
      compute: {
        accelerator: 'A100-80GB',
        accelerators: 8,
        accelerator_memory_bytes: 85899345920
      }
    },
    {
      id: 'node-1',
      role: 'compute',
      local_memory: {
        capacity_bytes: 274877906944,
        latency_ns: 95,
        bandwidth_bytes_per_ns: 300
      },
      compute: {
        accelerator: 'A100-80GB',
        accelerators: 8,
        accelerator_memory_bytes: 85899345920
      }
    },
    {
      id: 'node-2',
      role: 'compute',
      local_memory: {
        capacity_bytes: 274877906944,
        latency_ns: 95,
        bandwidth_bytes_per_ns: 300
      },
      compute: {
        accelerator: 'A100-80GB',
        accelerators: 8,
        accelerator_memory_bytes: 85899345920
      }
    },
    {
      id: 'node-3',
      role: 'compute',
      local_memory: {
        capacity_bytes: 274877906944,
        latency_ns: 95,
        bandwidth_bytes_per_ns: 300
      },
      compute: {
        accelerator: 'A100-80GB',
        accelerators: 8,
        accelerator_memory_bytes: 85899345920
      }
    },
    {
      id: 'remote-pool',
      role: 'memory',
      remote_memory: {
        capacity_bytes: 8796093022208,
        latency_ns: 2500,
        bandwidth_bytes_per_ns: 25
      }
    }
  ],
  fabric: {
    links: [
      {
        id: 'node-0-rdma',
        from: 'node-0',
        to: 'remote-pool',
        latency_ns: 2500,
        bandwidth_bytes_per_ns: 25,
        in_flight_bytes: 4194304,
        queue_depth_bytes: 33554432,
        bidirectional: true
      },
      {
        id: 'node-1-rdma',
        from: 'node-1',
        to: 'remote-pool',
        latency_ns: 2500,
        bandwidth_bytes_per_ns: 25,
        in_flight_bytes: 4194304,
        queue_depth_bytes: 33554432,
        bidirectional: true
      },
      {
        id: 'node-2-rdma',
        from: 'node-2',
        to: 'remote-pool',
        latency_ns: 2500,
        bandwidth_bytes_per_ns: 25,
        in_flight_bytes: 4194304,
        queue_depth_bytes: 33554432,
        bidirectional: true
      },
      {
        id: 'node-3-rdma',
        from: 'node-3',
        to: 'remote-pool',
        latency_ns: 2500,
        bandwidth_bytes_per_ns: 25,
        in_flight_bytes: 4194304,
        queue_depth_bytes: 33554432,
        bidirectional: true
      }
    ]
  },
  workload: {
    type: 'synthetic',
    profile: 'moe',
    model: {
      name: 'mixtral-8x7b',
      family: 'mixtral',
      layers: 32,
      attention_heads: 32,
      kv_heads: 8,
      head_dim: 128,
      dtype_bytes: 2,
      experts: 8,
      top_k: 2,
      expert_size_bytes: 176160768,
      popularity_distribution: 'zipf',
      popularity_skew: 1.1
    },
    requests: {
      arrival_rate_per_second: 4,
      concurrency: 32,
      prompt_tokens: 2048,
      generated_tokens: 256,
      phase_mix: {
        prefill: 0.15,
        decode: 0.85
      }
    }
  },
  policy: {
    name: 'frequency_aware',
    params: {
      history_length: 8,
      k: 2,
      protect_fraction: 0.6,
      migration_watermark: 0.85,
      max_migrations_per_tick: 128
    }
  },
  faults: {
    node_failures: [
      {
        time_ns: 45000000000,
        node: 'node-3',
        repair_ns: 5000000000,
        reason: 'simulated NIC fault'
      }
    ],
    link_degradations: [
      {
        start_ns: 70000000000,
        end_ns: 80000000000,
        link: 'node-2-rdma',
        bandwidth_factor: 0.5,
        latency_factor: 2.0
      }
    ],
    packet_loss: {
      enabled: true,
      ppm: 10
    }
  },
  metrics: {
    percentiles: [50, 90, 99],
    sample_interval_ns: 200000000,
    warmup_ns: 10000000000
  },
  output: {
    format: 'parquet',
    path: 'runs/moe-remote-tiering',
    include_event_log: false
  }
}

function generateTimeSeries(
  durationNs: number,
  pointsCount: number,
  baseP50: number,
  baseP95: number,
  baseP99: number,
  baseBandwidth: number,
  maxBandwidth: number,
  jitter: number
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = []
  const step = durationNs / pointsCount

  for (let i = 0; i <= pointsCount; i++) {
    const time_ns = Math.floor(i * step)
    const time_s = (time_ns / 1_000_000_000).toFixed(1)
    const factor = 1 + Math.sin(i * 0.45) * 0.15 + (Math.random() - 0.5) * jitter
    const p50 = Math.round(baseP50 * factor)
    const p95 = Math.round(baseP95 * factor * 1.1)
    const p99 = Math.round(baseP99 * factor * 1.25)

    const bw = Math.min(maxBandwidth, Math.max(2, baseBandwidth * factor))
    const util = Math.min(100, Math.round((bw / maxBandwidth) * 100))

    // Local DRAM fills up gradually then stabilizes
    const ramp = Math.min(1, i / (pointsCount * 0.25))
    const localOcc = Math.round( ramp * 520 * 1024 * 1024 * 1024 * (1 + (Math.random() - 0.5) * 0.04) )
    const remoteOcc = i > pointsCount * 0.25
      ? Math.round( (i - pointsCount * 0.25) * 45 * 1024 * 1024 * 1024 * (1 + (Math.random() - 0.5) * 0.05) )
      : 12 * 1024 * 1024 * 1024

    points.push({
      time_ns,
      time_formatted: `${time_s}s`,
      p50_latency_ns: p50,
      p95_latency_ns: p95,
      p99_latency_ns: p99,
      local_occupancy_bytes: localOcc,
      remote_occupancy_bytes: remoteOcc,
      fabric_bandwidth_bytes_per_ns: parseFloat(bw.toFixed(1)),
      fabric_utilization_pct: util,
      queue_depth_bytes: Math.round(util * 420000 + (Math.random() * 50000)),
      migrations_active: Math.round(Math.max(0, (factor - 0.95) * 45))
    })
  }

  return points
}

export const MOCK_SIMULATION_RUNS: SimulationRun[] = [
  {
    id: 'run-llama-cxl-hotcold',
    scenario_name: 'llama-70b-cxl',
    scenario_hash: 'sha256:7f9b8c2a3d4e5f60',
    workload_profile: 'kv_cache_decode',
    policy_name: 'hot_cold',
    policy_display_name: 'Hot/Cold Migration (EWMA)',
    seed: 42,
    duration_ns: 60000000000,
    status: 'completed',
    created_at: '2026-10-29 10:45:00',
    metrics: {
      latency_ns: {
        p50: 142.4,
        p90: 168.0,
        p95: 184.2,
        p99: 226.8,
        mean: 153.2,
        max: 312.0
      },
      stall_time_ns: 42100000,
      local_hit_ratio: 0.714,
      remote_hit_ratio: 0.242,
      miss_ratio: 0.044,
      remote_traffic_bytes: 1561300000000, // ~1.56 TB
      migration_bytes: 334900000000, // ~334 GB
      fabric_utilization: 0.426,
      peak_queue_depth_bytes: 14889000,
      total_accesses: 98450000
    },
    time_series: generateTimeSeries(60000000000, 20, 142, 184, 226, 20.4, 48.0, 0.12),
    bottleneck: {
      severity: 'low',
      primary_bottleneck: 'Fabric Queuing at Token Decode Transitions',
      explanation: 'Hot/Cold EWMA successfully maintains active KV cache heads in local DRAM (71.4% local hit ratio). Fabric utilization averages 42.6% with periodic migration bursts.',
      suggested_policy_tuning: 'Increase min_residency_ns from 10ms to 25ms to reduce marginal page migrations during bursty prompt phases.'
    },
    scenario_snapshot: LLAMA_70B_CXL_SCENARIO
  },
  {
    id: 'run-llama-cxl-swap',
    scenario_name: 'llama-70b-cxl',
    scenario_hash: 'sha256:3a4b5c6d7e8f9012',
    workload_profile: 'kv_cache_decode',
    policy_name: 'swap_remote',
    policy_display_name: 'Swap to Remote (Demand Paging)',
    seed: 42,
    duration_ns: 60000000000,
    status: 'completed',
    created_at: '2026-10-29 11:15:00',
    metrics: {
      latency_ns: {
        p50: 231.8,
        p90: 342.0,
        p95: 395.4,
        p99: 512.0,
        mean: 268.5,
        max: 780.0
      },
      stall_time_ns: 184600000,
      local_hit_ratio: 0.486,
      remote_hit_ratio: 0.382,
      miss_ratio: 0.132,
      remote_traffic_bytes: 3497000000000, // ~3.5 TB
      migration_bytes: 0,
      fabric_utilization: 0.748,
      peak_queue_depth_bytes: 54980000,
      total_accesses: 98450000
    },
    time_series: generateTimeSeries(60000000000, 20, 231, 395, 512, 35.9, 48.0, 0.22),
    bottleneck: {
      severity: 'high',
      primary_bottleneck: 'Demand Paging Head-of-Line Blocking on CXL Link',
      explanation: 'Reactive demand paging incurs full roundtrip fabric stalls (180ns + queueing) on every non-local touch. Fabric utilization spikes to 74.8% and queue depth exceeds 54 MB.',
      suggested_policy_tuning: 'Replace reactive swap with proactive hot/cold promotion or predictive prefetching to hide CXL link latency.'
    },
    scenario_snapshot: {
      ...LLAMA_70B_CXL_SCENARIO,
      policy: {
        name: 'swap_remote',
        params: {}
      }
    }
  },
  {
    id: 'run-llama-cxl-localonly',
    scenario_name: 'llama-70b-cxl',
    scenario_hash: 'sha256:1122334455667788',
    workload_profile: 'kv_cache_decode',
    policy_name: 'local_only',
    policy_display_name: 'Local Only (DRAM Eviction Baseline)',
    seed: 42,
    duration_ns: 60000000000,
    status: 'completed',
    created_at: '2026-10-29 11:35:00',
    metrics: {
      latency_ns: {
        p50: 92.5,
        p90: 640.0,
        p95: 840.2,
        p99: 1450.0,
        mean: 412.0,
        max: 2200.0
      },
      stall_time_ns: 395000000,
      local_hit_ratio: 0.521,
      remote_hit_ratio: 0.0,
      miss_ratio: 0.479,
      remote_traffic_bytes: 0,
      migration_bytes: 0,
      fabric_utilization: 0.0,
      peak_queue_depth_bytes: 0,
      total_accesses: 98450000
    },
    time_series: generateTimeSeries(60000000000, 20, 92, 840, 1450, 0, 48.0, 0.35),
    bottleneck: {
      severity: 'critical',
      primary_bottleneck: 'Context Eviction & KV Recompute Thrashing',
      explanation: 'Without remote memory backing, when context exceeds local DRAM, pages are discarded. Subsequent accesses incur severe recomputation stalls, elevating p99 to 1.45 µs.',
      suggested_policy_tuning: 'Attach CXL pooled memory with hot/cold tiering to prevent context drops.'
    },
    scenario_snapshot: {
      ...LLAMA_70B_CXL_SCENARIO,
      policy: {
        name: 'local_only',
        params: {}
      }
    }
  },
  {
    id: 'run-moe-rdma-freqaware',
    scenario_name: 'moe-remote-tiering',
    scenario_hash: 'sha256:8899aabbccddeeff',
    workload_profile: 'moe',
    policy_name: 'frequency_aware',
    policy_display_name: 'Frequency-Aware LRU-K',
    seed: 7,
    duration_ns: 120000000000,
    status: 'completed',
    created_at: '2026-10-29 11:50:00',
    metrics: {
      latency_ns: {
        p50: 310.2,
        p90: 890.0,
        p95: 1240.5,
        p99: 2850.0,
        mean: 485.0,
        max: 4200.0
      },
      stall_time_ns: 112000000,
      local_hit_ratio: 0.824,
      remote_hit_ratio: 0.148,
      miss_ratio: 0.028,
      remote_traffic_bytes: 2150000000000,
      migration_bytes: 410000000000,
      fabric_utilization: 0.518,
      peak_queue_depth_bytes: 28400000,
      total_accesses: 142000000
    },
    time_series: generateTimeSeries(120000000000, 20, 310, 1240, 2850, 12.9, 25.0, 0.18),
    bottleneck: {
      severity: 'medium',
      primary_bottleneck: 'Tail Expert Fetch Latency over 2.5µs RDMA Link',
      explanation: 'Popular Zipf experts are kept in local DRAM. The tail 20% expert activations traverse the 2.5 µs RDMA fabric, dominating p99 tail latency.',
      suggested_policy_tuning: 'Increase protected fraction or implement speculative prefetching based on layer token routing predictions.'
    },
    scenario_snapshot: MOE_RDMA_SCENARIO
  },
  {
    id: 'run-moe-rdma-faults',
    scenario_name: 'moe-remote-tiering',
    scenario_hash: 'sha256:556677889900aabb',
    workload_profile: 'moe',
    policy_name: 'frequency_aware',
    policy_display_name: 'Frequency-Aware (with Fault Injection)',
    seed: 7,
    duration_ns: 120000000000,
    status: 'completed',
    created_at: '2026-10-29 12:05:00',
    metrics: {
      latency_ns: {
        p50: 480.6,
        p90: 1950.0,
        p95: 3200.0,
        p99: 5900.0,
        mean: 790.0,
        max: 8900.0
      },
      stall_time_ns: 298000000,
      local_hit_ratio: 0.772,
      remote_hit_ratio: 0.178,
      miss_ratio: 0.050,
      remote_traffic_bytes: 2310000000000,
      migration_bytes: 380000000000,
      fabric_utilization: 0.684,
      peak_queue_depth_bytes: 33550000,
      total_accesses: 138000000
    },
    time_series: generateTimeSeries(120000000000, 20, 480, 3200, 5900, 17.1, 25.0, 0.28),
    bottleneck: {
      severity: 'high',
      primary_bottleneck: 'Link Degradation & NIC Fault Retransmission Backoff',
      explanation: 'At t=45s simulated NIC fault on node-3 and t=70s degradation on link node-2-rdma caused fabric queue saturation and TCP/RoCE packet loss retries.',
      suggested_policy_tuning: 'Enable fault-tolerant multi-path routing across parallel RDMA links.'
    },
    scenario_snapshot: MOE_RDMA_SCENARIO
  },
  {
    id: 'run-sparse-predictive',
    scenario_name: 'sparse-attention-prefetch',
    scenario_hash: 'sha256:aabb1122cc3344dd',
    workload_profile: 'sparse_attention',
    policy_name: 'predictive_prefetch',
    policy_display_name: 'Predictive Prefetch (Stride & Pattern Aware)',
    seed: 19,
    duration_ns: 45000000000,
    status: 'completed',
    created_at: '2026-10-29 12:15:00',
    metrics: {
      latency_ns: {
        p50: 168.0,
        p90: 215.0,
        p95: 245.0,
        p99: 310.0,
        mean: 182.0,
        max: 420.0
      },
      stall_time_ns: 56000000,
      local_hit_ratio: 0.785,
      remote_hit_ratio: 0.192,
      miss_ratio: 0.023,
      remote_traffic_bytes: 1890000000000,
      migration_bytes: 145000000000,
      prefetch_accuracy: 0.846,
      fabric_utilization: 0.485,
      peak_queue_depth_bytes: 19400000,
      total_accesses: 76000000
    },
    time_series: generateTimeSeries(45000000000, 20, 168, 245, 310, 23.2, 48.0, 0.14),
    bottleneck: {
      severity: 'low',
      primary_bottleneck: 'Speculative Prefetch Bandwidth Contention',
      explanation: 'Pattern prefetch achieved 84.6% accuracy on global token strides. Unused prefetches consumed ~15.4% extra fabric bandwidth with negligible latency impact.',
      suggested_policy_tuning: 'Raise confidence_threshold from 0.75 to 0.82 to eliminate marginal prefetches.'
    },
    scenario_snapshot: {
      ...LLAMA_70B_CXL_SCENARIO,
      name: 'sparse-attention-prefetch',
      workload: {
        type: 'synthetic',
        profile: 'sparse_attention',
        model: {
          name: 'llama-3-70b-sparse',
          family: 'llama',
          layers: 80,
          kv_heads: 8,
          head_dim: 128
        },
        sparsity: {
          window_tokens: 1024,
          global_tokens: 128
        }
      },
      policy: {
        name: 'predictive_prefetch',
        params: {
          confidence_threshold: 0.75,
          lookahead_depth: 4,
          max_inflight_prefetches: 32
        }
      }
    }
  }
]
