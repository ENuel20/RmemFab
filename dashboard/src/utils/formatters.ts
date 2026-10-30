/**
 * Numerical and Metric Formatters
 */

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const safeI = Math.min(i, sizes.length - 1)
  const val = bytes / Math.pow(k, safeI)
  return `${val.toFixed(decimals)} ${sizes[safeI]}`
}

export function formatBytesDecimal(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B'
  const k = 1000
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const safeI = Math.min(i, sizes.length - 1)
  const val = bytes / Math.pow(k, safeI)
  return `${val.toFixed(decimals)} ${sizes[safeI]}`
}

export function formatNanoseconds(ns: number, decimals = 1): string {
  if (ns === 0) return '0 ns'
  if (ns < 1000) return `${ns.toFixed(0)} ns`
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(decimals)} µs`
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(decimals)} ms`
  return `${(ns / 1_000_000_000).toFixed(decimals)} s`
}

export function formatBandwidth(bytesPerNs: number): string {
  // 1 byte/ns = 1 GB/s (10^9 bytes / 10^9 ns)
  return `${bytesPerNs.toFixed(1)} GB/s`
}

export function formatPercent(ratio: number, decimals = 1): string {
  return `${(ratio * 100).toFixed(decimals)}%`
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num)
}

