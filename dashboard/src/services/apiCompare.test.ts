import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { apiClient } from './api.ts'

describe('Policy Comparison Endpoint and HTTP 404 Handling', () => {
  it('normalizes base URL by stripping trailing slashes to avoid //runs/compare', () => {
    const originalUrl = apiClient.getBaseUrl()
    try {
      apiClient.setBaseUrl('http://localhost:8000/')
      assert.equal(apiClient.getBaseUrl(), 'http://localhost:8000')

      apiClient.setBaseUrl('http://localhost:8000///')
      assert.equal(apiClient.getBaseUrl(), 'http://localhost:8000')
    } finally {
      apiClient.setBaseUrl(originalUrl)
    }
  })

  it('correctly formats POST /runs/compare request and parses fair 200 response', async () => {
    const originalFetch = globalThis.fetch
    const originalMode = apiClient.isMockMode()

    let capturedUrl = ''
    let capturedMethod = ''
    let capturedBody = ''

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input)
      capturedMethod = init?.method || 'GET'
      capturedBody = String(init?.body || '')
      return new Response(
        JSON.stringify({
          verdict: 'fair',
          mode: 'same_seed',
          policies: ['swap_remote', 'hot_cold'],
          seed: 42,
          runs: []
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    try {
      apiClient.setMockMode(false)
      const verdict = await apiClient.compareRuns(['run-1', 'run-2'])
      assert.equal(capturedUrl, `${apiClient.getBaseUrl()}/runs/compare`)
      assert.equal(capturedMethod, 'POST')
      const parsedBody = JSON.parse(capturedBody)
      assert.deepEqual(parsedBody.ids, ['run-1', 'run-2'])
      assert.equal(parsedBody.multi_seed, false)
      assert.equal(verdict.verdict, 'fair')
    } finally {
      globalThis.fetch = originalFetch
      apiClient.setMockMode(originalMode)
    }
  })

  it('preserves exact backend refusal on HTTP 422', async () => {
    const originalFetch = globalThis.fetch
    const originalMode = apiClient.isMockMode()

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          verdict: 'refused',
          reason: 'seeds differ [42, 99]; same-seed comparison needs one seed'
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )
    }

    try {
      apiClient.setMockMode(false)
      const verdict = await apiClient.compareRuns(['run-1', 'run-2'])
      assert.equal(verdict.verdict, 'refused')
      assert.ok(verdict.reason?.includes('seeds differ'))
    } finally {
      globalThis.fetch = originalFetch
      apiClient.setMockMode(originalMode)
    }
  })

  it('truthfully propagates HTTP 404 without hiding it or fabricating local comparison', async () => {
    const originalFetch = globalThis.fetch
    const originalMode = apiClient.isMockMode()

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          detail: "unknown run 'run-llama-cxl-swap'"
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }

    try {
      apiClient.setMockMode(false)
      await assert.rejects(
        async () => {
          await apiClient.compareRuns(['run-llama-cxl-swap', 'run-llama-cxl-hotcold'])
        },
        (err: Error) => {
          assert.ok(err.message.includes('404'))
          assert.ok(err.message.includes("unknown run 'run-llama-cxl-swap'"))
          return true
        }
      )
    } finally {
      globalThis.fetch = originalFetch
      apiClient.setMockMode(originalMode)
    }
  })

  it('detects when remote fabric is unexercised (100% local hits, 0% remote hits, 0% fabric utilization)', () => {
    const runA = {
      metrics: {
        local_hit_ratio: 1,
        remote_hit_ratio: 0,
        fabric_utilization: 0,
        remote_traffic_bytes: 0
      }
    }
    const runB = {
      metrics: {
        local_hit_ratio: 1,
        remote_hit_ratio: 0,
        fabric_utilization: 0,
        remote_traffic_bytes: 0
      }
    }

    const runs = [runA, runB]
    const isFabricUnexercised =
      runs.length >= 2 &&
      runs.every(
        (r) =>
          (r.metrics.local_hit_ratio === 1 || r.metrics.local_hit_ratio === 100) &&
          (r.metrics.remote_hit_ratio === 0 || r.metrics.remote_hit_ratio == null) &&
          (r.metrics.fabric_utilization === 0 || r.metrics.fabric_utilization == null) &&
          (r.metrics.remote_traffic_bytes === 0 || r.metrics.remote_traffic_bytes == null)
      )

    assert.equal(isFabricUnexercised, true)
  })
})
