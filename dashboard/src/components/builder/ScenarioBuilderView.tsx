import React, { useState, useRef } from 'react'
import type {
  ScenarioConfig,
  WorkloadProfile,
  PolicyName,
  NodeConfig,
  FabricLinkConfig,
  ProvenanceConfig,
  ProvenanceKind
} from '../../types/scenario'
import { MUSE_GLIMMER_CXL_SCENARIO } from '../../services/mockData'
import { apiClient, apiErrorMessage, type ValidateResponse } from '../../services/api'
import type { DraftResponse } from '../../types/telemetry'
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
  RefreshCw,
  Sparkles,
  MessageSquareText
} from 'lucide-react'

interface ScenarioBuilderViewProps {
  onNotify: (text: string, type: 'success' | 'error' | 'info') => void
  onScenarioSaved?: (scenario: ScenarioConfig) => void
  onRunSubmitted?: (runId: string) => void
  traceWorkloadSeed?: { path: string; nonce: number } | null
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
      ...(value?.date ? { date: value.date } : {})
    })
  }

  const updateField = (field: 'source' | 'method' | 'date', val: string) => {
    const trimmed = val.trim()
    const currentKind = value?.kind || 'assumed'
    const updated: ProvenanceConfig = {
      kind: currentKind,
      ...(value?.source && field !== 'source' ? { source: value.source } : {}),
      ...(value?.method && field !== 'method' ? { method: value.method } : {}),
      ...(value?.date && field !== 'date' ? { date: value.date } : {})
    }
    if (trimmed.length > 0) {
      updated[field] = trimmed
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
          </>
        )}
      </div>
    </div>
  )
}

type BuilderTab = 'general' | 'infrastructure' | 'workload' | 'policy' | 'review' | 'describe'

export const ScenarioBuilderView: React.FC<ScenarioBuilderViewProps> = ({
  onNotify,
  onScenarioSaved,
  onRunSubmitted,
  traceWorkloadSeed
}) => {
  const [activeTab, setActiveTab] = useState<BuilderTab>('general')
  const [scenario, setScenario] = useState<ScenarioConfig>(() =>
    JSON.parse(JSON.stringify(MUSE_GLIMMER_CXL_SCENARIO))
  )
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([])
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [serverValidation, setServerValidation] = useState<ValidateResponse | null>(null)
  const [validationSource, setValidationSource] = useState<'mock' | 'live' | null>(null)
  const [isValidatingServer, setIsValidatingServer] = useState<boolean>(false)
  const [draftPrompt, setDraftPrompt] = useState<string>('')
  const [isDrafting, setIsDrafting] = useState<boolean>(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [draftResult, setDraftResult] = useState<DraftResponse | null>(null)

  const handleDraft = async () => {
    const prompt = draftPrompt.trim()
    if (!prompt || isDrafting) return
    setIsDrafting(true)
    setDraftError(null)
    setDraftResult(null)
    try {
      const res = await apiClient.draftScenario(prompt)
      setDraftResult(res)
      setScenario(JSON.parse(JSON.stringify(res.scenario)))
      validateCurrent(res.scenario)
      setActiveTab('review')
      onNotify(`Draft loaded as version ${res.version} — review before running`, 'success')
    } catch (err) {
      const msg = apiErrorMessage(err)
      setDraftError(msg)
      onNotify(`Draft failed: ${msg}`, 'error')
    } finally {
      setIsDrafting(false)
    }
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

  // Trace Library handoff: one-shot sync of the replayed trace path into the
  // workload tab. Render-time adjustment (React-endorsed for prop-derived
  // state); the nonce guard makes it fire exactly once per handoff.
  const [appliedTraceSeed, setAppliedTraceSeed] = useState<number | undefined>(undefined)
  if (traceWorkloadSeed && traceWorkloadSeed.nonce !== appliedTraceSeed) {
    setAppliedTraceSeed(traceWorkloadSeed.nonce)
    const seeded = {
      ...scenario,
      workload: { type: 'trace', path: traceWorkloadSeed.path } as ScenarioConfig['workload']
    }
    setScenario(seeded)
    setActiveTab('workload')
    validateCurrent(seeded)
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

  // Workload profile change (kv_cache_decode is the only implemented profile)
  const handleProfileChange = (profile: WorkloadProfile) => {
    if (scenario.workload.type !== 'synthetic') return

    const updated: ScenarioConfig = {
      ...scenario,
      workload: {
        ...scenario.workload,
        profile
      }
    }
    setScenario(updated)
    validateCurrent(updated)
  }

  // Policy change (defaults mirror the backend KNOWN_PARAMS; unknown keys
  // are ignored server-side, so only real knobs are emitted here)
  const handlePolicyChange = (name: PolicyName) => {
    let params: Record<string, unknown> = {}
    if (name === 'hot_cold') {
      params = {
        k: 2,
        hot_threshold: 3,
        cold_threshold: 1
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
  const handleReset = () => {
    const clone = JSON.parse(JSON.stringify(MUSE_GLIMMER_CXL_SCENARIO))
    setScenario(clone)
    validateCurrent(clone)
    onNotify('Reset editor to Muse-Glimmer CXL scenario', 'info')
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
              onClick={() => handleReset()}
              title="Load Muse-Glimmer 4-node CXL benchmark"
            >
              <RotateCcw size={13} />
              <span>Load Muse Glimmer</span>
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
              disabled={isSubmitting || (apiClient.isMockMode() && validationErrors.length > 0)}
              title="Dispatch scenario to simulation engine"
              style={{
                opacity: (apiClient.isMockMode() && validationErrors.length > 0) ? 0.6 : 1,
                cursor: (apiClient.isMockMode() && validationErrors.length > 0) || isSubmitting ? 'not-allowed' : 'pointer'
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
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-amber)' }}>Warnings:</span>
              <ul style={{ paddingLeft: '20px', fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                {serverValidation.warnings.map((w, idx) => (
                  <li key={idx} style={{ marginBottom: '2px' }}>
                    <span style={{ color: 'var(--accent-amber)' }}>{w}</span>
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
          { id: 'describe' as BuilderTab, label: '0. Describe', icon: <Sparkles size={14} /> },
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
      {activeTab === 'describe' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-title">
                <MessageSquareText size={15} style={{ marginRight: '8px', verticalAlign: '-2px' }} />
                Describe Your Experiment
              </div>
              <div className="card-subtitle">
                Plain language in, validated scenario out. The draft loads into this
                editor for review — nothing runs until you submit it.
              </div>
            </div>
          </div>

          {apiClient.isMockMode() ? (
            <div style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
              <Sparkles size={28} color="var(--text-muted)" />
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '10px' }}>
                Drafting needs a live backend
              </div>
              <div style={{ fontSize: '12px', marginTop: '6px' }}>
                Switch to Live mode in Settings to generate scenarios from text.
              </div>
            </div>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="draft-prompt">
                  What should the simulation model?
                </label>
                <textarea
                  id="draft-prompt"
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                  placeholder="e.g. 4 nodes with local DRAM and a shared 200 Gbps RDMA pool running KV-cache decode; compare swap_remote and hot_cold"
                  rows={5}
                  disabled={isDrafting}
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </div>
              {draftError && (
                <div role="alert" style={{ fontSize: '12.5px', color: 'var(--accent-rose)', marginBottom: '10px' }}>
                  {draftError}
                </div>
              )}
              {draftResult && (
                <div className="mono" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                  Model {draftResult.model} · version {draftResult.version}
                  {draftResult.validation.warnings.length > 0 && (
                    <> · Warnings: {draftResult.validation.warnings.join('; ')}</>
                  )}
                  {draftResult.validation.assumed.length > 0 && (
                    <> · Assumed: {draftResult.validation.assumed.length} parameters (see Review tab)</>
                  )}
                </div>
              )}
              <button
                className="btn btn-sm btn-primary"
                onClick={() => void handleDraft()}
                disabled={isDrafting || draftPrompt.trim().length === 0}
              >
                <Sparkles size={13} />
                <span>{isDrafting ? 'Drafting…' : 'Generate scenario'}</span>
              </button>
            </>
          )}
        </div>
      )}

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
                placeholder="e.g. muse-glimmer-cxl"
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
                        <div style={{ gridColumn: 'span 2' }}>
                          <ProvenanceEditor
                            label="Local Memory Tier Provenance"
                            value={node.local_memory.provenance}
                            onChange={(prov) => {
                              const updated = [...scenario.nodes]
                              if (updated[index].local_memory) {
                                if (prov) {
                                  updated[index].local_memory.provenance = prov
                                } else {
                                  delete updated[index].local_memory.provenance
                                }
                                setScenario({ ...scenario, nodes: updated })
                                validateCurrent({ ...scenario, nodes: updated })
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
                        <div style={{ gridColumn: 'span 2' }}>
                          <ProvenanceEditor
                            label="Remote Pool Memory Tier Provenance"
                            value={node.remote_memory.provenance}
                            onChange={(prov) => {
                              const updated = [...scenario.nodes]
                              if (updated[index].remote_memory) {
                                if (prov) {
                                  updated[index].remote_memory.provenance = prov
                                } else {
                                  delete updated[index].remote_memory.provenance
                                }
                                setScenario({ ...scenario, nodes: updated })
                                validateCurrent({ ...scenario, nodes: updated })
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
                    <div style={{ gridColumn: 'span 2' }}>
                      <ProvenanceEditor
                        label="Fabric Interconnect Link Provenance"
                        value={link.provenance}
                        onChange={(prov) => {
                          const updated = [...scenario.fabric.links]
                          if (prov) {
                            updated[index].provenance = prov
                          } else {
                            delete updated[index].provenance
                          }
                          setScenario({ ...scenario, fabric: { links: updated } })
                          validateCurrent({ ...scenario, fabric: { links: updated } })
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

          <div className="form-grid-2" style={{ marginBottom: '12px' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="workload-type">Workload source</label>
              <select
                id="workload-type"
                value={scenario.workload.type}
                onChange={(e) => {
                  const type = e.target.value as 'synthetic' | 'trace'
                  const prevSynth = scenario.workload.type === 'synthetic' ? scenario.workload : null
                  const updated: ScenarioConfig = type === 'trace'
                    ? { ...scenario, workload: { type: 'trace', path: '' } }
                    : {
                        ...scenario,
                        workload: {
                          type: 'synthetic',
                          profile: 'kv_cache_decode',
                          model: prevSynth?.model
                            ?? { layers: 32, attention_heads: 32, kv_heads: 8, head_dim: 128, dtype_bytes: 2 },
                          requests: prevSynth?.requests
                        }
                      }
                  setScenario(updated)
                  validateCurrent(updated)
                }}
              >
                <option value="synthetic">synthetic (KV generator)</option>
                <option value="trace">trace (replay a file)</option>
              </select>
            </div>
            {scenario.workload.type === 'trace' && (
              <div className="form-group">
                <label className="form-label" htmlFor="workload-path">Trace path (server-side)</label>
                <input
                  id="workload-path"
                  type="text"
                  value={scenario.workload.path || ''}
                  onChange={(e) => {
                    const updated: ScenarioConfig = {
                      ...scenario,
                      workload: { type: 'trace', path: e.target.value }
                    }
                    setScenario(updated)
                    validateCurrent(updated)
                  }}
                  placeholder="traces/uploads/&lt;trace_id&gt;.jsonl — see Trace Library"
                  autoComplete="off"
                  className="mono"
                />
              </div>
            )}
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
                  placeholder="e.g. meta-models/Muse-Glimmer-30B"
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
              </select>
            </div>

            {/* Dynamic Policy Parameters */}
            {scenario.policy.name === 'hot_cold' && (
              <>
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

                <div className="form-group">
                  <label className="form-label">Hot Threshold (Hits / Window)</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.hot_threshold as number) || 3}
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
                  <label className="form-label">Degree (Pages Per Trigger)</label>
                  <input
                    type="number"
                    min={1}
                    value={(scenario.policy.params?.degree as number) || 1}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, degree: parseInt(e.target.value) || 1 }
                        }
                      })
                    }}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Stride (Pages)</label>
                  <input
                    type="number"
                    value={(scenario.policy.params?.stride as number) || 1}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, stride: parseInt(e.target.value) || 1 }
                        }
                      })
                    }}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Max In-Flight Prefetches</label>
                  <input
                    type="number"
                    min={1}
                    value={(scenario.policy.params?.max_in_flight as number) || 64}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, max_in_flight: parseInt(e.target.value) || 1 }
                        }
                      })
                    }}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Issue On Hit</label>
                  <input
                    type="checkbox"
                    checked={(scenario.policy.params?.on_hit as boolean) ?? true}
                    onChange={(e) => {
                      setScenario({
                        ...scenario,
                        policy: {
                          ...scenario.policy,
                          params: { ...scenario.policy.params, on_hit: e.target.checked }
                        }
                      })
                    }}
                  />
                  <span className="form-help">Prefetch on cache hits as well as misses</span>
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
