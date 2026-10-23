import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure } from '../dist/classify.js'

test('HTTP 429 is a genuine rate limit', () => {
  const result = classifyFailure({ status: 429, message: 'too many requests' })
  assert.equal(result.failover, true)
  assert.equal(result.kind, 'rate-limit')
})

test('structured RATE_LIMIT and QUOTA codes fail over', () => {
  assert.equal(classifyFailure({ code: 'RATE_LIMIT' }).kind, 'rate-limit')
  assert.equal(classifyFailure({ code: 'QUOTA' }).kind, 'quota')
})

test('the OpenCode free-tier provenance gate is a route rejection', () => {
  const result = classifyFailure({ code: 'AUTH', status: 403, message: "OpenCode's free tier can only be used from within OpenCode." })
  assert.equal(result.failover, true)
  assert.equal(result.kind, 'route-rejected')
})

test('provider/server 5xx and transport failures are transient', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(classifyFailure({ status }).kind, 'transient')
  }
  for (const code of ['SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.equal(classifyFailure({ code }).kind, 'transient')
  }
})

test('bad requests, auth, invalid models, context, tools, and aborts never fail over', () => {
  for (const failure of [
    { code: 'AUTH', status: 401, message: 'invalid api key' },
    { code: 'MISSING_CREDENTIAL' },
    { code: 'INVALID_CREDENTIAL' },
    { code: 'INVALID_REQUEST', status: 400, message: 'bad request' },
    { code: 'INVALID_MODEL' },
    { code: 'CONTEXT_WINDOW_EXCEEDED' },
    { code: 'TOOL_ERROR' },
    { code: 'CONTENT_FILTER' },
    { code: 'ABORTED' },
    { code: 'EMPTY_RESPONSE' },
    { code: 'NO_ADAPTER' },
    { code: 'UNKNOWN', message: 'something odd' },
    { status: 403, message: 'permission denied' },
  ]) {
    assert.equal(classifyFailure(failure).failover, false, JSON.stringify(failure))
  }
})

test('a generic 500 is never presented as a rate limit', () => {
  const result = classifyFailure({ status: 500, message: 'internal server error' })
  assert.equal(result.kind, 'transient')
  assert.notEqual(result.kind, 'rate-limit')
})
