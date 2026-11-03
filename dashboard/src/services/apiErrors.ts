export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.detail && typeof err.detail === 'object') {
    const d = err.detail as Record<string, unknown>
    const inner = (d.detail ?? d.Detail ?? d) as Record<string, unknown> | unknown
    if (typeof inner === 'string') return inner
    if (inner && typeof inner === 'object') {
      const rec = inner as Record<string, unknown>
      const head = typeof rec.error === 'string' ? rec.error
        : typeof rec.reason === 'string' ? rec.reason : null
      if (Array.isArray(rec.errors)) {
        const items = (rec.errors as Array<{ path?: string; message?: string }>)
          .map((e) => `${e.path || 'error'}: ${e.message || JSON.stringify(e)}`)
        const shown = items.slice(0, 5).join('; ')
        const more = items.length > 5 ? ` (+${items.length - 5} more)` : ''
        return head ? `${head} — ${shown}${more}` : `${shown}${more}`
      }
      if (head) return head
    }
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}
