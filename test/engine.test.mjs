import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FreeFirstEngine } from '../dist/engine.js'
import { FreeFirstStateStore } from '../dist/state.js'
import { ModeStore } from '../dist/mode.js'
import { applyFailure, initialHealth } from '../dist/health.js'

const START = Date.parse('2026-10-19T02:00:00Z')
const FREE = { provider: 'opencode-go', model: 'beam-free' }
const PAID = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
const DIRECT = { provider: 'deepseek', model: 'deepseek-flash' }

function fakeClock(start = START) {
  let now = start
  const timers = []
  return {
    now: () => now,
    setTimer(callback, delay) {
      const timer = { at: now + delay, callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) { timer.cleared = true },
    async advanceTo(target) {
      for (;;) {
        const pending = timers.filter(timer => !timer.cleared && timer.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!pending) break
        now = Math.max(now, pending.at)
        pending.cleared = true
        pending.callback()
        await new Promise(resolve => setImmediate(resolve))
      }
      now = target
    },
    pending: () => timers.filter(timer => !timer.cleared).length,
  }
}

function session(id, options = {}) {
  const header = options.header
  const events = options.events ?? []
  return {
    id,
    requestHeader: () => header === undefined ? undefined : { config: header },
    events: () => events,
  }
}

async function makeEngine(overrides = {}, start = START) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-free-first-'))
  const clock = fakeClock(start)
  const store = new FreeFirstStateStore(join(dir, 'state.json'))
  await store.load()
  const modeStore = new ModeStore(join(dir, 'mode.json'))
  const config = {
    free: FREE,
    fallback: PAID,
    mode: 'free-first',
    preferAsDefault: true,
    respectExplicitModelSelection: true,
    backoffMs: [60_000, 120_000, 300_000],
    maxCooldownMs: 900_000,
    jitterRatio: 0,
    routeRejectRetryMs: 300_000,
    probeLeaseMs: 60_000,
    ...overrides,
  }
  const engine = new FreeFirstEngine({ store, modeStore, config, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  await engine.load()
  return { engine, clock, dir, store, modeStore }
}

test('a new managed session starts on the free route', async () => {
  const { engine, dir } = await makeEngine()
  const result = await engine.selectRoute(session('s1'), FREE)
  assert.equal(result.managed, true)
  assert.deepEqual(result.route, FREE)
  assert.equal(result.reason, 'free-healthy')
  await rm(dir, { recursive: true, force: true })
})

test('a rate limit moves the same session to the fallback', async () => {
  const { engine, dir } = await makeEngine()
  const s = session('s1', { header: FREE })
  const result = await engine.recordFailure(s, { code: 'RATE_LIMIT', status: 429 }, FREE)
  assert.equal(result.failover, true)
  const selected = await engine.selectRoute(s, FREE)
  assert.deepEqual(selected.route, PAID)
  assert.equal(engine.health().cooldownReason, 'rate-limit')
  await rm(dir, { recursive: true, force: true })
})

test('a provider 500 uses the transient path and never claims a rate limit', async () => {
  const { engine, dir } = await makeEngine()
  const s = session('s1', { header: FREE })
  await engine.recordFailure(s, { code: 'SERVER', status: 503 }, FREE)
  assert.equal(engine.health().cooldownReason, 'transient')
  await rm(dir, { recursive: true, force: true })
})

test('auth, invalid-model, context, tool, and abort failures do not fail over', async () => {
  for (const failure of [
    { code: 'AUTH', status: 401 },
    { code: 'INVALID_MODEL' },
    { code: 'CONTEXT_WINDOW_EXCEEDED' },
    { code: 'TOOL_ERROR' },
    { code: 'ABORTED' },
  ]) {
    const { engine, dir } = await makeEngine()
    const s = session('s1', { header: FREE })
    const result = await engine.recordFailure(s, failure, FREE)
    assert.equal(result.failover, false, JSON.stringify(failure))
    assert.equal(engine.health().state, 'healthy')
    await rm(dir, { recursive: true, force: true })
  }
})

test('only one of two concurrent sessions probes free after a cooldown', async () => {
  const { engine, clock, dir } = await makeEngine()
  await engine.recordFailure(session('s1', { header: FREE }), { code: 'RATE_LIMIT' }, FREE)
  const s1 = session('s1', { header: FREE })
  const s2 = session('s2', { header: FREE })
  assert.deepEqual((await engine.selectRoute(s1, FREE)).route, PAID)
  assert.deepEqual((await engine.selectRoute(s2, FREE)).route, PAID)
  await clock.advanceTo(START + 60_000)
  assert.deepEqual((await engine.selectRoute(s1, FREE)).route, FREE)
  assert.deepEqual((await engine.selectRoute(s2, FREE)).route, PAID)
  await rm(dir, { recursive: true, force: true })
})

test('a successful free turn clears the cooldown and returns the session to free', async () => {
  const { engine, clock, dir } = await makeEngine()
  const s = session('s1', { header: FREE })
  await engine.recordFailure(s, { code: 'RATE_LIMIT' }, FREE)
  await clock.advanceTo(START + 60_000)
  assert.deepEqual((await engine.selectRoute(s, FREE)).route, FREE)
  await engine.recordSuccess(s, FREE)
  assert.equal(engine.health().state, 'healthy')
  assert.deepEqual((await engine.selectRoute(s, FREE)).route, FREE)
  await rm(dir, { recursive: true, force: true })
})

test('an explicit unrelated model is never managed', async () => {
  const { engine, dir } = await makeEngine()
  const s = session('s1', { header: DIRECT, events: [{ type: 'model/selection', data: DIRECT }] })
  assert.equal(engine.isManaged(s), false)
  const selection = await engine.selectRoute(s, DIRECT)
  assert.equal(selection.managed, false)
  assert.deepEqual(selection.route, DIRECT)
  await rm(dir, { recursive: true, force: true })
})

test('an explicit free selection is managed; an explicit paid selection is not', async () => {
  const { engine, dir } = await makeEngine()
  const free = session('s1', { header: FREE, events: [{ type: 'model/selection', data: FREE }] })
  const paid = session('s2', { header: PAID, events: [{ type: 'model/selection', data: PAID }] })
  assert.equal(engine.isManaged(free), true)
  assert.equal(engine.isManaged(paid), false)
  await rm(dir, { recursive: true, force: true })
})

test('a persisted fallback session is still managed after a reload', async () => {
  const { engine, store, dir } = await makeEngine()
  const s = session('s1', { header: FREE })
  await engine.recordFailure(s, { code: 'RATE_LIMIT' }, FREE)
  await store.flush()
  const reopened = new FreeFirstStateStore(store.path)
  await reopened.load()
  const modeStore = new ModeStore(join(dir, 'mode.json'))
  const config = {
    free: FREE, fallback: PAID, mode: 'free-first', preferAsDefault: true, respectExplicitModelSelection: true,
    backoffMs: [60_000], maxCooldownMs: 900_000, jitterRatio: 0,
    routeRejectRetryMs: 300_000, probeLeaseMs: 60_000,
  }
  const resumed = new FreeFirstEngine({ store: reopened, modeStore, config, now: () => START + 1000 })
  await resumed.load()
  const paidSession = session('s1', { header: PAID })
  assert.equal(resumed.isManaged(paidSession), true)
  await rm(dir, { recursive: true, force: true })
})

test('waitForChange wakes at the cooldown boundary without polling', async () => {
  const { engine, clock, dir } = await makeEngine()
  await engine.store.update(state => ({
    ...state,
    health: applyFailure(initialHealth(), { now: START, kind: 'rate-limit' }, engine.config),
  }))
  let woke = false
  const wait = engine.waitForChange(undefined, 's1').then(() => { woke = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(woke, false)
  assert.equal(clock.pending(), 1)
  await clock.advanceTo(START + 60_000)
  await wait
  assert.equal(woke, true)
  assert.equal(clock.pending(), 0)
  await rm(dir, { recursive: true, force: true })
})

test('abort releases a waiting request', async () => {
  const { engine, controller, dir } = await (async () => {
    const made = await makeEngine()
    return { ...made, controller: new AbortController() }
  })()
  await engine.store.update(state => ({
    ...state,
    health: applyFailure(initialHealth(), { now: START, kind: 'rate-limit' }, engine.config),
  }))
  const wait = engine.waitForChange(controller.signal, 's1')
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(wait, /aborted/)
  await rm(dir, { recursive: true, force: true })
})

test('peak-only uses free during a positive PEAK window', async () => {
  const { engine, dir } = await makeEngine({ mode: 'peak-only' })
  const result = await engine.selectRoute(session('s1'), FREE, true)
  assert.equal(result.managed, true)
  assert.deepEqual(result.route, FREE)
  assert.equal(result.reason, 'free-healthy')
  await rm(dir, { recursive: true, force: true })
})

test('peak-only uses the paid route directly when pricing is not PEAK', async () => {
  const { engine, dir } = await makeEngine({ mode: 'peak-only' })
  const result = await engine.selectRoute(session('s1'), FREE, false)
  assert.equal(result.managed, true)
  assert.deepEqual(result.route, PAID)
  assert.equal(result.reason, 'peak-only-not-peak')
  await rm(dir, { recursive: true, force: true })
})

test('peak-only does not claim a recovery probe outside PEAK', async () => {
  const { engine, clock, dir } = await makeEngine({ mode: 'peak-only' })
  await engine.recordFailure(session('s1', { header: FREE }), { code: 'RATE_LIMIT' }, FREE)
  await clock.advanceTo(START + 60_000)
  const offPeak = await engine.selectRoute(session('s1', { header: FREE }), FREE, false)
  assert.deepEqual(offPeak.route, PAID)
  assert.equal(engine.health().probe, undefined)
  const peak = await engine.selectRoute(session('s1', { header: FREE }), FREE, true)
  assert.deepEqual(peak.route, FREE)
  assert.equal(engine.health().probe?.sessionId, 's1')
  await rm(dir, { recursive: true, force: true })
})

test('disabled mode leaves routing and health untouched', async () => {
  const { engine, dir } = await makeEngine({ mode: 'disabled' })
  const s = session('s1', { header: FREE })
  const selected = await engine.selectRoute(s, FREE)
  assert.equal(selected.managed, false)
  assert.deepEqual(selected.route, FREE)
  const failure = await engine.recordFailure(s, { code: 'RATE_LIMIT', status: 429 }, FREE)
  assert.equal(failure.failover, false)
  assert.equal(engine.health().state, 'healthy')
  await rm(dir, { recursive: true, force: true })
})

test('a saved mode override persists across a reload', async () => {
  const { engine, dir } = await makeEngine()
  assert.equal(engine.mode, 'free-first')
  await engine.setMode('peak-only')
  const reopened = new ModeStore(join(dir, 'mode.json'))
  assert.equal(await reopened.load(), 'peak-only')
  await rm(dir, { recursive: true, force: true })
})

test('configured reset clears the saved override and restores the configured mode', async () => {
  const { engine, dir } = await makeEngine({ mode: 'peak-only' })
  await engine.setMode('disabled')
  assert.equal(engine.mode, 'disabled')
  assert.equal(engine.modeSource, 'override')
  await engine.clearModeOverride()
  assert.equal(engine.mode, 'peak-only')
  assert.equal(engine.modeSource, 'config')
  const reopened = new ModeStore(join(dir, 'mode.json'))
  assert.equal(await reopened.load(), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('a direct DeepSeek request is never managed, even as the default route', async () => {
  const { engine, dir } = await makeEngine()
  const s = session('s1')
  const selected = await engine.selectRoute(s, DIRECT, true)
  assert.equal(selected.managed, false)
  assert.deepEqual(selected.route, DIRECT)
  await rm(dir, { recursive: true, force: true })
})

test('a direct DeepSeek failure never arms OpenCode Go failover state', async () => {
  const { engine, dir } = await makeEngine()
  const s = session('s1', { header: DIRECT })
  for (const failure of [
    { code: 'RATE_LIMIT', status: 429 },
    { code: 'SERVER', status: 503 },
    { code: 'AUTH', status: 401 },
  ]) {
    const result = await engine.recordFailure(s, failure, DIRECT)
    assert.equal(result.failover, false, JSON.stringify(failure))
  }
  assert.equal(engine.health().state, 'healthy')
  const free = await engine.selectRoute(session('s2'), FREE, false)
  assert.deepEqual(free.route, FREE)
  await rm(dir, { recursive: true, force: true })
})

test('an OpenCode Go failure never selects the direct DeepSeek provider', async () => {
  const { engine, dir } = await makeEngine()
  const s = session('s1', { header: FREE })
  const failure = await engine.recordFailure(s, { code: 'RATE_LIMIT', status: 429 }, FREE)
  assert.equal(failure.failover, true)
  const selected = await engine.selectRoute(s, FREE)
  assert.deepEqual(selected.route, PAID)
  assert.equal(selected.route.provider, 'opencode-go')
  assert.notEqual(selected.route.provider, DIRECT.provider)
  await rm(dir, { recursive: true, force: true })
})

test('returning from direct DeepSeek to OpenCode Go restores normal management', async () => {
  const { engine, dir } = await makeEngine()
  const direct = session('s1', { header: DIRECT, events: [{ type: 'model/selection', data: DIRECT }] })
  assert.equal((await engine.selectRoute(direct, DIRECT, true)).managed, false)
  const go = session('s2', { header: FREE })
  const selected = await engine.selectRoute(go, FREE, true)
  assert.equal(selected.managed, true)
  assert.deepEqual(selected.route, FREE)
  await rm(dir, { recursive: true, force: true })
})
