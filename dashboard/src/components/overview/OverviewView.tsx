import React, { useState } from 'react'
import {
  Activity,
  Zap,
  TrendingDown,
  Layers,
  ArrowRight,
  PlusCircle,
  Clock,
  Sparkles,
  ExternalLink
} from 'lucide-react'
import { KpiCard } from '../common/KpiCard'
import { Badge } from '../common/Badge'
import type { SimulationRun } from '../../types/telemetry'
import { formatNanoseconds, formatPercent } from '../../utils/formatters'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend
} from 'recharts'

interface OverviewViewProps {
  runs: SimulationRun[]
  isMockMode?: boolean
  onOpenRunDetails: (run: SimulationRun) => void
  onNavigateToBuilder: () => void
  onNavigateToComparison: (initialRunIds?: string[]) => void
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  runs,
  isMockMode = true,
  onOpenRunDetails,
  onNavigateToBuilder,
  onNavigateToComparison
}) => {
  const [activeChartMetric, setActiveChartMetric] = useState<'latency' | 'bandwidth'>('latency')

  // Dynamic KPIs computed strictly from loaded runs
  const completedRuns = runs.filter((r) => r.status === 'completed')
  const validP50s = runs
    .map((r) => r.metrics?.latency_ns?.p50)
    .filter((v): v is number => v != null && !isNaN(v))
  validP50s.sort((a, b) => a - b)
  const medianP50 = validP50s.length > 0 ? validP50s[Math.floor(validP50s.length / 2)].toFixed(1) : '—'

  const validHitRatios = runs
    .map((r) => r.metrics?.remote_hit_ratio)
    .filter((v): v is number => v != null && !isNaN(v))
  const avgHitRatio = validHitRatios.length > 0
    ? ((validHitRatios.reduce((s, v) => s + v, 0) / validHitRatios.length) * 100).toFixed(1)
    : '—'

  const validUtils = runs
    .map((r) => r.metrics?.fabric_utilization)
    .filter((v): v is number => v != null && !isNaN(v))
  const avgUtil = validUtils.length > 0
    ? ((validUtils.reduce((s, v) => s + v, 0) / validUtils.length) * 100).toFixed(1)
    : '—'

  // Benchmark run for time-series and topology display
  const primaryRun = runs.find((r) => r.scenario_snapshot?.nodes && r.scenario_snapshot.nodes.length > 0) || runs[0]

  // Memory tier distribution data derived from authentic scenario snapshot
  const tierDistributionData = primaryRun?.scenario_snapshot?.nodes
    ? primaryRun.scenario_snapshot.nodes.map((n) => ({
        name: n.id,
        localDramGb: n.local_memory?.capacity_bytes
          ? parseFloat((n.local_memory.capacity_bytes / (1024 ** 3)).toFixed(1))
          : 0,
        remotePoolGb: n.remote_memory?.capacity_bytes
          ? parseFloat((n.remote_memory.capacity_bytes / (1024 ** 3)).toFixed(1))
          : 0,
        acceleratorHbmGb: n.compute?.accelerator_memory_bytes
          ? parseFloat((n.compute.accelerator_memory_bytes / (1024 ** 3)).toFixed(1))
          : 0
      }))
    : []

  return (
    <div className="app-content">
      {/* Welcome Banner */}
      <div
        className="card"
        style={{
          background: 'linear-gradient(135deg, rgba(14, 165, 233, 0.1) 0%, rgba(20, 184, 166, 0.05) 50%, var(--bg-card) 100%)',
          borderColor: 'rgba(14, 165, 233, 0.25)',
          padding: '24px 28px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
          <div style={{ maxWidth: '820px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <Badge variant="cyan" icon={<Sparkles size={12} />}>DISCRETE-EVENT MEMORY EXPLORATION</Badge>
              {isMockMode ? (
                <Badge variant="amber">DEMO DATASET ACTIVE</Badge>
              ) : (
                <Badge variant="emerald">LIVE BACKEND ACTIVE</Badge>
              )}
            </div>
            <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.3px', margin: '4px 0 8px 0' }}>
              Welcome to RmemFab Simulation Studio
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px', lineHeight: 1.6 }}>
              Model, evaluate, and benchmark disaggregated remote-memory fabrics (CXL / RDMA),
              page placement policies (Hot/Cold Frequency Banding, Frequency-Aware LRU-K, Predictive Prefetch),
              and memory-tiering behaviors under LLM KV-cache decode and trace replay workloads.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              className="btn btn-outline"
              onClick={() => {
                if (isMockMode) {
                  onNavigateToComparison(['run-llama-cxl-swap', 'run-llama-cxl-hotcold'])
                } else {
                  onNavigateToComparison()
                }
              }}
              style={{ fontSize: '12px', padding: '9px 14px' }}
            >
              <span>{isMockMode ? 'Compare Swap vs Hot/Cold' : 'Compare Policies'}</span>
              <ArrowRight size={14} />
            </button>
            <button
              className="btn btn-primary"
              onClick={onNavigateToBuilder}
              style={{ fontSize: '12px', padding: '9px 16px' }}
            >
              <PlusCircle size={15} />
              <span>Create New Scenario</span>
            </button>
          </div>
        </div>
      </div>

      {/* 4 KPI Cards */}
      <div className="kpi-grid">
        <KpiCard
          title="Completed Runs"
          value={completedRuns.length}
          subtitle={`Total loaded: ${runs.length}`}
          unit="runs"
          trend={{ value: `${runs.length} runs tracked`, isPositive: true }}
          icon={<Layers size={16} />}
          provenance={isMockMode ? 'demo' : 'live'}
        />
        <KpiCard
          title="Memory Read Latency (p50)"
          value={medianP50}
          subtitle="Median page read latency"
          unit={medianP50 !== '—' ? 'ns' : ''}
          tooltip="Measures the time to access a memory page during simulation. These percentiles represent page-level memory read latency, not end-to-end request duration."
          trend={{ value: medianP50 !== '—' ? 'Measured median' : 'Awaiting data', isPositive: true }}
          icon={<TrendingDown size={16} />}
          provenance={isMockMode ? 'demo' : 'live'}
        />
        <KpiCard
          title="Remote Memory Hit Ratio"
          value={avgHitRatio}
          subtitle="Average across runs"
          unit={avgHitRatio !== '—' ? '%' : ''}
          trend={{ value: avgHitRatio !== '—' ? 'Across valid runs' : 'Awaiting data', isPositive: true }}
          icon={<Zap size={16} />}
          provenance={isMockMode ? 'demo' : 'live'}
        />
        <KpiCard
          title="Fabric Utilization"
          value={avgUtil}
          subtitle="Average across runs"
          unit={avgUtil !== '—' ? '%' : ''}
          trend={{ value: avgUtil !== '—' ? 'Across valid runs' : 'Awaiting data', isPositive: true }}
          icon={<Activity size={16} />}
          provenance={isMockMode ? 'demo' : 'live'}
        />
      </div>

      {/* Main Charts Row */}
      <div className="charts-grid-2col">
        {/* Primary Latency / Throughput Chart */}
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-title">
                <Activity size={16} color="var(--accent-cyan)" />
                <span>Virtual-Time Telemetry Dynamics</span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>
                  ({primaryRun?.scenario_name || primaryRun?.id || 'No run'} • seed {primaryRun?.seed ?? '—'})
                </span>
              </div>
              <div className="card-subtitle">
                Sampling interval: 100ms virtual clock • Percentile distributions
              </div>
            </div>

            <div style={{ display: 'flex', gap: '4px', background: 'var(--bg-input)', padding: '3px', borderRadius: 'var(--radius-md)' }}>
              <button
                className={`btn btn-sm ${activeChartMetric === 'latency' ? 'btn-secondary' : 'btn-outline'}`}
                style={{ fontSize: '11px', padding: '3px 8px', border: 'none' }}
                onClick={() => setActiveChartMetric('latency')}
              >
                Memory Read Latency (ns)
              </button>
              <button
                className={`btn btn-sm ${activeChartMetric === 'bandwidth' ? 'btn-secondary' : 'btn-outline'}`}
                style={{ fontSize: '11px', padding: '3px 8px', border: 'none' }}
                onClick={() => setActiveChartMetric('bandwidth')}
              >
                Fabric Bandwidth (GB/s)
              </button>
            </div>
          </div>

          <div className="chart-container-inner">
            {activeChartMetric === 'latency' ? (
              primaryRun?.time_series?.some((p) => p.p50_latency_ns != null || p.p99_latency_ns != null) ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={primaryRun?.time_series || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="p99Grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.0} />
                      </linearGradient>
                      <linearGradient id="p50Grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis dataKey="time_formatted" stroke="var(--text-muted)" fontSize={11} tickLine={false} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} unit=" ns" />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff', fontSize: '12px' }}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                    <Area type="monotone" dataKey="p99_latency_ns" name="Memory Read (p99 Tail)" stroke="#f43f5e" fillOpacity={1} fill="url(#p99Grad)" />
                    <Area type="monotone" dataKey="p95_latency_ns" name="Memory Read (p95)" stroke="#f59e0b" fillOpacity={0} />
                    <Area type="monotone" dataKey="p50_latency_ns" name="Memory Read (p50 Median)" stroke="#06b6d4" fillOpacity={1} fill="url(#p50Grad)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : primaryRun?.metrics?.latency_ns && (primaryRun.metrics.latency_ns.p50 != null || primaryRun.metrics.latency_ns.p95 != null || primaryRun.metrics.latency_ns.p99 != null) ? (
                <div
                  style={{
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    background: 'var(--bg-card-secondary)',
                    borderRadius: 'var(--radius-md)',
                    padding: '16px',
                    border: '1px solid var(--border-subtle)'
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                          Measured Memory Read Latency Distribution
                        </span>
                        <Badge variant="blue">
                          Whole-Run Percentiles
                        </Badge>
                      </div>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        Page-level memory read latency across percentiles. Identical percentiles reflect high local tier hit rates and histogram bin resolution.
                      </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '16px' }}>
                      <div style={{ padding: '10px 12px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>p50 (Median)</span>
                        <div className="tabular-nums" style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent-cyan)', marginTop: '2px' }}>
                          {formatNanoseconds(primaryRun.metrics.latency_ns.p50)}
                        </div>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>50% below this latency</span>
                      </div>

                      <div style={{ padding: '10px 12px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>p95 (Tail)</span>
                        <div className="tabular-nums" style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent-amber)', marginTop: '2px' }}>
                          {formatNanoseconds(primaryRun.metrics.latency_ns.p95)}
                        </div>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>95% below this latency</span>
                      </div>

                      <div style={{ padding: '10px 12px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>p99 (Peak Tail)</span>
                        <div className="tabular-nums" style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent-rose)', marginTop: '2px' }}>
                          {formatNanoseconds(primaryRun.metrics.latency_ns.p99)}
                        </div>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Worst 1% tail access</span>
                      </div>
                    </div>

                    {/* Latency Range Progression Visualizer */}
                    <div style={{ marginBottom: '6px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                        <span>Local DRAM Page-Read Baseline (~5.3 µs)</span>
                        <span>Remote CXL Page-Read (~44.2 µs)</span>
                      </div>
                      <div style={{ display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', background: 'var(--border-subtle)' }}>
                        <div style={{ width: '40%', background: 'var(--accent-cyan)' }} title="p50 Median Zone" />
                        <div style={{ width: '35%', background: 'var(--accent-amber)' }} title="p95 Tail Escalation" />
                        <div style={{ width: '25%', background: 'var(--accent-rose)' }} title="p99 Peak Spike" />
                      </div>
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', maxWidth: '78%', lineHeight: 1.4 }}>
                      Whole-run percentiles are authentically measured from full simulation events. Per-interval sliding windows are not stored in time series. Switch to <strong>Fabric Bandwidth</strong> to view time-series dynamics.
                    </span>
                    <button
                      className="btn btn-sm btn-outline"
                      style={{ fontSize: '11px', padding: '3px 10px' }}
                      onClick={() => setActiveChartMetric('bandwidth')}
                    >
                      View Bandwidth
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ height: '100%', minHeight: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-subtle)', padding: '24px', textAlign: 'center' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '420px', lineHeight: 1.5 }}>
                    Access latency data is unavailable for this run.
                  </span>
                </div>
              )
            ) : (
              primaryRun?.time_series?.some((p) => p.fabric_bandwidth_bytes_per_ns != null) ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={primaryRun?.time_series || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="bwGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="#14b8a6" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis dataKey="time_formatted" stroke="var(--text-muted)" fontSize={11} tickLine={false} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} unit=" GB/s" />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff', fontSize: '12px' }}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                    <Area type="monotone" dataKey="fabric_bandwidth_bytes_per_ns" name="Fabric Bandwidth (GB/s)" stroke="#14b8a6" fillOpacity={1} fill="url(#bwGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: '100%', minHeight: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-subtle)', padding: '24px', textAlign: 'center' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '420px', lineHeight: 1.5 }}>
                    Fabric bandwidth time series unavailable for this run.
                  </span>
                </div>
              )
            )}
          </div>
        </div>

        {/* Memory Tier Capacity Allocation */}
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-title">
                <Layers size={16} color="var(--accent-teal)" />
                <span>Memory Tier Architecture</span>
              </div>
              <div className="card-subtitle">
                Local DRAM vs CXL Pooled Storage per Node (GiB)
              </div>
            </div>
            <Badge variant="teal">
              {primaryRun?.scenario_snapshot?.name || 'Selected Topology'}
            </Badge>
          </div>

          <div className="chart-container-inner">
            {tierDistributionData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={tierDistributionData} margin={{ top: 10, right: 15, left: -10, bottom: 25 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis
                    dataKey="name"
                    stroke="var(--text-muted)"
                    fontSize={11}
                    tickLine={false}
                    interval={0}
                    angle={-15}
                    textAnchor="end"
                    height={35}
                  />
                  <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} unit=" GiB" />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff', fontSize: '12px' }}
                  />
                  <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '4px' }} />
                  <Bar dataKey="acceleratorHbmGb" name="Accelerator HBM" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="localDramGb" name="Local DRAM" stackId="a" fill="#0ea5e9" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="remotePoolGb" name="Remote CXL Pool" stackId="a" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: '100%', minHeight: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-subtle)', padding: '24px', textAlign: 'center' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '420px', lineHeight: 1.5 }}>
                  Memory tier allocations are unavailable for this run.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Simulation Runs Table */}
      <div className="card">
        <div className="card-header">
          <div className="card-title-group">
            <div className="card-title">
              <Clock size={16} color="var(--accent-blue)" />
              <span>Recent Simulation Experiments</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>
                ({runs.length} runs loaded)
              </span>
            </div>
            <div className="card-subtitle">
              Click any run to inspect detailed bottleneck diagnostics, percentiles, and virtual timelines
            </div>
          </div>

          <button
            className="btn btn-sm btn-outline"
            onClick={() => onNavigateToComparison()}
            style={{ fontSize: '12px' }}
          >
            <span>Multi-Policy Comparison</span>
            <ArrowRight size={13} />
          </button>
        </div>

        <div className="table-responsive">
          <table className="data-table">
            <thead>
              <tr>
                <th>Scenario / Run ID</th>
                <th>Workload Profile</th>
                <th>Placement Policy</th>
                <th>Seed</th>
                <th title="Measures the time to access a memory page during simulation. These percentiles represent page-level memory read latency, not end-to-end request duration.">Memory Read (p50)</th>
                <th title="Measures the time to access a memory page during simulation. These percentiles represent page-level memory read latency, not end-to-end request duration.">Memory Read (p99)</th>
                <th>Remote Hit %</th>
                <th>Fabric Util</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} style={{ cursor: 'pointer' }} onClick={() => onOpenRunDetails(run)}>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{run.scenario_name || run.id}</span>
                      <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{run.id}</span>
                    </div>
                  </td>
                  <td>
                    <Badge variant="blue">{run.workload_profile}</Badge>
                  </td>
                  <td>
                    <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{run.policy_name}</span>
                  </td>
                  <td className="mono">{run.seed ?? '—'}</td>
                  <td className="tabular-nums" style={{ fontWeight: 600, color: 'var(--accent-cyan)' }}>
                    {formatNanoseconds(run.metrics.latency_ns.p50)}
                  </td>
                  <td className="tabular-nums" style={{ color: (run.metrics.latency_ns.p99 ?? 0) > 1000 ? 'var(--accent-rose)' : 'var(--text-secondary)' }}>
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
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => onOpenRunDetails(run)}
                        title="View run telemetry & analysis"
                      >
                        <ExternalLink size={12} />
                        <span>Inspect</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Memory Tiering Architecture Insights Card */}
      <div className="card" style={{ backgroundColor: 'var(--bg-card-secondary)', borderStyle: 'dashed' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          <div>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Deterministic Discrete-Event Engine
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Runs execute along virtual nanosecond time ticks. Tie-breaking is deterministic via sequence IDs.
              Identical scenario definitions and seeds produce byte-identical metric summaries.
            </p>
          </div>
          <div>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              LLM KV Working Set Dynamics
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Autoregressive decode expands KV caches (320 KiB/token for Llama-3-70B GQA). Under local capacity
              pressure, policies partition pages: swap-to-remote spills victims to pooled CXL, while frequency-aware
              policies prioritize keeping frequently reused pages resident in local memory.
            </p>
          </div>
          <div>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Fabric Contention & Demand Paging
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Concurrent remote page fetches share link bandwidth and accumulate queuing delay under memory pressure.
              Predictive prefetching and frequency-aware placement can reduce remote fetch frequency, but speculative
              prefetches contend for the same shared fabric links.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
