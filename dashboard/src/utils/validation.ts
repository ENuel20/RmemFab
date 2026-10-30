/**
 * Scenario Validation strictly adhering to SPECS/config.schema.json (Draft 2020-12)
 */

export interface ValidationError {
  field: string
  message: string
}

const ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const ALLOWED_ROOT_PROPERTIES = new Set([
  '$schema',
  'version',
  'name',
  'description',
  'seed',
  'duration_ns',
  'warmup_ns',
  'page_size_bytes',
  'nodes',
  'fabric',
  'workload',
  'policy',
  'faults',
  'metrics',
  'output',
  'cost_model'
])

const VALID_WORKLOAD_PROFILES = [
  'kv_cache_decode',
  'prefill',
  'sparse_attention',
  'moe',
  'mixed'
]

const VALID_POLICIES = [
  'local_only',
  'swap_remote',
  'hot_cold',
  'frequency_aware',
  'predictive_prefetch',
  'cost_aware'
]

export function validateScenario(scenario: unknown): { isValid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = []

  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return { isValid: false, errors: [{ field: 'root', message: 'Scenario must be a valid JSON object' }] }
  }

  const s = scenario as Record<string, unknown>

  // 1. Root additionalProperties check
  Object.keys(s).forEach((key) => {
    if (!ALLOWED_ROOT_PROPERTIES.has(key)) {
      errors.push({
        field: key,
        message: `Unexpected property "${key}" not permitted by config.schema.json`
      })
    }
  })

  // 2. Version
  if (s.version !== '0.1') {
    errors.push({ field: 'version', message: 'Version must be "0.1" as defined in config.schema.json' })
  }

  // 3. Name
  if (typeof s.name !== 'string' || s.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'Scenario name is required and must be a non-empty string' })
  } else if (s.name.length > 120) {
    errors.push({ field: 'name', message: 'Scenario name cannot exceed 120 characters' })
  }

  // 4. Description (optional)
  if (s.description !== undefined) {
    if (typeof s.description !== 'string') {
      errors.push({ field: 'description', message: 'Description must be a string' })
    } else if (s.description.length > 4000) {
      errors.push({ field: 'description', message: 'Description cannot exceed 4000 characters' })
    }
  }

  // 5. Seed
  if (
    typeof s.seed !== 'number' ||
    !Number.isInteger(s.seed) ||
    s.seed < 0 ||
    s.seed > Number.MAX_SAFE_INTEGER
  ) {
    errors.push({
      field: 'seed',
      message: 'Seed must be an integer between 0 and 9007199254740991'
    })
  }

  // 6. Duration
  if (typeof s.duration_ns !== 'number' || !Number.isInteger(s.duration_ns) || s.duration_ns <= 0) {
    errors.push({ field: 'duration_ns', message: 'Duration must be a positive integer in nanoseconds' })
  }

  // 7. Warmup duration (optional)
  if (s.warmup_ns !== undefined) {
    if (typeof s.warmup_ns !== 'number' || !Number.isInteger(s.warmup_ns) || s.warmup_ns < 0) {
      errors.push({ field: 'warmup_ns', message: 'Warm-up duration must be a non-negative integer in nanoseconds' })
    } else if (typeof s.duration_ns === 'number' && s.warmup_ns >= s.duration_ns) {
      errors.push({
        field: 'warmup_ns',
        message: `Warm-up duration (${s.warmup_ns} ns) must be strictly less than simulation duration (${s.duration_ns} ns)`
      })
    }
  }

  // 8. Page size (optional)
  if (s.page_size_bytes !== undefined) {
    if (typeof s.page_size_bytes !== 'number' || !Number.isInteger(s.page_size_bytes) || s.page_size_bytes < 4096) {
      errors.push({ field: 'page_size_bytes', message: 'Page size must be an integer >= 4096 bytes' })
    }
  }

  // 9. Nodes
  const nodeIds = new Set<string>()
  let hasRemoteMemoryTier = false

  if (!Array.isArray(s.nodes) || s.nodes.length === 0) {
    errors.push({ field: 'nodes', message: 'At least one node is required in "nodes"' })
  } else {
    s.nodes.forEach((nodeItem, index) => {
      const path = `nodes[${index}]`
      if (!nodeItem || typeof nodeItem !== 'object' || Array.isArray(nodeItem)) {
        errors.push({ field: path, message: 'Node must be a JSON object' })
        return
      }

      const node = nodeItem as Record<string, unknown>
      const allowedNodeKeys = new Set(['id', 'role', 'description', 'local_memory', 'remote_memory', 'compute'])
      Object.keys(node).forEach((k) => {
        if (!allowedNodeKeys.has(k)) {
          errors.push({ field: `${path}.${k}`, message: `Unexpected property "${k}" on node` })
        }
      })

      // Node ID
      if (typeof node.id !== 'string' || node.id.length === 0) {
        errors.push({ field: `${path}.id`, message: 'Node ID is required and must be a non-empty string' })
      } else {
        if (!ID_REGEX.test(node.id) || node.id.length > 64) {
          errors.push({
            field: `${path}.id`,
            message: 'Node ID must match pattern ^[A-Za-z0-9][A-Za-z0-9._-]*$ (1-64 characters)'
          })
        }
        if (nodeIds.has(node.id)) {
          errors.push({ field: `${path}.id`, message: `Duplicate node ID: "${node.id}"` })
        }
        nodeIds.add(node.id)
      }

      // Role
      if (node.role !== 'compute' && node.role !== 'memory') {
        errors.push({ field: `${path}.role`, message: 'Node role must be either "compute" or "memory"' })
      }

      if (node.description !== undefined && (typeof node.description !== 'string' || node.description.length > 500)) {
        errors.push({ field: `${path}.description`, message: 'Node description must be a string up to 500 characters' })
      }

      // Role requirements
      if (node.role === 'compute' && !node.local_memory) {
        errors.push({ field: `${path}.local_memory`, message: 'Compute node requires "local_memory" definition' })
      }
      if (node.role === 'memory' && !node.remote_memory) {
        errors.push({ field: `${path}.remote_memory`, message: 'Memory node requires "remote_memory" definition' })
      }

      if (node.remote_memory || node.role === 'memory') {
        hasRemoteMemoryTier = true
      }

      // Memory tiers validation
      const validateMemoryTier = (tier: unknown, tierPath: string) => {
        if (!tier || typeof tier !== 'object' || Array.isArray(tier)) {
          errors.push({ field: tierPath, message: `${tierPath} must be a valid memory tier object` })
          return
        }
        const m = tier as Record<string, unknown>
        const allowedTierKeys = new Set([
          'capacity_bytes',
          'latency_ns',
          'bandwidth_bytes_per_ns',
          'page_size_bytes',
          'read_latency_factor',
          'write_latency_factor',
          'cost_per_byte_second'
        ])
        Object.keys(m).forEach((k) => {
          if (!allowedTierKeys.has(k)) {
            errors.push({ field: `${tierPath}.${k}`, message: `Unexpected property "${k}" in memory tier` })
          }
        })

        if (typeof m.capacity_bytes !== 'number' || !Number.isInteger(m.capacity_bytes) || m.capacity_bytes < 1) {
          errors.push({ field: `${tierPath}.capacity_bytes`, message: 'Memory capacity must be an integer >= 1' })
        }
        if (typeof m.latency_ns !== 'number' || m.latency_ns < 0) {
          errors.push({ field: `${tierPath}.latency_ns`, message: 'Memory latency must be a number >= 0' })
        }
        if (typeof m.bandwidth_bytes_per_ns !== 'number' || m.bandwidth_bytes_per_ns <= 0) {
          errors.push({ field: `${tierPath}.bandwidth_bytes_per_ns`, message: 'Memory bandwidth must be a number > 0' })
        }
        if (m.page_size_bytes !== undefined && (typeof m.page_size_bytes !== 'number' || !Number.isInteger(m.page_size_bytes) || m.page_size_bytes < 4096)) {
          errors.push({ field: `${tierPath}.page_size_bytes`, message: 'Tier page size must be an integer >= 4096' })
        }
        if (m.read_latency_factor !== undefined && (typeof m.read_latency_factor !== 'number' || m.read_latency_factor <= 0)) {
          errors.push({ field: `${tierPath}.read_latency_factor`, message: 'Read latency factor must be > 0' })
        }
        if (m.write_latency_factor !== undefined && (typeof m.write_latency_factor !== 'number' || m.write_latency_factor <= 0)) {
          errors.push({ field: `${tierPath}.write_latency_factor`, message: 'Write latency factor must be > 0' })
        }
        if (m.cost_per_byte_second !== undefined && (typeof m.cost_per_byte_second !== 'number' || m.cost_per_byte_second < 0)) {
          errors.push({ field: `${tierPath}.cost_per_byte_second`, message: 'Cost per byte-second must be >= 0' })
        }
      }

      if (node.local_memory) validateMemoryTier(node.local_memory, `${path}.local_memory`)
      if (node.remote_memory) validateMemoryTier(node.remote_memory, `${path}.remote_memory`)

      // Compute details
      if (node.compute) {
        if (typeof node.compute !== 'object' || Array.isArray(node.compute)) {
          errors.push({ field: `${path}.compute`, message: 'Compute configuration must be an object' })
        } else {
          const comp = node.compute as Record<string, unknown>
          if (comp.accelerators !== undefined && (typeof comp.accelerators !== 'number' || !Number.isInteger(comp.accelerators) || comp.accelerators < 1)) {
            errors.push({ field: `${path}.compute.accelerators`, message: 'Accelerators count must be an integer >= 1' })
          }
          if (comp.accelerator_memory_bytes !== undefined && (typeof comp.accelerator_memory_bytes !== 'number' || comp.accelerator_memory_bytes < 0)) {
            errors.push({ field: `${path}.compute.accelerator_memory_bytes`, message: 'Accelerator memory bytes must be >= 0' })
          }
          if (comp.tokens_per_second !== undefined && (typeof comp.tokens_per_second !== 'number' || comp.tokens_per_second <= 0)) {
            errors.push({ field: `${path}.compute.tokens_per_second`, message: 'Tokens per second must be > 0' })
          }
        }
      }
    })
  }

  // 10. Fabric
  const linkIds = new Set<string>()
  if (!s.fabric || typeof s.fabric !== 'object' || Array.isArray(s.fabric)) {
    errors.push({ field: 'fabric', message: 'Fabric object is required with a links array' })
  } else {
    const fab = s.fabric as Record<string, unknown>
    if (!Array.isArray(fab.links) || fab.links.length === 0) {
      errors.push({ field: 'fabric.links', message: 'At least one fabric link is required in "fabric.links"' })
    } else {
      fab.links.forEach((linkItem, index) => {
        const path = `fabric.links[${index}]`
        if (!linkItem || typeof linkItem !== 'object' || Array.isArray(linkItem)) {
          errors.push({ field: path, message: 'Link must be a JSON object' })
          return
        }

        const link = linkItem as Record<string, unknown>
        const allowedLinkKeys = new Set([
          'id',
          'from',
          'to',
          'latency_ns',
          'bandwidth_bytes_per_ns',
          'in_flight_bytes',
          'queue_depth_bytes',
          'bidirectional',
          'loss_ppm'
        ])
        Object.keys(link).forEach((k) => {
          if (!allowedLinkKeys.has(k)) {
            errors.push({ field: `${path}.${k}`, message: `Unexpected property "${k}" in link` })
          }
        })

        // Link ID
        if (typeof link.id !== 'string' || link.id.length === 0) {
          errors.push({ field: `${path}.id`, message: 'Link ID is required and must be a non-empty string' })
        } else {
          if (!ID_REGEX.test(link.id) || link.id.length > 64) {
            errors.push({
              field: `${path}.id`,
              message: 'Link ID must match pattern ^[A-Za-z0-9][A-Za-z0-9._-]*$ (1-64 characters)'
            })
          }
          if (linkIds.has(link.id)) {
            errors.push({ field: `${path}.id`, message: `Duplicate link ID: "${link.id}"` })
          }
          linkIds.add(link.id)
        }

        // From / To
        if (typeof link.from !== 'string' || link.from.length === 0) {
          errors.push({ field: `${path}.from`, message: 'Link "from" node ID is required' })
        } else if (!nodeIds.has(link.from)) {
          errors.push({ field: `${path}.from`, message: `Link source "${link.from}" does not exist in nodes` })
        }

        if (typeof link.to !== 'string' || link.to.length === 0) {
          errors.push({ field: `${path}.to`, message: 'Link "to" node ID is required' })
        } else if (!nodeIds.has(link.to)) {
          errors.push({ field: `${path}.to`, message: `Link destination "${link.to}" does not exist in nodes` })
        }

        // Reject self-connecting fabric links
        if (link.from && link.to && link.from === link.to) {
          errors.push({
            field: `${path}.to`,
            message: `Fabric link cannot connect node "${link.from}" to itself`
          })
        }

        // Latency and bandwidth
        if (typeof link.latency_ns !== 'number' || link.latency_ns < 0) {
          errors.push({ field: `${path}.latency_ns`, message: 'Link latency must be a number >= 0' })
        }
        if (typeof link.bandwidth_bytes_per_ns !== 'number' || link.bandwidth_bytes_per_ns <= 0) {
          errors.push({ field: `${path}.bandwidth_bytes_per_ns`, message: 'Link bandwidth must be a number > 0' })
        }

        // Optional parameters
        if (link.in_flight_bytes !== undefined && (typeof link.in_flight_bytes !== 'number' || !Number.isInteger(link.in_flight_bytes) || link.in_flight_bytes < 1)) {
          errors.push({ field: `${path}.in_flight_bytes`, message: 'Link in_flight_bytes must be an integer >= 1' })
        }
        if (link.queue_depth_bytes !== undefined && (typeof link.queue_depth_bytes !== 'number' || !Number.isInteger(link.queue_depth_bytes) || link.queue_depth_bytes < 0)) {
          errors.push({ field: `${path}.queue_depth_bytes`, message: 'Link queue_depth_bytes must be an integer >= 0' })
        }
        if (link.bidirectional !== undefined && typeof link.bidirectional !== 'boolean') {
          errors.push({ field: `${path}.bidirectional`, message: 'Link bidirectional flag must be a boolean' })
        }
        if (link.loss_ppm !== undefined && (typeof link.loss_ppm !== 'number' || !Number.isInteger(link.loss_ppm) || link.loss_ppm < 0 || link.loss_ppm > 1000000)) {
          errors.push({ field: `${path}.loss_ppm`, message: 'Link loss_ppm must be an integer between 0 and 1,000,000' })
        }
      })
    }
  }

  // 11. Workload
  if (!s.workload || typeof s.workload !== 'object' || Array.isArray(s.workload)) {
    errors.push({ field: 'workload', message: 'Workload configuration object is required' })
  } else {
    const wl = s.workload as Record<string, unknown>
    if (wl.type === 'synthetic') {
      if (typeof wl.profile !== 'string' || !VALID_WORKLOAD_PROFILES.includes(wl.profile)) {
        errors.push({
          field: 'workload.profile',
          message: `Synthetic workload profile must be one of: ${VALID_WORKLOAD_PROFILES.join(', ')}`
        })
      }

      // Model validation
      if (wl.model !== undefined) {
        if (typeof wl.model !== 'object' || Array.isArray(wl.model)) {
          errors.push({ field: 'workload.model', message: 'Workload model must be an object' })
        } else {
          const m = wl.model as Record<string, unknown>
          if (m.layers !== undefined && (typeof m.layers !== 'number' || !Number.isInteger(m.layers) || m.layers < 1)) {
            errors.push({ field: 'workload.model.layers', message: 'Model layers must be an integer >= 1' })
          }
          if (m.attention_heads !== undefined && (typeof m.attention_heads !== 'number' || !Number.isInteger(m.attention_heads) || m.attention_heads < 1)) {
            errors.push({ field: 'workload.model.attention_heads', message: 'Attention heads must be an integer >= 1' })
          }
          if (m.kv_heads !== undefined && (typeof m.kv_heads !== 'number' || !Number.isInteger(m.kv_heads) || m.kv_heads < 1)) {
            errors.push({ field: 'workload.model.kv_heads', message: 'KV heads must be an integer >= 1' })
          }
          if (m.head_dim !== undefined && (typeof m.head_dim !== 'number' || !Number.isInteger(m.head_dim) || m.head_dim < 1)) {
            errors.push({ field: 'workload.model.head_dim', message: 'Head dimension must be an integer >= 1' })
          }
          if (m.hidden_size !== undefined && (typeof m.hidden_size !== 'number' || !Number.isInteger(m.hidden_size) || m.hidden_size < 1)) {
            errors.push({ field: 'workload.model.hidden_size', message: 'Hidden size must be an integer >= 1' })
          }
          if (m.dtype_bytes !== undefined && (typeof m.dtype_bytes !== 'number' || m.dtype_bytes <= 0)) {
            errors.push({ field: 'workload.model.dtype_bytes', message: 'dtype_bytes must be a number > 0' })
          }
          if (m.experts !== undefined && (typeof m.experts !== 'number' || !Number.isInteger(m.experts) || m.experts < 1)) {
            errors.push({ field: 'workload.model.experts', message: 'Experts count must be an integer >= 1' })
          }
          if (m.top_k !== undefined && (typeof m.top_k !== 'number' || !Number.isInteger(m.top_k) || m.top_k < 1)) {
            errors.push({ field: 'workload.model.top_k', message: 'top_k must be an integer >= 1' })
          }
          if (typeof m.experts === 'number' && typeof m.top_k === 'number' && m.top_k > m.experts) {
            errors.push({
              field: 'workload.model.top_k',
              message: `top_k (${m.top_k}) cannot exceed total experts (${m.experts})`
            })
          }
          if (m.expert_size_bytes !== undefined && (typeof m.expert_size_bytes !== 'number' || !Number.isInteger(m.expert_size_bytes) || m.expert_size_bytes < 0)) {
            errors.push({ field: 'workload.model.expert_size_bytes', message: 'Expert size bytes must be an integer >= 0' })
          }
          if (m.popularity_distribution !== undefined && !['uniform', 'zipf', 'custom'].includes(m.popularity_distribution as string)) {
            errors.push({ field: 'workload.model.popularity_distribution', message: 'Popularity distribution must be "uniform", "zipf", or "custom"' })
          }
          if (m.popularity_skew !== undefined && (typeof m.popularity_skew !== 'number' || m.popularity_skew <= 0)) {
            errors.push({ field: 'workload.model.popularity_skew', message: 'Popularity skew must be a number > 0' })
          }
        }
      }

      // Requests validation
      if (wl.requests !== undefined) {
        if (typeof wl.requests !== 'object' || Array.isArray(wl.requests)) {
          errors.push({ field: 'workload.requests', message: 'Requests configuration must be an object' })
        } else {
          const req = wl.requests as Record<string, unknown>
          if (req.arrival_rate_per_second !== undefined && (typeof req.arrival_rate_per_second !== 'number' || req.arrival_rate_per_second <= 0)) {
            errors.push({ field: 'workload.requests.arrival_rate_per_second', message: 'Arrival rate must be a number > 0' })
          }
          if (req.concurrency !== undefined && (typeof req.concurrency !== 'number' || !Number.isInteger(req.concurrency) || req.concurrency < 1)) {
            errors.push({ field: 'workload.requests.concurrency', message: 'Concurrency must be an integer >= 1' })
          }
          if (req.prompt_tokens !== undefined && (typeof req.prompt_tokens !== 'number' || !Number.isInteger(req.prompt_tokens) || req.prompt_tokens < 0)) {
            errors.push({ field: 'workload.requests.prompt_tokens', message: 'Prompt tokens must be an integer >= 0' })
          }
          if (req.generated_tokens !== undefined && (typeof req.generated_tokens !== 'number' || !Number.isInteger(req.generated_tokens) || req.generated_tokens < 0)) {
            errors.push({ field: 'workload.requests.generated_tokens', message: 'Generated tokens must be an integer >= 0' })
          }
        }
      }
    } else if (wl.type === 'trace') {
      if (typeof wl.path !== 'string' || wl.path.trim().length === 0) {
        errors.push({ field: 'workload.path', message: 'Trace workload requires a valid non-empty path' })
      }
      if (wl.format !== undefined && wl.format !== 'jsonl') {
        errors.push({ field: 'workload.format', message: 'Trace format must be "jsonl"' })
      }
      if (wl.time_scale !== undefined && (typeof wl.time_scale !== 'number' || wl.time_scale <= 0)) {
        errors.push({ field: 'workload.time_scale', message: 'Trace time_scale must be a number > 0' })
      }
    } else {
      errors.push({ field: 'workload.type', message: 'Workload type must be "synthetic" or "trace"' })
    }
  }

  // 12. Policy
  if (!s.policy || typeof s.policy !== 'object' || Array.isArray(s.policy)) {
    errors.push({ field: 'policy', message: 'Policy object is required' })
  } else {
    const pol = s.policy as Record<string, unknown>
    if (typeof pol.name !== 'string' || !VALID_POLICIES.includes(pol.name)) {
      errors.push({ field: 'policy.name', message: `Policy name must be one of: ${VALID_POLICIES.join(', ')}` })
    } else {
      // Remote memory tier requirement
      if (pol.name !== 'local_only' && !hasRemoteMemoryTier) {
        errors.push({
          field: 'policy.name',
          message: `Policy "${pol.name}" requires at least one memory node with remote_memory configured`
        })
      }

      // Hot/Cold thrashing prevention (hot_threshold > cold_threshold)
      if (pol.name === 'hot_cold' && pol.params && typeof pol.params === 'object') {
        const { hot_threshold, cold_threshold } = pol.params as { hot_threshold?: unknown; cold_threshold?: unknown }
        if (typeof hot_threshold === 'number' && typeof cold_threshold === 'number') {
          if (hot_threshold <= cold_threshold) {
            errors.push({
              field: 'policy.params.hot_threshold',
              message: `hot_threshold (${hot_threshold}) must be strictly greater than cold_threshold (${cold_threshold}) to prevent migration thrashing`
            })
          }
        }
      }
    }
  }

  // 13. Faults (optional)
  if (s.faults !== undefined) {
    if (typeof s.faults !== 'object' || Array.isArray(s.faults)) {
      errors.push({ field: 'faults', message: 'Faults configuration must be an object' })
    } else {
      const f = s.faults as Record<string, unknown>
      if (Array.isArray(f.node_failures)) {
        f.node_failures.forEach((nfItem, i) => {
          const path = `faults.node_failures[${i}]`
          if (!nfItem || typeof nfItem !== 'object') {
            errors.push({ field: path, message: 'Node failure specification must be an object' })
            return
          }
          const nf = nfItem as Record<string, unknown>
          if (typeof nf.time_ns !== 'number' || !Number.isInteger(nf.time_ns) || nf.time_ns < 0) {
            errors.push({ field: `${path}.time_ns`, message: 'Failure time_ns must be an integer >= 0' })
          }
          if (typeof nf.node !== 'string' || !nodeIds.has(nf.node)) {
            errors.push({ field: `${path}.node`, message: `Failure node "${nf.node}" does not match any valid node ID` })
          }
          if (nf.repair_ns !== undefined && (typeof nf.repair_ns !== 'number' || !Number.isInteger(nf.repair_ns) || nf.repair_ns < 0)) {
            errors.push({ field: `${path}.repair_ns`, message: 'Repair repair_ns must be an integer >= 0' })
          }
        })
      }

      if (Array.isArray(f.link_degradations)) {
        f.link_degradations.forEach((ldItem, i) => {
          const path = `faults.link_degradations[${i}]`
          if (!ldItem || typeof ldItem !== 'object') {
            errors.push({ field: path, message: 'Link degradation specification must be an object' })
            return
          }
          const ld = ldItem as Record<string, unknown>
          if (typeof ld.start_ns !== 'number' || ld.start_ns < 0) {
            errors.push({ field: `${path}.start_ns`, message: 'Degradation start_ns must be an integer >= 0' })
          }
          if (typeof ld.end_ns !== 'number' || ld.end_ns < 0) {
            errors.push({ field: `${path}.end_ns`, message: 'Degradation end_ns must be an integer >= 0' })
          }
          if (typeof ld.start_ns === 'number' && typeof ld.end_ns === 'number' && ld.start_ns > ld.end_ns) {
            errors.push({ field: `${path}.end_ns`, message: 'Degradation end_ns must be >= start_ns' })
          }
          if (typeof ld.link !== 'string' || !linkIds.has(ld.link)) {
            errors.push({ field: `${path}.link`, message: `Degradation link "${ld.link}" does not match any valid link ID` })
          }
          if (ld.bandwidth_factor !== undefined && (typeof ld.bandwidth_factor !== 'number' || ld.bandwidth_factor <= 0 || ld.bandwidth_factor > 1)) {
            errors.push({ field: `${path}.bandwidth_factor`, message: 'Degradation bandwidth_factor must be > 0 and <= 1' })
          }
          if (ld.latency_factor !== undefined && (typeof ld.latency_factor !== 'number' || ld.latency_factor < 1)) {
            errors.push({ field: `${path}.latency_factor`, message: 'Degradation latency_factor must be >= 1' })
          }
        })
      }

      if (f.packet_loss !== undefined) {
        if (typeof f.packet_loss !== 'object' || Array.isArray(f.packet_loss)) {
          errors.push({ field: 'faults.packet_loss', message: 'Packet loss must be an object' })
        } else {
          const pl = f.packet_loss as Record<string, unknown>
          if (pl.ppm !== undefined && (typeof pl.ppm !== 'number' || !Number.isInteger(pl.ppm) || pl.ppm < 0 || pl.ppm > 1000000)) {
            errors.push({ field: 'faults.packet_loss.ppm', message: 'Packet loss ppm must be an integer 0..1,000,000' })
          }
        }
      }
    }
  }

  // 14. Metrics (optional)
  if (s.metrics !== undefined) {
    if (typeof s.metrics !== 'object' || Array.isArray(s.metrics)) {
      errors.push({ field: 'metrics', message: 'Metrics configuration must be an object' })
    } else {
      const m = s.metrics as Record<string, unknown>
      if (m.sample_interval_ns !== undefined && (typeof m.sample_interval_ns !== 'number' || !Number.isInteger(m.sample_interval_ns) || m.sample_interval_ns < 1)) {
        errors.push({ field: 'metrics.sample_interval_ns', message: 'Sample interval must be an integer >= 1' })
      }
      if (m.warmup_ns !== undefined && (typeof m.warmup_ns !== 'number' || !Number.isInteger(m.warmup_ns) || m.warmup_ns < 0)) {
        errors.push({ field: 'metrics.warmup_ns', message: 'Metrics warmup_ns must be an integer >= 0' })
      }
      if (m.percentiles !== undefined) {
        if (!Array.isArray(m.percentiles)) {
          errors.push({ field: 'metrics.percentiles', message: 'Percentiles must be an array of numbers' })
        } else {
          const seenP = new Set<number>()
          m.percentiles.forEach((p, idx) => {
            if (typeof p !== 'number' || p <= 0 || p > 100) {
              errors.push({ field: `metrics.percentiles[${idx}]`, message: 'Percentile must be a number > 0 and <= 100' })
            }
            if (seenP.has(p)) {
              errors.push({ field: `metrics.percentiles[${idx}]`, message: `Duplicate percentile: ${p}` })
            }
            seenP.add(p)
          })
        }
      }
    }
  }

  // 15. Output (optional)
  if (s.output !== undefined) {
    if (typeof s.output !== 'object' || Array.isArray(s.output)) {
      errors.push({ field: 'output', message: 'Output configuration must be an object' })
    } else {
      const out = s.output as Record<string, unknown>
      if (out.format !== undefined && out.format !== 'jsonl' && out.format !== 'parquet') {
        errors.push({ field: 'output.format', message: 'Output format must be "jsonl" or "parquet"' })
      }
      if (out.path !== undefined && (typeof out.path !== 'string' || out.path.length === 0)) {
        errors.push({ field: 'output.path', message: 'Output path must be a non-empty string' })
      }
    }
  }

  // 16. Cost Model (optional)
  if (s.cost_model !== undefined) {
    if (typeof s.cost_model !== 'object' || Array.isArray(s.cost_model)) {
      errors.push({ field: 'cost_model', message: 'Cost model configuration must be an object' })
    } else {
      const cm = s.cost_model as Record<string, unknown>
      if (cm.capacity_per_gib_second !== undefined && (typeof cm.capacity_per_gib_second !== 'number' || cm.capacity_per_gib_second < 0)) {
        errors.push({ field: 'cost_model.capacity_per_gib_second', message: 'Cost capacity_per_gib_second must be >= 0' })
      }
      if (cm.transfer_per_gib !== undefined && (typeof cm.transfer_per_gib !== 'number' || cm.transfer_per_gib < 0)) {
        errors.push({ field: 'cost_model.transfer_per_gib', message: 'Cost transfer_per_gib must be >= 0' })
      }
      if (cm.migration_per_gib !== undefined && (typeof cm.migration_per_gib !== 'number' || cm.migration_per_gib < 0)) {
        errors.push({ field: 'cost_model.migration_per_gib', message: 'Cost migration_per_gib must be >= 0' })
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  }
}
