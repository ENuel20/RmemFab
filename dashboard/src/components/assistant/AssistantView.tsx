import React, { useEffect, useRef, useState } from 'react'
import { Bot, Send, CheckCircle2, XCircle, AlertTriangle, Undo2, Play } from 'lucide-react'
import { apiClient, apiErrorMessage } from '../../services/api'
import type {
  ApplyResponse, ChatMessage, ChatResponse, RollbackResponse,
  SimulationRun, SuggestedPatch
} from '../../types/telemetry'
import { Badge } from '../common/Badge'
import { parseChatMessage } from '../../utils/chatFormat'
import type { Span } from '../../utils/chatFormat'

interface AssistantViewProps {
  runs: SimulationRun[]
  onNotify: (message: string, type: 'success' | 'error' | 'info') => void
  onRefreshRuns: () => void
  isMockMode: boolean
}

interface ThreadMessage extends ChatMessage {
  suggestion?: SuggestedPatch | null
  model?: string
}

function SuggestionCard({
  suggestion, runId, note, onApplied
}: {
  suggestion: SuggestedPatch
  runId: string
  note: string
  onApplied: (res: ApplyResponse) => void
}) {
  const [isApplying, setIsApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  if (!suggestion.valid || !suggestion.ops) {
    return (
      <div
        role="alert"
        style={{ marginTop: '10px', padding: '12px 14px', border: '1px solid rgba(244, 63, 94, 0.3)', borderRadius: '8px' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 600, color: 'var(--accent-rose)' }}>
          <XCircle size={14} /> Suggestion invalid — not applied
        </div>
        <ul style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
          {suggestion.errors.map((e, i) => (
            <li key={i} className="mono">{e.path ? `${e.path}: ` : ''}{e.message}</li>
          ))}
        </ul>
      </div>
    )
  }

  const handleApply = async () => {
    setIsApplying(true)
    setApplyError(null)
    try {
      const res = await apiClient.applyChange({
        parent_run_id: runId,
        patch: suggestion.ops ?? [],
        note: note || undefined
      })
      onApplied(res)
    } catch (err) {
      setApplyError(apiErrorMessage(err))
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <div style={{ marginTop: '10px', padding: '12px 14px', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 600, color: 'var(--accent-emerald)' }}>
        <CheckCircle2 size={14} /> Validated suggestion ({suggestion.ops.length} op{suggestion.ops.length === 1 ? '' : 's'})
      </div>
      <ul style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }} className="mono">
        {suggestion.ops.map((op, i) => (
          <li key={i}>{op.op} {op.path}{op.value !== undefined ? ` = ${JSON.stringify(op.value)}` : ''}</li>
        ))}
      </ul>
      {applyError && (
        <div role="alert" style={{ marginTop: '8px', fontSize: '12.5px', color: 'var(--accent-rose)' }}>
          {applyError}
        </div>
      )}
      <button
        className="btn btn-sm btn-primary"
        style={{ marginTop: '10px' }}
        onClick={() => void handleApply()}
        disabled={isApplying}
      >
        <Play size={13} />
        <span>{isApplying ? 'Applying & running…' : 'Apply & run'}</span>
      </button>
    </div>
  )
}

function ChatSpans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.t === 'bold' ? (
          <strong key={i}>{s.s}</strong>
        ) : s.t === 'code' ? (
          <code
            key={i}
            className="mono"
            style={{ padding: '0 4px', borderRadius: '4px', backgroundColor: 'rgba(148, 163, 184, 0.12)', fontSize: '12px' }}
          >
            {s.s}
          </code>
        ) : (
          <span key={i}>{s.s}</span>
        )
      )}
    </>
  )
}

function ChatMessageBody({ content }: { content: string }) {
  const blocks = parseChatMessage(content)
  return (
    <div style={{ fontSize: '13px', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {blocks.map((b, bi) => {
        if (b.t === 'code') {
          return (
            <pre
              key={bi}
              className="mono"
              style={{ margin: 0, padding: '8px 10px', borderRadius: '6px', backgroundColor: 'rgba(148, 163, 184, 0.08)', border: '1px solid var(--border-card)', overflowX: 'auto', fontSize: '12px' }}
            >
              {b.text}
            </pre>
          )
        }
        if (b.t === 'list') {
          return (
            <ul key={bi} style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {b.items.map((it, ii) => (
                <li key={ii} style={{ marginLeft: `${it.level * 16}px` }}>
                  <ChatSpans spans={it.spans} />
                </li>
              ))}
            </ul>
          )
        }
        return (
          <div key={bi}>
            <ChatSpans spans={b.spans} />
          </div>
        )
      })}
    </div>
  )
}

function ResultCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginTop: '12px' }}>
      <div className="card-header">
        <div className="card-title-group">
          <div className="card-title" style={{ fontSize: '13px' }}>{title}</div>
        </div>
      </div>
      {children}
    </div>
  )
}

export const AssistantView: React.FC<AssistantViewProps> = ({ runs, onNotify, onRefreshRuns, isMockMode }) => {
  const completed = runs.filter((r) => r.status === 'completed')
  const [runId, setRunId] = useState<string>('')
  const activeRunId = runId || (completed.length > 0 ? completed[0].id : '')
  const [thread, setThread] = useState<ThreadMessage[]>([])
  const [input, setInput] = useState('')
  const [suggestPatch, setSuggestPatch] = useState(true)
  const [useStream, setUseStream] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null)
  const [note, setNote] = useState('')
  const [rbTo, setRbTo] = useState('')
  const [rbFrom, setRbFrom] = useState('')
  const [rbNote, setRbNote] = useState('')
  const [rbResult, setRbResult] = useState<RollbackResponse | null>(null)
  const [isRollingBack, setIsRollingBack] = useState(false)
  const [rbError, setRbError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [thread])

  useEffect(() => () => abortRef.current?.abort(), [])

  const sendable = input.trim().length > 0 && !isSending && (!suggestPatch || activeRunId !== '')

  const handleSend = async () => {
    const text = input.trim()
    if (!text || isSending) return
    if (suggestPatch && !activeRunId) {
      setChatError('Pick a run first: suggestions are validated against a run scenario')
      return
    }
    setInput('')
    setChatError(null)
    const history: ChatMessage[] = [
      ...thread.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text }
    ]
    setThread((prev) => [...prev, { role: 'user', content: text }])
    setIsSending(true)
    try {
      if (useStream) {
        abortRef.current?.abort()
        abortRef.current = new AbortController()
        let full = ''
        setThread((prev) => [...prev, { role: 'assistant', content: '' }])
        full = await apiClient.chatAssistantStream(
          history, activeRunId || undefined,
          (token) => {
            full += token
            const snap = full
            setThread((prev) => {
              const next = [...prev]
              next[next.length - 1] = { role: 'assistant', content: snap }
              return next
            })
          },
          abortRef.current.signal
        )
      } else {
        const res: ChatResponse = await apiClient.chatAssistant(history, activeRunId || null, suggestPatch)
        setThread((prev) => [...prev, {
          role: 'assistant', content: res.content,
          suggestion: res.suggested_patch ?? null, model: res.model
        }])
      }
    } catch (err) {
      const msg = apiErrorMessage(err)
      setChatError(msg)
      onNotify(`Chat failed: ${msg}`, 'error')
    } finally {
      setIsSending(false)
    }
  }

  const handleApplied = (res: ApplyResponse) => {
    setApplyResult(res)
    onNotify(`Applied as version ${res.version}, run ${res.run_id.slice(0, 12)} (${res.status})`,
      res.status === 'completed' ? 'success' : 'error')
    onRefreshRuns()
  }

  const handleRollback = async () => {
    if (!rbTo.trim()) {
      setRbError('Enter the version to roll back to')
      return
    }
    setIsRollingBack(true)
    setRbError(null)
    setRbResult(null)
    try {
      const res = await apiClient.rollbackChange({
        to_version: rbTo.trim(),
        from_version: rbFrom.trim() || undefined,
        note: rbNote.trim() || undefined
      })
      setRbResult(res)
      onNotify(`Rolled back as version ${res.version}, run ${res.run_id.slice(0, 12)} (${res.status})`,
        res.status === 'completed' ? 'success' : 'error')
      onRefreshRuns()
    } catch (err) {
      setRbError(apiErrorMessage(err))
    } finally {
      setIsRollingBack(false)
    }
  }

  return (
    <div className="app-content">
      <div className="card">
        <div className="card-header">
          <div className="card-title-group">
            <div className="card-title">
              <Bot size={16} style={{ marginRight: '8px', verticalAlign: '-2px' }} />
              Research Assistant
            </div>
            <div className="card-subtitle">
              Telemetry-grounded answers about a run. Suggestions arrive as validated
              patches — nothing runs until you apply it.
            </div>
          </div>
          <Badge variant={isMockMode ? 'amber' : 'emerald'}>
            {isMockMode ? 'Demo Dataset' : 'Live Data'}
          </Badge>
        </div>

        {isMockMode ? (
          <div style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
            <Bot size={28} color="var(--text-muted)" />
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '10px' }}>
              The assistant needs a live backend
            </div>
            <div style={{ fontSize: '12px', marginTop: '6px' }}>
              Switch to Live mode in Settings to chat about real runs.
            </div>
          </div>
        ) : (
          <>
            <div className="form-grid-2" style={{ marginBottom: '12px' }}>
              <div className="form-group">
                <label className="form-label" htmlFor="assistant-run">Run context</label>
                <select
                  id="assistant-run"
                  value={activeRunId}
                  onChange={(e) => setRunId(e.target.value)}
                  disabled={isSending}
                >
                  <option value="">No run (ungrounded)</option>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {(r.scenario_name || r.id).slice(0, 40)} · {r.id.slice(0, 12)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <span className="form-label">Options</span>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center', minHeight: '40px', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                    <input
                      type="checkbox"
                      checked={suggestPatch}
                      onChange={(e) => setSuggestPatch(e.target.checked)}
                      disabled={isSending}
                    />
                    Request validated patch
                  </label>
                  <label style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                    <input
                      type="checkbox"
                      checked={useStream}
                      onChange={(e) => setUseStream(e.target.checked)}
                      disabled={isSending}
                    />
                    Stream reply
                  </label>
                </div>
              </div>
            </div>

            <div
              aria-live="polite"
              style={{
                border: '1px solid var(--border-color, rgba(148, 163, 184, 0.2))',
                borderRadius: '8px', padding: '12px 14px', minHeight: '120px',
                maxHeight: '380px', overflowY: 'auto', marginBottom: '12px'
              }}
            >
              {thread.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: '12.5px' }}>
                  Ask about the selected run — e.g. “Why did p95 spike?” or “What should I try next?”
                  {suggestPatch && ' Patch suggestions arrive validated, with an Apply button.'}
                </div>
              )}
              {thread.map((m, i) => (
                <div key={i} style={{ marginBottom: i === thread.length - 1 ? 0 : '12px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: m.role === 'user' ? 'var(--accent-cyan)' : 'var(--accent-emerald)', marginBottom: '4px' }}>
                    {m.role === 'user' ? 'YOU' : `ASSISTANT${m.model ? ` · ${m.model}` : ''}`}
                  </div>
                  {m.content ? (
                    <ChatMessageBody content={m.content} />
                  ) : (
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                      {isSending && i === thread.length - 1 ? '…' : ''}
                    </div>
                  )}
                  {m.suggestion && activeRunId && (
                    <SuggestionCard
                      suggestion={m.suggestion}
                      runId={activeRunId}
                      note={note}
                      onApplied={handleApplied}
                    />
                  )}
                </div>
              ))}
              <div ref={threadEndRef} />
            </div>

            {chatError && (
              <div role="alert" style={{ fontSize: '12.5px', color: 'var(--accent-rose)', marginBottom: '10px' }}>
                <AlertTriangle size={13} style={{ marginRight: '6px', verticalAlign: '-2px' }} />
                {chatError}
              </div>
            )}

            <div className="form-grid-2">
              <div className="form-group">
                <label className="form-label" htmlFor="assistant-note">Apply note (optional)</label>
                <input
                  id="assistant-note"
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Recorded on the applied version"
                  disabled={isSending}
                  autoComplete="off"
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="assistant-input">Message</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    id="assistant-input"
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSend() }}
                    placeholder="Ask about this run…"
                    disabled={isSending}
                    autoComplete="off"
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void handleSend()}
                    disabled={!sendable}
                  >
                    <Send size={13} />
                    <span>{isSending ? 'Sending…' : 'Send'}</span>
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {applyResult && !isMockMode && (
        <ResultCard title={`Applied → version ${applyResult.version} · run ${applyResult.run_id.slice(0, 16)}`}>
          <div className="mono" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            Status: {applyResult.status}
            {applyResult.compare && (
              <> · Compare: {applyResult.compare.verdict}
                {applyResult.compare.verdict === 'refused' ? ` (${applyResult.compare.reason})` : ` (${applyResult.compare.mode ?? 'same_seed'})`}
              </>
            )}
            {applyResult.error && <> · Error: {applyResult.error}</>}
          </div>
          {applyResult.validation.warnings.length > 0 && (
            <div style={{ fontSize: '12px', color: 'var(--accent-amber)', marginTop: '6px' }}>
              Warnings: {applyResult.validation.warnings.join('; ')}
            </div>
          )}
          {applyResult.changes && applyResult.changes.length > 0 && (
            <ul className="mono" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', paddingLeft: '18px' }}>
              {applyResult.changes.map((c, i) => (
                <li key={i}>{c.path}</li>
              ))}
            </ul>
          )}
        </ResultCard>
      )}

      {!isMockMode && (
        <div className="card" style={{ marginTop: '12px' }}>
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-title">
                <Undo2 size={14} style={{ marginRight: '8px', verticalAlign: '-2px' }} />
                Rollback
              </div>
              <div className="card-subtitle">
                Re-run a stored version as a new audited rollback version. Nothing is overwritten.
              </div>
            </div>
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label" htmlFor="rb-to">Roll back to (version)</label>
              <input
                id="rb-to"
                type="text"
                value={rbTo}
                onChange={(e) => setRbTo(e.target.value)}
                placeholder="e.g. a1b2c3d4e5f60718"
                disabled={isRollingBack}
                autoComplete="off"
                className="mono"
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="rb-from">From version (optional audit context)</label>
              <input
                id="rb-from"
                type="text"
                value={rbFrom}
                onChange={(e) => setRbFrom(e.target.value)}
                placeholder="Version being undone"
                disabled={isRollingBack}
                autoComplete="off"
                className="mono"
              />
            </div>
            <div className="form-group" style={{ gridColumn: 'span 2' }}>
              <label className="form-label" htmlFor="rb-note">Note (optional)</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  id="rb-note"
                  type="text"
                  value={rbNote}
                  onChange={(e) => setRbNote(e.target.value)}
                  placeholder="Why this rollback"
                  disabled={isRollingBack}
                  autoComplete="off"
                  style={{ flex: 1 }}
                />
                <button
                  className="btn btn-sm btn-outline"
                  onClick={() => void handleRollback()}
                  disabled={isRollingBack || rbTo.trim().length === 0}
                >
                  <Undo2 size={13} />
                  <span>{isRollingBack ? 'Rolling back…' : 'Rollback & run'}</span>
                </button>
              </div>
            </div>
          </div>
          {rbError && (
            <div role="alert" style={{ fontSize: '12.5px', color: 'var(--accent-rose)', marginTop: '8px' }}>
              {rbError}
            </div>
          )}
          {rbResult && (
            <div className="mono" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px' }}>
              Version {rbResult.version} · run {rbResult.run_id.slice(0, 16)} · {rbResult.status}
              {rbResult.error && ` · ${rbResult.error}`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
