import React, { useState, useRef, useCallback } from 'react'
import type {
  ScenarioConfig,
  WorkloadProfile,
  PolicyName,
  NodeConfig,
  FabricLinkConfig,
  ProvenanceConfig,
  ProvenanceKind
} from '../../types/scenario'
import { LLAMA_70B_CXL_SCENARIO, MOE_RDMA_SCENARIO } from '../../services/mockData'
import {
  IMPLEMENTED_POLICIES,
  generateUniqueId,
  renameNodeWithLinkCascade,
  isStructurallyValidScenario
} from './scenarioBuilderUtils'
import { apiClient, type ValidateResponse } from '../../services/api'
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

interface ProvenanceEditorProps {
  label: string
  value?: ProvenanceConfig
  onChange: (updated: ProvenanceConfig | undefined) => void
}

const ProvenanceEditor: React.FC<ProvenanceEditorProps> = ({ label, value, onChange }) => {
  const handleKindChange = (kind: string) => {
    if (!kind) {
      onChange(undefined)
      return
    }
    onChange({
      kind: kind as ProvenanceKind,
      ...(value?.source ? { source: value.source } : {}),
      ...(value?.method ? { method: value.method } : {}),
      ...(value?.date ? { date: value.date } : {}),
      ...(typeof value?.uncertainty_pct === 'number' && !isNaN(value.uncertainty_pct)
        ? { uncertainty_pct: value.uncertainty_pct }
        : {})
    })
  }

  const updateField = (field: 'source' | 'method' | 'date', val: string) => {
    const trimmed = val.trim()
    const currentKind = value?.kind || 'assumed'
    const updated: ProvenanceConfig = {
      kind: currentKind,
      ...(value?.source && field !== 'source' ? { source: value.source } : {}),
      ...(value?.method && field !== 'method' ? { method: value.method } : {}),
      ...(value?.date && field !== 'date' ? { date: value.date } : {}),
      ...(typeof value?.uncertainty_pct === 'number' && !isNaN(value.uncertainty_pct)
        ? { uncertainty_pct: value.uncertainty_pct }
        : {})
    }
    if (trimmed.length > 0) {
      updated[field] = trimmed
    }
    onChange(updated)
  }

  const updateUncertainty = (valStr: string) => {
    const currentKind = value?.kind || 'assumed'
    const updated: ProvenanceConfig = {
      kind: currentKind,
      ...(value?.source ? { source: value.source } : {}),
      ...(value?.method ? { method: value.method } : {}),
      ...(value?.date ? { date: value.date } : {})
    }
    const trimmed = valStr.trim()
    if (trimmed.length > 0) {
      const num = parseFloat(trimmed)
      if (!isNaN(num) && num >= 0) {
        updated.uncertainty_pct = num
      }
    }
    onChange(updated)
  }

  return (
    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed var(--border-card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          {label}
        </span>
        {value ? (
          <Badge variant={value.kind === 'measured' ? 'emerald' : value.kind === 'sourced' ? 'cyan' : 'amber'}>
            {value.kind.toUpperCase()}
          </Badge>
        ) : (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Not configured</span>
        )}
      </div>

      <div className="form-grid-2">
        <div className="form-group" style={{ marginBottom: '6px' }}>
          <label className="form-label" style={{ fontSize: '11px' }}>Provenance Kind</label>
          <select
            value={value?.kind || ''}
            onChange={(e) => handleKindChange(e.target.value)}
            style={{ fontSize: '12px', padding: '4px 8px' }}
          >
            <option value="">None (Omit)</option>
            <option value="measured">Measured (Target Hardware)</option>
            <option value="sourced">Sourced (Datasheet / Spec / Paper)</option>
            <option value="assumed">Assumed (Exploration Baseline)</option>
          </select>
        </div>

        {value && (
          <>
            <div className="form-group" style={{ marginBottom: '6px' }}>
              <label className="form-label" style={{ fontSize: '11px' }}>Date (ISO, e.g. YYYY-MM-DD)</label>
              <input
                type="text"
                placeholder="2026-10-28"
                value={value.date || ''}
                onChange={(e) => updateField('date', e.target.value)}
                style={{ fontSize: '12px', padding: '4px 8px' }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: '6px', gridColumn: 'span 2' }}>
              <label className="form-label" style={{ fontSize: '11px' }}>Source Citation</label>
              <input
                type="text"
                placeholder="e.g. Micron DDR5-4800 Spec Sheet / AWS H100 MLC microbenchmark"
                value={value.source || ''}
                onChange={(e) => updateField('source', e.target.value)}
                style={{ fontSize: '12px', padding: '4px 8px' }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: '6px', gridColumn: 'span 2' }}>
              <label className="form-label" style={{ fontSize: '11px' }}>Methodology</label>
              <input
                type="text"
                placeholder="e.g. Memory Latency Checker v3.10 with 8 threads"
                value={value.method || ''}
                onChange={(e) => updateField('method', e.target.value)}
                style={{ fontSize: '12px', padding: '4px 8px' }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: '6px', gridColumn: 'span 2' }}>
              <label className="form-label" style={{ fontSize: '11px' }}>Uncertainty (±%)</label>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="e.g. 25"
                value={value.uncertainty_pct !== undefined ? value.uncertainty_pct : ''}
                onChange={(e) => updateUncertainty(e.target.value)}
                style={{ fontSize: '12px', padding: '4px 8px' }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
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
  const [serverValidation, setServerValidation] = useState<ValidateResponse | null>(null)
  const [validationSource, setValidationSource] = useState<'mock' | 'live' | null>(null)
  const [isValidatingServer, setIsValidatingServer] = useState<boolean>(false)

  const currentProfile = scenario.workload.type === 'synthetic' ? scenario.workload.profile : 'trace'
  const isProfileExecutable = scenario.workload.type === 'trace' || currentProfile === 'kv_cache_decode'

  const isPolicyExecutable = IMPLEMENTED_POLICIES.includes(scenario.policy.name)

  const mutateScenario = useCallback((updater: ScenarioConfig | ((prev: ScenarioConfig) => ScenarioConfig)) => {
    setScenario((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      const res = validateScenario(next)
      setValidationErrors(res.errors)
      return next
    })
  }, [])

  const updateNodeAt = (index: number, patch: Partial<NodeConfig> | ((node: NodeConfig) => NodeConfig)) => {
    mutateScenario((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n, i) => {
        if (i !== index) return n
        return typeof patch === 'function' ? patch(n) : { ...n, ...patch }
      })
    }))
  }

  const updateLinkAt = (index: number, patch: Partial<FabricLinkConfig> | ((link: FabricLinkConfig) => FabricLinkConfig)) => {
    mutateScenario((prev) => ({
      ...prev,
      fabric: {
        ...prev.fabric,
        links: prev.fabric.links.map((l, i) => {
          if (i !== index) return l
          return typeof patch === 'function' ? patch(l) : { ...l, ...patch }
        })
      }
    }))
  }

  // Server / Local Demo validation
  const handleValidateServer = async () => {
    setIsValidatingServer(true)
    const isMock = apiClient.isMockMode()
    setValidationSource(isMock ? 'mock' : 'live')
    try {
      const res = await apiClient.validateScenarioBackend(scenario)
      setServerValidation(res)
      if (res.valid) {
        onNotify(isMock ? 'Local demo schema validation passed!' : 'Authoritative server validation passed!', 'success')
      } else {
        onNotify(`${isMock ? 'Local demo' : 'Server'} validation detected ${res.errors.length} issue(s).`, 'error')
      }
    } catch (err) {
      onNotify(
        `Validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error'
      )
    } finally {
      setIsValidatingServer(false)
    }
  }
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

    const isMock = apiClient.isMockMode()
    const isValid = validateCurrent(scenario)
    if (isMock && !isValid) {
      onNotify('Cannot submit invalid scenario in Demo Mode. Please resolve all schema errors first.', 'error')
      return
    }

    if (!isProfileExecutable) {
      onNotify(
        `Cannot run simulation: workload profile '${currentProfile}' is not implemented in the engine (only 'kv_cache_decode' is executable).`,
        'error'
      )
      return
    }

    if (!isPolicyExecutable) {
      onNotify(
        `Cannot run simulation: policy '${scenario.policy.name}' is not implemented in the engine (executable policies: ${IMPLEMENTED_POLICIES.join(', ')}).`,
        'error'
      )
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
        if (res.runId) {
          onRunSubmitted?.(res.runId)
        }
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
    mutateScenario((prev) => ({ ...prev, [key]: value }))
  }

  // Add / remove nodes
  const addNode = (role: 'compute' | 'memory') => {
    const id = generateUniqueId(role === 'compute' ? 'node' : 'remote-pool', scenario.nodes.map((n) => n.id))
    const newNode: NodeConfig = role === 'compute'
      ? {
          id,
          role: 'compute',
          local_memory: {
            capacity_bytes: 549755813888, // 512 GiB
            latency_ns: 90,
            bandwidth_bytes_per_ns: 400,
            provenance: {
              kind: 'assumed',
              source: 'docs/HARDWARE-MODELS.md local DRAM preset',
              method: 'Socket-class latency and bandwidth chosen for exploration; not measured on the target node.',
              date: '2026-10-28',
              uncertainty_pct: 25
            }
          },
          compute: {
            accelerator: 'H100-80GB',
            accelerators: 8,
            accelerator_memory_bytes: 85899345920,
            provenance: {
              kind: 'assumed',
              source: 'NVIDIA H100 SXM datasheet reference',
              method: 'Typical 8x H100-80GB host accelerator topology for LLM inference; tokens_per_second intentionally omitted.',
              date: '2026-10-28',
              uncertainty_pct: 10
            }
          }
        }
      : {
          id,
          role: 'memory',
          remote_memory: {
            capacity_bytes: 4398046511104, // 4 TiB
            latency_ns: 180,
            bandwidth_bytes_per_ns: 48,
            provenance: {
              kind: 'assumed',
              source: 'docs/HARDWARE-MODELS.md CXL 2.0/3.0 preset',
              method: 'CXL.mem class latency and per-port bandwidth; not measured and not fitted to a switch topology.',
              date: '2026-10-28',
              uncertainty_pct: 30
            }
          }
        }

    mutateScenario((prev) => ({ ...prev, nodes: [...prev.nodes, newNode] }))
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

    mutateScenario((prev) => ({
      ...prev,
      nodes: updatedNodes,
      fabric: { links: updatedLinks }
    }))
    onNotify(`Removed node ${removedNode.id} and associated links`, 'info')
  }

  // Add / remove links
  const addLink = () => {
    const computeNodes = scenario.nodes.filter((n) => n.role === 'compute')
    const memoryNodes = scenario.nodes.filter((n) => n.role === 'memory')

    const from = computeNodes[0]?.id || scenario.nodes[0].id
    const to = memoryNodes[0]?.id || scenario.nodes[1]?.id || scenario.nodes[0].id
    const id = generateUniqueId('link', scenario.fabric.links.map((l) => l.id))

    const newLink: FabricLinkConfig = {
      id,
      from,
      to,
      latency_ns: 180,
      bandwidth_bytes_per_ns: 48,
      in_flight_bytes: 16777216,
      queue_depth_bytes: 67108864,
      bidirectional: true,
      provenance: {
        kind: 'assumed',
        source: 'docs/HARDWARE-MODELS.md CXL per-port preset',
        method: 'One-way latency and sustained bandwidth for a CXL.mem class link; queue depth and in-flight limits are scenario assumptions.',
        date: '2026-10-28',
        uncertainty_pct: 30
      }
    }

    mutateScenario((prev) => ({
      ...prev,
      fabric: {
        links: [...prev.fabric.links, newLink]
      }
    }))
    onNotify(`Added fabric link: ${id}`, 'info')
  }

  const removeLink = (index: number) => {
    if (scenario.fabric.links.length <= 1) {
      onNotify('Scenario requires at least one fabric link.', 'error')
      return
    }
    const updatedLinks = scenario.fabric.links.filter((_, i) => i !== index)
    mutateScenario((prev) => ({
      ...prev,
      fabric: { links: updatedLinks }
    }))
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

    mutateScenario((prev) => ({
      ...prev,
      workload: {
        ...prev.workload,
        profile,
        model: updatedModel
      }
    }))
  }

  // Policy change
  const handlePolicyChange = (name: PolicyName) => {
    let params: Record<string, unknown> = {}
    if (name === 'hot_cold') {
      params = {
        hot_threshold: 8,
        cold_threshold: 1,
        k: 2
      }
    } else if (name === 'frequency_aware') {
      params = {
        k: 2
      }
    } else if (name === 'predictive_prefetch') {
      params = {
        degree: 1,
        stride: 1,
        max_in_flight: 64,
        on_hit: true
      }
    } else if (name === 'cost_aware') {
      params = {
        cost_weight_latency: 0.6,
        cost_weight_bandwidth: 0.4
      }
    }

    mutateScenario((prev) => ({
      ...prev,
      policy: {
        name,
        params
      }
    }))
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
        if (!isStructurallyValidScenario(parsed)) {
          onNotify(
            'Import rejected: JSON does not conform to the RmemFab scenario structure (missing required nodes, fabric links, workload, or policy). Existing scenario preserved.',
            'error'
          )
          return
        }

        const validation = validateScenario(parsed)
        mutateScenario(parsed as ScenarioConfig)

        if (validation.isValid) {
          onNotify(`Successfully imported scenario: ${parsed.name || file.name}`, 'success')
        } else {
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
    mutateScenario(clone)
    onNotify(
      preset === 'llama'
        ? 'Loaded Llama-70B CXL scenario (Executable)'
        : 'Loaded MoE RDMA scenario (Draft Specification - Unimplemented in engine)',
      'info'
    )
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
            {!isProfileExecutable && (
              <Badge
                variant="amber"
                icon={<AlertTriangle size={12} />}
                title={`Workload profile '${currentProfile}' conforms to config.schema.json, but is not implemented in the engine (only kv_cache_decode is executable).`}
              >
                Engine Unimplemented (Draft)
              </Badge>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => handleReset('llama')}
              title="Load Llama-70B 4-node CXL benchmark (Executable)"
            >
              <RotateCcw size={13} />
              <span>Load Llama-70B</span>
            </button>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => handleReset('moe')}
              title="Load Mixtral MoE RDMA scenario (Draft Specification - Unimplemented in Engine)"
            >
              <RotateCcw size={13} />
              <span>Load MoE Preset</span>
              <span
                style={{
                  fontSize: '9px',
                  background: 'rgba(245, 158, 11, 0.2)',
                  color: 'var(--accent-amber)',
                  padding: '1px 5px',
                  borderRadius: '4px',
                  marginLeft: '4px',
                  fontWeight: 600
                }}
              >
                DRAFT
              </span>
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
              onClick={handleValidateServer}
              disabled={isValidatingServer}
              title={apiClient.isMockMode() ? "Run local schema validation against SPECS/config.schema.json" : "Run authoritative server validation (POST /scenarios/validate)"}
            >
              {isValidatingServer ? (
                <>
                  <RefreshCw size={13} className="spin" />
                  <span>Validating...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={13} color="var(--accent-teal)" />
                  <span>{apiClient.isMockMode() ? 'Validate (Local Demo)' : 'Validate (Server)'}</span>
                </>
              )}
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
              disabled={isSubmitting || (apiClient.isMockMode() && validationErrors.length > 0) || !isProfileExecutable}
              title={
                !isProfileExecutable
                  ? `Cannot run simulation: workload profile '${currentProfile}' is not implemented in simulator engine (only 'kv_cache_decode' is executable)`
                  : "Dispatch scenario to simulation engine"
              }
              style={{
                opacity: (apiClient.isMockMode() && validationErrors.length > 0) || !isProfileExecutable ? 0.6 : 1,
                cursor: (apiClient.isMockMode() && validationErrors.length > 0) || isSubmitting || !isProfileExecutable ? 'not-allowed' : 'pointer'
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

      {/* Server / Local Demo Validation Feedback Notice */}
      {serverValidation && (
        <div
          className="card"
          style={{
            backgroundColor: serverValidation.valid
              ? 'rgba(16, 185, 129, 0.08)'
              : 'rgba(244, 63, 94, 0.08)',
            borderColor: serverValidation.valid
              ? 'rgba(16, 185, 129, 0.3)'
              : 'rgba(244, 63, 94, 0.3)',
            padding: '16px 20px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: serverValidation.valid ? 'var(--accent-emerald)' : 'var(--accent-rose)', fontWeight: 600 }}>
                {serverValidation.valid ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                <span>
                  {validationSource === 'live'
                    ? 'Authoritative Server Validation Report (POST /scenarios/validate)'
                    : 'Local Demo Validation Report (SPECS/config.schema.json)'}
                </span>
              </div>
              <Badge variant={validationSource === 'live' ? 'teal' : 'amber'}>
                {validationSource === 'live' ? 'LIVE BACKEND' : 'DEMO MODE (OFFLINE)'}
              </Badge>
            </div>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => setServerValidation(null)}
              style={{ fontSize: '11px', padding: '2px 8px' }}
            >
              Dismiss
            </button>
          </div>

          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
            {validationSource === 'live'
              ? 'Verified directly by FastAPI backend via POST /scenarios/validate.'
              : 'This validation was performed locally against SPECS/config.schema.json. Live backend server was not contacted.'}
          </div>

          {serverValidation.errors.length > 0 && (
            <div style={{ marginBottom: '8px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-rose)' }}>Errors:</span>
              <ul style={{ paddingLeft: '20px', fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                {serverValidation.errors.map((err, idx) => (
                  <li key={idx} style={{ marginBottom: '2px' }}>
                    <span className="mono" style={{ color: 'var(--accent-rose)' }}>{err.path}</span>: {err.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {serverValidation.warnings && serverValidation.warnings.length > 0 && (
            <div style={{ marginBottom: '8px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-amber)' }}>Warnings / Engine Compatibility:</span>
              <ul style={{ paddingLeft: '20px', fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                {serverValidation.warnings.map((w, idx) => (
                  <li key={idx} style={{ marginBottom: '2px' }}>
                    <span style={{ color: w.includes('not runnable') ? 'var(--accent-rose)' : 'var(--accent-amber)', fontWeight: w.includes('not runnable') ? 600 : 400 }}>
                      {w}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {serverValidation.assumed && serverValidation.assumed.length > 0 && (
            <div>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-cyan)' }}>Engine Assumptions:</span>
              <ul style={{ paddingLeft: '20px', fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                {serverValidation.assumed.map((a, idx) => (
                  <li key={idx} style={{ marginBottom: '2px' }}>
                    <span className="mono" style={{ color: 'var(--accent-cyan)' }}>{a.path}</span>
                    {a.source ? ` (source: ${a.source})` : ''}
                    {a.uncertainty_pct != null ? ` [±${a.uncertainty_pct}%]` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

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
                          const res = renameNodeWithLinkCascade(scenario, node.id, e.target.value)
                          if (res.error) {
                            onNotify(res.error, 'error')
                          } else {
                            mutateScenario(res.updatedScenario)
                          }
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
                              const val = parseInt(e.target.value) || 0
                              updateNodeAt(index, (n) => ({
                                ...n,
                                local_memory: n.local_memory ? { ...n.local_memory, capacity_bytes: val } : undefined
                              }))
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
                              const val = parseFloat(e.target.value) || 0
                              updateNodeAt(index, (n) => ({
                                ...n,
                                local_memory: n.local_memory ? { ...n.local_memory, latency_ns: val } : undefined
                              }))
                            }}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">Local Bandwidth (Bytes/ns = GB/s)</label>
                          <input
                            type="number"
                            value={node.local_memory.bandwidth_bytes_per_ns}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 0
                              updateNodeAt(index, (n) => ({
                                ...n,
                                local_memory: n.local_memory ? { ...n.local_memory, bandwidth_bytes_per_ns: val } : undefined
                              }))
                            }}
                          />
                        </div>
                        <div style={{ gridColumn: 'span 2' }}>
                          <ProvenanceEditor
                            label="Local Memory Tier Provenance"
                            value={node.local_memory.provenance}
                            onChange={(prov) => {
                              updateNodeAt(index, (n) => {
                                if (!n.local_memory) return n
                                if (prov) {
                                  return { ...n, local_memory: { ...n.local_memory, provenance: prov } }
                                }
                                const restMem = { ...n.local_memory }
                                delete restMem.provenance
                                return { ...n, local_memory: restMem }
                              })
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
                              const val = parseInt(e.target.value) || 0
                              updateNodeAt(index, (n) => ({
                                ...n,
                                remote_memory: n.remote_memory ? { ...n.remote_memory, capacity_bytes: val } : undefined
                              }))
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
                              const val = parseFloat(e.target.value) || 0
                              updateNodeAt(index, (n) => ({
                                ...n,
                                remote_memory: n.remote_memory ? { ...n.remote_memory, latency_ns: val } : undefined
                              }))
                            }}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">Remote Bandwidth (Bytes/ns)</label>
                          <input
                            type="number"
                            value={node.remote_memory.bandwidth_bytes_per_ns}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 0
                              updateNodeAt(index, (n) => ({
                                ...n,
                                remote_memory: n.remote_memory ? { ...n.remote_memory, bandwidth_bytes_per_ns: val } : undefined
                              }))
                            }}
                          />
                        </div>
                        <div style={{ gridColumn: 'span 2' }}>
                          <ProvenanceEditor
                            label="Remote Pool Memory Tier Provenance"
                            value={node.remote_memory.provenance}
                            onChange={(prov) => {
                              updateNodeAt(index, (n) => {
                                if (!n.remote_memory) return n
                                if (prov) {
                                  return { ...n, remote_memory: { ...n.remote_memory, provenance: prov } }
                                }
                                const restMem = { ...n.remote_memory }
                                delete restMem.provenance
                                return { ...n, remote_memory: restMem }
                              })
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
                          updateLinkAt(index, { id: e.target.value })
                        }}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">From Node</label>
                      <select
                        value={link.from}
                        onChange={(e) => {
                          updateLinkAt(index, { from: e.target.value })
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
                          updateLinkAt(index, { to: e.target.value })
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
                          updateLinkAt(index, { latency_ns: parseFloat(e.target.value) || 0 })
                        }}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Link Bandwidth (GB/s = Bytes/ns)</label>
                      <input
                        type="number"
                        value={link.bandwidth_bytes_per_ns}
                        onChange={(e) => {
                          updateLinkAt(index, { bandwidth_bytes_per_ns: parseFloat(e.target.value) || 0 })
                        }}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Queue Depth (Bytes)</label>
                      <input
                        type="number"
                        value={link.queue_depth_bytes || 67108864}
                        onChange={(e) => {
                          updateLinkAt(index, { queue_depth_bytes: parseInt(e.target.value) || 0 })
                        }}
                      />
                      <span className="form-hint">
                        {((link.queue_depth_bytes || 0) / (1024 ** 2)).toFixed(1)} MiB FIFO buffer
                      </span>
                    </div>
                    <div style={{ gridColumn: 'span 2' }}>
                      <ProvenanceEditor
                        label="Fabric Interconnect Link Provenance"
                        value={link.provenance}
                        onChange={(prov) => {
                          updateLinkAt(index, (l) => {
                            if (prov) {
                              return { ...l, provenance: prov }
                            }
                            const restLink = { ...l }
                            delete restLink.provenance
                            return restLink
                          })
                        }}
                      />
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
                  <option value="kv_cache_decode">kv_cache_decode (Executable — LLM Autoregressive Token Generation)</option>
                  <option value="prefill">prefill (Planned — Prompt Processing Sequential Scans)</option>
                  <option value="sparse_attention">sparse_attention (Planned — Long-Context Strided & Global Tokens)</option>
                  <option value="moe">moe (Draft Specification — Mixture-of-Experts Skewed Routing)</option>
                  <option value="mixed">mixed (Planned — Multi-Tenant Serving Interference)</option>
                </select>
                <span className="form-help">
                  Normalized memory event source for the discrete-event scheduler
                </span>
                {!isProfileExecutable && (
                  <div
                    style={{
                      marginTop: '8px',
                      padding: '10px 14px',
                      background: 'rgba(245, 158, 11, 0.08)',
                      border: '1px solid rgba(245, 158, 11, 0.3)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '12px',
                      color: 'var(--text-secondary)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--accent-amber)', fontWeight: 600, marginBottom: '2px' }}>
                      <AlertTriangle size={14} />
                      <span>Engine Implementation Status</span>
                    </div>
                    Workload profile <code>&apos;{scenario.workload.profile}&apos;</code> conforms to <code>SPECS/config.schema.json</code>, but the simulator engine currently only executes <code>kv_cache_decode</code>. This scenario can be edited, schema-validated, and exported, but will be refused by the engine if submitted for simulation.
                  </div>
                )}
              </div>

              {/* Model Specifications */}
              <div className="form-group">
                <label className="form-label">Model Identifier</label>
                <input
                  type="text"
                  value={scenario.workload.model?.name || ''}
                  onChange={(e) => {
                    if (scenario.workload.type === 'synthetic') {
                      const val = e.target.value
                      mutateScenario((prev) => {
                        if (prev.workload.type !== 'synthetic') return prev
                        return {
                          ...prev,
                          workload: {
                            ...prev.workload,
                            model: { ...prev.workload.model, name: val }
                          }
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
                      const val = parseInt(e.target.value) || 1
                      mutateScenario((prev) => {
                        if (prev.workload.type !== 'synthetic') return prev
                        return {
                          ...prev,
                          workload: {
                            ...prev.workload,
                            model: { ...prev.workload.model, layers: val }
                          }
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
                      const val = parseInt(e.target.value) || 1
                      mutateScenario((prev) => {
                        if (prev.workload.type !== 'synthetic') return prev
                        return {
                          ...prev,
                          workload: {
                            ...prev.workload,
                            model: { ...prev.workload.model, kv_heads: val }
                          }
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
                      const val = parseInt(e.target.value) || 1
                      mutateScenario((prev) => {
                        if (prev.workload.type !== 'synthetic') return prev
                        return {
                          ...prev,
                          workload: {
                            ...prev.workload,
                            model: { ...prev.workload.model, head_dim: val }
                          }
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
                          const val = parseInt(e.target.value) || 1
                          mutateScenario((prev) => {
                            if (prev.workload.type !== 'synthetic') return prev
                            return {
                              ...prev,
                              workload: {
                                ...prev.workload,
                                model: { ...prev.workload.model, experts: val }
                              }
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
                          const val = parseInt(e.target.value) || 1
                          mutateScenario((prev) => {
                            if (prev.workload.type !== 'synthetic') return prev
                            return {
                              ...prev,
                              workload: {
                                ...prev.workload,
                                model: { ...prev.workload.model, top_k: val }
                              }
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
                      const val = parseFloat(e.target.value) || 1
                      mutateScenario((prev) => {
                        if (prev.workload.type !== 'synthetic') return prev
                        return {
                          ...prev,
                          workload: {
                            ...prev.workload,
                            requests: { ...prev.workload.requests, arrival_rate_per_second: val }
                          }
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
                      const val = parseInt(e.target.value) || 1
                      mutateScenario((prev) => {
                        if (prev.workload.type !== 'synthetic') return prev
                        return {
                          ...prev,
                          workload: {
                            ...prev.workload,
                            requests: { ...prev.workload.requests, concurrency: val }
                          }
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
                <option value="hot_cold">hot_cold (Lifetime Frequency Thresholds with LRU-K)</option>
                <option value="frequency_aware">frequency_aware (LRU-K Eviction)</option>
                <option value="swap_remote">swap_remote (Demand Paging Baseline)</option>
                <option value="local_only">local_only (Local DRAM Only Baseline - No Remote Fabric)</option>
                <option value="predictive_prefetch">predictive_prefetch (Lookahead Speculative Prefetch)</option>
                {!IMPLEMENTED_POLICIES.includes(scenario.policy.name) && (
                  <option value={scenario.policy.name}>
                    {scenario.policy.name} (Not implemented in v0.1 engine)
                  </option>
                )}
                {scenario.policy.name !== 'cost_aware' && (
                  <option value="cost_aware" disabled>
                    cost_aware (Multi-Objective Optimization — Not Implemented in v0.1 Engine)
                  </option>
                )}
              </select>
            </div>

            {!isPolicyExecutable && (
              <div
                style={{
                  gridColumn: 'span 2',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                  fontSize: '12px',
                  color: 'var(--accent-amber)'
                }}
              >
                Policy <strong>{scenario.policy.name}</strong> is preserved from configuration but is not implemented in the v0.1 simulation engine. The backend will fall back to swap_remote or reject execution upon submission.
              </div>
            )}

            {/* Dynamic Policy Parameters */}
            {scenario.policy.name === 'hot_cold' && (
              <>
                <div className="form-group">
                  <label className="form-label">Hot Threshold (Hits / Window)</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.hot_threshold as number) || 8}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 0
                      mutateScenario((prev) => ({
                        ...prev,
                        policy: {
                          ...prev.policy,
                          params: { ...prev.policy.params, hot_threshold: val }
                        }
                      }))
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
                      const val = parseInt(e.target.value) || 0
                      mutateScenario((prev) => ({
                        ...prev,
                        policy: {
                          ...prev.policy,
                          params: { ...prev.policy.params, cold_threshold: val }
                        }
                      }))
                    }}
                  />
                  <span className="form-help">Demotes local page to remote memory</span>
                </div>

                <div className="form-group">
                  <label className="form-label">K (LRU-K Recency)</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.k as number) || 2}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 1
                      mutateScenario((prev) => ({
                        ...prev,
                        policy: {
                          ...prev.policy,
                          params: { ...prev.policy.params, k: val }
                        }
                      }))
                    }}
                  />
                  <span className="form-help">LRU-K recency parameter to break ties inside bands</span>
                </div>
              </>
            )}

            {scenario.policy.name === 'frequency_aware' && (
              <>
                <div className="form-group">
                  <label className="form-label">K (Reference Distance)</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.k as number) || 2}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 1
                      mutateScenario((prev) => ({
                        ...prev,
                        policy: {
                          ...prev.policy,
                          params: { ...prev.policy.params, k: val }
                        }
                      }))
                    }}
                  />
                  <span className="form-help">LRU-K reference distance: victims ordered by K-th-last-touch</span>
                </div>
              </>
            )}

            {scenario.policy.name === 'predictive_prefetch' && (
              <>
                <div className="form-group">
                  <label className="form-label">Prefetch Degree</label>
                  <input
                    type="number"
                    min={1}
                    value={(scenario.policy.params?.degree as number) || 1}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 1
                      mutateScenario((prev) => ({
                        ...prev,
                        policy: {
                          ...prev.policy,
                          params: { ...prev.policy.params, degree: val }
                        }
                      }))
                    }}
                  />
                  <span className="form-help">Number of sequential pages to prefetch</span>
                </div>

                <div className="form-group">
                  <label className="form-label">Stride</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.stride as number) || 1}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 1
                      mutateScenario((prev) => ({
                        ...prev,
                        policy: {
                          ...prev.policy,
                          params: { ...prev.policy.params, stride: val }
                        }
                      }))
                    }}
                  />
                  <span className="form-help">Address stride step for prefetching</span>
                </div>

                <div className="form-group">
                  <label className="form-label">Max In-Flight</label>
                  <input
                    type="number"
                    min={1}
                    value={(scenario.policy.params?.max_in_flight as number) || 64}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 1
                      mutateScenario((prev) => ({
                        ...prev,
                        policy: {
                          ...prev.policy,
                          params: { ...prev.policy.params, max_in_flight: val }
                        }
                      }))
                    }}
                  />
                  <span className="form-help">Maximum concurrent prefetches permitted</span>
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
