import React, { useState } from 'react'
import { apiClient, type ApiStatus } from '../../services/api'
import { Badge } from '../common/Badge'
import {
  Server,
  Database,
  RefreshCw,
  Terminal,
  CheckCircle2,
  AlertCircle,
  RotateCcw
} from 'lucide-react'

interface SettingsViewProps {
  onNotify: (text: string, type: 'success' | 'error' | 'info') => void
  onResetDefaults: () => void
  onModeChange?: (mockEnabled: boolean) => void
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  onNotify,
  onResetDefaults,
  onModeChange
}) => {
  const [apiUrl, setApiUrl] = useState<string>(apiClient.getBaseUrl())
  const [isMockMode, setIsMockMode] = useState<boolean>(apiClient.isMockMode())
  const [testingConnection, setTestingConnection] = useState<boolean>(false)
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null)

  const handleSaveApiUrl = () => {
    const trimmed = apiUrl.trim()
    apiClient.setBaseUrl(trimmed)
    setApiUrl(trimmed)
    onNotify(`FastAPI Run API endpoint updated to: ${trimmed}`, 'success')
  }

  const handleToggleMock = (enabled: boolean) => {
    setIsMockMode(enabled)
    apiClient.setMockMode(enabled)
    setApiStatus(null)
    onModeChange?.(enabled)
    onNotify(
      enabled
        ? 'Switched to Standalone Mock Telemetry Provider (Demo mode)'
        : 'Switched to Live Backend Mode (FastAPI)',
      'info'
    )
  }

  const handleTestConnection = async () => {
    setTestingConnection(true)
    const status = await apiClient.checkHealth()
    setApiStatus(status)
    setTestingConnection(false)
    if (status.connected) {
      onNotify('Successfully connected to FastAPI Run API!', 'success')
    } else {
      if (isMockMode) {
        onNotify('Mock Telemetry Mode is currently enabled. Switch to Live mode to query live FastAPI backend.', 'info')
      } else {
        onNotify(`FastAPI backend is unreachable at ${apiUrl}. Verify server is running at this URL.`, 'error')
      }
    }
  }

  const handleReset = () => {
    onResetDefaults()
    setApiUrl('http://localhost:8000')
    setIsMockMode(true)
    setApiStatus(null)
  }

  return (
    <div className="app-content">
      {/* Backend API Integration Section */}
      <div className="card">
        <div className="card-header">
          <div className="card-title-group">
            <div className="card-title">
              <Server size={16} color="var(--accent-cyan)" />
              <span>FastAPI Run API Service Configuration</span>
            </div>
            <div className="card-subtitle">
              Manage the bridge between this dashboard UI and the Python simulation engine
            </div>
          </div>

          <Badge variant={isMockMode ? 'amber' : 'emerald'}>
            {isMockMode ? 'MOCK TELEMETRY MODE' : 'LIVE BACKEND MODE'}
          </Badge>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="form-group">
            <label className="form-label">FastAPI Run API Base URL</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                style={{ flex: 1 }}
                placeholder="http://localhost:8000"
              />
              <button className="btn btn-secondary" onClick={handleSaveApiUrl}>
                Save URL
              </button>
              <button
                className="btn btn-outline"
                onClick={handleTestConnection}
                disabled={testingConnection}
              >
                <RefreshCw size={13} className={testingConnection ? 'spin' : ''} />
                <span>{testingConnection ? 'Probing...' : 'Test Health'}</span>
              </button>
            </div>
            <span className="form-help">
              Expected FastAPI endpoint running `uvicorn rmemfab.api.app:app`
            </span>
          </div>

          {/* Test Status Display */}
          {apiStatus && (
            <div
              style={{
                padding: '12px 16px',
                borderRadius: 'var(--radius-md)',
                backgroundColor: apiStatus.connected ? 'rgba(16, 185, 129, 0.08)' : 'rgba(245, 158, 11, 0.08)',
                border: apiStatus.connected ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(245, 158, 11, 0.3)',
                display: 'flex',
                alignItems: 'center',
                gap: '10px'
              }}
            >
              {apiStatus.connected ? (
                <CheckCircle2 size={16} color="var(--accent-emerald)" />
              ) : (
                <AlertCircle size={16} color="var(--accent-amber)" />
              )}
              <div style={{ fontSize: '12px' }}>
                <strong>Status: </strong>
                <span>{apiStatus.message}</span>
              </div>
            </div>
          )}

          {/* Mode Switcher */}
          <div
            style={{
              padding: '14px 18px',
              backgroundColor: 'var(--bg-card-secondary)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-card)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <div>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                Telemetry Data Provider
              </span>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                Use mock datasets when running the frontend independently, or switch to live backend runs.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                className={`btn btn-sm ${isMockMode ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => handleToggleMock(true)}
              >
                Mock Data Provider
              </button>
              <button
                className={`btn btn-sm ${!isMockMode ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => handleToggleMock(false)}
              >
                Live FastAPI
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* System Specifications Card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title-group">
            <div className="card-title">
              <Terminal size={16} color="var(--accent-teal)" />
              <span>Specification Contracts & System Info</span>
            </div>
            <div className="card-subtitle">
              Versioned contracts implemented across CLI, Engine, and Frontend
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
          <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>CONFIG SCHEMA</span>
            <p style={{ fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>Draft 2020-12</p>
            <span style={{ fontSize: '11px', color: 'var(--accent-cyan)' }}>
              SPECS/config.schema.json
            </span>
          </div>

          <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>SIMULATION VERSION</span>
            <p style={{ fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>v0.1-preview</p>
            <span style={{ fontSize: '11px', color: 'var(--accent-teal)' }}>
              Phase 4: Dashboard
            </span>
          </div>

          <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>EXECUTION PARADIGM</span>
            <p style={{ fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>Deterministic DES</p>
            <span style={{ fontSize: '11px', color: 'var(--accent-violet)' }}>
              Virtual Time (ns)
            </span>
          </div>

          <div style={{ padding: '12px', background: 'var(--bg-card-secondary)', borderRadius: 'var(--radius-md)' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>SECURITY ISOLATION</span>
            <p style={{ fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>Zero Credentials</p>
            <span style={{ fontSize: '11px', color: 'var(--accent-emerald)' }}>
              No API Keys Required
            </span>
          </div>
        </div>
      </div>

      {/* Local Storage & Cache Controls */}
      <div className="card">
        <div className="card-header">
          <div className="card-title-group">
            <div className="card-title">
              <Database size={16} color="var(--accent-amber)" />
              <span>Workspace Data & Presets</span>
            </div>
            <div className="card-subtitle">
              Reset scenarios and local cache
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <span style={{ fontSize: '13px', fontWeight: 600 }}>Reset Scenarios to Clean State</span>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Restores default Llama-70B CXL and MoE RDMA benchmark scenarios.
            </p>
          </div>

          <button className="btn btn-outline" onClick={handleReset}>
            <RotateCcw size={13} />
            <span>Restore Default Scenarios & API Defaults</span>
          </button>
        </div>
      </div>
    </div>
  )
}
