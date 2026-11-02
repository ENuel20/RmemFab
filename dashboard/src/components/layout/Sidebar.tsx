import React from 'react'
import {
  LayoutDashboard,
  Cpu,
  Activity,
  GitCompare,
  Network,
  Settings,
  PlusCircle,
  Database
} from 'lucide-react'

export type NavView =
  | 'overview'
  | 'builder'
  | 'runs'
  | 'comparison'
  | 'infrastructure'
  | 'settings'

interface SidebarProps {
  currentView: NavView
  onSelectView: (view: NavView) => void
  onNewScenario: () => void
  isMockMode?: boolean
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onSelectView,
  onNewScenario,
  isMockMode = true
}) => {
  const navItems: Array<{
    id: NavView
    label: string
    icon: React.ReactNode
    badge?: string
  }> = [
    {
      id: 'overview',
      label: 'Overview',
      icon: <LayoutDashboard size={18} className="nav-icon" />
    },
    {
      id: 'builder',
      label: 'Scenario Builder',
      icon: <Cpu size={18} className="nav-icon" />,
      badge: 'Editor'
    },
    {
      id: 'runs',
      label: 'Simulation Runs',
      icon: <Activity size={18} className="nav-icon" />,
      badge: '6'
    },
    {
      id: 'comparison',
      label: 'Policy Comparison',
      icon: <GitCompare size={18} className="nav-icon" />
    },
    {
      id: 'infrastructure',
      label: 'Infrastructure',
      icon: <Network size={18} className="nav-icon" />
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: <Settings size={18} className="nav-icon" />
    }
  ]

  return (
    <aside className="app-sidebar">
      {/* Brand Header */}
      <div className="sidebar-header">
        <div className="brand-wrapper">
          <div className="brand-logo-icon">
            <Database size={20} />
          </div>
          <div className="brand-info">
            <div className="brand-name">
              <span>RmemFab</span>
              <span className="brand-version-tag">v0.1</span>
            </div>
            <span className="brand-subtitle">Remote Memory Simulator</span>
          </div>
        </div>
      </div>

      {/* Primary Action Button */}
      <div className="sidebar-cta-section">
        <button
          className="btn-new-scenario"
          onClick={onNewScenario}
          title="Create a new memory fabric scenario"
        >
          <PlusCircle size={16} />
          <span>New Scenario</span>
        </button>
      </div>

      {/* Main Navigation Menu */}
      <nav className="sidebar-nav">
        <div className="nav-section-title">EXPLORATION</div>
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${currentView === item.id ? 'active' : ''}`}
            onClick={() => onSelectView(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badge && <span className="nav-badge">{item.badge}</span>}
          </button>
        ))}
      </nav>

      {/* Sidebar Footer with Demo Badge */}
      <div className="sidebar-footer">
        <div className="mode-badge-card">
          <div className="mode-badge-left">
            <div className={`status-indicator-dot ${!isMockMode ? 'connected' : ''}`} />
            <span className="mode-title">{isMockMode ? 'Mock Telemetry' : 'FastAPI Live'}</span>
          </div>
          <span className="mode-tag">{isMockMode ? 'DEMO' : 'LIVE'}</span>
        </div>

        <div className="sidebar-spec-info">
          <span>Schema 2020-12</span>
          <span>Draft v0.1</span>
        </div>
      </div>
    </aside>
  )
}

