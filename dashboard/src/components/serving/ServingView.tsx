import React, { useEffect, useState } from 'react'
import type { SimulationRun } from '../../types/telemetry'
import { apiClient, apiErrorMessage } from '../../services/api'
import { Badge } from '../common/Badge'
import { KpiCard } from '../common/KpiCard'
import { Gauge } from 'lucide-react'
import { formatNanoseconds } from '../../utils/formatters'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'

interface ServingViewProps {
  runs: SimulationRun[]
  isMockMode: boolean
}

interface ItlPoint {
  t: number
  label: string
  stepNs: number
}

function StackedBar({ segments }: {
  segments: Array<{ label: string; fraction: number; color: string; exact: string }>
}) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          height: '22px',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
          background: 'var(--bg-input)'
        }}
        role="img"
        aria-label={segments.map((s) => `${s.label}: ${s.exact}`).join('; ')}
      >
        {segments.map((s) => (
          <div
            key={s.label}
            style={{ width: `${Math.max(s.fraction * 100, s.fraction > 0 ? 2 : 0)}%`, background: s.color }}
            title={`${s.label}: ${s.exact}`}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginTop: '10px' }}>
        {segments.map((s) => (
          <span key={s.label} style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: s.color, display: 'inline-block' }} />
            {s.label}: <strong className="mono" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{s.exact}</strong>
          </span>
        ))}
      </div>
    </div>
  )
}

export const ServingView: React.FC<ServingViewProps> = ({ runs, isMockMode }) => {
  const [selectedRunId, setSelectedRunId] = useState<string>('')
  const currentRun = runs.find((r) => r.id === (selectedRunId || runs[0]?.id)) || runs[0]
  const currentRunId = currentRun?.id ?? null

  // Live list rows lack the serving section; enrich once per run on demand.
  const [enriched, setEnriched] = useState<{ id: string; run: SimulationRun } | null>(null)
  const [attempted, setAttempted] = useState<Record<string, boolean>>({})
  const runHasServing = !!currentRun?.serving
  useEffect(() => {
    if (isMockMode || !currentRunId || runHasServing || attempted[currentRunId]) return
    let cancelled = false
    void apiClient.getRun(currentRunId)
      .then((r) => {
        if (cancelled) return
        setAttempted((p) => ({ ...p, [currentRunId]: true }))
        if (r) setEnriched({ id: currentRunId, run: r })
      })
      .catch(() => {
        if (!cancelled) setAttempted((p) => ({ ...p, [currentRunId]: true }))
      })
    return () => { cancelled = true }
  }, [isMockMode, currentRunId, runHasServing, attempted])
  const displayRun = !isMockMode && enriched && enriched.id === currentRunId ? enriched.run : currentRun
  const serving = displayRun?.serving ?? null
  const isLoadingServing = !isMockMode && !!currentRunId && !serving && !attempted[currentRunId]

  // ITL timeline from recorded decode_step events (live only).
  const displayRunId = displayRun?.id ?? null
  const [retryNonce, setRetryNonce] = useState(0)
  const [itl, setItl] = useState<{ id: string; points: ItlPoint[]; truncated: boolean } | null>(null)
  const [itlError, setItlError] = useState<{ id: string; message: string } | null>(null)
  useEffect(() => {
    if (isMockMode || !displayRunId) return
    let cancelled = false
    void apiClient.getRunEvents(displayRunId, { types: 'decode_step', limit: 2000 })
      .then((res) => {
        if (cancelled) return
        const points: ItlPoint[] = []
        for (const e of res.events) {
          const step = (e.data as Record<string, unknown>)?.step_ns
          if (typeof step === 'number' && Number.isFinite(step)) {
            points.push({ t: e.time_ns, label: `${(e.time_ns / 1_000_000).toFixed(0)} ms`, stepNs: step })
          }
        }
        setItl({ id: displayRunId, points, truncated: res.next_cursor !== null })
      })
      .catch((err) => {
        if (!cancelled) setItlError({ id: displayRunId, message: apiErrorMessage(err) })
      })
    return () => { cancelled = true }
  }, [isMockMode, displayRunId, retryNonce])
  const itlForRun = itl && itl.id === displayRunId ? itl : null
  const itlErrorForRun = itlError && itlError.id === displayRunId ? itlError : null
  const isLoadingItl = !isMockMode && !!displayRunId && !itlForRun && !itlErrorForRun

  // Honest time split: recorded compute vs (mean request latency x count − compute).
  const totalReqNs = serving?.request_latency_mean != null && serving?.request_latency_count != null
    ? serving.request_latency_mean * serving.request_latency_count
    : null
  const computeNs = serving?.compute_ns
  const memoryQueueNs = totalReqNs != null && computeNs != null ? Math.max(totalReqNs - computeNs, 0) : null
  const computeShare = totalReqNs != null && totalReqNs > 0 && computeNs != null ? computeNs / totalReqNs : null

  if (!displayRun || runs.length === 0) {
    return (
      <div className="app-content">
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px', backgroundColor: 'var(--bg-card-secondary)', borderStyle: 'dashed' }}>
          <Gauge size={36} color="var(--accent-cyan)" style={{ margin: '0 auto 12px auto' }} />
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
            No Simulation Runs Available
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '480px', margin: '0 auto' }}>
            Run a simulation to inspect serving telemetry: time to first token, token pacing, and the compute-vs-memory time split.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-content">
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Gauge size={16} color="var(--accent-cyan)" />
              <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                Serving Telemetry
              </h3>
              <Badge variant={isMockMode ? 'amber' : 'emerald'}>
                {isMockMode ? 'Demo Dataset' : 'Live Engine'}
              </Badge>
            </div>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              TTFT, token pacing, and compute-vs-memory time — all derived from recorded event boundaries
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label htmlFor="serving-run-select" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Select Run:</label>
            <select
              id="serving-run-select"
              value={displayRun.id}
              onChange={(e) => setSelectedRunId(e.target.value)}
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-primary)',
                fontSize: '12px',
                padding: '6px 10px',
                borderRadius: 'var(--radius-sm)'
              }}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.scenario_name || r.id} ({r.policy_name})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {isLoadingServing && (
        <div className="card" style={{ textAlign: 'center', padding: '24px', backgroundColor: 'var(--bg-card-secondary)', borderStyle: 'dashed' }}>
          <span style={{ fontSize: '13px', color: 'var(--accent-cyan)' }}>Loading serving telemetry from live backend…</span>
        </div>
      )}

      {!serving && !isLoadingServing && (
        <div className="card" style={{ textAlign: 'center', padding: '36px 24px', backgroundColor: 'var(--bg-card-secondary)', borderStyle: 'dashed' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
            No Serving Telemetry on This Run
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '520px', margin: '0 auto' }}>
            {isMockMode
              ? 'Demo runs predate the serving model and carry no TTFT/TPOT record. Switch to Live mode and open a run produced by the compute-aware engine.'
              : 'This run was produced before the serving section existed. Re-run its scenario with the compute-aware engine to record TTFT, pacing, and compute service time.'}
          </p>
        </div>
      )}

      {serving && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
            <KpiCard
              title="TTFT p50"
              value={serving.ttft_p50 != null ? formatNanoseconds(serving.ttft_p50) : '—'}
              subtitle={`First token · n=${serving.ttft_count ?? '—'}`}
              demoBadge={isMockMode}
            />
            <KpiCard
              title="TTFT p99"
              value={serving.ttft_p99 != null ? formatNanoseconds(serving.ttft_p99) : '—'}
              subtitle="Tail first-token latency"
              demoBadge={isMockMode}
            />
            <KpiCard
              title="TPOT (mean)"
              value={serving.tpot_ns != null ? formatNanoseconds(serving.tpot_ns) : '—'}
              subtitle="Mean time per output token"
              demoBadge={isMockMode}
            />
            <KpiCard
              title="ITL p99"
              value={serving.itl_p99 != null ? formatNanoseconds(serving.itl_p99) : '—'}
              subtitle="Tail inter-token latency"
              demoBadge={isMockMode}
            />
          </div>

          <div className="charts-grid-2col">
            <div className="card">
              <div className="card-header">
                <div className="card-title-group">
                  <div className="card-title"><span>Where Request Time Went</span></div>
                  <div className="card-subtitle">Recorded compute service vs memory + queue remainder</div>
                </div>
              </div>
              {computeNs != null && memoryQueueNs != null && computeShare != null ? (
                <StackedBar
                  segments={[
                    { label: 'Compute', fraction: computeShare, color: 'var(--accent-cyan)', exact: `${formatNanoseconds(computeNs)} (${(computeShare * 100).toFixed(1)}%)` },
                    { label: 'Memory + queue', fraction: 1 - computeShare, color: 'var(--accent-amber)', exact: `${formatNanoseconds(memoryQueueNs)} (${((1 - computeShare) * 100).toFixed(1)}%)` }
                  ]}
                />
              ) : (
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                  {serving.request_latency_count === 0
                    ? 'No requests completed in this run — the time split needs completed-request latencies.'
                    : 'Time split unavailable: this run lacks request-latency totals or compute accounting.'}
                </span>
              )}
            </div>

            <div className="card">
              <div className="card-header">
                <div className="card-title-group">
                  <div className="card-title"><span>Compute Split</span></div>
                  <div className="card-subtitle">Prefill vs decode service (serialized bound)</div>
                </div>
              </div>
              {serving.compute_prefill_ns != null && serving.compute_decode_ns != null && computeNs != null && computeNs > 0 ? (
                <StackedBar
                  segments={[
                    { label: 'Prefill', fraction: serving.compute_prefill_ns / computeNs, color: 'var(--accent-teal)', exact: formatNanoseconds(serving.compute_prefill_ns) },
                    { label: 'Decode', fraction: serving.compute_decode_ns / computeNs, color: 'var(--accent-blue)', exact: formatNanoseconds(serving.compute_decode_ns) }
                  ]}
                />
              ) : (
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                  {computeNs === 0
                    ? 'Compute term is zero: this scenario sets no tokens_per_second, so the run is memory-only by design.'
                    : 'Compute split unavailable for this run.'}
                </span>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <div className="card-title"><span>Inter-Token Latency Over Virtual Time</span></div>
                <div className="card-subtitle">
                  One point per recorded decode step
                  {itlForRun?.truncated ? ' · showing first 2,000 steps' : ''}
                </div>
              </div>
            </div>
            <div className="chart-container-inner">
              {isLoadingItl && (
                <span style={{ fontSize: '13px', color: 'var(--accent-cyan)' }}>Loading decode-step events…</span>
              )}
              {itlErrorForRun && !itlForRun && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                    Could not load decode-step events: {itlErrorForRun.message}
                  </span>
                  <button className="btn btn-sm btn-outline" onClick={() => setRetryNonce((n) => n + 1)}>
                    Retry
                  </button>
                </div>
              )}
              {itlForRun && itlForRun.points.length > 0 && (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={itlForRun.points} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis dataKey="label" stroke="var(--text-muted)" fontSize={11} tickLine={false} minTickGap={48} />
                    <YAxis
                      stroke="var(--text-muted)"
                      fontSize={11}
                      tickLine={false}
                      tickFormatter={(val: number) => formatNanoseconds(val, 0)}
                    />
                    <Tooltip
                      formatter={(val: unknown) => [formatNanoseconds(Number(val) || 0), 'Step time']}
                      contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff', fontSize: '12px' }}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                    <Area
                      type="monotone"
                      dataKey="stepNs"
                      name="Decode step time"
                      stroke="#06b6d4"
                      fill="#06b6d4"
                      fillOpacity={0.25}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
              {itlForRun && itlForRun.points.length === 0 && (
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                  No decode steps recorded for this run.
                </span>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <div className="card-title"><span>How These Numbers Are Defined</span></div>
              </div>
            </div>
            <ul style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0, paddingLeft: '18px' }}>
              <li>TTFT = arrival → first decode step completion (queue + prefill + first token), one sample per request.</li>
              <li>ITL = decode-step durations from recorded step events; TPOT is their mean.</li>
              <li>Compute = prompt/tps at prefill + 1/tps per decode token, serialized after memory service with no overlap. Memory-bandwidth changes cannot move it.</li>
              <li>Zero compute with a serving record means memory-only by design (no tokens_per_second set), not missing data.</li>
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
