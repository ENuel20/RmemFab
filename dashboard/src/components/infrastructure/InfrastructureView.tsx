import React, { useState } from 'react'
import {
  Network,
  Database,
  Layers,
  ArrowRightLeft,
  Server,
  HardDrive
} from 'lucide-react'
import { Badge } from '../common/Badge'

export const InfrastructureView: React.FC = () => {
  const [selectedTopology, setSelectedTopology] = useState<'cxl' | 'rdma'>('cxl')
  const [hoveredLink, setHoveredLink] = useState<string | null>(null)

  return (
    <div className="app-content">
      {/* Topology Header Controls */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Network size={16} color="var(--accent-cyan)" />
              <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                Simulated Remote-Memory Hardware Topology
              </h3>
              <Badge variant="cyan">ARCHITECTURAL MODEL</Badge>
            </div>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Analytical model of compute host caches, fabric interconnects, and disaggregated memory
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Topology Preset:</span>
            <button
              className={`btn btn-sm ${selectedTopology === 'cxl' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setSelectedTopology('cxl')}
            >
              4-Node CXL 2.0 Pooled (Llama-70B)
            </button>
            <button
              className={`btn btn-sm ${selectedTopology === 'rdma' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setSelectedTopology('rdma')}
            >
              8-Node RDMA RoCE (MoE Cluster)
            </button>
          </div>
        </div>
      </div>

      {/* SVG & Card Architectural Visualization Canvas */}
      <div
        className="card"
        style={{
          padding: '32px 24px',
          backgroundColor: 'var(--bg-card)',
          position: 'relative',
          overflow: 'hidden'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Badge variant={selectedTopology === 'cxl' ? 'teal' : 'violet'}>
              {selectedTopology === 'cxl' ? 'CXL.mem Point-to-Point' : 'RDMA / RoCEv2 Fabric'}
            </Badge>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              {selectedTopology === 'cxl'
                ? '4x H100-80GB Nodes &bull; 48 GB/s CXL 2.0 Links &bull; 180ns Access Latency'
                : '8x A100-80GB Nodes &bull; 25 GB/s RDMA Links &bull; 2,500ns Access Latency'}
            </span>
          </div>

          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Hover over links to view simulated bandwidth & latency characteristics
          </div>
        </div>

        {/* Diagram Layout */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '16px',
            marginBottom: '40px'
          }}
        >
          {/* Compute Nodes */}
          {(selectedTopology === 'cxl' ? [0, 1, 2, 3] : [0, 1, 2, 3, 4, 5, 6, 7]).map((nodeIdx) => {
            const nodeId = `node-${nodeIdx}`
            const linkId = selectedTopology === 'cxl' ? `${nodeId}-cxl` : `${nodeId}-rdma`
            const isHovered = hoveredLink === linkId

            return (
              <div
                key={nodeId}
                onMouseEnter={() => setHoveredLink(linkId)}
                onMouseLeave={() => setHoveredLink(null)}
                style={{
                  padding: '16px',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'var(--bg-card-secondary)',
                  border: isHovered ? '1px solid var(--accent-cyan)' : '1px solid var(--border-card)',
                  transition: 'all 0.15s ease',
                  boxShadow: isHovered ? '0 4px 16px rgba(6, 182, 212, 0.2)' : 'none'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Server size={14} color="var(--accent-cyan)" />
                    <span className="mono" style={{ fontWeight: 600 }}>{nodeId}</span>
                  </div>
                  <Badge variant="cyan">COMPUTE</Badge>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Accelerator: </span>
                    <strong style={{ color: 'var(--text-primary)' }}>
                      {selectedTopology === 'cxl' ? '8x H100 (80GB)' : '8x A100 (80GB)'}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Local DRAM: </span>
                    <strong style={{ color: 'var(--text-primary)' }}>
                      {selectedTopology === 'cxl' ? '512 GiB DDR5' : '256 GiB DDR4'}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Local Latency / BW: </span>
                    <span>{selectedTopology === 'cxl' ? '90 ns / 400 GB/s' : '95 ns / 300 GB/s'}</span>
                  </div>
                </div>

                <div
                  style={{
                    marginTop: '12px',
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: 'var(--bg-input)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '10px'
                  }}
                >
                  <span style={{ color: 'var(--accent-teal)' }}>{linkId}</span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {selectedTopology === 'cxl' ? '48 GB/s &bull; 180ns' : '25 GB/s &bull; 2.5µs'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        {/* Fabric Interconnect Hub / Switch */}
        <div
          style={{
            margin: '0 auto 40px auto',
            maxWidth: '680px',
            padding: '16px 24px',
            borderRadius: 'var(--radius-lg)',
            background: 'linear-gradient(90deg, rgba(6, 182, 212, 0.1) 0%, rgba(139, 92, 246, 0.1) 100%)',
            border: '1px solid var(--border-hover)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'var(--bg-card)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-cyan)'
              }}
            >
              <ArrowRightLeft size={18} />
            </div>
            <div>
              <h4 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {selectedTopology === 'cxl' ? 'CXL 2.0 Pooled Switch Fabric' : '200Gb RoCEv2 Network Fabric'}
              </h4>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                {selectedTopology === 'cxl'
                  ? 'PCIe Gen5 x16 PHY &bull; Coherent CXL.mem protocol &bull; 64 MB FIFO link queues'
                  : 'InfiniBand / RoCEv2 &bull; Hardware offloaded RDMA read/write &bull; 32 MB buffers'}
              </span>
            </div>
          </div>

          <Badge variant="teal">BIDIRECTIONAL</Badge>
        </div>

        {/* Remote Disaggregated Memory Pool */}
        <div
          style={{
            margin: '0 auto',
            maxWidth: '560px',
            padding: '20px 24px',
            borderRadius: 'var(--radius-lg)',
            backgroundColor: 'var(--bg-card-secondary)',
            border: '1px solid rgba(139, 92, 246, 0.4)',
            boxShadow: '0 4px 20px rgba(139, 92, 246, 0.15)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Database size={18} color="var(--accent-violet)" />
              <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                remote-pool (Disaggregated Memory Tier)
              </span>
            </div>
            <Badge variant="violet">REMOTE TIER</Badge>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', textAlign: 'center' }}>
            <div style={{ padding: '8px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>TOTAL CAPACITY</span>
              <p className="tabular-nums" style={{ fontSize: '16px', fontWeight: 700, color: 'var(--accent-violet)', marginTop: '2px' }}>
                {selectedTopology === 'cxl' ? '4.4 TB' : '8.8 TB'}
              </p>
            </div>
            <div style={{ padding: '8px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>ACCESS LATENCY</span>
              <p className="tabular-nums" style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>
                {selectedTopology === 'cxl' ? '180 ns' : '2,500 ns'}
              </p>
            </div>
            <div style={{ padding: '8px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>TIER BANDWIDTH</span>
              <p className="tabular-nums" style={{ fontSize: '16px', fontWeight: 700, color: 'var(--accent-cyan)', marginTop: '2px' }}>
                {selectedTopology === 'cxl' ? '48 GB/s' : '25 GB/s'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Hardware Tier Specification Matrix */}
      <div className="card">
        <div className="card-header">
          <div className="card-title-group">
            <div className="card-title">
              <Layers size={16} color="var(--accent-cyan)" />
              <span>Hardware Tier Comparison & Physical Media Characteristics</span>
            </div>
            <div className="card-subtitle">
              Discrete-event analytical timing parameters modeled in RmemFab core
            </div>
          </div>
        </div>

        <div className="table-responsive">
          <table className="data-table">
            <thead>
              <tr>
                <th>Tier / Layer</th>
                <th>Physical Media</th>
                <th>Access Latency</th>
                <th>Per-Link Bandwidth</th>
                <th>Address Model</th>
                <th>Cost Index</th>
                <th>Simulation Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <HardDrive size={13} color="var(--accent-cyan)" />
                    <strong>Local DRAM</strong>
                  </div>
                </td>
                <td>DDR5-5600 Registered ECC</td>
                <td className="tabular-nums" style={{ fontWeight: 600, color: 'var(--accent-cyan)' }}>90 ns</td>
                <td className="tabular-nums">400 GB/s</td>
                <td>Direct physical address translation</td>
                <td>1.0x (Baseline)</td>
                <td><Badge variant="emerald">Simulated</Badge></td>
              </tr>

              <tr>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Database size={13} color="var(--accent-teal)" />
                    <strong>CXL Pooled Memory</strong>
                  </div>
                </td>
                <td>CXL 2.0 Type-3 Device (DDR5)</td>
                <td className="tabular-nums" style={{ fontWeight: 600, color: 'var(--accent-teal)' }}>180 ns</td>
                <td className="tabular-nums">48 GB/s (PCIe Gen5 x16)</td>
                <td>Abstract page IDs over CXL.mem</td>
                <td>0.45x per GiB</td>
                <td><Badge variant="emerald">Simulated</Badge></td>
              </tr>

              <tr>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Network size={13} color="var(--accent-violet)" />
                    <strong>RDMA Far Memory</strong>
                  </div>
                </td>
                <td>Disaggregated RoCEv2 Appliance</td>
                <td className="tabular-nums" style={{ fontWeight: 600, color: 'var(--accent-violet)' }}>2,500 ns</td>
                <td className="tabular-nums">25 GB/s (200Gb NIC)</td>
                <td>Async two-sided / one-sided RDMA</td>
                <td>0.20x per GiB</td>
                <td><Badge variant="emerald">Simulated</Badge></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
