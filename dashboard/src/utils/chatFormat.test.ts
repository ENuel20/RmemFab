import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChatMessage } from './chatFormat.ts'

test('plain lines become paragraphs', () => {
  const blocks = parseChatMessage('hello\nworld')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].t, 'para')
  assert.deepEqual(blocks[0], { t: 'para', spans: [{ t: 'text', s: 'hello' }] })
})

test('bold and code spans parse inline', () => {
  const blocks = parseChatMessage('**p50:** `1686939 ns`')
  assert.equal(blocks.length, 1)
  const b = blocks[0]
  assert.equal(b.t, 'para')
  if (b.t !== 'para') throw new Error('unreachable')
  assert.deepEqual(b.spans, [
    { t: 'bold', s: 'p50:' },
    { t: 'text', s: ' ' },
    { t: 'code', s: '1686939 ns' }
  ])
})

test('unpaired markers stay literal', () => {
  const blocks = parseChatMessage('a **oops and `code')
  assert.equal(blocks.length, 1)
  const b = blocks[0]
  assert.equal(b.t, 'para')
  if (b.t !== 'para') throw new Error('unreachable')
  assert.deepEqual(b.spans, [{ t: 'text', s: 'a **oops and `code' }])
})

test('bullets group with nesting levels', () => {
  const blocks = parseChatMessage('* a\n  * b\n- c')
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0], {
    t: 'list',
    items: [
      { level: 0, spans: [{ t: 'text', s: 'a' }] },
      { level: 1, spans: [{ t: 'text', s: 'b' }] },
      { level: 0, spans: [{ t: 'text', s: 'c' }] }
    ]
  })
})

test('fenced blocks keep raw text and language', () => {
  const blocks = parseChatMessage('before\n```patch\n[{"op": "replace"}]\n```\nafter')
  assert.equal(blocks.length, 3)
  assert.deepEqual(blocks[1], { t: 'code', lang: 'patch', text: '[{"op": "replace"}]' })
})

test('unclosed fence runs to end of message', () => {
  const blocks = parseChatMessage('```patch\n[{"op": "replace"}]')
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0], { t: 'code', lang: 'patch', text: '[{"op": "replace"}]' })
})

test('blank lines split paragraphs without empty blocks', () => {
  const blocks = parseChatMessage('a\n\n\nb')
  assert.equal(blocks.length, 2)
})
