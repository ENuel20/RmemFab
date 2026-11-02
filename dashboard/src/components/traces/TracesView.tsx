import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Database, Upload, Trash2, ArrowRight, AlertTriangle, FileUp } from 'lucide-react'
import { apiClient, apiErrorMessage } from '../../services/api'
import type { TraceProfile } from '../../types/telemetry'
import { Badge } from '../common/Badge'

interface TracesViewProps {
  onNotify: (message: string, type: 'success' | 'error' | 'info') => void
  onUseInBuilder: (trace: TraceProfile) => void
  isMockMode: boolean
}

function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number') return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  return `${(n / 1024 ** 3).toFixed(2)} GiB`
}

export const TracesView: React.FC<TracesViewProps> = ({ onNotify, onUseInBuilder, isMockMode }) => {
  const [traces, setTraces] = useState<TraceProfile[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState<boolean>(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    if (apiClient.isMockMode()) {
      setTraces([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setLoadError(null)
    try {
      setTraces(await apiClient.getTraces())
    } catch (err) {
      setLoadError(apiErrorMessage(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Fetch-on-view-open is intentional: this app shell has no route loaders or
  // Suspense boundaries, so the trace list loads when the view mounts.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh, isMockMode])

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setUploadError('Choose a .jsonl trace file first')
      return
    }
    setIsUploading(true)
    setUploadError(null)
    try {
      const prof = await apiClient.uploadTrace(file)
      onNotify(`Uploaded ${prof.filename || file.name} (${prof.requests} requests)`, 'success')
      if (fileRef.current) fileRef.current.value = ''
      await refresh()
    } catch (err) {
      const msg = apiErrorMessage(err)
      setUploadError(msg)
      onNotify(`Upload rejected: ${msg}`, 'error')
    } finally {
      setIsUploading(false)
    }
  }

  const handleDelete = async (traceId: string) => {
    if (confirmingDelete !== traceId) {
      setConfirmingDelete(traceId)
      return
    }
    setConfirmingDelete(null)
    try {
      await apiClient.deleteTrace(traceId)
      onNotify(`Deleted trace ${traceId.slice(0, 12)}`, 'success')
      await refresh()
    } catch (err) {
      onNotify(`Delete failed: ${apiErrorMessage(err)}`, 'error')
    }
  }

  return (
    <div className="app-content">
      <div className="card">
        <div className="card-header">
          <div className="card-title-group">
            <div className="card-title">
              <Database size={16} style={{ marginRight: '8px', verticalAlign: '-2px' }} />
              Trace Library
            </div>
            <div className="card-subtitle">
              Upload canonical JSONL traces, inspect their profiles, and replay them.
              Invalid uploads are rejected with row numbers — never stored.
            </div>
          </div>
          <Badge variant={isMockMode ? 'amber' : 'emerald'}>
            {isMockMode ? 'Demo Dataset' : 'Live Data'}
          </Badge>
        </div>

        {isMockMode ? (
          <div style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
            <FileUp size={28} color="var(--text-muted)" />
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '10px' }}>
              Trace library needs a live backend
            </div>
            <div style={{ fontSize: '12px', marginTop: '6px' }}>
              Switch to Live mode in Settings to upload and replay real traces.
            </div>
          </div>
        ) : (
          <div className="form-grid-2">
            <div className="form-group" style={{ gridColumn: 'span 2' }}>
              <label className="form-label" htmlFor="trace-file">Trace file (.jsonl, 128 MiB cap)</label>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  id="trace-file"
                  ref={fileRef}
                  type="file"
                  accept=".jsonl,.json"
                  disabled={isUploading}
                  aria-label="Trace file to upload"
                />
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => void handleUpload()}
                  disabled={isUploading}
                >
                  <Upload size={13} />
                  <span>{isUploading ? 'Uploading…' : 'Upload & Validate'}</span>
                </button>
              </div>
              {uploadError && (
                <div role="alert" style={{ marginTop: '8px', fontSize: '12.5px', color: 'var(--accent-rose)' }}>
                  <AlertTriangle size={13} style={{ marginRight: '6px', verticalAlign: '-2px' }} />
                  {uploadError}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {!isMockMode && (
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-title">Uploaded Traces ({traces.length})</div>
              <div className="card-subtitle">Server-side traces available for replay</div>
            </div>
            <button className="btn btn-sm btn-outline" onClick={() => void refresh()} disabled={isLoading}>
              <span>Refresh</span>
            </button>
          </div>

          {isLoading && (
            <div style={{ padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>Loading traces…</div>
          )}
          {loadError && (
            <div role="alert" style={{ fontSize: '12.5px', color: 'var(--accent-rose)' }}>
              {loadError}{' '}
              <button className="btn btn-sm btn-outline" onClick={() => void refresh()}>
                <span>Retry</span>
              </button>
            </div>
          )}
          {!isLoading && !loadError && traces.length === 0 && (
            <div style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                No traces uploaded yet
              </div>
              <div style={{ fontSize: '12px', marginTop: '6px' }}>
                Upload a canonical JSONL trace above to replay it.
              </div>
            </div>
          )}
          {!isLoading && !loadError && traces.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {traces.map((t) => (
                <div
                  key={t.trace_id}
                  className="card"
                  style={{ padding: '14px 16px', margin: 0 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>
                        {t.filename || t.trace_id.slice(0, 16)}
                      </span>
                      <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>
                        {t.trace_id.slice(0, 16)} · sha {t.sha256.slice(0, 12)}
                      </span>
                      {t.provenance && (
                        <Badge variant={t.provenance === 'measured' ? 'emerald' : 'amber'}>
                          {t.provenance}
                        </Badge>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {t.workload_path && (
                        <button
                          className="btn btn-sm btn-outline"
                          onClick={() => onUseInBuilder(t)}
                          title="Open the Scenario Builder with this trace as the workload"
                        >
                          <ArrowRight size={13} />
                          <span>Use in builder</span>
                        </button>
                      )}
                      <button
                        className={`btn btn-sm ${confirmingDelete === t.trace_id ? 'btn-primary' : 'btn-outline'}`}
                        onClick={() => void handleDelete(t.trace_id)}
                        title="Delete this uploaded trace"
                      >
                        <Trash2 size={13} />
                        <span>{confirmingDelete === t.trace_id ? 'Confirm delete' : 'Delete'}</span>
                      </button>
                    </div>
                  </div>
                  <div className="mono" style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '8px' }}>
                    {t.requests} requests · {t.counts.alloc} alloc / {t.counts.read} read / {t.counts.write} write / {t.counts.free} free
                    {' '}· {t.normalized_pages} pages · {formatBytes(t.footprint_bytes)}
                    {t.model && ` · ${t.model}`}
                    {t.runtime && ` · ${t.runtime}`}
                  </div>
                  {t.limitation_note && (
                    <div style={{ fontSize: '12px', color: 'var(--accent-amber)', marginTop: '6px' }}>
                      <AlertTriangle size={12} style={{ marginRight: '5px', verticalAlign: '-1px' }} />
                      {t.limitation_note}
                    </div>
                  )}
                  {t.validation.warnings.length > 0 && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                      Warnings: {t.validation.warnings.join('; ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
