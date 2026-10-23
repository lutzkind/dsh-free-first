/** Free-first routing: health, one-probe recovery, managed sessions, and waits. */

import { classifyFailure, type FailureView } from './classify.js'
import {
  applyFailure,
  claimProbe,
  cooldownExpired,
  freeRouteUsable,
  markHealthy,
  releaseProbe,
  type HealthOptions,
  type HealthRecord,
} from './health.js'
import type { FreeFirstState, FreeFirstStateStore } from './state.js'

export interface Route {
  provider: string
  model: string
}

export interface EngineConfig extends HealthOptions {
  free: Route
  fallback: Route
  preferAsDefault: boolean
  respectExplicitModelSelection: boolean
  reasoningEffort?: string
}

export interface SessionView {
  id: string
  requestHeader?: () => { config: Route } | undefined
  events?: () => readonly { type: string; data?: unknown }[]
}

export interface SelectionResult {
  route: Route
  managed: boolean
  reason: string
}

export interface FreeFirstEngineOptions {
  store: FreeFirstStateStore
  config: EngineConfig
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

function sameRoute(left: Route | undefined, right: Route): boolean {
  return left !== undefined && left.provider === right.provider && left.model === right.model
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error('free-first wait aborted')
  error.name = 'AbortError'
  return error
}

/** One process-local free-route controller. */
export class FreeFirstEngine {
  private readonly store: FreeFirstStateStore
  readonly config: EngineConfig
  private readonly now: () => number
  private readonly setTimer: NonNullable<FreeFirstEngineOptions['setTimer']>
  private readonly clearTimer: NonNullable<FreeFirstEngineOptions['clearTimer']>
  private readonly waiters = new Set<() => void>()
  private disposed = false

  constructor(options: FreeFirstEngineOptions) {
    this.store = options.store
    this.config = options.config
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  async load(): Promise<void> {
    await this.store.load()
  }

  health(): HealthRecord {
    return this.store.current().health
  }

  state(): FreeFirstState {
    return this.store.current()
  }

  /** Read the latest explicit selection recorded by the Session controller. */
  explicitSelection(session: SessionView): Route | undefined {
    if (session.events === undefined) return undefined
    let latest: Route | undefined
    for (const event of session.events()) {
      if (event.type !== 'model/selection') continue
      const data = event.data as { provider?: unknown; model?: unknown } | undefined
      if (typeof data?.provider === 'string' && typeof data.model === 'string') {
        latest = { provider: data.provider, model: data.model }
      }
    }
    return latest
  }

  /** Whether this session is owned by free-first rather than an explicit user route. */
  isManaged(session: SessionView): boolean {
    if (this.config.respectExplicitModelSelection) {
      const explicit = this.explicitSelection(session)
      if (explicit !== undefined) {
        if (sameRoute(explicit, this.config.free)) return true
        if (sameRoute(explicit, this.config.fallback)) return false
        return false
      }
    }
    const header = session.requestHeader?.()?.config
    if (header === undefined) return this.config.preferAsDefault
    if (sameRoute(header, this.config.free)) return true
    if (sameRoute(header, this.config.fallback)) {
      return this.store.current().sessions[session.id]?.managed === true
    }
    return false
  }

  /**
   * Resolve the route for one request. A managed session uses the free route
   * when healthy or when it wins the single post-cooldown probe lease; every
   * other managed request uses the paid fallback.
   */
  async selectRoute(session: SessionView, current: Route): Promise<SelectionResult> {
    if (!this.isManaged(session)) {
      return { route: current, managed: false, reason: 'explicit-or-unrelated-route' }
    }
    const now = this.now()
    const health = this.health()
    if (health.state === 'healthy') {
      return { route: this.config.free, managed: true, reason: 'free-healthy' }
    }
    if (cooldownExpired(health, now)) {
      const claim = claimProbe(health, session.id, now, this.config)
      if (claim.record !== health) await this.persistHealth(claim.record)
      if (claim.claimed) {
        return { route: this.config.free, managed: true, reason: 'free-recovery-probe' }
      }
    }
    return {
      route: this.config.fallback,
      managed: true,
      reason: `free-${health.cooldownReason ?? 'cooldown'}`,
    }
  }

  /**
   * Record one free-route failure and decide whether the same step should be
   * retried on the paid fallback. Only a conservative transient/limit verdict
   * returns true.
   */
  async recordFailure(session: SessionView, failure: FailureView, route: Route): Promise<{ failover: boolean; reason: string }> {
    if (!this.isManaged(session) || !sameRoute(route, this.config.free)) {
      return { failover: false, reason: 'not-a-managed-free-request' }
    }
    const classification = classifyFailure(failure)
    if (!classification.failover || classification.kind === undefined) {
      const released = releaseProbe(this.health(), session.id)
      if (released !== this.health()) await this.persistHealth(released)
      return { failover: false, reason: classification.reason }
    }
    const now = this.now()
    const next = applyFailure(releaseProbe(this.health(), session.id), {
      now,
      kind: classification.kind,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs }),
    }, this.config)
    await this.store.update(state => ({
      ...state,
      health: next,
      sessions: {
        ...state.sessions,
        [session.id]: {
          managed: true,
          since: state.sessions[session.id]?.since ?? now,
          movedToFallback: true,
        },
      },
    }))
    this.wakeWaiters()
    return { failover: true, reason: classification.reason }
  }

  /** A successful free-route assistant message confirms recovery. */
  async recordSuccess(session: SessionView, route: Route): Promise<void> {
    if (!sameRoute(route, this.config.free)) return
    if (!this.isManaged(session)) return
    const released = releaseProbe(this.health(), session.id)
    if (released.state === 'healthy' && released.probe === undefined) {
      if (released !== this.health()) await this.persistHealth(released)
      return
    }
    const healthy = markHealthy(released, this.now())
    await this.store.update(state => ({ ...state, health: healthy }))
    this.wakeWaiters()
  }

  /** Clear the cooldown on an explicit operator reset. */
  async reset(): Promise<void> {
    const healthy = markHealthy(this.health(), this.now())
    await this.store.update(state => ({ ...state, health: healthy }))
    this.wakeWaiters()
  }

  /** Forget one session's managed record without touching shared health. */
  async forgetSession(sessionId: string): Promise<void> {
    const state = this.store.current()
    if (state.sessions[sessionId] === undefined) return
    await this.store.update(current => {
      const sessions = { ...current.sessions }
      delete sessions[sessionId]
      return { ...current, sessions }
    })
  }

  /**
   * Wait until free health changes or its next cooldown/probe boundary.
   * One timer is scheduled at the next authoritative instant; no polling.
   */
  async waitForChange(signal?: AbortSignal, sessionId?: string): Promise<void> {
    while (true) {
      signal?.throwIfAborted()
      if (this.disposed) throw new Error('dsh-free-first is disposed')
      const health = this.health()
      const now = this.now()
      const foreignProbe = health.probe !== undefined
        && health.probe.until > now
        && health.probe.sessionId !== sessionId
      if (freeRouteUsable(health, now) && !foreignProbe) return
      const deadline = foreignProbe
        ? health.probe!.until
        : health.probe !== undefined && health.probe.until > now
          ? health.probe.until
          : health.cooldownUntil
      if (deadline === undefined) return
      const waiter = { resolve: undefined as (() => void) | undefined }
      const promise = new Promise<void>((resolve) => { waiter.resolve = resolve })
      const wake = (): void => waiter.resolve?.()
      this.waiters.add(wake)
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => wake()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (deadline > now) {
        timer = this.setTimer(wake, Math.max(1, deadline - now))
      } else {
        wake()
      }
      try {
        await promise
      } finally {
        signal?.removeEventListener('abort', onAbort)
        if (timer !== undefined) this.clearTimer(timer)
        this.waiters.delete(wake)
      }
      signal?.throwIfAborted()
    }
  }

  wakeWaiters(): void {
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
  }

  private async persistHealth(health: HealthRecord): Promise<void> {
    await this.store.update(state => ({ ...state, health }))
    this.wakeWaiters()
  }

  dispose(): void {
    this.disposed = true
    this.wakeWaiters()
  }
}
