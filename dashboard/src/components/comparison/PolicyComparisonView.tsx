import React, { useState, useEffect, useMemo, useRef } from 'react'
import type { SimulationRun, ComparisonVerdict } from '../../types/telemetry'
import { apiClient } from '../../services/api'
import { Badge } from '../common/Badge'
import {
  formatNanoseconds,
  formatBytes,
  formatPercent
} from '../../utils/formatters'
import {
  evaluateComparisonEligibility,
  type FairnessCheckItem
} from '../../utils/comparisonGuard'
import {
  prepareComparisonChartData,
  getTailLatencyColor,
  getFabricUtilColor,
  getMedianLatencyColor,
  getLocalHitRatioColor
} from '../../utils/comparisonMetrics'
import {
  GitCompare,
  AlertTriangle,
  CheckCircle2,
  TrendingDown,
  Layers,
  Zap,
  ArrowRight,
  Activity,
  ShieldAlert,
  Info
} from 'lucide-react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts'

interface PolicyComparisonViewProps {
  runs: SimulationRun[]
  selectedRunIds: string[]
  onToggleRunSelection: (runId: string) => void
  onSelectBenchmarkPair: () => void
  isMockMode?: boolean
}

export const PolicyComparisonView: React.FC<PolicyComparisonViewProps> = ({
  runs,
  selectedRunIds,
  onToggleRunSelection,
  onSelectBenchmarkPair,
  isMockMode = true
}) => {
  const [isComparingLive, setIsComparingLive] = useState<boolean>(false)
  const [backendVerdict, setBackendVerdict] = useState<ComparisonVerdict | null>(null)
  const [evaluateCount, setEvaluateCount] = useState<number>(0)
  const activeRequestIdRef = useRef<number>(0)
  const lastEvaluatedKeyRef = useRef<string>('')

  // Derive stable selected runs that actually exist in the current dataset
  const selectedRuns = useMemo(() => {
    return runs.filter((r) => selectedRunIds.includes(r.id))
  }, [runs, selectedRunIds])

  // Stable string key representing the active selection (comma-separated sorted IDs)
  const comparisonKey = useMemo(() => {
    if (isMockMode || selectedRuns.length < 2 || selectedRuns.length > 4) {
      return ''
    }
    return selectedRuns.map((r) => r.id).sort().join(',')
  }, [isMockMode, selectedRuns])

  const activeBackendVerdict = isMockMode || selectedRuns.length < 2 || selectedRuns.length > 4 ? null : backendVerdict

  // In LIVE mode, query authoritative POST /runs/compare automatically
  useEffect(() => {
    if (!comparisonKey) {
      activeRequestIdRef.current += 1
      lastEvaluatedKeyRef.current = ''
      return
    }

    if (comparisonKey === lastEvaluatedKeyRef.current) {
      return
    }

    const currentReqId = ++activeRequestIdRef.current
    const targetRunIds = comparisonKey.split(',')
    setIsComparingLive(true)

    const fetchComparison = async () => {
      try {
        const verdict = await apiClient.compareRuns(targetRunIds)
        // Only apply if this request is still the active one
        if (activeRequestIdRef.current === currentReqId) {
          lastEvaluatedKeyRef.current = comparisonKey
          setBackendVerdict(verdict)
          setIsComparingLive(false)
        }
      } catch (err) {
        if (activeRequestIdRef.current === currentReqId) {
          lastEvaluatedKeyRef.current = comparisonKey
          setBackendVerdict({
            verdict: 'refused',
            reason: err instanceof Error ? err.message : 'Server refused comparison request'
          })
          setIsComparingLive(false)
        }
      }
    }

    void fetchComparison()

    return () => {
      // If unmounted or selection changes before response arrives, clear loading state
      if (activeRequestIdRef.current === currentReqId) {
        setIsComparingLive(false)
      }
    }
  }, [comparisonKey, evaluateCount])

  const handleReevaluate = () => {
    lastEvaluatedKeyRef.current = ''
    setEvaluateCount((c) => c + 1)
  }

  // Client-side guard (authoritative for Demo Mode, informational fallback)
  const guardResult = evaluateComparisonEligibility(selectedRuns)

  // In LIVE mode, the server POST /runs/compare verdict is the sole authority
  const isEligible = isMockMode
    ? guardResult.eligible
    : (activeBackendVerdict?.verdict === 'fair')

  const isRefused = isMockMode
    ? !guardResult.eligible
    : (activeBackendVerdict?.verdict === 'refused')

  const refusalReason = isMockMode
    ? guardResult.reason
    : (activeBackendVerdict?.verdict === 'refused' ? activeBackendVerdict.reason : guardResult.reason)

  const isSingleSeed = isMockMode
    ? guardResult.isSingleSeed
    : (activeBackendVerdict?.verdict === 'fair' && activeBackendVerdict.mode === 'same_seed')

  // Comparative chart data (only calculated when eligible, preserving nulls)
  const { latencyData, hitRatioData, trafficData } = prepareComparisonChartData(selectedRuns)

  // Remote fabric unexercised check: 100% local hits, 0% remote hits, and 0% fabric utilization
  const isFabricUnexercised =
    selectedRuns.length >= 2 &&
    selectedRuns.every(
      (r) =>
        (r.metrics.local_hit_ratio === 1 || r.metrics.local_hit_ratio === 100) &&
        (r.metrics.remote_hit_ratio === 0 || r.metrics.remote_hit_ratio == null) &&
        (r.metrics.fabric_utilization === 0 || r.metrics.fabric_utilization == null) &&
        (r.metrics.remote_traffic_bytes === 0 || r.metrics.remote_traffic_bytes == null)
    )

  return (
    <div className="app-content">
      {/* Selector Header Bar */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
              Compare Policy Candidates ({selectedRuns.length} selected)
            </h3>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Evaluate trade-offs between access latency, remote fabric traffic, and migration overheads
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Toggle Runs:</span>
            {runs.map((r) => {
              const isSelected = selectedRunIds.includes(r.id)
              const scenarioBadge = r.scenario_name
                ? r.scenario_name.replace(/^llama-70b-/, '')
                : r.id.slice(0, 8)
              return (
                <button
                  key={r.id}
                  className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-outline'}`}
                  style={{ fontSize: '11px', padding: '4px 10px' }}
                  onClick={() => onToggleRunSelection(r.id)}
                  title={`Run ID: ${r.id}\nScenario: ${r.scenario_name || 'Unknown'}\nPolicy: ${r.policy_name}`}
                >
                  {r.policy_name} ({scenarioBadge})
                </button>
              )
            })}
            {!isMockMode && selectedRuns.length >= 2 && selectedRuns.length <= 4 && (
              <button
                className="btn btn-sm btn-outline"
                onClick={handleReevaluate}
                disabled={isComparingLive}
                title="Re-run comparison check with backend"
                style={{ fontSize: '11px', padding: '4px 10px' }}
              >
                <span>Re-evaluate</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Case 1: Empty state (fewer than 2 runs selected) */}
      {selectedRuns.length < 2 && (
        <div
          className="card"
          style={{
            textAlign: 'center',
            padding: '48px 24px',
            backgroundColor: 'var(--bg-card-secondary)',
            borderStyle: 'dashed'
          }}
        >
          <GitCompare size={36} color="var(--accent-cyan)" style={{ margin: '0 auto 12px auto' }} />
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
            Select At Least Two Runs to Compare
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '520px', margin: '0 auto 18px auto' }}>
            Compare how different memory tiering algorithms (Swap-to-Remote, Hot/Cold Frequency Banding, Frequency-Aware)
            impact latency distributions and fabric link congestion.
          </p>
          <button className="btn btn-primary" onClick={onSelectBenchmarkPair}>
            <span>{isMockMode ? 'Compare Benchmark Pair: Swap vs. Hot/Cold' : 'Compare Available LIVE Runs'}</span>
            <ArrowRight size={14} />
          </button>
        </div>
      )}

      {/* Case 2: Run selection exceeds maximum (more than 4 runs selected) */}
      {selectedRuns.length > 4 && (
        <div
          className="card"
          style={{
            backgroundColor: 'rgba(244, 63, 94, 0.08)',
            borderColor: 'rgba(244, 63, 94, 0.4)',
            padding: '24px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <AlertTriangle size={20} color="var(--accent-rose)" />
            <h4 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--accent-rose)', margin: 0 }}>
              Comparison Refused: Selection Exceeds Maximum (4 Runs)
            </h4>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 16px 0' }}>
            {guardResult.reason || 'You have selected more than 4 runs. Please narrow your selection to 2–4 runs to maintain statistical rigor and readable comparative visualizations.'}
          </p>
          <button className="btn btn-sm btn-outline" onClick={onSelectBenchmarkPair}>
            <span>Reset to Baseline Pair (2 Runs)</span>
          </button>
        </div>
      )}

      {/* Loading state for Live Comparison */}
      {!isMockMode && isComparingLive && (
        <div className="card" style={{ textAlign: 'center', padding: '36px 20px', backgroundColor: 'var(--bg-card-secondary)' }}>
          <span style={{ fontSize: '13px', color: 'var(--accent-cyan)' }}>Evaluating comparison guard with server (POST /runs/compare)...</span>
        </div>
      )}

      {/* Case 3: 2-4 runs selected, but Comparison Guard REFUSES comparison */}
      {selectedRuns.length >= 2 && selectedRuns.length <= 4 && !isComparingLive && isRefused && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Refusal Notice Banner */}
          <div
            className="card"
            style={{
              backgroundColor: 'rgba(244, 63, 94, 0.08)',
              borderColor: 'rgba(244, 63, 94, 0.4)',
              padding: '20px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
              <div
                style={{
                  padding: '8px',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'rgba(244, 63, 94, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <ShieldAlert size={24} color="var(--accent-rose)" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                  <h4 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--accent-rose)', margin: 0 }}>
                    Comparison Refused: Strict Scientific Eligibility Guard
                  </h4>
                  <Badge variant="rose">COMPARISON REFUSED</Badge>
                </div>
                <p style={{ fontSize: '13px', color: 'var(--text-primary)', margin: '8px 0 4px 0', fontWeight: 500 }}>
                  {refusalReason}
                </p>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                  Per project specifications (<code>docs/POLICIES.md</code>): <em>&ldquo;If the guard cannot prove sameness, it refuses rather than warning.&rdquo;</em> A valid scientific comparison holds all controlled variables constant (hardware, workload parameters, trace content hash, seed, duration, warmup, page size, metric percentiles, engine version), varying ONLY the memory tiering policy.
                </p>
              </div>
            </div>

            {/* Checklist of Fairness Criteria */}
            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(244, 63, 94, 0.2)' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '10px' }}>
                Controlled Variables Audit Checklist:
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' }}>
                {guardResult.checks.map((check: FairnessCheckItem) => (
                  <div
                    key={check.id}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-md)',
                      backgroundColor: 'var(--bg-card)',
                      border: '1px solid var(--border-card)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                        {check.name}
                      </span>
                      <Badge
                        variant={
                          check.status === 'match'
                            ? 'emerald'
                            : check.status === 'mismatch'
                            ? 'rose'
                            : 'blue'
                        }
                      >
                        {check.status === 'match'
                          ? 'MATCH'
                          : check.status === 'mismatch'
                          ? 'MISMATCH'
                          : 'CANNOT VERIFY'}
                      </Badge>
                    </div>
                    <span
                      style={{ fontSize: '11px', color: 'var(--text-muted)' }}
                      title={check.details}
                    >
                      {check.details}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Action suggestion */}
            <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Please select runs configured with identical scenario specifications, or use the benchmark preset.
              </span>
              <button className="btn btn-sm btn-outline" onClick={onSelectBenchmarkPair}>
                <span>Select Compatible Benchmark Pair</span>
                <ArrowRight size={12} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Case 4: 2-4 runs selected AND comparison is eligible/fair */}
      {selectedRuns.length >= 2 && selectedRuns.length <= 4 && !isComparingLive && isEligible && (
        <>
          {/* Scientific Validation Guarantee Banner */}
          <div
            className="card"
            style={{
              backgroundColor: 'rgba(16, 185, 129, 0.08)',
              borderColor: 'rgba(16, 185, 129, 0.35)',
              padding: '16px 20px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <CheckCircle2 size={18} color="var(--accent-emerald)" />
                <span
                  style={{
                    fontSize: '14px',
                    fontWeight: 600,
                    color: 'var(--accent-emerald)'
                  }}
                >
                  Scientifically Fair Benchmark (All Controlled Variables Matched)
                </span>
                {/* Single-seed directional label required by specification */}
                {isSingleSeed && (
                  <Badge variant="cyan">
                    directional: single seed, no spread estimate
                  </Badge>
                )}
              </div>

              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Protocol: docs/POLICIES.md &sect; Comparison Protocol
              </span>
            </div>

            {/* Note regarding directional single seed */}
            {isSingleSeed && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '11px',
                  color: 'var(--text-secondary)',
                  backgroundColor: 'rgba(6, 182, 212, 0.06)',
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-sm)',
                  marginBottom: '12px'
                }}
              >
                <Info size={14} color="var(--accent-cyan)" />
                <span>
                  <strong>Statistical note:</strong> This is a <code>directional — single seed</code> evaluation (Seed {selectedRuns[0].seed}). Results provide comparative guidance across algorithmic behaviors, but do not imply multi-seed confidence intervals or definitive statistical superiority.
                </span>
              </div>
            )}

            {/* Remote fabric unexercised notification */}
            {isFabricUnexercised && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  fontSize: '12px',
                  color: 'var(--text-secondary)',
                  backgroundColor: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid rgba(245, 158, 11, 0.25)',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-sm)',
                  marginBottom: '12px',
                  lineHeight: 1.5
                }}
              >
                <Info size={16} color="var(--accent-amber)" style={{ flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <strong style={{ color: 'var(--accent-amber)' }}>Remote Fabric Not Exercised:</strong> In the evaluated runs, local hit ratio is 100% with 0% remote hits and 0% fabric link utilization. Because the working set remained entirely resident in local memory, remote paging and migration mechanisms were not exercised. Neither policy can be judged or classified as superior under this workload.
                </div>
              </div>
            )}

            {/* Controlled Variables Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
              {guardResult.checks.map((check: FairnessCheckItem) => (
                <div
                  key={check.id}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-card)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      {check.name}
                    </span>
                    <Badge variant="emerald">MATCH</Badge>
                  </div>
                  <span
                    style={{ fontSize: '11px', color: 'var(--text-muted)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}
                    title={check.details}
                  >
                    {check.details}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Side-by-side Comparative Charts */}
          <div className="charts-grid-equal">
            {/* Latency Percentiles Grouped Bar */}
            <div className="card">
              <div className="card-header">
                <div className="card-title-group">
                  <div className="card-title">
                    <TrendingDown size={16} color="var(--accent-cyan)" />
                    <span>Memory Read Latency Comparison (Lower is Better &darr;)</span>
                  </div>
                  <div className="card-subtitle">Measures the time to access a memory page during simulation. These percentiles represent page-level memory read latency, not end-to-end request duration.</div>
                </div>
              </div>

              <div className="chart-container-inner">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={latencyData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} unit=" ns" />
                    <Tooltip formatter={(val: unknown) => [val != null ? `${val} ns` : '—', undefined]} contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff' }} />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                    <Bar dataKey="p50" name="Memory Read (p50 Median)" fill="#06b6d4" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="p95" name="Memory Read (p95 Tail)" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="p99" name="Memory Read (p99 Peak Tail)" fill="#f43f5e" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Hit Ratio Breakdown Grouped Bar */}
            <div className="card">
              <div className="card-header">
                <div className="card-title-group">
                  <div className="card-title">
                    <Zap size={16} color="var(--accent-teal)" />
                    <span>Access Hit Distribution (%)</span>
                  </div>
                  <div className="card-subtitle">Local DRAM Hits vs Remote Fabric Hits vs Misses</div>
                </div>
              </div>

              <div className="chart-container-inner">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hitRatioData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} unit="%" />
                    <Tooltip formatter={(val: unknown) => [val != null ? `${val}%` : '—', undefined]} contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff' }} />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                    <Bar dataKey="localHitPct" name="Local Hit %" stackId="a" fill="#0ea5e9" />
                    <Bar dataKey="remoteHitPct" name="Remote Hit %" stackId="a" fill="#8b5cf6" />
                    <Bar dataKey="missPct" name="Miss / Evicted %" stackId="a" fill="#f43f5e" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Remote Traffic & Migration Volume */}
            <div className="card" style={{ gridColumn: 'span 2' }}>
              <div className="card-header">
                <div className="card-title-group">
                  <div className="card-title">
                    <Activity size={16} color="var(--accent-amber)" />
                    <span>Remote Memory Traffic & Memory Migration Volume (GiB)</span>
                  </div>
                  <div className="card-subtitle">Comparison of fabric bytes transferred and memory migration volume (evictions, spills, and installs)</div>
                </div>
              </div>

              <div className="chart-container-inner">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trafficData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} unit=" GiB" />
                    <Tooltip formatter={(val: unknown, name: unknown) => [val != null ? `${val}${String(name || '').includes('Util') ? '%' : ' GiB'}` : '—', undefined]} contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff' }} />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                    <Bar dataKey="remoteTrafficGb" name="Remote Traffic (GiB)" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="migrationGb" name="Memory Migration Volume (GiB)" fill="#06b6d4" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Comprehensive Comparison Table */}
          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <div className="card-title">
                  <Layers size={16} color="var(--accent-violet)" />
                  <span>Metric Comparison Matrix</span>
                </div>
                <div className="card-subtitle">
                  Direct evaluation with optimal direction indicators
                </div>
              </div>
            </div>

            <div className="table-responsive">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Target Direction</th>
                    {selectedRuns.map((r) => (
                      <th key={r.id}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ color: 'var(--text-primary)' }}>{r.policy_name}</span>
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{r.id}</span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ fontWeight: 600 }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span title="Measures the time to access a memory page during simulation. These percentiles represent page-level memory read latency, not end-to-end request duration.">
                          Memory Read Latency (p50)
                        </span>
                        <span style={{ fontSize: '10px', fontWeight: 400, color: 'var(--text-muted)' }}>
                          Page-level read access median
                        </span>
                      </div>
                    </td>
                    <td><Badge variant="cyan">&darr; Lower is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ fontWeight: 700, color: getMedianLatencyColor(r.metrics.latency_ns.p50) }}>
                        {formatNanoseconds(r.metrics.latency_ns.p50)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span title="Measures the time to access a memory page during simulation. These percentiles represent page-level memory read latency, not end-to-end request duration.">
                          Memory Read Latency (p95)
                        </span>
                        <span style={{ fontSize: '10px', fontWeight: 400, color: 'var(--text-muted)' }}>
                          95th percentile read access
                        </span>
                      </div>
                    </td>
                    <td><Badge variant="cyan">&darr; Lower is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ color: getTailLatencyColor(r.metrics.latency_ns.p95) }}>
                        {formatNanoseconds(r.metrics.latency_ns.p95)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span title="Measures the time to access a memory page during simulation. These percentiles represent page-level memory read latency, not end-to-end request duration.">
                          Memory Read Latency (p99)
                        </span>
                        <span style={{ fontSize: '10px', fontWeight: 400, color: 'var(--text-muted)' }}>
                          99th percentile peak tail read
                        </span>
                      </div>
                    </td>
                    <td><Badge variant="cyan">&darr; Lower is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ color: getTailLatencyColor(r.metrics.latency_ns.p99) }}>
                        {formatNanoseconds(r.metrics.latency_ns.p99)}
                      </td>
                    ))}
                  </tr>

                  {selectedRuns.some((r) => r.metrics.latency_ns.mean != null) && (
                    <tr>
                      <td style={{ fontWeight: 600 }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span title="Mean includes queueing delays, so a small number of heavily delayed accesses can raise the average above p99.">
                            Mean Memory Read Latency
                          </span>
                          <span style={{ fontSize: '10px', fontWeight: 400, color: 'var(--text-muted)' }}>
                            Arithmetic average across all steady-state reads
                          </span>
                        </div>
                      </td>
                      <td><Badge variant="cyan">&darr; Lower is better</Badge></td>
                      {selectedRuns.map((r) => (
                        <td
                          key={r.id}
                          className="tabular-nums"
                          style={{ color: r.metrics.latency_ns.mean != null ? 'var(--text-primary)' : 'var(--text-muted)' }}
                          title="Mean includes queueing delays, so a small number of heavily delayed accesses can raise the average above p99."
                        >
                          {formatNanoseconds(r.metrics.latency_ns.mean)}
                        </td>
                      ))}
                    </tr>
                  )}

                  <tr>
                    <td style={{ fontWeight: 600 }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span>Cumulative Memory-Access Stall Time</span>
                        <span style={{ fontSize: '10px', fontWeight: 400, color: 'var(--text-muted)' }}>
                          Sum of individual memory-access stall durations across concurrent workers.
                        </span>
                      </div>
                    </td>
                    <td><Badge variant="cyan">&darr; Lower is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td
                        key={r.id}
                        className="tabular-nums"
                        style={{ color: r.metrics.stall_time_ns != null ? 'var(--text-primary)' : 'var(--text-muted)' }}
                        title="Sum of access stall durations across all concurrent worker threads over the simulation steady-state window"
                      >
                        {formatNanoseconds(r.metrics.stall_time_ns)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Local Hit Ratio</td>
                    <td><Badge variant="emerald">&uarr; Higher is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ fontWeight: 600, color: getLocalHitRatioColor(r.metrics.local_hit_ratio) }}>
                        {formatPercent(r.metrics.local_hit_ratio)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Remote Hit Ratio</td>
                    <td><Badge variant="blue">Workload dependent</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ color: r.metrics.remote_hit_ratio != null ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {formatPercent(r.metrics.remote_hit_ratio)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Remote Traffic Volume</td>
                    <td><Badge variant="cyan">&darr; Lower is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ color: r.metrics.remote_traffic_bytes != null ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {formatBytes(r.metrics.remote_traffic_bytes)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span>Memory Migration Volume</span>
                        <span style={{ fontSize: '10px', fontWeight: 400, color: 'var(--text-muted)' }}>
                          Eviction writeback + install transfers
                        </span>
                      </div>
                    </td>
                    <td><Badge variant="blue">Trade-off metric</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ color: r.metrics.migration_bytes != null ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {formatBytes(r.metrics.migration_bytes)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Request Throughput</td>
                    <td><Badge variant="emerald">&uarr; Higher is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ color: r.metrics.throughput_per_s != null ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {r.metrics.throughput_per_s != null ? `${r.metrics.throughput_per_s.toFixed(2)} req/s` : '—'}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Fabric Utilization</td>
                    <td><Badge variant="amber">&darr; Moderate is better (&lt;70%)</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ color: getFabricUtilColor(r.metrics.fabric_utilization) }}>
                        {formatPercent(r.metrics.fabric_utilization)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Identified Bottleneck</td>
                    <td>-</td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} style={{ fontSize: '12px', maxWidth: '240px', color: isFabricUnexercised ? 'var(--text-secondary)' : (r.bottleneck?.primary_bottleneck ? 'var(--text-primary)' : 'var(--text-muted)') }}>
                        {isFabricUnexercised
                          ? 'None (Remote fabric not exercised)'
                          : (r.bottleneck?.primary_bottleneck || 'Unavailable')}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
