import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Tests simulating the Policy Comparison request lifecycle and state machines.
 * Verifies:
 * 1. Initial automatic comparison on mount with 2+ selected runs.
 * 2. Selection changes trigger a fresh request and discard stale responses.
 * 3. Loading state always resolves (to fair verdict, refused reason, or error) without getting stuck.
 * 4. Deselection and reselection behavior.
 */

interface MockVerdict {
  verdict: 'fair' | 'refused'
  reason?: string
  ids?: string[]
}

class ComparisonLifecycleTracker {
  isComparingLive = false
  backendVerdict: MockVerdict | null = null
  lastEvaluatedKey = ''
  activeRequestId = 0

  handleSelection(comparisonKey: string, fetchFn: (ids: string[]) => Promise<MockVerdict>) {
    if (!comparisonKey) {
      this.activeRequestId += 1
      this.lastEvaluatedKey = ''
      this.isComparingLive = false
      this.backendVerdict = null
      return
    }

    if (comparisonKey === this.lastEvaluatedKey && this.backendVerdict !== null) {
      return
    }

    const currentReqId = ++this.activeRequestId
    const targetRunIds = comparisonKey.split(',')
    this.isComparingLive = true

    return fetchFn(targetRunIds)
      .then((verdict) => {
        if (this.activeRequestId === currentReqId) {
          this.lastEvaluatedKey = comparisonKey
          this.backendVerdict = verdict
          this.isComparingLive = false
        }
      })
      .catch((err: Error) => {
        if (this.activeRequestId === currentReqId) {
          this.lastEvaluatedKey = comparisonKey
          this.backendVerdict = {
            verdict: 'refused',
            reason: err.message
          }
          this.isComparingLive = false
        }
      })
  }
}

describe('Policy Comparison Automatic Loading Lifecycle', () => {
  it('1. Triggers initial automatic comparison on mount with 2 selected runs', async () => {
    const tracker = new ComparisonLifecycleTracker()
    const comparisonKey = 'run-a,run-b'

    assert.equal(tracker.isComparingLive, false)
    assert.equal(tracker.backendVerdict, null)

    const promise = tracker.handleSelection(comparisonKey, async (ids) => {
      return { verdict: 'fair', ids }
    })

    assert.equal(tracker.isComparingLive, true)
    await promise

    assert.equal(tracker.isComparingLive, false)
    assert.equal(tracker.backendVerdict?.verdict, 'fair')
    assert.deepEqual(tracker.backendVerdict?.ids, ['run-a', 'run-b'])
    assert.equal(tracker.lastEvaluatedKey, comparisonKey)
  })

  it('2. Selection changes trigger fresh comparison and discard stale responses from superseded requests', async () => {
    const tracker = new ComparisonLifecycleTracker()

    // Request 1 starts (slow)
    let resolveReq1!: (v: MockVerdict) => void
    const req1Promise = new Promise<MockVerdict>((res) => {
      resolveReq1 = res
    })
    tracker.handleSelection('run-a,run-b', () => req1Promise)
    assert.equal(tracker.isComparingLive, true)
    assert.equal(tracker.activeRequestId, 1)

    // User changes selection to run-a,run-c (Request 2 starts)
    let resolveReq2!: (v: MockVerdict) => void
    const req2Promise = new Promise<MockVerdict>((res) => {
      resolveReq2 = res
    })
    const handle2 = tracker.handleSelection('run-a,run-c', () => req2Promise)
    assert.equal(tracker.isComparingLive, true)
    assert.equal(tracker.activeRequestId, 2)

    // Late arrival of Request 1
    resolveReq1({ verdict: 'fair', ids: ['run-a', 'run-b'] })
    await req1Promise

    // Request 1 must NOT overwrite state or clear isComparingLive
    assert.equal(tracker.backendVerdict, null)
    assert.equal(tracker.isComparingLive, true)

    // Request 2 completes
    resolveReq2({ verdict: 'fair', ids: ['run-a', 'run-c'] })
    await handle2

    assert.equal(tracker.isComparingLive, false)
    assert.deepEqual(tracker.backendVerdict?.ids, ['run-a', 'run-c'])
    assert.equal(tracker.lastEvaluatedKey, 'run-a,run-c')
  })

  it('3. Loading state always resolves when server request rejects with an error', async () => {
    const tracker = new ComparisonLifecycleTracker()
    const comparisonKey = 'run-x,run-y'

    const handle = tracker.handleSelection(comparisonKey, async () => {
      throw new Error('Connection timeout')
    })
    assert.equal(tracker.isComparingLive, true)

    await handle

    // Loading MUST be false, and verdict must be refused with error message
    assert.equal(tracker.isComparingLive, false)
    assert.equal(tracker.backendVerdict?.verdict, 'refused')
    assert.equal(tracker.backendVerdict?.reason, 'Connection timeout')
  })

  it('4. Deselecting to fewer than 2 runs immediately resets loading state and verdict', async () => {
    const tracker = new ComparisonLifecycleTracker()
    await tracker.handleSelection('run-a,run-b', async (ids) => ({ verdict: 'fair', ids }))

    assert.equal(tracker.backendVerdict?.verdict, 'fair')

    // User deselects a run, leaving 1 run (comparisonKey becomes '')
    tracker.handleSelection('', async () => ({ verdict: 'fair' }))

    assert.equal(tracker.isComparingLive, false)
    assert.equal(tracker.backendVerdict, null)
    assert.equal(tracker.lastEvaluatedKey, '')
  })

  it('5. Avoids duplicate network calls when selection remains identical and verdict is cached', async () => {
    const tracker = new ComparisonLifecycleTracker()
    let networkCalls = 0

    const fetchFn = async (ids: string[]): Promise<MockVerdict> => {
      networkCalls++
      return { verdict: 'fair', ids }
    }

    await tracker.handleSelection('run-1,run-2', fetchFn)
    assert.equal(networkCalls, 1)

    // Re-render with same key does not trigger additional network call
    tracker.handleSelection('run-1,run-2', fetchFn)
    assert.equal(networkCalls, 1)
  })
})

