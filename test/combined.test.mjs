import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'

const FREE = { provider: 'opencode', model: 'deepseek-v4.1-flash-free' }
const PAID = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }

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

function makeSession() {
  const events = []
  return {
    id: 'session-1',
    header: undefined,
    events: () => events,
    requestHeader() { return this.header === undefined ? undefined : { config: this.header } },
  }
}

function fakeOffpeak({ initiallyAllowed = false } = {}) {
  let allowed = initiallyAllowed
  let release
  const waiting = new Promise(resolve => { release = resolve })
  return {
    evaluate() { return { allowed } },
    waitUntilAllowed() { return waiting },
    allow() { allowed = true; release() },
  }
}

async function load(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-free-first-plugin-'))
  const ctx = makeContext()
  const offpeak = fakeOffpeak({ initiallyAllowed: options.paidAllowed ?? false })
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

test('free healthy is preferred', async () => {
  const { ctx, dir } = await load()
  const session = makeSession()
  const selected = await ctx.emit('agent/request', { agent: { session }, signal: new AbortController().signal, turn: 1, step: 1 }, FREE)
  assert.deepEqual({ provider: selected.provider, model: selected.model }, FREE)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('a real rate limit retries the same step on the paid fallback', async () => {
  const { ctx, dir } = await load({ paidAllowed: true })
  const session = makeSession()
  let nextCalled = false
  session.header = FREE
  const action = await ctx.emit('agent/request-error', {
    agent: { session }, signal: new AbortController().signal, turn: 1, step: 1,
    provider: FREE.provider, failure: { code: 'RATE_LIMIT', message: '429', status: 429 },
  }, undefined)
  assert.deepEqual(action, { kind: 'retry' })
  const selected = await ctx.emit('agent/request', { agent: { session }, signal: new AbortController().signal, turn: 1, step: 1 }, FREE)
  assert.deepEqual({ provider: selected.provider, model: selected.model }, PAID)
  assert.equal(nextCalled, false)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('auth failures surface instead of falling back', async () => {
  const { ctx, dir } = await load()
  const session = makeSession()
  session.header = FREE
  const action = await ctx.emit('agent/request-error', {
    agent: { session }, signal: new AbortController().signal, turn: 1, step: 1,
    provider: FREE.provider, failure: { code: 'AUTH', message: 'invalid key', status: 401 },
  }, 'downstream')
  assert.equal(action, 'downstream')
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('free unavailable and paid off-peak uses the fallback immediately', async () => {
  const { ctx, offpeak, dir } = await load({ paidAllowed: true })
  const session = makeSession()
  session.header = FREE
  await ctx.emit('agent/request-error', {
    agent: { session }, signal: new AbortController().signal, turn: 1, step: 1,
    provider: FREE.provider, failure: { code: 'RATE_LIMIT', status: 429 },
  }, undefined)
  const selected = await ctx.emit('agent/request', { agent: { session }, signal: new AbortController().signal, turn: 1, step: 1 }, FREE)
  assert.deepEqual({ provider: selected.provider, model: selected.model }, PAID)
  offpeak.allow()
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})

test('free unavailable and paid at peak waits, then returns to free when it recovers', async () => {
  const { ctx, dir } = await load({ paidAllowed: false, config: { backoffMs: [30], jitterRatio: 0 } })
  const session = makeSession()
  session.header = FREE
  await ctx.emit('agent/request-error', {
    agent: { session }, signal: new AbortController().signal, turn: 1, step: 1,
    provider: FREE.provider, failure: { code: 'RATE_LIMIT', status: 429 },
  }, undefined)
  let settled = false
  const request = ctx.emit('agent/request', { agent: { session }, signal: new AbortController().signal, turn: 1, step: 1 }, FREE)
    .then(value => { settled = true; return value })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(settled, false)
  const selected = await request
  assert.deepEqual({ provider: selected.provider, model: selected.model }, FREE)
  await rm(dir, { recursive: true, force: true })
  ctx.disposers.forEach(dispose => dispose())
})
