import React, { useState, useRef } from 'react'
import type {
  ScenarioConfig,
  WorkloadProfile,
  PolicyName,
  NodeConfig,
  FabricLinkConfig
} from '../../types/scenario'
import { LLAMA_70B_CXL_SCENARIO, MOE_RDMA_SCENARIO } from '../../services/mockData'
import { apiClient } from '../../services/api'
import { validateScenario, type ValidationError } from '../../utils/validation'
import { Badge } from '../common/Badge'
import {
  Play,
  Save,
  Download,
  Upload,
  Copy,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  Plus,
  Trash2,
  FileCode,
  Sliders,
  Network,
  Cpu,
  Settings2,
  RefreshCw
} from 'lucide-react'

interface ScenarioBuilderViewProps {
  onNotify: (text: string, type: 'success' | 'error' | 'info') => void
  onScenarioSaved?: (scenario: ScenarioConfig) => void
  onRunSubmitted?: (runId: string) => void
}

type BuilderTab = 'general' | 'infrastructure' | 'workload' | 'policy' | 'review'

export const ScenarioBuilderView: React.FC<ScenarioBuilderViewProps> = ({
  onNotify,
  onScenarioSaved,
  onRunSubmitted
}) => {
  const [activeTab, setActiveTab] = useState<BuilderTab>('general')
  const [scenario, setScenario] = useState<ScenarioConfig>(() =>
    JSON.parse(JSON.stringify(LLAMA_70B_CXL_SCENARIO))
  )
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([])
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Live validation
  const validateCurrent = (updated: ScenarioConfig) => {
    const res = validateScenario(updated)
    setValidationErrors(res.errors)
    return res.isValid
  }

  // Handle run simulation submission
  const handleSubmitSimulation = async () => {
    if (isSubmitting) return

    const isValid = validateCurrent(scenario)
    if (!isValid) {
      onNotify('Cannot submit invalid scenario. Please resolve all schema errors first.', 'error')
      return
    }

    setIsSubmitting(true)
    try {
      const res = await apiClient.submitScenario(scenario)
      if (res.success && res.runId) {
        onNotify(res.message, 'success')
        onRunSubmitted?.(res.runId)
      } else {
        onNotify(res.message, 'error')
      }
    } catch (err) {
      onNotify(
        `Simulation dispatch error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error'
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  // Update general scenario properties
  const updateGeneral = <K extends keyof ScenarioConfig>(key: K, value: ScenarioConfig[K]) => {
    const updated = { ...scenario, [key]: value }
    setScenario(updated)
    validateCurrent(updated)
  }

  // Add / remove nodes
  const addNode = (role: 'compute' | 'memory') => {
    const id = role === 'compute' ? `node-${scenario.nodes.length}` : `remote-pool-${scenario.nodes.length}`
    const newNode: NodeConfig = role === 'compute'
      ? {
          id,
          role: 'compute',
          local_memory: {
            capacity_bytes: 549755813888, // 512 GiB
            latency_ns: 90,
            bandwidth_bytes_per_ns: 400
          },
          compute: {
            accelerator: 'H100-80GB',
            accelerators: 8,
            accelerator_memory_bytes: 85899345920
          }
        }
      : {
          id,
          role: 'memory',
          remote_memory: {
            capacity_bytes: 4398046511104, // 4 TiB
            latency_ns: 180,
            bandwidth_bytes_per_ns: 48
          }
        }

    const updated = { ...scenario, nodes: [...scenario.nodes, newNode] }
    setScenario(updated)
    validateCurrent(updated)
    onNotify(`Added new ${role} node: ${id}`, 'info')
  }

  const removeNode = (index: number) => {
    if (scenario.nodes.length <= 1) {
      onNotify('Scenario requires at least one node.', 'error')
      return
    }
    const removedNode = scenario.nodes[index]
    const updatedNodes = scenario.nodes.filter((_, i) => i !== index)
    // Filter out links pointing to or from this removed node
    const updatedLinks = scenario.fabric.links.filter(
      (l) => l.from !== removedNode.id && l.to !== removedNode.id
    )

    const updated = {
      ...scenario,
      nodes: updatedNodes,
      fabric: { links: updatedLinks }
    }
    setScenario(updated)
    validateCurrent(updated)
    onNotify(`Removed node ${removedNode.id} and associated links`, 'info')
  }

  // Add / remove links
  const addLink = () => {
    const computeNodes = scenario.nodes.filter((n) => n.role === 'compute')
    const memoryNodes = scenario.nodes.filter((n) => n.role === 'memory')

    const from = computeNodes[0]?.id || scenario.nodes[0].id
    const to = memoryNodes[0]?.id || scenario.nodes[1]?.id || scenario.nodes[0].id
    const id = `link-${scenario.fabric.links.length}`

    const newLink: FabricLinkConfig = {
      id,
      from,
      to,
      latency_ns: 180,
      bandwidth_bytes_per_ns: 48,
      in_flight_bytes: 16777216,
      queue_depth_bytes: 67108864,
      bidirectional: true
    }

    const updated = {
      ...scenario,
      fabric: {
        links: [...scenario.fabric.links, newLink]
      }
    }
    setScenario(updated)
    validateCurrent(updated)
    onNotify(`Added fabric link: ${id}`, 'info')
  }

  const removeLink = (index: number) => {
    if (scenario.fabric.links.length <= 1) {
      onNotify('Scenario requires at least one fabric link.', 'error')
      return
    }
    const updatedLinks = scenario.fabric.links.filter((_, i) => i !== index)
    const updated = {
      ...scenario,
      fabric: { links: updatedLinks }
    }
    setScenario(updated)
    validateCurrent(updated)
  }

  // Workload profile change
  const handleProfileChange = (profile: WorkloadProfile) => {
    if (scenario.workload.type !== 'synthetic') return

    const baseModel = scenario.workload.model || {}
    const updatedModel = { ...baseModel }

    if (profile === 'moe') {
      updatedModel.experts = 8
      updatedModel.top_k = 2
      updatedModel.expert_size_bytes = 176160768
      updatedModel.popularity_distribution = 'zipf'
      updatedModel.popularity_skew = 1.1
    }

    const updated: ScenarioConfig = {
      ...scenario,
      workload: {
        ...scenario.workload,
        profile,
        model: updatedModel
      }
    }
    setScenario(updated)
    validateCurrent(updated)
  }

  // Policy change
  const handlePolicyChange = (name: PolicyName) => {
    let params: Record<string, unknown> = {}
    if (name === 'hot_cold') {
      params = {
        hot_threshold: 8,
        cold_threshold: 1,
        tick_ns: 1000000,
        min_residency_ns: 10000000,
        max_migrations_per_tick: 64
      }
    } else if (name === 'frequency_aware') {
      params = {
        history_length: 8,
        k: 2,
        protect_fraction: 0.6,
        migration_watermark: 0.85,
        max_migrations_per_tick: 128
      }
    } else if (name === 'predictive_prefetch') {
      params = {
        confidence_threshold: 0.75,
        lookahead_depth: 4,
        max_inflight_prefetches: 32
      }
    } else if (name === 'cost_aware') {
      params = {
        cost_weight_latency: 0.6,
        cost_weight_bandwidth: 0.4
      }
    }

    const updated: ScenarioConfig = {
      ...scenario,
      policy: {
        name,
        params
      }
    }
    setScenario(updated)
    validateCurrent(updated)
  }

  // Export JSON file
  const handleExportJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(scenario, null, 2))
    const downloadAnchor = document.createElement('a')
    downloadAnchor.setAttribute('href', dataStr)
    downloadAnchor.setAttribute('download', `${scenario.name || 'scenario'}.json`)
    document.body.appendChild(downloadAnchor)
    downloadAnchor.click()
    downloadAnchor.remove()
    onNotify(`Scenario exported as ${scenario.name}.json`, 'success')
  }

  // Copy JSON to clipboard
  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(scenario, null, 2))
      onNotify('Scenario JSON copied to clipboard!', 'success')
    } catch {
      onNotify('Failed to copy to clipboard', 'error')
    }
  }

  // Import JSON file
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string
        const parsed = JSON.parse(text)
        const validation = validateScenario(parsed)

        if (validation.isValid) {
          setScenario(parsed as ScenarioConfig)
          setValidationErrors([])
          onNotify(`Successfully imported scenario: ${parsed.name || file.name}`, 'success')
        } else {
          setScenario(parsed as ScenarioConfig)
          setValidationErrors(validation.errors)
          onNotify(`Scenario loaded with ${validation.errors.length} validation issues. Check error list.`, 'error')
        }
      } catch (err) {
        onNotify(`Malformed JSON file: ${err instanceof Error ? err.message : 'Parse error'}`, 'error')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  // Reset to example preset
  const handleReset = (preset: 'llama' | 'moe') => {
    const target = preset === 'llama' ? LLAMA_70B_CXL_SCENARIO : MOE_RDMA_SCENARIO
    const clone = JSON.parse(JSON.stringify(target))
    setScenario(clone)
    validateCurrent(clone)
    onNotify(`Reset editor to ${preset === 'llama' ? 'Llama-70B CXL' : 'MoE RDMA'} scenario`, 'info')
  }

  // Compute KV cache estimated size per token
  const calcKvCacheBytesPerToken = () => {
    if (scenario.workload.type !== 'synthetic' || !scenario.workload.model) return null
    const { layers = 80, kv_heads = 8, head_dim = 128, dtype_bytes = 2 } = scenario.workload.model
    // 2 * layers * kv_heads * head_dim * dtype_bytes
    const bytes = 2 * layers * kv_heads * head_dim * dtype_bytes
    return bytes
  }

  const kvBytes = calcKvCacheBytesPerToken()

  return (
    <div className="app-content">
      {/* Hidden file input for JSON import */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".json,application/json"
        style={{ display: 'none' }}
      />

      {/* Action Bar */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text-primary)' }}>
              {scenario.name || 'Untitled Scenario'}
            </span>
            <Badge variant="cyan">Schema 0.1</Badge>
            {validationErrors.length === 0 ? (
              <Badge variant="emerald" icon={<CheckCircle2 size={12} />}>Valid Scenario</Badge>
            ) : (
              <Badge variant="rose" icon={<AlertTriangle size={12} />}>
                {validationErrors.length} Schema {validationErrors.length === 1 ? 'Error' : 'Errors'}
              </Badge>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => handleReset('llama')}
              title="Load Llama-70B 4-node CXL benchmark"
            >
              <RotateCcw size={13} />
              <span>Load Llama-70B</span>
            </button>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => handleReset('moe')}
              title="Load Mixtral MoE 8-node RDMA benchmark"
            >
              <RotateCcw size={13} />
              <span>Load MoE Preset</span>
            </button>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => fileInputRef.current?.click()}
              title="Import JSON scenario file"
            >
              <Upload size={13} />
              <span>Import JSON</span>
            </button>
            <button
              className="btn btn-sm btn-secondary"
              onClick={handleExportJson}
              title="Export scenario as JSON file"
            >
              <Download size={13} />
              <span>Export JSON</span>
            </button>
            <button
              className="btn btn-sm btn-outline"
              onClick={handleCopyJson}
              title="Copy JSON to clipboard"
            >
              <Copy size={13} />
              <span>Copy</span>
            </button>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                if (validateCurrent(scenario)) {
                  onScenarioSaved?.(scenario)
                  onNotify('Scenario saved to local active session!', 'success')
                } else {
                  onNotify('Please resolve validation errors before saving.', 'error')
                }
              }}
              title="Save active scenario to current session"
            >
              <Save size={13} />
              <span>Save Scenario</span>
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={handleSubmitSimulation}
              disabled={isSubmitting || validationErrors.length > 0}
              title="Dispatch scenario to simulation engine"
              style={{
                opacity: validationErrors.length > 0 ? 0.6 : 1,
                cursor: validationErrors.length > 0 || isSubmitting ? 'not-allowed' : 'pointer'
              }}
            >
              {isSubmitting ? (
                <>
                  <RefreshCw size={13} className="spin" />
                  <span>Submitting...</span>
                </>
              ) : (
                <>
                  <Play size={13} />
                  <span>Run Simulation</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Validation Errors Notice (if any) */}
      {validationErrors.length > 0 && (
        <div
          className="card"
          style={{
            backgroundColor: 'rgba(244, 63, 94, 0.08)',
            borderColor: 'rgba(244, 63, 94, 0.3)',
            padding: '16px 20px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-rose)', fontWeight: 600, marginBottom: '6px' }}>
            <AlertTriangle size={16} />
            <span>Validation Errors (SPECS/config.schema.json compliance)</span>
          </div>
          <ul style={{ paddingLeft: '20px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {validationErrors.map((err, idx) => (
              <li key={idx} style={{ marginBottom: '2px' }}>
                <span className="mono" style={{ color: 'var(--accent-rose)' }}>{err.field}</span>: {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tabs Navigation */}
      <div style={{ display: 'flex', gap: '6px', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '2px' }}>
        {[
          { id: 'general' as BuilderTab, label: '1. General', icon: <Settings2 size={14} /> },
          { id: 'infrastructure' as BuilderTab, label: '2. Infrastructure', icon: <Network size={14} /> },
          { id: 'workload' as BuilderTab, label: '3. Workload', icon: <Cpu size={14} /> },
          { id: 'policy' as BuilderTab, label: '4. Policy', icon: <Sliders size={14} /> },
          { id: 'review' as BuilderTab, label: '5. Review & JSON', icon: <FileCode size={14} /> }
        ].map((tab) => (
          <button
            key={tab.id}
            className={`btn btn-sm ${activeTab === tab.id ? 'btn-primary' : 'btn-outline'}`}
            style={{ borderRadius: '6px 6px 0 0', borderBottom: 'none' }}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* TAB 1: GENERAL */}
      {activeTab === 'general' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-title">Scenario Identity & Virtual Timeline</div>
              <div className="card-subtitle">Global simulation parameters and reproducible random seed</div>
            </div>
          </div>

          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label">Scenario Name</label>
              <input
                type="text"
                value={scenario.name}
                onChange={(e) => updateGeneral('name', e.target.value)}
                placeholder="e.g. llama-70b-cxl"
              />
              <span className="form-help">Max 120 characters, used in manifests and logs</span>
            </div>

            <div className="form-group">
              <label className="form-label">Schema Version</label>
              <input
                type="text"
                value={scenario.version}
                disabled
                style={{ opacity: 0.7, cursor: 'not-allowed' }}
              />
              <span className="form-help">Fixed specification version: "0.1"</span>
            </div>

            <div className="form-group" style={{ gridColumn: 'span 2' }}>
              <label className="form-label">Scenario Description</label>
              <textarea
                rows={2}
                value={scenario.description || ''}
                onChange={(e) => updateGeneral('description', e.target.value)}
                placeholder="Describe experimental goals, policy trade-offs, and hardware configuration..."
              />
            </div>

            <div className="form-group">
              <label className="form-label">Random Seed</label>
              <input
                type="number"
                min={0}
                value={scenario.seed}
                onChange={(e) => updateGeneral('seed', parseInt(e.target.value) || 0)}
              />
              <span className="form-help">Independent seeded PRNG stream guarantees determinism</span>
            </div>

            <div className="form-group">
              <label className="form-label">Simulation Duration (ns)</label>
              <input
                type="number"
                min={1000}
                value={scenario.duration_ns}
                onChange={(e) => updateGeneral('duration_ns', parseInt(e.target.value) || 1)}
              />
              <span className="form-help">
                {(scenario.duration_ns / 1_000_000_000).toFixed(1)} seconds of virtual clock execution
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">Warm-Up Duration (ns)</label>
              <input
                type="number"
                min={0}
                value={scenario.warmup_ns || 0}
                onChange={(e) => updateGeneral('warmup_ns', parseInt(e.target.value) || 0)}
              />
              <span className="form-help">
                Warm-up telemetry is excluded from final metric summaries
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">Page Size (Bytes)</label>
              <select
                value={scenario.page_size_bytes || 2097152}
                onChange={(e) => updateGeneral('page_size_bytes', parseInt(e.target.value))}
              >
                <option value={4096}>4 KiB (Standard Linux Page)</option>
                <option value={65536}>64 KiB (ARM64 Hugepage)</option>
                <option value={2097152}>2 MiB (Default x86-64 Hugepage)</option>
                <option value={1073741824}>1 GiB (Gigabyte Hugepage)</option>
              </select>
              <span className="form-help">Granularity of capacity accounting and migration</span>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: INFRASTRUCTURE */}
      {activeTab === 'infrastructure' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Nodes Section */}
          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <div className="card-title">
                  <Cpu size={16} color="var(--accent-cyan)" />
                  <span>Compute & Memory Nodes ({scenario.nodes.length})</span>
                </div>
                <div className="card-subtitle">
                  Configure local DRAM capacities, accelerators, and pooled disaggregated memory
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-sm btn-outline" onClick={() => addNode('compute')}>
                  <Plus size={13} />
                  <span>Add Compute Node</span>
                </button>
                <button className="btn btn-sm btn-outline" onClick={() => addNode('memory')}>
                  <Plus size={13} />
                  <span>Add Memory Pool</span>
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {scenario.nodes.map((node, index) => (
                <div
                  key={node.id + index}
                  style={{
                    backgroundColor: 'var(--bg-card-secondary)',
                    border: '1px solid var(--border-card)',
                    borderRadius: 'var(--radius-md)',
                    padding: '14px 18px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Badge variant={node.role === 'compute' ? 'cyan' : 'violet'}>
                        {node.role.toUpperCase()}
                      </Badge>
                      <span className="mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        {node.id}
                      </span>
                    </div>

                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => removeNode(index)}
                      title="Remove node"
                    >
                      <Trash2 size={12} />
                      <span>Remove</span>
                    </button>
                  </div>

                  <div className="form-grid-2">
                    <div className="form-group">
                      <label className="form-label">Node Identifier</label>
                      <input
                        type="text"
                        value={node.id}
                        onChange={(e) => {
                          const updated = [...scenario.nodes]
                          updated[index].id = e.target.value
                          setScenario({ ...scenario, nodes: updated })
                        }}
                      />
                    </div>

                    {node.role === 'compute' && node.local_memory && (
                      <>
                        <div className="form-group">
                          <label className="form-label">Local DRAM Capacity (Bytes)</label>
                          <input
                            type="number"
                            value={node.local_memory.capacity_bytes}
                            onChange={(e) => {
                              const updated = [...scenario.nodes]
                              if (updated[index].local_memory) {
                                updated[index].local_memory.capacity_bytes = parseInt(e.target.value) || 0
                                setScenario({ ...scenario, nodes: updated })
                              }
                            }}
                          />
                          <span className="form-hint">
                            {(node.local_memory.capacity_bytes / (1024 ** 3)).toFixed(1)} GiB
                          </span>
                        </div>

                        <div className="form-group">
                          <label className="form-label">Local DRAM Latency (ns)</label>
                          <input
                            type="number"
                            value={node.local_memory.latency_ns}
                            onChange={(e) => {
                              const updated = [...scenario.nodes]
                              if (updated[index].local_memory) {
                                updated[index].local_memory.latency_ns = parseFloat(e.target.value) || 0
                                setScenario({ ...scenario, nodes: updated })
                              }
                            }}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">Local Bandwidth (Bytes/ns = GB/s)</label>
                          <input
                            type="number"
                            value={node.local_memory.bandwidth_bytes_per_ns}
                            onChange={(e) => {
                              const updated = [...scenario.nodes]
                              if (updated[index].local_memory) {
                                updated[index].local_memory.bandwidth_bytes_per_ns = parseFloat(e.target.value) || 0
                                setScenario({ ...scenario, nodes: updated })
                              }
                            }}
                          />
                        </div>
                      </>
                    )}

                    {node.role === 'memory' && node.remote_memory && (
                      <>
                        <div className="form-group">
                          <label className="form-label">Remote Pool Capacity (Bytes)</label>
                          <input
                            type="number"
                            value={node.remote_memory.capacity_bytes}
                            onChange={(e) => {
                              const updated = [...scenario.nodes]
                              if (updated[index].remote_memory) {
                                updated[index].remote_memory.capacity_bytes = parseInt(e.target.value) || 0
                                setScenario({ ...scenario, nodes: updated })
                              }
                            }}
                          />
                          <span className="form-hint">
                            {(node.remote_memory.capacity_bytes / (1024 ** 4)).toFixed(1)} TiB Pooled
                          </span>
                        </div>

                        <div className="form-group">
                          <label className="form-label">Remote Pool Access Latency (ns)</label>
                          <input
                            type="number"
                            value={node.remote_memory.latency_ns}
                            onChange={(e) => {
                              const updated = [...scenario.nodes]
                              if (updated[index].remote_memory) {
                                updated[index].remote_memory.latency_ns = parseFloat(e.target.value) || 0
                                setScenario({ ...scenario, nodes: updated })
                              }
                            }}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">Remote Bandwidth (Bytes/ns)</label>
                          <input
                            type="number"
                            value={node.remote_memory.bandwidth_bytes_per_ns}
                            onChange={(e) => {
                              const updated = [...scenario.nodes]
                              if (updated[index].remote_memory) {
                                updated[index].remote_memory.bandwidth_bytes_per_ns = parseFloat(e.target.value) || 0
                                setScenario({ ...scenario, nodes: updated })
                              }
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Fabric Links Section */}
          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <div className="card-title">
                  <Network size={16} color="var(--accent-teal)" />
                  <span>Fabric Interconnect Links ({scenario.fabric.links.length})</span>
                </div>
                <div className="card-subtitle">
                  Configure CXL, PCIe, or RDMA RoCE fabric links with FIFO queues
                </div>
              </div>

              <button className="btn btn-sm btn-outline" onClick={addLink}>
                <Plus size={13} />
                <span>Add Fabric Link</span>
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {scenario.fabric.links.map((link, index) => (
                <div
                  key={link.id + index}
                  style={{
                    backgroundColor: 'var(--bg-card-secondary)',
                    border: '1px solid var(--border-card)',
                    borderRadius: 'var(--radius-md)',
                    padding: '14px 18px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Badge variant="teal">LINK</Badge>
                      <span className="mono" style={{ fontWeight: 600 }}>{link.id}</span>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        ({link.from} &harr; {link.to})
                      </span>
                    </div>

                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => removeLink(index)}
                      title="Remove link"
                    >
                      <Trash2 size={12} />
                      <span>Remove</span>
                    </button>
                  </div>

                  <div className="form-grid-2">
                    <div className="form-group">
                      <label className="form-label">Link Identifier</label>
                      <input
                        type="text"
                        value={link.id}
                        onChange={(e) => {
                          const updated = [...scenario.fabric.links]
                          updated[index].id = e.target.value
                          setScenario({ ...scenario, fabric: { links: updated } })
                        }}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">From Node</label>
                      <select
                        value={link.from}
                        onChange={(e) => {
                          const updated = [...scenario.fabric.links]
                          updated[index].from = e.target.value
                          setScenario({ ...scenario, fabric: { links: updated } })
                        }}
                      >
                        {scenario.nodes.map((n) => (
                          <option key={n.id} value={n.id}>{n.id} ({n.role})</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label">To Node</label>
                      <select
                        value={link.to}
                        onChange={(e) => {
                          const updated = [...scenario.fabric.links]
                          updated[index].to = e.target.value
                          setScenario({ ...scenario, fabric: { links: updated } })
                        }}
                      >
                        {scenario.nodes.map((n) => (
                          <option key={n.id} value={n.id}>{n.id} ({n.role})</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label">One-Way Latency (ns)</label>
                      <input
                        type="number"
                        value={link.latency_ns}
                        onChange={(e) => {
                          const updated = [...scenario.fabric.links]
                          updated[index].latency_ns = parseFloat(e.target.value) || 0
                          setScenario({ ...scenario, fabric: { links: updated } })
                        }}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Link Bandwidth (GB/s = Bytes/ns)</label>
                      <input
                        type="number"
                        value={link.bandwidth_bytes_per_ns}
                        onChange={(e) => {
                          const updated = [...scenario.fabric.links]
                          updated[index].bandwidth_bytes_per_ns = parseFloat(e.target.value) || 0
                          setScenario({ ...scenario, fabric: { links: updated } })
                        }}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Queue Depth (Bytes)</label>
                      <input
                        type="number"
                        value={link.queue_depth_bytes || 67108864}
                        onChange={(e) => {
                          const updated = [...scenario.fabric.links]
                          updated[index].queue_depth_bytes = parseInt(e.target.value) || 0
                          setScenario({ ...scenario, fabric: { links: updated } })
                        }}
                      />
                      <span className="form-hint">
                        {((link.queue_depth_bytes || 0) / (1024 ** 2)).toFixed(1)} MiB FIFO buffer
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: WORKLOAD */}
      {activeTab === 'workload' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-title">Workload Synthesis & Memory Access Patterns</div>
              <div className="card-subtitle">
                Configure synthetic LLM trace generators strictly adhering to SPECS/config.schema.json
              </div>
            </div>
          </div>

          {scenario.workload.type === 'synthetic' && (
            <div className="form-grid-2">
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Workload Profile</label>
                <select
                  value={scenario.workload.profile}
                  onChange={(e) => handleProfileChange(e.target.value as WorkloadProfile)}
                >
                  <option value="kv_cache_decode">kv_cache_decode (LLM Autoregressive Token Generation)</option>
                  <option value="prefill">prefill (Prompt Processing Sequential Scans)</option>
                  <option value="sparse_attention">sparse_attention (Long-Context Strided & Global Tokens)</option>
                  <option value="moe">moe (Mixture-of-Experts Skewed Routing)</option>
                  <option value="mixed">mixed (Multi-Tenant Serving Interference)</option>
                </select>
                <span className="form-help">
                  Normalized memory event source for the discrete-event scheduler
                </span>
              </div>

              {/* Model Specifications */}
              <div className="form-group">
                <label className="form-label">Model Identifier</label>
                <input
                  type="text"
                  value={scenario.workload.model?.name || ''}
                  onChange={(e) => {
                    if (scenario.workload.type === 'synthetic') {
                      setScenario({
                        ...scenario,
                        workload: {
                          ...scenario.workload,
                          model: { ...scenario.workload.model, name: e.target.value }
                        }
                      })
                    }
                  }}
                  placeholder="e.g. llama-3-70b"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Transformer Layers</label>
                <input
                  type="number"
                  min={1}
                  value={scenario.workload.model?.layers || 80}
                  onChange={(e) => {
                    if (scenario.workload.type === 'synthetic') {
                      setScenario({
                        ...scenario,
                        workload: {
                          ...scenario.workload,
                          model: { ...scenario.workload.model, layers: parseInt(e.target.value) || 1 }
                        }
                      })
                    }
                  }}
                />
              </div>

              <div className="form-group">
                <label className="form-label">KV Heads (GQA/MQA)</label>
                <input
                  type="number"
                  min={1}
                  value={scenario.workload.model?.kv_heads || 8}
                  onChange={(e) => {
                    if (scenario.workload.type === 'synthetic') {
                      setScenario({
                        ...scenario,
                        workload: {
                          ...scenario.workload,
                          model: { ...scenario.workload.model, kv_heads: parseInt(e.target.value) || 1 }
                        }
                      })
                    }
                  }}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Head Dimension</label>
                <input
                  type="number"
                  min={1}
                  value={scenario.workload.model?.head_dim || 128}
                  onChange={(e) => {
                    if (scenario.workload.type === 'synthetic') {
                      setScenario({
                        ...scenario,
                        workload: {
                          ...scenario.workload,
                          model: { ...scenario.workload.model, head_dim: parseInt(e.target.value) || 1 }
                        }
                      })
                    }
                  }}
                />
              </div>

              {/* KV Cache Footprint Calculation Card */}
              {kvBytes !== null && (
                <div
                  style={{
                    gridColumn: 'span 2',
                    padding: '12px 16px',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'rgba(6, 182, 212, 0.08)',
                    border: '1px solid rgba(6, 182, 212, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                >
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Calculated KV Cache footprint per token:
                    <code style={{ marginLeft: '8px', color: 'var(--accent-cyan)' }}>
                      2 &times; {scenario.workload.model?.layers}L &times; {scenario.workload.model?.kv_heads}H &times; {scenario.workload.model?.head_dim}D &times; {scenario.workload.model?.dtype_bytes || 2}B
                    </code>
                  </span>
                  <span className="mono" style={{ fontWeight: 700, color: 'var(--accent-cyan)' }}>
                    {(kvBytes / 1024).toFixed(2)} KiB / token
                  </span>
                </div>
              )}

              {/* MoE specific fields */}
              {scenario.workload.profile === 'moe' && (
                <>
                  <div className="form-group">
                    <label className="form-label">Total Experts</label>
                    <input
                      type="number"
                      min={1}
                      value={scenario.workload.model?.experts || 8}
                      onChange={(e) => {
                        if (scenario.workload.type === 'synthetic') {
                          setScenario({
                            ...scenario,
                            workload: {
                              ...scenario.workload,
                              model: { ...scenario.workload.model, experts: parseInt(e.target.value) || 1 }
                            }
                          })
                        }
                      }}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Top-K Active per Token</label>
                    <input
                      type="number"
                      min={1}
                      value={scenario.workload.model?.top_k || 2}
                      onChange={(e) => {
                        if (scenario.workload.type === 'synthetic') {
                          setScenario({
                            ...scenario,
                            workload: {
                              ...scenario.workload,
                              model: { ...scenario.workload.model, top_k: parseInt(e.target.value) || 1 }
                            }
                          })
                        }
                      }}
                    />
                  </div>
                </>
              )}

              {/* Request Parameters */}
              <div className="form-group">
                <label className="form-label">Arrival Rate (req/sec)</label>
                <input
                  type="number"
                  min={0.1}
                  step={0.5}
                  value={scenario.workload.requests?.arrival_rate_per_second || 8}
                  onChange={(e) => {
                    if (scenario.workload.type === 'synthetic') {
                      setScenario({
                        ...scenario,
                        workload: {
                          ...scenario.workload,
                          requests: { ...scenario.workload.requests, arrival_rate_per_second: parseFloat(e.target.value) || 1 }
                        }
                      })
                    }
                  }}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Concurrency</label>
                <input
                  type="number"
                  min={1}
                  value={scenario.workload.requests?.concurrency || 16}
                  onChange={(e) => {
                    if (scenario.workload.type === 'synthetic') {
                      setScenario({
                        ...scenario,
                        workload: {
                          ...scenario.workload,
                          requests: { ...scenario.workload.requests, concurrency: parseInt(e.target.value) || 1 }
                        }
                      })
                    }
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: POLICY */}
      {activeTab === 'policy' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-title">Memory Tiering & Migration Policy</div>
              <div className="card-subtitle">
                Configure deterministic page placement algorithms and threshold parameters
              </div>
            </div>
          </div>

          <div className="form-grid-2">
            <div className="form-group" style={{ gridColumn: 'span 2' }}>
              <label className="form-label">Policy Algorithm</label>
              <select
                value={scenario.policy.name}
                onChange={(e) => handlePolicyChange(e.target.value as PolicyName)}
              >
                <option value="hot_cold">hot_cold (EWMA Access Counting with Migration Watermarks)</option>
                <option value="frequency_aware">frequency_aware (LRU-K / Protected Segment Replacement)</option>
                <option value="swap_remote">swap_remote (Reactive Demand Paging Baseline)</option>
                <option value="local_only">local_only (Local DRAM Only Baseline - No Remote Fabric)</option>
                <option value="predictive_prefetch">predictive_prefetch (Lookahead Speculative Prefetch)</option>
                <option value="cost_aware">cost_aware (Multi-Objective Cost vs. Latency Optimization)</option>
              </select>
            </div>

            {/* Dynamic Policy Parameters */}
            {scenario.policy.name === 'hot_cold' && (
              <>
                <div className="form-group">
                  <label className="form-label">Hot Threshold (Hits / Window)</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.hot_threshold as number) || 8}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, hot_threshold: parseInt(e.target.value) || 0 }
                        }
                      })
                    }}
                  />
                  <span className="form-help">Promotes remote page to local memory</span>
                </div>

                <div className="form-group">
                  <label className="form-label">Cold Threshold</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.cold_threshold as number) || 1}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, cold_threshold: parseInt(e.target.value) || 0 }
                        }
                      })
                    }}
                  />
                  <span className="form-help">Demotes local page to remote memory</span>
                </div>

                <div className="form-group">
                  <label className="form-label">Tick Interval (ns)</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.tick_ns as number) || 1000000}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, tick_ns: parseInt(e.target.value) || 0 }
                        }
                      })
                    }}
                  />
                  <span className="form-help">Virtual time period for EWMA decay update</span>
                </div>

                <div className="form-group">
                  <label className="form-label">Max Migrations Per Tick</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.max_migrations_per_tick as number) || 64}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, max_migrations_per_tick: parseInt(e.target.value) || 0 }
                        }
                      })
                    }}
                  />
                  <span className="form-help">Rate-limits fabric traffic to prevent queue storms</span>
                </div>
              </>
            )}

            {scenario.policy.name === 'frequency_aware' && (
              <>
                <div className="form-group">
                  <label className="form-label">History Length</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.history_length as number) || 8}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, history_length: parseInt(e.target.value) || 1 }
                        }
                      })
                    }}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">K (Reference Distance)</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.k as number) || 2}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, k: parseInt(e.target.value) || 1 }
                        }
                      })
                    }}
                  />
                </div>
              </>
            )}

            {scenario.policy.name === 'predictive_prefetch' && (
              <>
                <div className="form-group">
                  <label className="form-label">Confidence Threshold (0.0 - 1.0)</label>
                  <input
                    type="number"
                    step={0.05}
                    min={0.1}
                    max={1.0}
                    value={(scenario.policy.params?.confidence_threshold as number) || 0.75}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, confidence_threshold: parseFloat(e.target.value) || 0.75 }
                        }
                      })
                    }}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Lookahead Depth (Tokens/Pages)</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.lookahead_depth as number) || 4}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, lookahead_depth: parseInt(e.target.value) || 1 }
                        }
                      })
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* TAB 5: REVIEW & JSON */}
      {activeTab === 'review' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Summary Breakdown Card */}
          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <div className="card-title">Scenario Summary Specification</div>
                <div className="card-subtitle">Verified against SPECS/config.schema.json</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Badge variant={validationErrors.length === 0 ? 'emerald' : 'rose'}>
                  {validationErrors.length === 0 ? 'Ready for Execution' : 'Invalid Parameters'}
                </Badge>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleSubmitSimulation}
                  disabled={isSubmitting || validationErrors.length > 0}
                  style={{
                    opacity: validationErrors.length > 0 ? 0.6 : 1,
                    cursor: validationErrors.length > 0 || isSubmitting ? 'not-allowed' : 'pointer'
                  }}
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw size={13} className="spin" />
                      <span>Submitting...</span>
                    </>
                  ) : (
                    <>
                      <Play size={13} />
                      <span>Run Simulation</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
              <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>TOPOLOGY</span>
                <p style={{ fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>
                  {scenario.nodes.filter(n => n.role === 'compute').length} Compute &bull; {scenario.nodes.filter(n => n.role === 'memory').length} Memory Pool
                </p>
                <span style={{ fontSize: '11px', color: 'var(--accent-cyan)' }}>
                  {scenario.fabric.links.length} Fabric Links
                </span>
              </div>

              <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>WORKLOAD</span>
                <p style={{ fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>
                  {scenario.workload.type === 'synthetic' ? scenario.workload.profile : 'Trace'}
                </p>
                <span style={{ fontSize: '11px', color: 'var(--accent-teal)' }}>
                  {scenario.workload.type === 'synthetic' && scenario.workload.model?.name}
                </span>
              </div>

              <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>POLICY</span>
                <p style={{ fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>
                  {scenario.policy.name}
                </p>
                <span style={{ fontSize: '11px', color: 'var(--accent-violet)' }}>
                  Deterministic PRNG (Seed {scenario.seed})
                </span>
              </div>

              <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>VIRTUAL DURATION</span>
                <p style={{ fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>
                  {(scenario.duration_ns / 1_000_000_000).toFixed(1)} s
                </p>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  Page: {((scenario.page_size_bytes || 2097152) / (1024 ** 2)).toFixed(0)} MiB
                </span>
              </div>
            </div>
          </div>

          {/* Formatted JSON Editor Preview */}
          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <div className="card-title">
                  <FileCode size={16} color="var(--accent-cyan)" />
                  <span>Config JSON Representation</span>
                </div>
                <div className="card-subtitle">Exact payload dispatched to `rmemfab run` CLI and FastAPI Run API</div>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-sm btn-outline" onClick={handleCopyJson}>
                  <Copy size={13} />
                  <span>Copy JSON</span>
                </button>
                <button className="btn btn-sm btn-outline" onClick={handleExportJson}>
                  <Download size={13} />
                  <span>Download File</span>
                </button>
              </div>
            </div>

            <pre
              className="mono"
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-card)',
                borderRadius: 'var(--radius-md)',
                padding: '16px',
                fontSize: '12px',
                lineHeight: 1.5,
                color: '#e2e8f0',
                overflowX: 'auto',
                maxHeight: '440px'
              }}
            >
              {JSON.stringify(scenario, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
