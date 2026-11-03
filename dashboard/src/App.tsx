import { useState, useEffect } from 'react'
import { Sidebar, type NavView } from './components/layout/Sidebar'
import { Header } from './components/layout/Header'
import { OverviewView } from './components/overview/OverviewView'
import { ScenarioBuilderView } from './components/builder/ScenarioBuilderView'
import { SimulationRunsView, RunDetailInspector } from './components/runs/SimulationRunsView'
import { PolicyComparisonView } from './components/comparison/PolicyComparisonView'
import { InfrastructureView } from './components/infrastructure/InfrastructureView'
import { TracesView } from './components/traces/TracesView'
import { AssistantView } from './components/assistant/AssistantView'
import { ServingView } from './components/serving/ServingView'
import { SettingsView } from './components/settings/SettingsView'
import { Modal } from './components/common/Modal'
import { ToastContainer, type ToastMessage } from './components/common/Toast'
import { apiClient } from './services/api'
import type { SimulationRun, TraceProfile } from './types/telemetry'
import type { ScenarioConfig } from './types/scenario'
import './App.css'

export function App() {
  const [currentView, setCurrentView] = useState<NavView>('overview')
  const [runs, setRuns] = useState<SimulationRun[]>([])
  const [activeRunDetail, setActiveRunDetail] = useState<SimulationRun | null>(null)
  const [selectedComparisonIds, setSelectedComparisonIds] = useState<string[]>([])
  const [activeScenarioName, setActiveScenarioName] = useState<string>('llama-70b-cxl')
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [isMockMode, setIsMockMode] = useState<boolean>(() => apiClient.isMockMode())
  const [traceWorkloadSeed, setTraceWorkloadSeed] = useState<{ path: string; nonce: number } | null>(null)

  // Toast dispatch
  const notify = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString(36) + Math.random().toString(36).substring(2)
    setToasts((prev) => [...prev, { id, text, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4000)
  }

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  // Load runs on mount
  useEffect(() => {
    const loadRuns = async () => {
      try {
        const data = await apiClient.getRuns()
        setRuns(data)
        setIsMockMode(apiClient.isMockMode())
      } catch (err) {
        setIsMockMode(apiClient.isMockMode())
        notify(
          err instanceof Error ? err.message : 'Failed to query live FastAPI backend',
          'error'
        )
      }
    }
    loadRuns()
  }, [])

  // Toggle run selection for Policy Comparison
  const handleToggleRunComparison = (runId: string) => {
    setSelectedComparisonIds((prev) =>
      prev.includes(runId) ? prev.filter((id) => id !== runId) : [...prev, runId]
    )
  }

  // Navigate to Policy Comparison with given runs
  const handleNavigateToComparison = (initialRunIds?: string[]) => {
    if (initialRunIds && initialRunIds.length > 0) {
      setSelectedComparisonIds(initialRunIds)
    }
    setCurrentView('comparison')
  }

  // Reset to default benchmark pair (first two completed runs, whatever they are)
  const handleSelectBenchmarkPair = () => {
    const completed = runs.filter((r) => r.status === 'completed').slice(0, 2)
    if (completed.length < 2) {
      notify('Need at least two completed runs for a comparison', 'error')
      return
    }
    setSelectedComparisonIds(completed.map((r) => r.id))
    notify(`Selected pair: ${completed.map((r) => r.policy_display_name || r.policy_name).join(' vs ')}`, 'info')
  }

  // Handle new scenario click
  const handleNewScenario = () => {
    setCurrentView('builder')
    notify('Scenario builder opened with default specification template', 'info')
  }

  // Handle scenario saved
  const handleScenarioSaved = (scenario: ScenarioConfig) => {
    setActiveScenarioName(scenario.name)
  }

  // Handle successful scenario submission
  const handleRunSubmitted = async (runId: string) => {
    try {
      const data = await apiClient.getRuns()
      setRuns(data)
      notify(`Run list refreshed with new submission (Run ID: ${runId})`, 'info')
    } catch (err) {
      notify(
        `Simulation submitted (ID: ${runId}), but failed to refresh runs: ${
          err instanceof Error ? err.message : 'Unknown error'
        }`,
        'error'
      )
    }
  }

  // Handle telemetry mode change from Settings
  const handleModeChange = async (mockEnabled: boolean) => {
    setIsMockMode(mockEnabled)
    try {
      const data = await apiClient.getRuns()
      setRuns(data)
    } catch (err) {
      if (!mockEnabled) {
        notify(
          `Live backend request failed: ${err instanceof Error ? err.message : 'Unknown error'}. Return to Mock mode if backend is offline.`,
          'error'
        )
      }
    }
  }

  const refreshRuns = async () => {
    try {
      setRuns(await apiClient.getRuns())
    } catch {
      // Leave existing list in place; callers notify on failure.
    }
  }

  const handleUseTraceInBuilder = (trace: TraceProfile) => {
    if (!trace.workload_path) return
    setTraceWorkloadSeed({ path: trace.workload_path, nonce: Date.now() })
    setCurrentView('builder')
    notify(`Builder workload set to trace ${trace.trace_id.slice(0, 12)}`, 'info')
  }

  // Restore defaults
  const handleResetDefaults = async () => {
    apiClient.resetToDefaults()
    setIsMockMode(apiClient.isMockMode())
    try {
      const data = await apiClient.getRuns()
      setRuns(data)
    } catch {
      // ignore
    }
    notify('Reset persistent settings, in-memory API configuration, and restored demo scenarios', 'success')
  }

  return (
    <div className="app-container">
      {/* Persistent Left Sidebar */}
      <Sidebar
        currentView={currentView}
        onSelectView={(view) => setCurrentView(view)}
        onNewScenario={handleNewScenario}
        isMockMode={isMockMode}
      />

      {/* Main Workspace */}
      <div className="app-main">
        {/* Sticky Top Header */}
        <Header
          currentView={currentView}
          activeScenarioName={activeScenarioName}
          isMockMode={isMockMode}
        />

        {/* View Switcher */}
        {currentView === 'overview' && (
          <OverviewView
            runs={runs}
            isMockMode={isMockMode}
            onOpenRunDetails={(run) => setActiveRunDetail(run)}
            onNavigateToBuilder={() => setCurrentView('builder')}
            onNavigateToComparison={handleNavigateToComparison}
          />
        )}

        {currentView === 'builder' && (
          <ScenarioBuilderView
            onNotify={notify}
            onScenarioSaved={handleScenarioSaved}
            onRunSubmitted={handleRunSubmitted}
            traceWorkloadSeed={traceWorkloadSeed}
          />
        )}

        {currentView === 'runs' && (
          <SimulationRunsView
            runs={runs}
            onOpenRunDetails={(run) => setActiveRunDetail(run)}
            onSelectForComparison={handleToggleRunComparison}
            selectedComparisonIds={selectedComparisonIds}
            isMockMode={isMockMode}
          />
        )}

        {currentView === 'comparison' && (
          <PolicyComparisonView
            runs={runs}
            selectedRunIds={selectedComparisonIds}
            onToggleRunSelection={handleToggleRunComparison}
            onSelectBenchmarkPair={handleSelectBenchmarkPair}
            isMockMode={isMockMode}
          />
        )}

        {currentView === 'infrastructure' && (
          <InfrastructureView
            runs={runs}
            isMockMode={isMockMode}
          />
        )}

        {currentView === 'traces' && (
          <TracesView
            onNotify={notify}
            onUseInBuilder={handleUseTraceInBuilder}
            isMockMode={isMockMode}
          />
        )}

        {currentView === 'assistant' && (
          <AssistantView
            runs={runs}
            onNotify={notify}
            onRefreshRuns={() => void refreshRuns()}
            isMockMode={isMockMode}
          />
        )}

        {currentView === 'serving' && (
          <ServingView
            runs={runs}
            isMockMode={isMockMode}
          />
        )}

        {currentView === 'settings' && (
          <SettingsView
            onNotify={notify}
            onResetDefaults={handleResetDefaults}
            onModeChange={handleModeChange}
          />
        )}
      </div>

      {/* Detailed Run Telemetry Inspector Modal */}
      {activeRunDetail && (
        <Modal
          isOpen={!!activeRunDetail}
          onClose={() => setActiveRunDetail(null)}
          title={
            <div>
              <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {activeRunDetail.scenario_name}
              </span>
              <span className="mono" style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '8px' }}>
                ({activeRunDetail.id})
              </span>
            </div>
          }
          maxWidth="900px"
        >
          <RunDetailInspector
            run={activeRunDetail}
            onSelectForComparison={handleToggleRunComparison}
            isSelectedForComparison={selectedComparisonIds.includes(activeRunDetail.id)}
            onNotify={notify}
            onRunCreated={() => void refreshRuns()}
          />
        </Modal>
      )}

      {/* Global Interactive Notification Toasts */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

export default App
