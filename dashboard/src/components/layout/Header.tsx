import React from 'react'
import type { NavView } from './Sidebar'
import { ChevronRight, Database, Terminal } from 'lucide-react'

interface HeaderProps {
  currentView: NavView
  activeScenarioName?: string
  isMockMode?: boolean
}

const VIEW_METADATA: Record<NavView, { title: string; subtitle: string }> = {
  overview: {
    title: 'Simulation Overview',
    subtitle: 'High-level telemetry, KPI trends, and memory-tier utilization across active experiments'
  },
  builder: {
    title: 'Scenario Builder',
    subtitle: 'Guided scenario editor strictly adhering to SPECS/config.schema.json with instant validation'
  },
  runs: {
    title: 'Simulation Runs',
    subtitle: 'Historical and pre-computed runs with detailed virtual-time telemetry and bottleneck diagnostics'
  },
  comparison: {
    title: 'Policy Comparison',
    subtitle: 'Multi-run policy benchmarking with strict identical-seed and hardware validation guarantees'
  },
  infrastructure: {
    title: 'Infrastructure Architecture',
    subtitle: 'Interactive architectural diagram of compute nodes, fabric interconnects, and disaggregated pools'
  },
  settings: {
    title: 'Settings & Runtime',
    subtitle: 'Configure FastAPI Run API endpoints, toggle simulation mock telemetry, and inspect schemas'
  }
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  activeScenarioName = 'llama-70b-cxl',
  isMockMode = true
}) => {
  const meta = VIEW_METADATA[currentView]

  return (
    <header className="app-header">
      <div className="header-left">
        <div className="breadcrumbs">
          <span>RmemFab</span>
          <ChevronRight size={12} className="breadcrumb-separator" />
          <span style={{ color: 'var(--text-secondary)' }}>{meta.title}</span>
          {currentView === 'builder' && (
            <>
              <ChevronRight size={12} className="breadcrumb-separator" />
              <span style={{ color: 'var(--accent-cyan)' }}>{activeScenarioName}</span>
            </>
          )}
        </div>

        <div className="header-title-row">
          <h1 className="header-page-title">{meta.title}</h1>
          <span className="header-page-desc">{meta.subtitle}</span>
        </div>
      </div>

      <div className="header-right">
        {isMockMode && (
          <div
            className="demo-data-badge"
            title="Showing pre-computed discrete-event simulation results. FastAPI Run API is disconnected."
          >
            <span className="pulsing-dot" />
            <span>DEMO DATA ACTIVE</span>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Database size={12} />
            Discrete-Event Core
          </span>
          <span style={{ fontSize: '11px', color: 'var(--border-card)' }}>|</span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Terminal size={12} />
            CLI v0.1
          </span>
        </div>
      </div>
    </header>
  )
}
