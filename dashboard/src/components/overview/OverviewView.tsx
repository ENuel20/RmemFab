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
  onOpenRunDetails: (run: SimulationRun) => void
  onNavigateToBuilder: () => void
  onNavigateToComparison: (initialRunIds?: string[]) => void
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  runs,
  onOpenRunDetails,
  onNavigateToBuilder,
  onNavigateToComparison
}) => {
  const [activeChartMetric, setActiveChartMetric] = useState<'latency' | 'bandwidth'>('latency')

  // Benchmark run for time-series display
  const primaryRun = runs.find((r) => r.id === 'run-llama-cxl-hotcold') || runs[0]

  // Memory tier distribution data
  const tierDistributionData = [
    { name: 'node-0', localDramGb: 512, remotePoolGb: 1024, acceleratorHbmGb: 80 },
    { name: 'node-1', localDramGb: 512, remotePoolGb: 1024, acceleratorHbmGb: 80 },
    { name: 'node-2', localDramGb: 512, remotePoolGb: 1024, acceleratorHbmGb: 80 },
    { name: 'node-3', localDramGb: 512, remotePoolGb: 1024, acceleratorHbmGb: 80 }
  ]

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
              <Badge variant="amber">DEMO DATASET ACTIVE</Badge>
            </div>
            <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.3px', margin: '4px 0 8px 0' }}>
              Welcome to RmemFab Simulation Studio
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px', lineHeight: 1.6 }}>
              Model, evaluate, and benchmark disaggregated remote-memory fabrics (CXL 2.0 / RDMA RoCE),
              dynamic page placement policies (Hot/Cold EWMA vs. Frequency-Aware LRU-K), and memory-tiering
              bottlenecks under LLM KV-cache decode and MoE expert serving workloads.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              className="btn btn-outline"
              onClick={() => onNavigateToComparison(['run-llama-cxl-swap', 'run-llama-cxl-hotcold'])}
              style={{ fontSize: '12px', padding: '9px 14px' }}
            >
              <span>Compare Swap vs Hot/Cold</span>
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
          value={runs.length}
          subtitle="Across CXL & RDMA scenarios"
          unit="runs"
          trend={{ value: '4 policies active', isPositive: true }}
          icon={<Layers size={16} />}
        />
        <KpiCard
          title="Median Access Latency"
          value="142.4"
          subtitle="p50 access completion time"
          unit="ns"
          trend={{ value: '-38.6% with Hot/Cold', isPositive: true }}
          icon={<TrendingDown size={16} />}
        />
        <KpiCard
          title="Remote Memory Hit Ratio"
          value="78.2"
          subtitle="1.24 TB / 1.58 TB remote touches"
          unit="%"
          trend={{ value: '1.56 TB traffic served', isPositive: true }}
          icon={<Zap size={16} />}
        />
        <KpiCard
          title="Fabric Utilization"
          value="42.6"
          subtitle="Peak 76.8 GB/s on 4x CXL links"
          unit="%"
          trend={{ value: 'Well within 192 GB/s cap', isPositive: true }}
          icon={<Activity size={16} />}
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
                  ({primaryRun?.scenario_name} • seed {primaryRun?.seed})
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
                Access Latency (ns)
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
            <ResponsiveContainer width="100%" height="100%">
              {activeChartMetric === 'latency' ? (
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
                  <Area type="monotone" dataKey="p99_latency_ns" name="p99 Latency (Tail)" stroke="#f43f5e" fillOpacity={1} fill="url(#p99Grad)" />
                  <Area type="monotone" dataKey="p95_latency_ns" name="p95 Latency" stroke="#f59e0b" fillOpacity={0} />
                  <Area type="monotone" dataKey="p50_latency_ns" name="p50 Latency (Median)" stroke="#06b6d4" fillOpacity={1} fill="url(#p50Grad)" />
                </AreaChart>
              ) : (
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
              )}
            </ResponsiveContainer>
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
            <Badge variant="teal">4-Node CXL</Badge>
          </div>

          <div className="chart-container-inner">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={tierDistributionData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} tickLine={false} />
                <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} unit=" GiB" />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff', fontSize: '12px' }}
                />
                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                <Bar dataKey="localDramGb" name="Local DRAM" stackId="a" fill="#0ea5e9" radius={[0, 0, 0, 0]} />
                <Bar dataKey="remotePoolGb" name="Remote CXL Pool" stackId="a" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
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
                <th>p50 Latency</th>
                <th>p99 Latency</th>
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
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{run.scenario_name}</span>
                      <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{run.id}</span>
                    </div>
                  </td>
                  <td>
                    <Badge variant="blue">{run.workload_profile}</Badge>
                  </td>
                  <td>
                    <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{run.policy_name}</span>
                  </td>
                  <td className="mono">{run.seed}</td>
                  <td className="tabular-nums" style={{ fontWeight: 600, color: 'var(--accent-cyan)' }}>
                    {formatNanoseconds(run.metrics.latency_ns.p50)}
                  </td>
                  <td className="tabular-nums" style={{ color: run.metrics.latency_ns.p99 > 1000 ? 'var(--accent-rose)' : 'var(--text-secondary)' }}>
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
              LLM Working Set Dynamics
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Llama-3-70B autoregressive decode grows KV caches by 2.62 MB per sequence token. Hot/cold
              EWMA policies keep the active decode window local, migrating cold prompt contexts to pooled CXL.
            </p>
          </div>
          <div>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Fabric Bottleneck Prevention
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Demand paging causes head-of-line blocking when multiple compute nodes simultaneously fetch
              cold pages. Predictive prefetching and rate-limited migrations avoid fabric congestion.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
