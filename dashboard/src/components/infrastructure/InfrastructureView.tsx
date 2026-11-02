import React, { useState, useEffect } from 'react'
import type { SimulationRun } from '../../types/telemetry'
import { apiClient } from '../../services/api'
import {
  Network,
  Database,
  Layers,
  ArrowRightLeft,
  Server,
  HardDrive,
  AlertTriangle
} from 'lucide-react'
import { Badge } from '../common/Badge'
import { deriveTopologySummary } from './topologyHelpers'
import { reconcileSingleRunSelection } from '../../utils/selectionReconciliation'
import {
  formatBytes,
  formatNanoseconds,
  formatBandwidth,
  formatPercent
} from '../../utils/formatters'

interface InfrastructureViewProps {
  runs?: SimulationRun[]
  selectedRunId?: string
  onSelectRun?: (runId: string) => void
  isMockMode?: boolean
}

export const InfrastructureView: React.FC<InfrastructureViewProps> = ({
  runs = [],
  selectedRunId: externalSelectedRunId,
  onSelectRun,
  isMockMode = true
}) => {
  const [internalSelectedRunId, setInternalSelectedRunId] = useState<string>('')
  const [hoveredLink, setHoveredLink] = useState<string | null>(null)
  const [fetchedRun, setFetchedRun] = useState<SimulationRun | null>(null)

  // Synchronize selection: prefer controlled prop, fallback to internal state, fallback to most recent run
  const activeSelectedRunId = reconcileSingleRunSelection(
    externalSelectedRunId || internalSelectedRunId,
    runs
  )

  const currentRun = runs.find((r) => r.id === activeSelectedRunId) || (runs.length > 0 ? runs[0] : undefined)

  const handleSelectRun = (newRunId: string) => {
    setInternalSelectedRunId(newRunId)
    onSelectRun?.(newRunId)
  }

  useEffect(() => {
    if (!currentRun || currentRun.scenario_snapshot || isMockMode) {
      return
    }

    let ignore = false
    const fetchDetail = async () => {
      try {
        const fullRun = await apiClient.getRun(currentRun.id)
        if (!ignore && fullRun) {
          setFetchedRun(fullRun)
        }
      } catch {
        // retain null
      }
    }

    void fetchDetail()

    return () => {
      ignore = true
    }
  }, [currentRun, isMockMode])

  const activeRun = (fetchedRun && fetchedRun.id === currentRun?.id && !currentRun?.scenario_snapshot) ? fetchedRun : currentRun
  const scenario = activeRun?.scenario_snapshot

  // Empty state: no runs available
  if (!activeRun || runs.length === 0) {
    return (
      <div className="app-content">
        <div
          className="card"
          style={{
            textAlign: 'center',
            padding: '48px 24px',
            backgroundColor: 'var(--bg-card-secondary)',
            borderStyle: 'dashed'
          }}
        >
          <Network size={36} color="var(--accent-cyan)" style={{ margin: '0 auto 12px auto' }} />
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
            No Simulation Run or Scenario Selected
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '480px', margin: '0 auto' }}>
            Run a simulation or load an experiment to inspect its hardware topology, nodes, memory tiers, and link bandwidth.
          </p>
        </div>
      </div>
    )
  }

  const topology = deriveTopologySummary(scenario, activeRun?.metrics)
  const computeNodes = topology.computeNodes
  const memoryPoolNodes = topology.memoryPoolNodes
  const links = topology.links
  const fabricSwitch = scenario?.fabric?.switch

  return (
    <div className="app-content">
      {/* Topology Header Controls */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Network size={16} color="var(--accent-cyan)" />
              <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                Data-Driven Remote-Memory Hardware Topology
              </h3>
              <Badge variant={isMockMode ? 'amber' : 'emerald'}>
                {isMockMode ? 'Demo Dataset' : 'Live Engine'}
              </Badge>
            </div>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Hardware topology, memory tiers, and interconnect properties derived strictly from scenario definition
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Select Run:</span>
            <select
              value={activeRun.id}
              onChange={(e) => handleSelectRun(e.target.value)}
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-primary)',
                fontSize: '12px',
                padding: '6px 10px',
                borderRadius: 'var(--radius-sm)'
              }}
            >
              {runs.map((r) => {
                const shortId = r.id.length > 8 ? r.id.slice(0, 8) : r.id
                return (
                  <option key={r.id} value={r.id}>
                    {r.scenario_name || r.id} ({r.policy_name}) — {shortId}
                  </option>
                )
              })}
            </select>
          </div>
        </div>
      </div>

      {/* Scenario Unavailable Warning */}
      {!scenario && (
        <div
          className="card"
          style={{
            textAlign: 'center',
            padding: '36px 24px',
            backgroundColor: 'var(--bg-card-secondary)',
            borderStyle: 'dashed'
          }}
        >
          <AlertTriangle size={32} color="var(--accent-amber)" style={{ margin: '0 auto 12px auto' }} />
          <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
            Scenario Hardware Definition Unavailable for {activeRun.id}
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '480px', margin: '0 auto' }}>
            The simulation engine manifest did not bundle an authentic scenario configuration for this run. Hardware topology cannot be fabricated.
          </p>
        </div>
      )}

      {/* Data-Driven Architectural Visualization */}
      {scenario && (
        <div
          className="card"
          style={{
            padding: '24px',
            backgroundColor: 'var(--bg-card)',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {/* Topology Metadata Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Badge variant="teal">
                {scenario.name || activeRun.scenario_name || 'Scenario Fabric'}
              </Badge>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {computeNodes.length} Compute Host{computeNodes.length !== 1 ? 's' : ''} &bull; {memoryPoolNodes.length} Disaggregated Memory Pool{memoryPoolNodes.length !== 1 ? 's' : ''} &bull; {links.length} Interconnect Link{links.length !== 1 ? 's' : ''}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span>Seed: <strong style={{ color: 'var(--text-primary)' }}>{scenario.seed ?? activeRun.seed ?? '—'}</strong></span>
              <span>Page Size: <strong style={{ color: 'var(--text-primary)' }}>{scenario.page_size_bytes ? formatBytes(scenario.page_size_bytes) : '—'}</strong></span>
              <span>
                Fabric Util: <strong style={{ color: activeRun.metrics.fabric_utilization != null ? 'var(--accent-cyan)' : 'var(--text-muted)' }}>
                  {activeRun.metrics.fabric_utilization != null ? formatPercent(activeRun.metrics.fabric_utilization) : 'Unavailable'}
                </strong>
              </span>
            </div>
          </div>

          {/* Compute Nodes Grid */}
          <div style={{ marginBottom: '24px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '10px' }}>
              COMPUTE HOSTS ({computeNodes.length})
            </span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '14px'
              }}
            >
              {computeNodes.map((node) => (
                <div
                  key={node.id}
                  style={{
                    padding: '16px',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'var(--bg-card-secondary)',
                    border: '1px solid var(--border-card)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Server size={14} color="var(--accent-cyan)" />
                      <span className="mono" style={{ fontWeight: 600 }}>{node.id}</span>
                    </div>
                    <Badge variant="cyan">COMPUTE</Badge>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Accelerator: </span>
                      <strong style={{ color: 'var(--text-primary)' }}>
                        {node.compute?.accelerator ? `${node.compute.accelerators || 1}x ${node.compute.accelerator}` : 'None'}
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Local DRAM: </span>
                      <strong style={{ color: 'var(--text-primary)' }}>
                        {node.local_memory?.capacity_bytes ? formatBytes(node.local_memory.capacity_bytes) : 'Unavailable'}
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Local Latency / BW: </span>
                      <span>
                        {node.local_memory?.latency_ns != null ? formatNanoseconds(node.local_memory.latency_ns) : '—'} / {node.local_memory?.bandwidth_bytes_per_ns != null ? formatBandwidth(node.local_memory.bandwidth_bytes_per_ns) : '—'}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Local Hit Ratio: </span>
                      <strong style={{ color: activeRun.metrics.local_hit_ratio != null ? 'var(--accent-teal)' : 'var(--text-muted)' }}>
                        {activeRun.metrics.local_hit_ratio != null ? formatPercent(activeRun.metrics.local_hit_ratio) : 'Unavailable'}
                      </strong>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Fabric Interconnect Hub / Switch */}
          {fabricSwitch && (
            <div
              style={{
                margin: '0 auto 24px auto',
                maxWidth: '680px',
                padding: '14px 20px',
                borderRadius: 'var(--radius-lg)',
                background: 'linear-gradient(90deg, rgba(6, 182, 212, 0.08) 0%, rgba(139, 92, 246, 0.08) 100%)',
                border: '1px solid var(--border-card)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'var(--bg-card)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--accent-cyan)'
                  }}
                >
                  <ArrowRightLeft size={16} />
                </div>
                <div>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                    Switch Interconnect Fabric
                  </h4>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    Bisection Bandwidth: {formatBandwidth(fabricSwitch.bandwidth_bytes_per_ns)} &bull; Latency: {formatNanoseconds(fabricSwitch.latency_ns)}
                  </span>
                </div>
              </div>
              <Badge variant="teal">SWITCH</Badge>
            </div>
          )}

          {/* Remote Disaggregated Memory Pools Grid */}
          <div style={{ marginBottom: '24px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '10px' }}>
              DISAGGREGATED MEMORY POOLS ({memoryPoolNodes.length})
            </span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: '14px'
              }}
            >
              {memoryPoolNodes.map((pool) => (
                <div
                  key={pool.id}
                  style={{
                    padding: '16px',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'var(--bg-card-secondary)',
                    border: '1px solid rgba(139, 92, 246, 0.3)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Database size={16} color="var(--accent-violet)" />
                      <span className="mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{pool.id}</span>
                    </div>
                    <Badge variant="violet">REMOTE TIER</Badge>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', textAlign: 'center' }}>
                    <div style={{ padding: '6px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)' }}>
                      <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>CAPACITY</span>
                      <p className="tabular-nums" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--accent-violet)', marginTop: '2px' }}>
                        {pool.remote_memory?.capacity_bytes ? formatBytes(pool.remote_memory.capacity_bytes) : 'Unavailable'}
                      </p>
                    </div>
                    <div style={{ padding: '6px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)' }}>
                      <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>LATENCY</span>
                      <p className="tabular-nums" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>
                        {pool.remote_memory?.latency_ns != null ? formatNanoseconds(pool.remote_memory.latency_ns) : '—'}
                      </p>
                    </div>
                    <div style={{ padding: '6px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)' }}>
                      <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>BANDWIDTH</span>
                      <p className="tabular-nums" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--accent-cyan)', marginTop: '2px' }}>
                        {pool.remote_memory?.bandwidth_bytes_per_ns != null ? formatBandwidth(pool.remote_memory.bandwidth_bytes_per_ns) : '—'}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Fabric Links List */}
          <div>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '10px' }}>
              CONFIGURED FABRIC LINKS ({links.length})
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
              {links.map((link) => {
                const isHovered = hoveredLink === link.id
                return (
                  <div
                    key={link.id}
                    onMouseEnter={() => setHoveredLink(link.id)}
                    onMouseLeave={() => setHoveredLink(null)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-sm)',
                      backgroundColor: isHovered ? 'rgba(6, 182, 212, 0.08)' : 'var(--bg-input)',
                      border: isHovered ? '1px solid var(--accent-cyan)' : '1px solid var(--border-card)',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span className="mono" style={{ fontSize: '11px', fontWeight: 600, color: 'var(--accent-teal)' }}>
                        {link.id}
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        {link.bidirectional ? 'Bidirectional' : 'Unidirectional'}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                      <span>{link.from} &rarr; {link.to}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      <span>BW: {formatBandwidth(link.bandwidth_bytes_per_ns)}</span>
                      <span>Lat: {formatNanoseconds(link.latency_ns)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Dynamic Hardware Tiers Table */}
      {scenario && (
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-title">
                <Layers size={16} color="var(--accent-cyan)" />
                <span>Configured Hardware Memory Tiers</span>
              </div>
              <div className="card-subtitle">
                Exact timing and capacity values configured in {scenario.name || activeRun.id}
              </div>
            </div>
          </div>

          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tier / Entity</th>
                  <th>Node / Component</th>
                  <th>Capacity</th>
                  <th>Access Latency</th>
                  <th>Bandwidth</th>
                  <th>Provenance</th>
                </tr>
              </thead>
              <tbody>
                {computeNodes.map((cn) => (
                  <tr key={cn.id + '-dram'}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <HardDrive size={13} color="var(--accent-cyan)" />
                        <strong>Local DRAM</strong>
                      </div>
                    </td>
                    <td className="mono">{cn.id}</td>
                    <td className="tabular-nums">
                      {cn.local_memory?.capacity_bytes ? formatBytes(cn.local_memory.capacity_bytes) : '—'}
                    </td>
                    <td className="tabular-nums" style={{ fontWeight: 600, color: 'var(--accent-cyan)' }}>
                      {cn.local_memory?.latency_ns != null ? formatNanoseconds(cn.local_memory.latency_ns) : '—'}
                    </td>
                    <td className="tabular-nums">
                      {cn.local_memory?.bandwidth_bytes_per_ns != null ? formatBandwidth(cn.local_memory.bandwidth_bytes_per_ns) : '—'}
                    </td>
                    <td>
                      <Badge variant={cn.local_memory?.provenance?.kind ? 'cyan' : 'amber'}>
                        {cn.local_memory?.provenance?.kind || 'Unspecified'}
                      </Badge>
                    </td>
                  </tr>
                ))}

                {memoryPoolNodes.map((mp) => (
                  <tr key={mp.id + '-pool'}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Database size={13} color="var(--accent-violet)" />
                        <strong>Remote Memory Pool</strong>
                      </div>
                    </td>
                    <td className="mono">{mp.id}</td>
                    <td className="tabular-nums">
                      {mp.remote_memory?.capacity_bytes ? formatBytes(mp.remote_memory.capacity_bytes) : '—'}
                    </td>
                    <td className="tabular-nums" style={{ fontWeight: 600, color: 'var(--accent-violet)' }}>
                      {mp.remote_memory?.latency_ns != null ? formatNanoseconds(mp.remote_memory.latency_ns) : '—'}
                    </td>
                    <td className="tabular-nums">
                      {mp.remote_memory?.bandwidth_bytes_per_ns != null ? formatBandwidth(mp.remote_memory.bandwidth_bytes_per_ns) : '—'}
                    </td>
                    <td>
                      <Badge variant={mp.remote_memory?.provenance?.kind ? 'cyan' : 'amber'}>
                        {mp.remote_memory?.provenance?.kind || 'Unspecified'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
