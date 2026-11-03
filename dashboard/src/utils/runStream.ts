/**
 * Router for the run SSE stream (GET /runs/{id}/stream).
 *
 * The server emits NAMED frames only — `tick` (virtual-time markers),
 * `event` (stored telemetry), `done` (clean end) — so clients must
 * listen per name; a bare onmessage handler never fires. Malformed
 * payloads and unknown frame types are dropped, never surfaced.
 */
export interface StreamSink {
  onEvent: (event: Record<string, unknown>) => void
  onDone: () => void
}

export function routeRunStreamFrame(
  type: string,
  raw: string,
  sink: StreamSink
): void {
  if (type === 'done') {
    sink.onDone()
    return
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  if (type === 'tick') {
    const t = (data as Record<string, unknown>)?.t_ns
    if (typeof t === 'number') sink.onEvent({ event: 'tick', time_ns: t })
    return
  }
  if (type === 'event' && data !== null && typeof data === 'object') {
    sink.onEvent(data as Record<string, unknown>)
  }
}
