import React from 'react'
import type { SimulationRun } from '../../types/telemetry'
import { Badge } from '../common/Badge'
import {
  formatNanoseconds,
  formatBytes,
  formatPercent
} from '../../utils/formatters'
import {
  GitCompare,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  TrendingDown,
  Layers,
  Zap,
  ArrowRight,
  Activity
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
}

type CheckStatus = 'match' | 'mismatch' | 'unknown'

interface FairnessCheckItem {
  name: string
  status: CheckStatus
  details: string
}

export const PolicyComparisonView: React.FC<PolicyComparisonViewProps> = ({
  runs,
  selectedRunIds,
  onToggleRunSelection,
  onSelectBenchmarkPair
}) => {
  const selectedRuns = runs.filter((r) => selectedRunIds.includes(r.id))

  // 4-Point Scientific Fairness Validation
  const firstRun = selectedRuns[0]

  const seedCheck: FairnessCheckItem = (() => {
    if (!firstRun) return { name: 'Random Seed', status: 'unknown', details: 'No runs selected' }
    if (selectedRuns.some((r) => typeof r.seed !== 'number')) {
      return { name: 'Random Seed', status: 'unknown', details: 'Cannot verify (seed metadata missing)' }
    }
    const allMatch = selectedRuns.every((r) => r.seed === firstRun.seed)
    return {
      name: 'Random Seed',
      status: allMatch ? 'match' : 'mismatch',
      details: allMatch
        ? `Identical seed: ${firstRun.seed}`
        : `Mismatched seeds: ${selectedRuns.map((r) => `${r.policy_name} (${r.seed})`).join(' vs ')}`
    }
  })()

  const workloadCheck: FairnessCheckItem = (() => {
    if (!firstRun) return { name: 'Workload Profile & Model', status: 'unknown', details: 'No runs selected' }
    if (selectedRuns.some((r) => !r.workload_profile)) {
      return { name: 'Workload Profile & Model', status: 'unknown', details: 'Cannot verify (workload profile metadata missing)' }
    }
    const profileMatch = selectedRuns.every((r) => r.workload_profile === firstRun.workload_profile)
    if (!profileMatch) {
      return {
        name: 'Workload Profile & Model',
        status: 'mismatch',
        details: `Workload profiles differ: ${selectedRuns.map((r) => `${r.policy_name} (${r.workload_profile})`).join(' vs ')}`
      }
    }

    // Deep compare workload parameters from scenario_snapshot if available
    if (selectedRuns.some((r) => !r.scenario_snapshot?.workload)) {
      return {
        name: 'Workload Profile & Model',
        status: 'unknown',
        details: 'Cannot verify (workload snapshot parameters missing)'
      }
    }

    const firstWl = firstRun.scenario_snapshot.workload
    const paramDiffs: string[] = []

    selectedRuns.slice(1).forEach((other) => {
      const otherWl = other.scenario_snapshot.workload
      if (firstWl.type !== otherWl.type) {
        paramDiffs.push(`Workload type (${firstWl.type} vs ${otherWl.type})`)
        return
      }

      if (firstWl.type === 'synthetic' && otherWl.type === 'synthetic') {
        const m1 = firstWl.model || {}
        const m2 = otherWl.model || {}
        if (m1.layers !== m2.layers && (m1.layers !== undefined || m2.layers !== undefined)) {
          paramDiffs.push(`Model layers (${m1.layers ?? '?'} vs ${m2.layers ?? '?'})`)
        }
        if (m1.attention_heads !== m2.attention_heads && (m1.attention_heads !== undefined || m2.attention_heads !== undefined)) {
          paramDiffs.push(`Attention heads (${m1.attention_heads ?? '?'} vs ${m2.attention_heads ?? '?'})`)
        }
        if (m1.kv_heads !== m2.kv_heads && (m1.kv_heads !== undefined || m2.kv_heads !== undefined)) {
          paramDiffs.push(`KV heads (${m1.kv_heads ?? '?'} vs ${m2.kv_heads ?? '?'})`)
        }
        if (m1.experts !== m2.experts && (m1.experts !== undefined || m2.experts !== undefined)) {
          paramDiffs.push(`Experts (${m1.experts ?? '?'} vs ${m2.experts ?? '?'})`)
        }
        if (m1.top_k !== m2.top_k && (m1.top_k !== undefined || m2.top_k !== undefined)) {
          paramDiffs.push(`Top-k (${m1.top_k ?? '?'} vs ${m2.top_k ?? '?'})`)
        }

        const r1 = firstWl.requests || {}
        const r2 = otherWl.requests || {}
        if (r1.concurrency !== r2.concurrency && (r1.concurrency !== undefined || r2.concurrency !== undefined)) {
          paramDiffs.push(`Concurrency (${r1.concurrency ?? '?'} vs ${r2.concurrency ?? '?'})`)
        }
        if (r1.arrival_rate_per_second !== r2.arrival_rate_per_second && (r1.arrival_rate_per_second !== undefined || r2.arrival_rate_per_second !== undefined)) {
          paramDiffs.push(`Arrival rate (${r1.arrival_rate_per_second ?? '?'} vs ${r2.arrival_rate_per_second ?? '?'})`)
        }
      } else if (firstWl.type === 'trace' && otherWl.type === 'trace') {
        if (firstWl.path !== otherWl.path) {
          paramDiffs.push(`Trace path (${firstWl.path} vs ${otherWl.path})`)
        }
      }
    })

    if (paramDiffs.length > 0) {
      return {
        name: 'Workload Profile & Model',
        status: 'mismatch',
        details: `Workload parameters differ: ${paramDiffs.slice(0, 3).join(', ')}${paramDiffs.length > 3 ? ` (+${paramDiffs.length - 3} more)` : ''}`
      }
    }

    return {
      name: 'Workload Profile & Model',
      status: 'match',
      details: `Identical profile (${firstRun.workload_profile}) and model/request parameters`
    }
  })()

  const durationCheck: FairnessCheckItem = (() => {
    if (!firstRun) return { name: 'Simulation Duration', status: 'unknown', details: 'No runs selected' }
    if (selectedRuns.some((r) => typeof r.duration_ns !== 'number')) {
      return { name: 'Simulation Duration', status: 'unknown', details: 'Cannot verify (duration metadata missing)' }
    }
    const allMatch = selectedRuns.every((r) => r.duration_ns === firstRun.duration_ns)
    return {
      name: 'Simulation Duration',
      status: allMatch ? 'match' : 'mismatch',
      details: allMatch
        ? `Identical duration: ${formatNanoseconds(firstRun.duration_ns)}`
        : `Mismatched durations: ${selectedRuns.map((r) => `${r.policy_name} (${formatNanoseconds(r.duration_ns)})`).join(' vs ')}`
    }
  })()

  const hardwareCheck: FairnessCheckItem = (() => {
    if (!firstRun) return { name: 'Hardware & Fabric Topology', status: 'unknown', details: 'No runs selected' }
    if (
      selectedRuns.some(
        (r) =>
          !r.scenario_snapshot ||
          !Array.isArray(r.scenario_snapshot.nodes) ||
          !r.scenario_snapshot.fabric ||
          !Array.isArray(r.scenario_snapshot.fabric.links)
      )
    ) {
      return {
        name: 'Hardware & Fabric Topology',
        status: 'unknown',
        details: 'Cannot verify (hardware/fabric snapshot missing)'
      }
    }

    const firstSnap = firstRun.scenario_snapshot
    const topoDiffs: string[] = []

    for (const other of selectedRuns.slice(1)) {
      const snap = other.scenario_snapshot

      // Node count comparison
      if (snap.nodes.length !== firstSnap.nodes.length) {
        topoDiffs.push(`Node count differs (${firstSnap.nodes.length} vs ${snap.nodes.length})`)
        break
      }

      // Link count comparison
      if (snap.fabric.links.length !== firstSnap.fabric.links.length) {
        topoDiffs.push(`Fabric link count differs (${firstSnap.fabric.links.length} vs ${snap.fabric.links.length})`)
        break
      }

      // Node-by-node detailed property comparison
      for (const node of firstSnap.nodes) {
        const otherNode = snap.nodes.find((n) => n.id === node.id)
        if (!otherNode) {
          topoDiffs.push(`Node "${node.id}" missing in ${other.policy_name}`)
          continue
        }
        if (otherNode.role !== node.role) {
          topoDiffs.push(`Node "${node.id}" role differs (${node.role} vs ${otherNode.role})`)
        }

        // Local memory configuration
        if (node.local_memory && otherNode.local_memory) {
          if (node.local_memory.capacity_bytes !== otherNode.local_memory.capacity_bytes) {
            topoDiffs.push(
              `Node "${node.id}" local capacity differs (${formatBytes(node.local_memory.capacity_bytes)} vs ${formatBytes(otherNode.local_memory.capacity_bytes)})`
            )
          }
          if (node.local_memory.bandwidth_bytes_per_ns !== otherNode.local_memory.bandwidth_bytes_per_ns) {
            topoDiffs.push(
              `Node "${node.id}" local bandwidth differs (${node.local_memory.bandwidth_bytes_per_ns} vs ${otherNode.local_memory.bandwidth_bytes_per_ns} GB/s)`
            )
          }
          if (node.local_memory.latency_ns !== otherNode.local_memory.latency_ns) {
            topoDiffs.push(
              `Node "${node.id}" local latency differs (${node.local_memory.latency_ns} vs ${otherNode.local_memory.latency_ns} ns)`
            )
          }
        } else if (Boolean(node.local_memory) !== Boolean(otherNode.local_memory)) {
          topoDiffs.push(`Node "${node.id}" local memory presence mismatch`)
        }

        // Remote memory configuration
        if (node.remote_memory && otherNode.remote_memory) {
          if (node.remote_memory.capacity_bytes !== otherNode.remote_memory.capacity_bytes) {
            topoDiffs.push(
              `Node "${node.id}" remote capacity differs (${formatBytes(node.remote_memory.capacity_bytes)} vs ${formatBytes(otherNode.remote_memory.capacity_bytes)})`
            )
          }
          if (node.remote_memory.bandwidth_bytes_per_ns !== otherNode.remote_memory.bandwidth_bytes_per_ns) {
            topoDiffs.push(
              `Node "${node.id}" remote bandwidth differs (${node.remote_memory.bandwidth_bytes_per_ns} vs ${otherNode.remote_memory.bandwidth_bytes_per_ns} GB/s)`
            )
          }
          if (node.remote_memory.latency_ns !== otherNode.remote_memory.latency_ns) {
            topoDiffs.push(
              `Node "${node.id}" remote latency differs (${node.remote_memory.latency_ns} vs ${otherNode.remote_memory.latency_ns} ns)`
            )
          }
        } else if (Boolean(node.remote_memory) !== Boolean(otherNode.remote_memory)) {
          topoDiffs.push(`Node "${node.id}" remote memory presence mismatch`)
        }

        // Compute accelerators configuration
        if (node.compute && otherNode.compute) {
          if (node.compute.accelerators !== otherNode.compute.accelerators) {
            topoDiffs.push(`Node "${node.id}" accelerator count differs (${node.compute.accelerators} vs ${otherNode.compute.accelerators})`)
          }
          if (node.compute.accelerator !== otherNode.compute.accelerator) {
            topoDiffs.push(`Node "${node.id}" accelerator type differs (${node.compute.accelerator} vs ${otherNode.compute.accelerator})`)
          }
        }
      }

      // Link-by-link connectivity & performance comparison
      for (const link of firstSnap.fabric.links) {
        const otherLink = snap.fabric.links.find((l) => l.id === link.id)
        if (!otherLink) {
          topoDiffs.push(`Fabric link "${link.id}" missing in ${other.policy_name}`)
          continue
        }
        if (otherLink.from !== link.from || otherLink.to !== link.to) {
          topoDiffs.push(`Fabric link "${link.id}" routing differs (${link.from}&rarr;${link.to} vs ${otherLink.from}&rarr;${otherLink.to})`)
        }
        if (otherLink.latency_ns !== link.latency_ns) {
          topoDiffs.push(`Fabric link "${link.id}" latency differs (${link.latency_ns} vs ${otherLink.latency_ns} ns)`)
        }
        if (otherLink.bandwidth_bytes_per_ns !== link.bandwidth_bytes_per_ns) {
          topoDiffs.push(`Fabric link "${link.id}" bandwidth differs (${link.bandwidth_bytes_per_ns} vs ${otherLink.bandwidth_bytes_per_ns} GB/s)`)
        }
      }
    }

    if (topoDiffs.length > 0) {
      return {
        name: 'Hardware & Fabric Topology',
        status: 'mismatch',
        details: `Hardware topology differs: ${topoDiffs.slice(0, 3).join('; ')}${topoDiffs.length > 3 ? ` (+${topoDiffs.length - 3} more)` : ''}`
      }
    }

    return {
      name: 'Hardware & Fabric Topology',
      status: 'match',
      details: `Identical topology: verified ${firstSnap.nodes.length} nodes (roles, local/remote memory) & ${firstSnap.fabric.links.length} fabric links`
    }
  })()

  const fairnessChecks = [seedCheck, workloadCheck, durationCheck, hardwareCheck]
  const isStrictFairComparison = fairnessChecks.every((c) => c.status === 'match')
  const hasMismatch = fairnessChecks.some((c) => c.status === 'mismatch')

  // Comparative chart data
  const latencyData = selectedRuns.map((r) => ({
    name: r.policy_name,
    p50: r.metrics.latency_ns.p50,
    p95: r.metrics.latency_ns.p95,
    p99: r.metrics.latency_ns.p99
  }))

  const hitRatioData = selectedRuns.map((r) => ({
    name: r.policy_name,
    localHitPct: parseFloat((r.metrics.local_hit_ratio * 100).toFixed(1)),
    remoteHitPct: parseFloat((r.metrics.remote_hit_ratio * 100).toFixed(1)),
    missPct: parseFloat((r.metrics.miss_ratio * 100).toFixed(1))
  }))

  const trafficData = selectedRuns.map((r) => ({
    name: r.policy_name,
    remoteTrafficGb: parseFloat((r.metrics.remote_traffic_bytes / (1024 ** 3)).toFixed(1)),
    migrationGb: parseFloat((r.metrics.migration_bytes / (1024 ** 3)).toFixed(1)),
    fabricUtilPct: parseFloat((r.metrics.fabric_utilization * 100).toFixed(1))
  }))

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
              return (
                <button
                  key={r.id}
                  className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-outline'}`}
                  style={{ fontSize: '11px', padding: '4px 10px' }}
                  onClick={() => onToggleRunSelection(r.id)}
                >
                  {r.policy_name} ({r.scenario_name.split('-')[0]})
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Empty State when fewer than 2 runs are selected */}
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
            Compare how different memory tiering algorithms (Swap-to-Remote, Hot/Cold EWMA, Frequency-Aware)
            impact latency distributions and fabric link congestion.
          </p>
          <button className="btn btn-primary" onClick={onSelectBenchmarkPair}>
            <span>Compare Benchmark Pair: Swap vs. Hot/Cold</span>
            <ArrowRight size={14} />
          </button>
        </div>
      )}

      {selectedRuns.length >= 2 && (
        <>
          {/* Scientific Validation Guarantee Banner with 4-Point Breakdown */}
          <div
            className="card"
            style={{
              backgroundColor: isStrictFairComparison
                ? 'rgba(16, 185, 129, 0.08)'
                : hasMismatch
                ? 'rgba(245, 158, 11, 0.08)'
                : 'rgba(6, 182, 212, 0.08)',
              borderColor: isStrictFairComparison
                ? 'rgba(16, 185, 129, 0.35)'
                : hasMismatch
                ? 'rgba(245, 158, 11, 0.4)'
                : 'rgba(6, 182, 212, 0.35)',
              padding: '16px 20px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {isStrictFairComparison ? (
                  <CheckCircle2 size={18} color="var(--accent-emerald)" />
                ) : hasMismatch ? (
                  <AlertTriangle size={18} color="var(--accent-amber)" />
                ) : (
                  <HelpCircle size={18} color="var(--accent-cyan)" />
                )}
                <span
                  style={{
                    fontSize: '14px',
                    fontWeight: 600,
                    color: isStrictFairComparison
                      ? 'var(--accent-emerald)'
                      : hasMismatch
                      ? 'var(--accent-amber)'
                      : 'var(--accent-cyan)'
                  }}
                >
                  {isStrictFairComparison
                    ? 'Scientifically Fair Benchmark (All Controlled Variables Matched)'
                    : hasMismatch
                    ? 'Experimental Warning: Controlled Variable Mismatch Detected'
                    : 'Comparison Status: Partially Verified'}
                </span>
              </div>

              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Protocol: docs/POLICIES.md &sect; Comparison Protocol
              </span>
            </div>

            {/* 4-Point Validator Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
              {fairnessChecks.map((check) => (
                <div
                  key={check.name}
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
                    <Badge
                      variant={
                        check.status === 'match' ? 'emerald' : check.status === 'mismatch' ? 'amber' : 'blue'
                      }
                    >
                      {check.status === 'match' ? 'MATCH' : check.status === 'mismatch' ? 'MISMATCH' : 'CANNOT VERIFY'}
                    </Badge>
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={check.details}>
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
                    <span>Access Latency Comparison (Lower is Better &darr;)</span>
                  </div>
                  <div className="card-subtitle">p50 median vs p95 / p99 tail latency in nanoseconds</div>
                </div>
              </div>

              <div className="chart-container-inner">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={latencyData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} unit=" ns" />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff' }} />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                    <Bar dataKey="p50" name="p50 (Median)" fill="#06b6d4" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="p95" name="p95" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="p99" name="p99 (Tail)" fill="#f43f5e" radius={[4, 4, 0, 0]} />
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
                    <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff' }} />
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
                    <span>Remote Memory Traffic & Proactive Migration Volume (GiB)</span>
                  </div>
                  <div className="card-subtitle">Comparison of fabric bytes transferred and proactive migration overhead</div>
                </div>
              </div>

              <div className="chart-container-inner">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trafficData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} unit=" GiB" />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-card)', borderRadius: '8px', color: '#fff' }} />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                    <Bar dataKey="remoteTrafficGb" name="Remote Traffic (GiB)" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="migrationGb" name="Proactive Migration (GiB)" fill="#06b6d4" radius={[4, 4, 0, 0]} />
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
                    <td style={{ fontWeight: 600 }}>Median Latency (p50)</td>
                    <td><Badge variant="cyan">&darr; Lower is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ fontWeight: 700, color: 'var(--accent-cyan)' }}>
                        {formatNanoseconds(r.metrics.latency_ns.p50)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Tail Latency (p99)</td>
                    <td><Badge variant="cyan">&darr; Lower is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ color: r.metrics.latency_ns.p99 > 500 ? 'var(--accent-rose)' : 'var(--text-primary)' }}>
                        {formatNanoseconds(r.metrics.latency_ns.p99)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Stall Time</td>
                    <td><Badge variant="cyan">&darr; Lower is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums">
                        {formatNanoseconds(r.metrics.stall_time_ns)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Local Hit Ratio</td>
                    <td><Badge variant="emerald">&uarr; Higher is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ fontWeight: 600, color: 'var(--accent-teal)' }}>
                        {formatPercent(r.metrics.local_hit_ratio)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Remote Hit Ratio</td>
                    <td><Badge variant="blue">Workload dependent</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums">
                        {formatPercent(r.metrics.remote_hit_ratio)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Remote Traffic Volume</td>
                    <td><Badge variant="cyan">&darr; Lower is better</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums">
                        {formatBytes(r.metrics.remote_traffic_bytes)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Proactive Migration Volume</td>
                    <td><Badge variant="blue">Trade-off metric</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums">
                        {formatBytes(r.metrics.migration_bytes)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Fabric Utilization</td>
                    <td><Badge variant="amber">&darr; Moderate is better (&lt;70%)</Badge></td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} className="tabular-nums" style={{ color: r.metrics.fabric_utilization > 0.7 ? 'var(--accent-rose)' : 'var(--text-primary)' }}>
                        {formatPercent(r.metrics.fabric_utilization)}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td style={{ fontWeight: 600 }}>Identified Bottleneck</td>
                    <td>-</td>
                    {selectedRuns.map((r) => (
                      <td key={r.id} style={{ fontSize: '12px', maxWidth: '240px' }}>
                        {r.bottleneck.primary_bottleneck}
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
