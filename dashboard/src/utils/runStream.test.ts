import test from 'node:test'
import assert from 'node:assert/strict'
import { routeRunStreamFrame } from './runStream.ts'
import type { StreamSink } from './runStream.ts'

function collect(): { sink: StreamSink; events: Array<Record<string, unknown>>; done: { count: number } } {
  const events: Array<Record<string, unknown>> = []
  const done = { count: 0 }
  return {
    sink: { onEvent: (e) => events.push(e), onDone: () => { done.count++ } },
    events,
    done
  }
}

test('event frames pass through parsed', () => {
  const c = collect()
  routeRunStreamFrame('event', '{"event":"node_fail","time_ns":42,"node":"node-0"}', c.sink)
  assert.equal(c.events.length, 1)
  assert.deepEqual(c.events[0], { event: 'node_fail', time_ns: 42, node: 'node-0' })
  assert.equal(c.done.count, 0)
})

test('tick frames map to timeline markers', () => {
  const c = collect()
  routeRunStreamFrame('tick', '{"t_ns":100}', c.sink)
  assert.deepEqual(c.events, [{ event: 'tick', time_ns: 100 }])
})

test('done frames complete without emitting', () => {
  const c = collect()
  routeRunStreamFrame('done', '{}', c.sink)
  assert.equal(c.events.length, 0)
  assert.equal(c.done.count, 1)
})

test('malformed payloads are dropped silently', () => {
  const c = collect()
  routeRunStreamFrame('event', 'not json {{{', c.sink)
  routeRunStreamFrame('tick', '{"t_ns":', c.sink)
  assert.equal(c.events.length, 0)
  assert.equal(c.done.count, 0)
})

test('unknown frame types are ignored', () => {
  const c = collect()
  routeRunStreamFrame('ping', '{"t_ns":1}', c.sink)
  assert.equal(c.events.length, 0)
  assert.equal(c.done.count, 0)
})

test('tick without numeric t_ns is ignored', () => {
  const c = collect()
  routeRunStreamFrame('tick', '{"t_ns":"soon"}', c.sink)
  assert.equal(c.events.length, 0)
})
