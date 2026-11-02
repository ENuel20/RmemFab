import { useState, useEffect } from 'react'
import { Sidebar, type NavView } from './components/layout/Sidebar'
import { Header } from './components/layout/Header'
import { OverviewView } from './components/overview/OverviewView'
import { ScenarioBuilderView } from './components/builder/ScenarioBuilderView'
import { SimulationRunsView, RunDetailInspector } from './components/runs/SimulationRunsView'
import { PolicyComparisonView } from './components/comparison/PolicyComparisonView'
import { InfrastructureView } from './components/infrastructure/InfrastructureView'
import { SettingsView } from './components/settings/SettingsView'
import { Modal } from './components/common/Modal'
import { ToastContainer, type ToastMessage } from './components/common/Toast'
import { apiClient } from './services/api'
import type { SimulationRun } from './types/telemetry'
import type { ScenarioConfig } from './types/scenario'
import {
  reconcileComparisonSelection,
  findDefaultComparisonPair,
  reconcileSingleRunSelection
} from './utils/selectionReconciliation.ts'
import './App.css'

export function App() {
  const [currentView, setCurrentView] = useState<NavView>('overview')
  const [runs, setRuns] = useState<SimulationRun[]>([])
  const [activeRunDetail, setActiveRunDetail] = useState<SimulationRun | null>(null)
  const [selectedComparisonIds, setSelectedComparisonIds] = useState<string[]>([
    'run-llama-cxl-swap',
    'run-llama-cxl-hotcold'
  ])
  const [selectedRunId, setSelectedRunId] = useState<string>('')
  const [activeScenarioName, setActiveScenarioName] = useState<string>('llama-70b-cxl')
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [isMockMode, setIsMockMode] = useState<boolean>(true)

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
        const mockActive = apiClient.isMockMode()
        setIsMockMode(mockActive)
        setSelectedComparisonIds((prev) => reconcileComparisonSelection(prev, data, mockActive))
        setSelectedRunId((prev) => reconcileSingleRunSelection(prev, data))
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

  // Open run details modal, ensuring full run detail is retrieved if needed
  const handleOpenRunDetails = async (run: SimulationRun) => {
    setActiveRunDetail(run)
    if (!isMockMode && !run.scenario_snapshot) {
      try {
        const full = await apiClient.getRun(run.id)
        if (full) {
          setActiveRunDetail(full)
          setRuns((prev) => prev.map((r) => r.id === full.id ? full : r))
        }
      } catch {
        // retain summary run
      }
    }
  }

  // Navigate to Policy Comparison with given runs
  const handleNavigateToComparison = (initialRunIds?: string[]) => {
    if (initialRunIds && initialRunIds.length > 0) {
      setSelectedComparisonIds((prev) => {
        if (prev.length === initialRunIds.length && prev.every((id, i) => id === initialRunIds[i])) {
          return prev
        }
        return initialRunIds
      })
    }
    setCurrentView('comparison')
  }

  // Reset to default benchmark pair
  const handleSelectBenchmarkPair = () => {
    if (isMockMode) {
      setSelectedComparisonIds(['run-llama-cxl-swap', 'run-llama-cxl-hotcold'])
      notify('Selected baseline pair: Swap-to-Remote vs. Hot/Cold Migration', 'info')
    } else {
      const pair = findDefaultComparisonPair(runs)
      if (pair) {
        setSelectedComparisonIds(pair)
        const r1 = runs.find((r) => r.id === pair[0])
        const r2 = runs.find((r) => r.id === pair[1])
        notify(`Selected LIVE pair: ${r1?.policy_name || pair[0]} vs. ${r2?.policy_name || pair[1]}`, 'info')
      } else if (runs.length >= 2) {
        setSelectedComparisonIds([runs[0].id, runs[1].id])
        notify(`Selected LIVE pair: ${runs[0].policy_name} vs. ${runs[1].policy_name}`, 'info')
      } else {
        notify('Insufficient completed LIVE runs available for benchmark comparison', 'error')
      }
    }
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
      setSelectedComparisonIds((prev) => reconcileComparisonSelection(prev, data, isMockMode))
      setSelectedRunId((prev) => {
        if (data.some((r) => r.id === runId)) return runId
        return reconcileSingleRunSelection(prev, data)
      })
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
      setSelectedComparisonIds((prev) => reconcileComparisonSelection(prev, data, mockEnabled))
      setSelectedRunId((prev) => reconcileSingleRunSelection(prev, data))
    } catch (err) {
      if (!mockEnabled) {
        notify(
          `Live backend request failed: ${err instanceof Error ? err.message : 'Unknown error'}. Return to Mock mode if backend is offline.`,
          'error'
        )
      }
    }
  }

  // Restore defaults
  const handleResetDefaults = async () => {
    apiClient.resetToDefaults()
    setIsMockMode(true)
    try {
      const data = await apiClient.getRuns()
      setRuns(data)
      setSelectedRunId(reconcileSingleRunSelection('', data))
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
        runsCount={runs.length}
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
            onOpenRunDetails={handleOpenRunDetails}
            onNavigateToBuilder={() => setCurrentView('builder')}
            onNavigateToComparison={handleNavigateToComparison}
          />
        )}

        {currentView === 'builder' && (
          <ScenarioBuilderView
            onNotify={notify}
            onScenarioSaved={handleScenarioSaved}
            onRunSubmitted={handleRunSubmitted}
          />
        )}

        {currentView === 'runs' && (
          <SimulationRunsView
            runs={runs}
            onOpenRunDetails={handleOpenRunDetails}
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
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
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
          />
        </Modal>
      )}

      {/* Global Interactive Notification Toasts */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

export default App
