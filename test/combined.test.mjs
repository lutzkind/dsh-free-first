import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'

const FREE = { provider: 'opencode-go', model: 'beam-free' }
const PAID = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
const DIRECT = { provider: 'deepseek', model: 'deepseek-flash' }

function makeContext() {
  const listeners = new Map()
  const services = new Map()
  const commands = new Map()
  const ctx = {
    on(name, listener, options) {
      const list = listeners.get(name) ?? []
      if (options?.prepend) list.unshift(listener)
      else list.push(listener)
      listeners.set(name, list)
      return () => true
    },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') ctx.disposers.push(dispose)
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    get(name) { return services.get(name) },
    logger: { info() {}, warn() {}, error() {} },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    disposers: [],
  }
  ctx.emit = async (name, payload, initial) => {
    const list = listeners.get(name) ?? []
    let index = -1
    const next = async () => {
      index += 1
      if (index >= list.length) return initial
      return list[index](payload, next)
    }
    return next()
  }
  ctx.command = command => commands.get(command)
  return ctx
}

function makeSession(id = 'session-1', header) {
  const events = []
  return {
    id,
    header,
    events: () => events,
    requestHeader() { return this.header === undefined ? undefined : { config: this.header } },
  }
}

function fakeOffpeak({ initiallyAllowed = false, state = 'OFF_PEAK' } = {}) {
  let allowed = initiallyAllowed
  let pricingState = state
  let evaluateCalls = 0
  let release
  const waiting = new Promise(resolve => { release = resolve })
  return {
    evaluate() {
      evaluateCalls += 1
      return { allowed, state: pricingState }
    },
    waitUntilAllowed() { return waiting },
    allow() { allowed = true; release() },
    setState(next) { pricingState = next },
    calls() { return evaluateCalls },
  }
}

async function load(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-free-first-plugin-'))
  const ctx = makeContext()
  const offpeak = fakeOffpeak({
    initiallyAllowed: options.paidAllowed ?? false,
    state: options.pricingState ?? 'OFF_PEAK',
  })
  ctx.provide('offpeak', offpeak)
  await apply(ctx, {
    free: FREE,
    fallback: PAID,
    backoffMs: [40],
    jitterRatio: 0,
    probeLeaseMs: 500,
    statePath: join(dir, 'state.json'),
    ...options.config,
  })
  return { ctx, offpeak, dir }
}

function command(rawInput = '', header) {
  return {
    agent: { session: makeSession('command-session', header) },
    rawInput,
    signal: new AbortController().signal,
  }
}

function request(ctx, session, initial) {
  return ctx.emit('agent/request', {
    agent: { session }, signal: new AbortController().signal, turn: 1, step: 1,
  }, initial)
}

function failure(ctx, session, route, value, sentinel = undefined) {
  return ctx.emit('agent/request-error', {
    agent: { session }, signal: new AbortController().signal, turn: 1, step: 1,
    provider: route.provider, failure: value,
  }, sentinel)
}

test('free healthy is preferred', async () => {
  const { ctx, dir } = await load()
  const session = makeSession()
  const selected = await request(ctx, session, FREE)
  assert.deepEqual({ provider: selected.provider, model: selected.model }, FREE)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('a real rate limit retries the same step on the paid fallback', async () => {
  const { ctx, dir } = await load({ paidAllowed: true })
  const session = makeSession('session-1', FREE)
  const action = await failure(ctx, session, FREE, { code: 'RATE_LIMIT', message: '429', status: 429 })
  assert.deepEqual(action, { kind: 'retry' })
  const selected = await request(ctx, session, FREE)
  assert.deepEqual({ provider: selected.provider, model: selected.model }, PAID)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('auth failures surface instead of falling back', async () => {
  const { ctx, dir } = await load()
  const session = makeSession('session-1', FREE)
  const action = await failure(ctx, session, FREE, { code: 'AUTH', message: 'invalid key', status: 401 }, 'downstream')
  assert.equal(action, 'downstream')
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('free unavailable and paid off-peak uses the fallback immediately', async () => {
  const { ctx, offpeak, dir } = await load({ paidAllowed: true })
  const session = makeSession('session-1', FREE)
  await failure(ctx, session, FREE, { code: 'RATE_LIMIT', status: 429 })
  const selected = await request(ctx, session, FREE)
  assert.deepEqual({ provider: selected.provider, model: selected.model }, PAID)
  offpeak.allow()
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('free unavailable and paid at peak waits, then returns to free when it recovers', async () => {
  const { ctx, dir } = await load({ paidAllowed: false, config: { backoffMs: [30], jitterRatio: 0 } })
  const session = makeSession('session-1', FREE)
  await failure(ctx, session, FREE, { code: 'RATE_LIMIT', status: 429 })
  let settled = false
  const pending = request(ctx, session, FREE).then(value => { settled = true; return value })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(settled, false)
  const selected = await pending
  assert.deepEqual({ provider: selected.provider, model: selected.model }, FREE)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('a direct DeepSeek request bypasses free-first without asking for pricing', async () => {
  const { ctx, offpeak, dir } = await load({ paidAllowed: true })
  const session = makeSession('direct-1', DIRECT)
  const selected = await request(ctx, session, DIRECT)
  assert.deepEqual({ provider: selected.provider, model: selected.model }, DIRECT)
  assert.equal(offpeak.calls(), 0, 'pricing owner was consulted for a direct route')
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('direct DeepSeek rate limits, 5xx, and auth failures never invoke OpenCode Go fallback', async () => {
  const { ctx, dir } = await load({ paidAllowed: true })
  const session = makeSession('direct-1', DIRECT)
  for (const value of [
    { code: 'RATE_LIMIT', status: 429, message: '429' },
    { code: 'SERVER', status: 503, message: 'unavailable' },
    { code: 'AUTH', status: 401, message: 'invalid key' },
    { code: 'QUOTA', message: 'quota exhausted' },
  ]) {
    const action = await failure(ctx, session, DIRECT, value, 'downstream')
    assert.equal(action, 'downstream', JSON.stringify(value))
  }
  const status = await ctx.command('free-first').handler(command('status', DIRECT))
  assert.match(status.text, /Free route health: HEALTHY/)
  assert.match(status.text, /outside OpenCode Go/)
  const go = makeSession('go-1')
  assert.deepEqual((await request(ctx, go, FREE)).model, FREE.model)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('an OpenCode Go peak hold never escapes to direct DeepSeek', async () => {
  const { ctx, dir } = await load({ paidAllowed: false, config: { backoffMs: [30], jitterRatio: 0 } })
  const session = makeSession('go-1', FREE)
  await failure(ctx, session, FREE, { code: 'RATE_LIMIT', status: 429 })
  const selected = await request(ctx, session, FREE)
  assert.equal(selected.provider, 'opencode-go')
  assert.notEqual(selected.provider, DIRECT.provider)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('peak-only uses free only on a positive PEAK answer', async () => {
  const { ctx, offpeak, dir } = await load({ config: { mode: 'peak-only' }, pricingState: 'PEAK' })
  const session = makeSession()
  assert.deepEqual((await request(ctx, session, FREE)).model, FREE.model)
  offpeak.setState('OFF_PEAK')
  assert.deepEqual((await request(ctx, session, FREE)).model, PAID.model)
  for (const state of ['FLAT', 'UNTRACKED', 'UNKNOWN']) {
    offpeak.setState(state)
    assert.deepEqual((await request(ctx, session, FREE)).model, PAID.model, state)
  }
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('peak-only does not wait on the paid route or spend a free request off-peak', async () => {
  const { ctx, offpeak, dir } = await load({
    paidAllowed: true,
    pricingState: 'OFF_PEAK',
    config: { mode: 'peak-only', backoffMs: [600_000] },
  })
  const session = makeSession('go-1', FREE)
  await failure(ctx, session, FREE, { code: 'RATE_LIMIT', status: 429 })
  const selected = await request(ctx, session, FREE)
  assert.deepEqual(selected.model, PAID.model)
  assert.equal(offpeak.calls() > 0, true)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('disabled mode leaves normal routing and failures untouched', async () => {
  const { ctx, dir } = await load({ paidAllowed: true, config: { mode: 'disabled' } })
  const session = makeSession('go-1', FREE)
  const selected = await request(ctx, session, FREE)
  assert.deepEqual(selected, FREE)
  const action = await failure(ctx, session, FREE, { code: 'RATE_LIMIT', status: 429 }, 'downstream')
  assert.equal(action, 'downstream')
  const status = await ctx.command('free-first').handler(command('status'))
  assert.match(status.text, /Free usage mode: DISABLED/)
  assert.match(status.text, /normal DSH routing/)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('mode commands persist across a plugin restart and configured resets the choice', async () => {
  const first = await load()
  const set = await first.ctx.command('free-first').handler(command('mode peak-only'))
  assert.equal(set.kind, 'success')
  const saved = JSON.parse(await readFile(join(first.dir, 'mode.json'), 'utf8'))
  assert.equal(saved.mode, 'peak-only')
  first.ctx.disposers.forEach(dispose => dispose())

  const secondCtx = makeContext()
  secondCtx.provide('offpeak', fakeOffpeak({ state: 'PEAK' }))
  await apply(secondCtx, {
    free: FREE,
    fallback: PAID,
    backoffMs: [40],
    jitterRatio: 0,
    probeLeaseMs: 500,
    statePath: join(first.dir, 'state.json'),
  })
  const status = await secondCtx.command('free-first').handler(command('status'))
  assert.match(status.text, /Free usage mode: PEAK-ONLY \(saved override\)/)
  assert.match(status.text, /Configured mode: FREE-FIRST/)

  const reset = await secondCtx.command('free-first').handler(command('mode configured'))
  assert.equal(reset.kind, 'success')
  const after = await secondCtx.command('free-first').handler(command('status'))
  assert.match(after.text, /Free usage mode: FREE-FIRST \(configured default\)/)
  await assert.rejects(readFile(join(first.dir, 'mode.json'), 'utf8'), /ENOENT/)

  secondCtx.disposers.forEach(dispose => dispose())
  await rm(first.dir, { recursive: true, force: true })
})

test('an invalid mode is rejected without changing the effective mode', async () => {
  const { ctx, dir } = await load({ config: { mode: 'peak-only' } })
  const result = await ctx.command('free-first').handler(command('mode always'))
  assert.equal(result.kind, 'error')
  const status = await ctx.command('free-first').handler(command('status'))
  assert.match(status.text, /Free usage mode: PEAK-ONLY \(configured default\)/)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('a config that points either route outside OpenCode Go is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-free-first-plugin-'))
  const ctx = makeContext()
  await assert.rejects(
    apply(ctx, { free: DIRECT, fallback: PAID, statePath: join(dir, 'state.json') }),
    /free\.provider must be "opencode-go"/,
  )
  await assert.rejects(
    apply(ctx, { free: FREE, fallback: DIRECT, statePath: join(dir, 'state.json') }),
    /fallback\.provider must be "opencode-go"/,
  )
  await rm(dir, { recursive: true, force: true })
})
