import test from 'node:test'
import assert from 'node:assert/strict'
import { latencyWindowsCollapsed } from './latencyCollapse.ts'

test('empty series is not collapsed', () => {
  assert.equal(latencyWindowsCollapsed([]), false)
})

test('windows without any percentile are not collapsed', () => {
  assert.equal(latencyWindowsCollapsed([{ p50_latency_ns: null, p95_latency_ns: null, p99_latency_ns: null }]), false)
})

test('identical percentiles across windows are collapsed', () => {
  assert.equal(latencyWindowsCollapsed([
    { p50_latency_ns: 44, p95_latency_ns: 44, p99_latency_ns: 44 },
    { p50_latency_ns: 44, p95_latency_ns: 44, p99_latency_ns: 44 }
  ]), true)
})

test('one spread window breaks the collapse', () => {
  assert.equal(latencyWindowsCollapsed([
    { p50_latency_ns: 44, p95_latency_ns: 44, p99_latency_ns: 44 },
    { p50_latency_ns: 44, p95_latency_ns: 90, p99_latency_ns: 120 }
  ]), false)
})

test('single recorded percentile still counts as collapsed', () => {
  assert.equal(latencyWindowsCollapsed([
    { p50_latency_ns: 44, p95_latency_ns: null, p99_latency_ns: null }
  ]), true)
})

test('gaps do not break the collapse', () => {
  assert.equal(latencyWindowsCollapsed([
    { p50_latency_ns: 44, p95_latency_ns: 44, p99_latency_ns: 44 },
    { p50_latency_ns: null, p95_latency_ns: null, p99_latency_ns: null }
  ]), true)
})
