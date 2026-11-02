/**
 * RmemFab Scenario Types
 * Strictly aligned with SPECS/config.schema.json (Draft 2020-12)
 */

export type WorkloadProfile = 'kv_cache_decode'

export type PolicyName =
  | 'local_only'
  | 'swap_remote'
  | 'hot_cold'
  | 'frequency_aware'
  | 'predictive_prefetch'

export type ProvenanceKind = 'measured' | 'sourced' | 'assumed'

export interface ProvenanceConfig {
  kind: ProvenanceKind
  source?: string
  method?: string
  date?: string
}

export interface MemoryTierConfig {
  capacity_bytes: number
  latency_ns: number
  bandwidth_bytes_per_ns: number
  page_size_bytes?: number
  read_latency_factor?: number
  write_latency_factor?: number
  cost_per_byte_second?: number
  provenance?: ProvenanceConfig
}

export interface ComputeConfig {
  accelerator?: string
  accelerators?: number
  accelerator_memory_bytes?: number
  tokens_per_second?: number
  provenance?: ProvenanceConfig
}

export interface NodeConfig {
  id: string
  role: 'compute' | 'memory'
  description?: string
  local_memory?: MemoryTierConfig
  remote_memory?: MemoryTierConfig
  compute?: ComputeConfig
}

export interface FabricLinkConfig {
  id: string
  from: string
  to: string
  latency_ns: number
  bandwidth_bytes_per_ns: number
  in_flight_bytes?: number
  queue_depth_bytes?: number
  bidirectional?: boolean
  loss_ppm?: number
  provenance?: ProvenanceConfig
}

export interface SwitchConfig {
  bandwidth_bytes_per_ns: number
  latency_ns?: number
  provenance?: ProvenanceConfig
}

export interface NamedSwitchConfig {
  id: string
  bandwidth_bytes_per_ns: number
  latency_ns?: number
  provenance?: ProvenanceConfig
}

export interface ModelConfig {
  name?: string
  family?: string
  layers?: number
  attention_heads?: number
  kv_heads?: number
  head_dim?: number
  hidden_size?: number
  dtype_bytes?: number
  experts?: number
  top_k?: number
  expert_size_bytes?: number
  popularity_distribution?: 'uniform' | 'zipf' | 'custom'
  popularity_skew?: number
  [key: string]: unknown
}

export interface RequestConfig {
  arrival_rate_per_second?: number
  concurrency?: number
  prompt_tokens?: number
  generated_tokens?: number
  phase_mix?: {
    prefill?: number
    decode?: number
  }
  seed?: number
  [key: string]: unknown
}

export interface SparsityConfig {
  window_tokens?: number
  global_tokens?: number
  [key: string]: unknown
}

export interface SyntheticWorkloadConfig {
  type: 'synthetic'
  profile: WorkloadProfile
  model?: ModelConfig
  requests?: RequestConfig
  sparsity?: SparsityConfig
}

export interface TraceWorkloadConfig {
  type: 'trace'
  path: string
  trace_hash?: string
  format?: 'jsonl'
  sort?: boolean
  round_bytes?: boolean
  time_scale?: number
}

export type WorkloadConfig = SyntheticWorkloadConfig | TraceWorkloadConfig

export interface PolicyConfig {
  name: PolicyName
  params?: Record<string, unknown>
}

export interface NodeFailureConfig {
  time_ns: number
  node: string
  repair_ns?: number
  reason?: string
}

export interface LinkDegradationConfig {
  start_ns: number
  end_ns: number
  link: string
  bandwidth_factor?: number
  latency_factor?: number
}

export interface PacketLossConfig {
  enabled?: boolean
  ppm?: number
}

export interface FailureProcessConfig {
  enabled?: boolean
  mtbf_ns?: number
  repair_ns?: number
  distribution?: 'exponential' | 'weibull'
  shape?: number
}

export interface FaultsConfig {
  node_failures?: NodeFailureConfig[]
  node_failure_process?: FailureProcessConfig
  link_degradations?: LinkDegradationConfig[]
  packet_loss?: PacketLossConfig
}

export interface MetricsConfig {
  percentiles?: number[]
  sample_interval_ns?: number
  warmup_ns?: number
  percentile_interpolation?: string
}

export interface CostModelConfig {
  capacity_per_gib_second?: number
  transfer_per_gib?: number
  migration_per_gib?: number
  prefetch_per_gib?: number
  wasted_prefetch_per_gib?: number
  currency?: string
}

export interface OutputConfig {
  format?: 'jsonl' | 'parquet'
  path?: string
  include_event_log?: boolean
}

export interface ScenarioConfig {
  $schema?: string
  version: '0.1'
  name: string
  description?: string
  assumptions?: string[]
  seed: number
  duration_ns: number
  warmup_ns?: number
  page_size_bytes?: number
  nodes: NodeConfig[]
  fabric: {
    links: FabricLinkConfig[]
    switch?: SwitchConfig
    switches?: NamedSwitchConfig[]
  }
  workload: WorkloadConfig
  policy: PolicyConfig
  faults?: FaultsConfig
  metrics?: MetricsConfig
  output?: OutputConfig
  cost_model?: CostModelConfig
}

