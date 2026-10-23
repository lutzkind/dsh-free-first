import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyFailure,
  claimProbe,
  initialHealth,
  markHealthy,
  releaseProbe,
} from '../dist/health.js'

const options = {
  backoffMs: [60_000, 120_000, 300_000],
  maxCooldownMs: 900_000,
  jitterRatio: 0,
  routeRejectRetryMs: 300_000,
  probeLeaseMs: 60_000,
}
const now = Date.parse('2026-10-19T02:00:00Z')

test('a rate limit arms the first ladder rung and advances the level', () => {
  const health = applyFailure(initialHealth(), { now, kind: 'rate-limit', code: 'RATE_LIMIT' }, options)
  assert.equal(health.state, 'cooldown')
  assert.equal(health.cooldownUntil, now + 60_000)
  assert.equal(health.level, 1)
  assert.equal(health.failures, 1)
})

test('a provider Retry-After wins when it fits the bound', () => {
  const health = applyFailure(initialHealth(), { now, kind: 'rate-limit', providerRetryAfterMs: 42_000 }, options)
  assert.equal(health.cooldownUntil, now + 42_000)
})

test('a nonsense provider delay falls back to the ladder', () => {
  const health = applyFailure(initialHealth(), { now, kind: 'rate-limit', providerRetryAfterMs: 86_400_000 }, options)
  assert.equal(health.cooldownUntil, now + 60_000)
})

test('repeated failures back off further and clamp at the ladder end', () => {
  let health = initialHealth()
  const expected = [60_000, 120_000, 300_000, 300_000]
  for (const delay of expected) {
    health = applyFailure(health, { now, kind: 'transient', code: 'SERVER' }, options)
    assert.equal(health.cooldownUntil, now + delay)
  }
})

test('only one session claims the post-cooldown probe', () => {
  let health = applyFailure(initialHealth(), { now, kind: 'rate-limit' }, options)
  const ready = now + 60_000
  const first = claimProbe(health, 's1', ready, options)
  assert.equal(first.claimed, true)
  health = first.record
  const second = claimProbe(health, 's2', ready, options)
  assert.equal(second.claimed, false)
  assert.equal(second.record, health)
  const owner = claimProbe(health, 's1', ready, options)
  assert.equal(owner.claimed, true)
})

test('an expired probe lease lets another session try', () => {
  let health = applyFailure(initialHealth(), { now, kind: 'rate-limit' }, options)
  health = claimProbe(health, 's1', now + 60_000, options).record
  const later = now + 60_000 + 60_001
  assert.equal(claimProbe(health, 's2', later, options).claimed, true)
})

test('a confirmed success clears the cooldown and every ladder', () => {
  let health = applyFailure(initialHealth(), { now, kind: 'rate-limit' }, options)
  health = releaseProbe(health, 's1')
  health = markHealthy(health, now + 10_000)
  assert.equal(health.state, 'healthy')
  assert.equal(health.level, 0)
  assert.equal(health.failures, 0)
  assert.equal(health.probe, undefined)
})
