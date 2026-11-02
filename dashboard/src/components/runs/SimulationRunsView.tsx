import React, { useEffect, useRef, useState } from 'react'
import type { ApplyResponse, PatchOp, SimulationRun } from '../../types/telemetry'
import { apiClient, apiErrorMessage } from '../../services/api'
import { Badge } from '../common/Badge'
import { Modal } from '../common/Modal'
import {
  formatNanoseconds,
  formatBytes,
  formatPercent
} from '../../utils/formatters'
import {
  Search,
  Filter,
  Activity,
  ArrowUpDown,
  ExternalLink,
  GitCompare,
  AlertCircle,
  Radio,
  FlaskConical
} from 'lucide-react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts'

interface SimulationRunsViewProps {
  runs: SimulationRun[]
  onOpenRunDetails: (run: SimulationRun) => void
  onSelectForComparison: (runId: string) => void
  selectedComparisonIds: string[]
  isMockMode?: boolean
}

export const SimulationRunsView: React.FC<SimulationRunsViewProps> = ({
  runs,
  onOpenRunDetails,
  onSelectForComparison,
  selectedComparisonIds,
  isMockMode = true
}) => {
  const [searchQuery, setSearchQuery] = useState('')
  const [policyFilter, setPolicyFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<'latency' | 'time' | 'scenario'>('time')
  const [sortAsc, setSortAsc] = useState<boolean>(false)

  // Filter runs
  const filteredRuns = runs.filter((run) => {
    const scenarioName = run.scenario_name || run.id
    const matchesSearch =
      scenarioName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      run.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (run.workload_profile || '').toLowerCase().includes(searchQuery.toLowerCase())

    const matchesPolicy = policyFilter === 'all' || run.policy_name === policyFilter
    const matchesStatus = statusFilter === 'all' || run.status === statusFilter

    return matchesSearch && matchesPolicy && matchesStatus
  })

  // Sort runs
  filteredRuns.sort((a, b) => {
    const diff = sortField === 'latency'
      ? (a.metrics.latency_ns.p50 ?? 0) - (b.metrics.latency_ns.p50 ?? 0)
      : sortField === 'scenario'
      ? (a.scenario_name || a.id).localeCompare(b.scenario_name || b.id)
      : b.id.localeCompare(a.id)
    return sortAsc ? diff : -diff
  })

  return (
    <div className="app-content">
      {/* Notice Banner */}
      <div
        className="card"
        style={{
          background: isMockMode
            ? 'linear-gradient(90deg, rgba(245, 158, 11, 0.08) 0%, var(--bg-card) 100%)'
            : 'linear-gradient(90deg, rgba(16, 185, 129, 0.08) 0%, var(--bg-card) 100%)',
          borderColor: isMockMode ? 'rgba(245, 158, 11, 0.25)' : 'rgba(16, 185, 129, 0.25)',
          padding: '14px 20px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={16} color={isMockMode ? 'var(--accent-amber)' : 'var(--accent-emerald)'} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
              {isMockMode
                ? 'Deterministic Discrete-Event Telemetry (Standalone Demo Mode)'
                : 'FastAPI Live Telemetry Stream'}
            </span>
            <Badge variant={isMockMode ? 'amber' : 'emerald'}>
              {isMockMode ? 'Demo Dataset' : 'Live Data'}
            </Badge>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {isMockMode
              ? 'Telemetry produced by deterministic mock provider. Switch to Live mode in Settings to connect to FastAPI.'
              : 'Live telemetry queried directly from active FastAPI backend.'}
          </span>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: '260px' }}>
            <div style={{ position: 'relative', width: '100%', maxWidth: '340px' }}>
              <Search
                size={14}
                style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
              />
              <input
                type="text"
                placeholder="Search scenario, ID, workload..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ paddingLeft: '32px', width: '100%' }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Filter size={14} color="var(--text-muted)" />
              <select value={policyFilter} onChange={(e) => setPolicyFilter(e.target.value)}>
                <option value="all">All Policies</option>
                <option value="hot_cold">hot_cold</option>
                <option value="swap_remote">swap_remote</option>
                <option value="local_only">local_only</option>
                <option value="frequency_aware">frequency_aware</option>
                <option value="predictive_prefetch">predictive_prefetch</option>
              </select>

              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All Statuses</option>
                <option value="completed">Completed</option>
                <option value="running">Running</option>
                <option value="failed">Failed</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Sort by:</span>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                if (sortField === 'latency') setSortAsc(!sortAsc)
                else { setSortField('latency'); setSortAsc(true); }
              }}
            >
              <span>Median Latency</span>
              <ArrowUpDown size={12} />
            </button>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                if (sortField === 'time') setSortAsc(!sortAsc)
                else { setSortField('time'); setSortAsc(false); }
              }}
            >
              <span>Recent</span>
              <ArrowUpDown size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Runs Table */}
      <div className="card">
        <div className="card-header">
          <div className="card-title-group">
            <div className="card-title">
              <Activity size={16} color="var(--accent-cyan)" />
              <span>Simulation Run History</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>
                ({filteredRuns.length} of {runs.length} runs matched)
              </span>
            </div>
            <div className="card-subtitle">
              Select multiple runs to benchmark in Policy Comparison
            </div>
          </div>
        </div>

        <div className="table-responsive">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}>Compare</th>
                <th>Scenario / Run ID</th>
                <th>Workload</th>
                <th>Policy</th>
                <th>Seed</th>
                <th>Virtual Duration</th>
                <th>p50 Latency</th>
                <th>p99 Latency</th>
                <th>Remote Hit %</th>
                <th>Fabric Util</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuns.length === 0 ? (
                <tr>
                  <td colSpan={12} style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
                    No simulation runs match the selected filters.
                  </td>
                </tr>
              ) : (
                filteredRuns.map((run) => {
                  const isSelected = selectedComparisonIds.includes(run.id)
                  return (
                    <tr
                      key={run.id}
                      style={{
                        cursor: 'pointer',
                        backgroundColor: isSelected ? 'rgba(6, 182, 212, 0.05)' : undefined
                      }}
                      onClick={() => onOpenRunDetails(run)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onSelectForComparison(run.id)}
                          style={{ cursor: 'pointer' }}
                          title="Select for Policy Comparison"
                        />
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                              {run.scenario_name || run.id}
                            </span>
                            {(isMockMode || run.id.startsWith('demo-') || run.policy_display_name.startsWith('[Demo]')) && (
                              <Badge variant="amber">Demo</Badge>
                            )}
                          </div>
                          <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            {run.id}
                          </span>
                        </div>
                      </td>
                      <td>
                        <Badge variant="blue">{run.workload_profile}</Badge>
                      </td>
                      <td>
                        <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                          {run.policy_name}
                        </span>
                      </td>
                      <td className="mono">{run.seed ?? '—'}</td>
                      <td className="tabular-nums">
                        {run.duration_ns != null ? `${(run.duration_ns / 1_000_000_000).toFixed(0)}s` : '—'}
                      </td>
                      <td className="tabular-nums" style={{ fontWeight: 600, color: 'var(--accent-cyan)' }}>
                        {formatNanoseconds(run.metrics.latency_ns.p50)}
                      </td>
                      <td
                        className="tabular-nums"
                        style={{
                          color: (run.metrics.latency_ns.p99 ?? 0) > 1000 ? 'var(--accent-rose)' : 'var(--text-secondary)'
                        }}
                      >
                        {formatNanoseconds(run.metrics.latency_ns.p99)}
                      </td>
                      <td className="tabular-nums">
                        {formatPercent(run.metrics.remote_hit_ratio)}
                      </td>
                      <td className="tabular-nums">
                        {formatPercent(run.metrics.fabric_utilization)}
                      </td>
                      <td>
                        <Badge variant={run.status === 'completed' ? 'emerald' : run.status === 'failed' ? 'rose' : 'amber'}>
                          {run.status}
                        </Badge>
                      </td>
                      <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                          <button
                            className="btn btn-sm btn-outline"
                            onClick={() => onSelectForComparison(run.id)}
                            title="Toggle comparison selection"
                          >
                            <GitCompare size={12} />
                            <span>{isSelected ? 'Deselect' : 'Compare'}</span>
                          </button>
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => onOpenRunDetails(run)}
                            title="Open detailed run telemetry"
                          >
                            <ExternalLink size={12} />
                            <span>Inspect</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/**
 * Run Detail Inspector Modal Content
 */
interface RunDetailInspectorProps {
  run: SimulationRun
  onSelectForComparison: (runId: string) => void
  isSelectedForComparison: boolean
  onNotify?: (text: string, type: 'success' | 'error' | 'info') => void
  onRunCreated?: (runId: string) => void
}

function formatNsShort(ns: number): string {
  if (ns < 1000) return `${ns} ns`
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(1)} µs`
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)} ms`
  return `${(ns / 1_000_000_000).toFixed(2)} s`
}

const StreamModal: React.FC<{ runId: string; onClose: () => void }> = ({ runId, onClose }) => {
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([])
  const [streamError, setStreamError] = useState<string | null>(null)
  const [isDone, setIsDone] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = apiClient.openRunStream(
      runId,
      (ev) => setEvents((prev) => [...prev.slice(-199), ev]),
      (err) => {
        // A clean replay ends with [DONE] (close without error text surfaced).
        if (err.message !== 'Stream connection closed' || events.length === 0) {
          setStreamError(err.message)
        }
        setIsDone(true)
      }
    )
    return close
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [events.length])

  return (
    <Modal isOpen onClose={onClose} title="Virtual-time event stream" maxWidth="760px">
      <div className="mono" style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '10px' }}>
        Replaying stored telemetry over virtual time — playback, not live execution.
        {isDone && ' Stream ended.'}
      </div>
      {streamError && (
        <div role="alert" style={{ fontSize: '12.5px', color: 'var(--accent-rose)', marginBottom: '10px' }}>
          {streamError}
        </div>
      )}
      <div
        className="mono"
        style={{
          maxHeight: '380px', overflowY: 'auto', fontSize: '11.5px',
          background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', padding: '10px 12px'
        }}
      >
        {events.length === 0 && !streamError && <div>Waiting for events…</div>}
        {events.map((ev, i) => (
          <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: 'var(--accent-cyan)' }}>
              {typeof ev.time_ns === 'number' ? formatNsShort(ev.time_ns) : '?'}
            </span>
            {' '}{String(ev.event ?? 'event')}
            {typeof ev.node === 'string' && ev.node ? ` @${ev.node}` : ''}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </Modal>
  )
}

const WhatIfModal: React.FC<{
  run: SimulationRun
  onClose: () => void
  onNotify?: (text: string, type: 'success' | 'error' | 'info') => void
  onRunCreated?: (runId: string) => void
}> = ({ run, onClose, onNotify, onRunCreated }) => {
  const links = run.scenario_snapshot?.fabric?.links ?? []
  const [linkId, setLinkId] = useState<string>(links[0]?.id ?? '')
  const [bandwidth, setBandwidth] = useState<string>(
    links[0]?.bandwidth_bytes_per_ns !== undefined ? String(links[0].bandwidth_bytes_per_ns) : ''
  )
  const [note, setNote] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ApplyResponse | null>(null)

  const handleRun = async () => {
    const idx = links.findIndex((l) => l.id === linkId)
    const value = Number(bandwidth)
    if (idx < 0 || !Number.isFinite(value) || value <= 0) {
      setError('Pick a link and a positive bandwidth (bytes/ns)')
      return
    }
    setIsRunning(true)
    setError(null)
    setResult(null)
    const patch: PatchOp[] = [{
      op: 'replace', path: `/fabric/links/${idx}/bandwidth_bytes_per_ns`, value
    }]
    try {
      const res = await apiClient.applyChange({
        parent_run_id: run.id, patch, note: note.trim() || undefined
      })
      setResult(res)
      onNotify?.(`What-if run ${res.run_id.slice(0, 12)} (${res.status})`, res.status === 'completed' ? 'success' : 'error')
      onRunCreated?.(res.run_id)
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="What-if: change link bandwidth" maxWidth="560px">
      {links.length === 0 ? (
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '12px 0' }}>
          No link data on this run — what-if needs the saved scenario (live runs only).
        </div>
      ) : (
        <>
          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label" htmlFor="whatif-link">Link</label>
              <select
                id="whatif-link"
                value={linkId}
                onChange={(e) => {
                  setLinkId(e.target.value)
                  const l = links.find((x) => x.id === e.target.value)
                  if (l?.bandwidth_bytes_per_ns !== undefined) setBandwidth(String(l.bandwidth_bytes_per_ns))
                }}
                disabled={isRunning}
              >
                {links.map((l) => (
                  <option key={l.id} value={l.id}>{l.id}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="whatif-bw">Bandwidth (bytes/ns)</label>
              <input
                id="whatif-bw"
                type="number"
                min={0.001}
                step="any"
                value={bandwidth}
                onChange={(e) => setBandwidth(e.target.value)}
                disabled={isRunning}
                autoComplete="off"
              />
            </div>
            <div className="form-group" style={{ gridColumn: 'span 2' }}>
              <label className="form-label" htmlFor="whatif-note">Note (optional)</label>
              <input
                id="whatif-note"
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Recorded on the new version"
                disabled={isRunning}
                autoComplete="off"
              />
            </div>
          </div>
          <div className="mono" style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            Creates a new version (bandwidth only, everything else pinned), runs it, and compares fairly.
          </div>
          {error && (
            <div role="alert" style={{ fontSize: '12.5px', color: 'var(--accent-rose)', marginBottom: '10px' }}>
              {error}
            </div>
          )}
          {result && (
            <div className="mono" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
              Version {result.version} · run {result.run_id.slice(0, 16)} · {result.status}
              {result.compare && (
                <> · Compare: {result.compare.verdict}
                  {result.compare.verdict === 'refused' ? ` (${result.compare.reason})` : ''}
                </>
              )}
              {result.error && <> · {result.error}</>}
            </div>
          )}
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void handleRun()}
            disabled={isRunning}
          >
            <FlaskConical size={13} />
            <span>{isRunning ? 'Running…' : 'Run what-if'}</span>
          </button>
        </>
      )}
    </Modal>
  )
}

export const RunDetailInspector: React.FC<RunDetailInspectorProps> = ({
  run,
  onSelectForComparison,
  isSelectedForComparison,
  onNotify,
  onRunCreated
}) => {
  const [showStream, setShowStream] = useState(false)
  const [showWhatIf, setShowWhatIf] = useState(false)
  const degraded = run.degraded
  const hasFaults = !!degraded && (degraded.windows.length > 0 || degraded.loss_events > 0 || degraded.stalled_requests > 0)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Provenance Banner */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderRadius: 'var(--radius-md)',
          backgroundColor: run.is_demo ? 'rgba(245, 158, 11, 0.1)' : 'rgba(16, 185, 129, 0.1)',
          border: run.is_demo ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)'
        }}
      >
        <span style={{ fontSize: '12px', color: run.is_demo ? 'var(--accent-amber)' : 'var(--accent-emerald)', fontWeight: 600 }}>
          {run.is_demo ? 'DEMO TELEMETRY - Illustrative dataset' : 'LIVE TELEMETRY - Discrete-event simulation run'}
        </span>
        <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {run.scenario_hash ? `Hash: ${run.scenario_hash.slice(0, 12)}` : '—'}
        </span>
      </div>

      {/* Failure alert if run failed */}
      {run.status === 'failed' && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'rgba(244, 63, 94, 0.1)',
            border: '1px solid rgba(244, 63, 94, 0.3)'
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--accent-rose)', fontWeight: 600 }}>
            RUN FAILED: {run.error || run.bottleneck?.explanation || 'Simulation execution failed'}
          </span>
        </div>
      )}

      {/* KPI Overview Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>MEDIAN LATENCY (p50)</span>
          <p className="tabular-nums" style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent-cyan)', marginTop: '4px' }}>
            {formatNanoseconds(run.metrics.latency_ns.p50)}
          </p>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Mean: {formatNanoseconds(run.metrics.latency_ns.mean)}
          </span>
        </div>

        <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>TAIL LATENCY (p99)</span>
          <p className="tabular-nums" style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent-rose)', marginTop: '4px' }}>
            {formatNanoseconds(run.metrics.latency_ns.p99)}
          </p>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            p95: {formatNanoseconds(run.metrics.latency_ns.p95)}
          </span>
        </div>

        <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>HIT RATIO (LOCAL / REMOTE)</span>
          <p className="tabular-nums" style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent-teal)', marginTop: '4px' }}>
            {formatPercent(run.metrics.local_hit_ratio)} / {formatPercent(run.metrics.remote_hit_ratio)}
          </p>
          <span style={{ fontSize: '11px', color: 'var(--accent-amber)' }}>
            Miss: {formatPercent(run.metrics.miss_ratio)}
          </span>
        </div>

        <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>FABRIC UTILIZATION</span>
          <p className="tabular-nums" style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent-blue)', marginTop: '4px' }}>
            {formatPercent(run.metrics.fabric_utilization)}
          </p>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Peak Q: {formatBytes(run.metrics.peak_queue_depth_bytes)}
          </span>
        </div>
      </div>

      {/* Latency Percentile Chart */}
      <div style={{ height: '240px', width: '100%' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', display: 'block' }}>
          Latency Percentiles Over Virtual Time (ns)
        </span>
        {run.time_series.some((p) => p.p50_latency_ns != null || p.p99_latency_ns != null) ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={run.time_series} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis dataKey="time_formatted" stroke="var(--text-muted)" fontSize={11} />
              <YAxis stroke="var(--text-muted)" fontSize={11} unit=" ns" />
              <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff' }} />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
              <Area type="monotone" dataKey="p99_latency_ns" name="p99 Latency" stroke="#f43f5e" fill="#f43f5e" fillOpacity={0.1} />
              <Area type="monotone" dataKey="p50_latency_ns" name="p50 Latency" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.2} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ height: 'calc(100% - 24px)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-subtle)', padding: '16px', textAlign: 'center' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Per-window latency percentiles are not recorded in engine time series. See summary distribution above for full-run p50, p95, p99.
            </span>
          </div>
        )}
      </div>

      {/* Memory Occupancy Chart */}
      <div style={{ height: '240px', width: '100%' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', display: 'block' }}>
          Memory Occupancy Distribution by Tier (Local DRAM vs Remote Fabric)
        </span>
        {run.time_series.some((p) => p.local_occupancy_bytes != null || p.remote_occupancy_bytes != null) ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={run.time_series} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis dataKey="time_formatted" stroke="var(--text-muted)" fontSize={11} />
              <YAxis
                stroke="var(--text-muted)"
                fontSize={11}
                tickFormatter={(val) => `${(val / (1024 ** 3)).toFixed(0)} GB`}
              />
              <Tooltip
                formatter={(val: unknown) => [formatBytes(Number(val) || 0), 'Occupancy']}
                contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff' }}
              />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
              <Area type="monotone" dataKey="local_occupancy_bytes" name="Local DRAM Occupancy" stackId="1" stroke="#0ea5e9" fill="#0ea5e9" fillOpacity={0.4} />
              <Area type="monotone" dataKey="remote_occupancy_bytes" name="Remote Fabric Occupancy" stackId="1" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.4} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ height: 'calc(100% - 24px)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-subtle)', padding: '16px', textAlign: 'center' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Tier occupancy distribution unavailable in time series.
            </span>
          </div>
        )}
      </div>

      {/* Bottleneck Diagnostic Card */}
      {run.bottleneck ? (
        <div
          style={{
            padding: '16px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--bg-card-secondary)',
            border: '1px solid var(--border-card)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <Badge variant={run.bottleneck.severity === 'high' || run.bottleneck.severity === 'critical' ? 'rose' : 'cyan'}>
              BOTTLENECK: {run.bottleneck.primary_bottleneck}
            </Badge>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Severity: {run.bottleneck.severity.toUpperCase()}
            </span>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--text-primary)', marginBottom: '8px', lineHeight: 1.5 }}>
            {run.bottleneck.explanation}
          </p>
          <div style={{ fontSize: '12px', color: 'var(--accent-cyan)', background: 'var(--bg-input)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>
            <strong>Suggested Policy Tuning:</strong> {run.bottleneck.suggested_policy_tuning}
          </div>
        </div>
      ) : (
        <div
          style={{
            padding: '14px 16px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--bg-card-secondary)',
            border: '1px solid var(--border-card)',
            color: 'var(--text-muted)',
            fontSize: '12px'
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Diagnostic Analysis:</span> Factual telemetry counters recorded. Heuristic bottleneck diagnosis is not asserted by the discrete-event simulator for this run.
        </div>
      )}

      {hasFaults && degraded && (
        <div
          style={{
            padding: '16px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--bg-card-secondary)',
            border: '1px solid var(--border-card)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <Badge variant="amber">DEGRADED RUN</Badge>
            <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {degraded.windows.length} window{degraded.windows.length === 1 ? '' : 's'}
              {' '}· {degraded.stalled_requests} stalled requests
              {' '}· {degraded.loss_events} lost transfers ({degraded.retransmissions} retries)
            </span>
          </div>
          {degraded.windows.length > 0 && (
            <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '4px 8px 4px 0' }}>Type</th>
                  <th style={{ padding: '4px 8px 4px 0' }}>Target</th>
                  <th style={{ padding: '4px 8px 4px 0' }}>Window</th>
                  <th style={{ padding: '4px 8px 4px 0' }}>Effect</th>
                </tr>
              </thead>
              <tbody className="mono" style={{ fontSize: '11.5px' }}>
                {degraded.windows.map((w, i) => (
                  <tr key={i}>
                    <td style={{ padding: '4px 8px 4px 0' }}>{w.type}</td>
                    <td style={{ padding: '4px 8px 4px 0' }}>{w.target}</td>
                    <td style={{ padding: '4px 8px 4px 0' }}>
                      {formatNsShort(w.start_ns)} → {w.end_ns === null ? 'run end' : formatNsShort(w.end_ns)}
                    </td>
                    <td style={{ padding: '4px 8px 4px 0' }}>
                      {w.type === 'link_degradation'
                        ? `×${w.bandwidth_factor} bw, ×${w.latency_factor} lat`
                        : (w.reason || 'outage')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(degraded.stalled_transfers > 0 || degraded.retransmit_bytes > 0) && (
            <div className="mono" style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '8px' }}>
              {degraded.stalled_transfers} stalled transfers ({formatBytes(degraded.stalled_bytes)}) ·{' '}
              {formatBytes(degraded.retransmit_bytes)} retransmitted ({formatNsShort(Math.round(degraded.retransmit_delay_ns))} RTO delay)
            </div>
          )}
        </div>
      )}

      {/* Action Footer in Inspector */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
        {!run.is_demo && (
          <>
            <button
              className="btn btn-outline"
              onClick={() => setShowStream(true)}
            >
              <Radio size={14} />
              <span>Stream events</span>
            </button>
            <button
              className="btn btn-outline"
              onClick={() => setShowWhatIf(true)}
            >
              <FlaskConical size={14} />
              <span>What-if</span>
            </button>
          </>
        )}
        <button
          className={`btn ${isSelectedForComparison ? 'btn-secondary' : 'btn-primary'}`}
          onClick={() => onSelectForComparison(run.id)}
        >
          <GitCompare size={14} />
          <span>{isSelectedForComparison ? 'Remove from Comparison' : 'Add to Policy Comparison'}</span>
        </button>
      </div>

      {showStream && (
        <StreamModal runId={run.id} onClose={() => setShowStream(false)} />
      )}
      {showWhatIf && (
        <WhatIfModal
          run={run}
          onClose={() => setShowWhatIf(false)}
          onNotify={onNotify}
          onRunCreated={onRunCreated}
        />
      )}
    </div>
  )
}
