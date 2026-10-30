import React, { useState } from 'react'
import type { SimulationRun } from '../../types/telemetry'
import { Badge } from '../common/Badge'
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
  AlertCircle
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
    const matchesSearch =
      run.scenario_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      run.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      run.workload_profile.toLowerCase().includes(searchQuery.toLowerCase())

    const matchesPolicy = policyFilter === 'all' || run.policy_name === policyFilter
    const matchesStatus = statusFilter === 'all' || run.status === statusFilter

    return matchesSearch && matchesPolicy && matchesStatus
  })

  // Sort runs
  filteredRuns.sort((a, b) => {
    const diff = sortField === 'latency'
      ? a.metrics.latency_ns.p50 - b.metrics.latency_ns.p50
      : sortField === 'scenario'
      ? a.scenario_name.localeCompare(b.scenario_name)
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
                              {run.scenario_name}
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
                      <td className="mono">{run.seed}</td>
                      <td className="tabular-nums">
                        {(run.duration_ns / 1_000_000_000).toFixed(0)}s
                      </td>
                      <td className="tabular-nums" style={{ fontWeight: 600, color: 'var(--accent-cyan)' }}>
                        {formatNanoseconds(run.metrics.latency_ns.p50)}
                      </td>
                      <td
                        className="tabular-nums"
                        style={{
                          color: run.metrics.latency_ns.p99 > 1000 ? 'var(--accent-rose)' : 'var(--text-secondary)'
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
                        <Badge variant={run.status === 'completed' ? 'emerald' : 'amber'}>
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
}

export const RunDetailInspector: React.FC<RunDetailInspectorProps> = ({
  run,
  onSelectForComparison,
  isSelectedForComparison
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Demo Warning Pill */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          border: '1px solid rgba(245, 158, 11, 0.3)'
        }}
      >
        <span style={{ fontSize: '12px', color: 'var(--accent-amber)', fontWeight: 600 }}>
          DEMO TELEMETRY - Generated from discrete-event simulation model
        </span>
        <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {run.scenario_hash}
        </span>
      </div>

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
      </div>

      {/* Memory Occupancy Chart */}
      <div style={{ height: '240px', width: '100%' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', display: 'block' }}>
          Memory Occupancy Distribution by Tier (Local DRAM vs Remote Fabric)
        </span>
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
      </div>

      {/* Bottleneck Diagnostic Card */}
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

      {/* Action Footer in Inspector */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
        <button
          className={`btn ${isSelectedForComparison ? 'btn-secondary' : 'btn-primary'}`}
          onClick={() => onSelectForComparison(run.id)}
        >
          <GitCompare size={14} />
          <span>{isSelectedForComparison ? 'Remove from Comparison' : 'Add to Policy Comparison'}</span>
        </button>
      </div>
    </div>
  )
}
