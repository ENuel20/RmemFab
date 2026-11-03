import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, apiErrorMessage } from './apiErrors.ts'

test('apiErrorMessage keeps headline and field errors together', () => {
  const err = new ApiError(422, 'Request failed: HTTP 422', {
    detail: {
      error: 'draft failed validation',
      errors: [
        { path: '/nodes/0/memory/local_bytes', message: 'expected integer' },
        { path: '/policy/name', message: 'unknown policy' },
      ],
    },
  })
  const msg = apiErrorMessage(err)
  assert.match(msg, /draft failed validation/)
  assert.match(msg, /local_bytes/)
  assert.match(msg, /unknown policy/)
})

test('apiErrorMessage caps long error lists', () => {
  const errors = Array.from({ length: 8 }, (_, i) => ({ path: `/f${i}`, message: 'bad' }))
  const msg = apiErrorMessage(new ApiError(422, 'x', { detail: { error: 'e', errors } }))
  assert.match(msg, /\(\+3 more\)/)
})

test('apiErrorMessage falls back to headline alone', () => {
  const msg = apiErrorMessage(new ApiError(422, 'x', { detail: { error: 'just this' } }))
  assert.equal(msg, 'just this')
})
