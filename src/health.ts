/** Pure free-route health state machine with absolute cooldowns and one probe lease. */

export type CooldownReason = 'rate-limit' | 'quota' | 'route-rejected' | 'transient'

export interface ProbeLease {
  sessionId: string
  until: number
}

export interface HealthRecord {
  state: 'healthy' | 'cooldown'
  cooldownUntil?: number
  cooldownReason?: CooldownReason
  level: number
  failures: number
  lastFailureAt?: number
  lastFailureCode?: string
  lastHealthyAt?: number
  probe?: ProbeLease
}

export interface HealthOptions {
  backoffMs: readonly number[]
  maxCooldownMs: number
  jitterRatio: number
  routeRejectRetryMs: number
  probeLeaseMs: number
}

export interface FailureInput {
  now: number
  kind: CooldownReason
  code?: string
  providerRetryAfterMs?: number
  random?: () => number
}

export function initialHealth(): HealthRecord {
  return { state: 'healthy', level: 0, failures: 0 }
}

export function backoffFor(level: number, ladder: readonly number[]): number {
  if (ladder.length === 0) return 0
  const index = Math.min(Math.max(0, Math.floor(level)), ladder.length - 1)
  return ladder[index] ?? ladder[ladder.length - 1] ?? 0
}

export function withJitter(value: number, ratio: number, random: () => number): number {
  if (ratio <= 0) return Math.round(value)
  const span = value * Math.min(ratio, 1)
  const offset = (random() * 2 - 1) * span
  return Math.max(0, Math.round(value + offset))
}

export function cooldownFor(record: HealthRecord, input: FailureInput, options: HealthOptions): number {
  const providerDelay = input.providerRetryAfterMs
  if (input.kind !== 'transient'
    && providerDelay !== undefined
    && Number.isFinite(providerDelay)
    && providerDelay >= 1_000
    && providerDelay <= options.maxCooldownMs) {
    return Math.round(providerDelay)
  }
  if (input.kind === 'route-rejected') {
    return Math.max(options.routeRejectRetryMs, backoffFor(record.level, options.backoffMs))
  }
  const ladder = backoffFor(record.level, options.backoffMs)
  return Math.max(1_000, Math.min(withJitter(ladder, options.jitterRatio, input.random ?? Math.random), options.maxCooldownMs))
}

export function applyFailure(
  record: HealthRecord,
  input: FailureInput,
  options: HealthOptions,
): HealthRecord {
  const cooldownMs = cooldownFor(record, input, options)
  return {
    ...record,
    state: 'cooldown',
    cooldownUntil: input.now + cooldownMs,
    cooldownReason: input.kind,
    level: Math.min(record.level + 1, Math.max(1, options.backoffMs.length)),
    failures: record.failures + 1,
    lastFailureAt: input.now,
    ...(input.code === undefined ? {} : { lastFailureCode: input.code }),
    probe: undefined,
  }
}

export function markHealthy(record: HealthRecord, now: number): HealthRecord {
  return {
    ...record,
    state: 'healthy',
    cooldownUntil: undefined,
    cooldownReason: undefined,
    level: 0,
    failures: 0,
    lastHealthyAt: now,
    probe: undefined,
  }
}

export function cooldownExpired(record: HealthRecord, now: number): boolean {
  return record.state === 'cooldown' && record.cooldownUntil !== undefined && now >= record.cooldownUntil
}

/**
 * Claim the single recovery probe slot. Only one session may test the free
 * route after a cooldown; every other session stays on the paid fallback until
 * the probe settles or its lease expires.
 */
export function claimProbe(
  record: HealthRecord,
  sessionId: string,
  now: number,
  options: HealthOptions,
): { record: HealthRecord; claimed: boolean } {
  if (record.state === 'healthy') return { record, claimed: true }
  if (!cooldownExpired(record, now)) return { record, claimed: false }
  if (record.probe !== undefined && record.probe.until > now && record.probe.sessionId !== sessionId) {
    return { record, claimed: false }
  }
  return {
    record: { ...record, probe: { sessionId, until: now + options.probeLeaseMs } },
    claimed: true,
  }
}

export function releaseProbe(record: HealthRecord, sessionId: string): HealthRecord {
  if (record.probe?.sessionId !== sessionId) return record
  return { ...record, probe: undefined }
}

export function freeRouteUsable(record: HealthRecord, now: number): boolean {
  return record.state === 'healthy' || cooldownExpired(record, now)
}
