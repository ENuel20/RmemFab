/**
 * Detects when every recorded latency window carries identical
 * percentiles (p50 == p95 == p99 wherever present). The deterministic
 * engine models zero-jitter reads, so uniform windows collapse to one
 * value and multi-series charts render a single visible line. Callers
 * use this to label the coincidence instead of looking broken.
 */
export interface LatencyWindowPoint {
  p50_latency_ns?: number | null
  p95_latency_ns?: number | null
  p99_latency_ns?: number | null
}

export function latencyWindowsCollapsed(points: LatencyWindowPoint[]): boolean {
  let seen = false
  for (const p of points) {
    const vals = [p.p50_latency_ns, p.p95_latency_ns, p.p99_latency_ns].filter(
      (v): v is number => typeof v === 'number'
    )
    if (vals.length === 0) continue
    seen = true
    if (!vals.every((v) => v === vals[0])) return false
  }
  return seen
}
