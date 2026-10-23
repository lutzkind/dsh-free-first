/** Conservative free-route failure classification for DeepSeek Harness LlmFailure values. */

export interface FailureView {
  message?: string
  code?: string
  status?: number
  providerRetryAfterMs?: number
}

export type FailureKind = 'rate-limit' | 'quota' | 'route-rejected' | 'transient'

export interface Classification {
  failover: boolean
  kind?: FailureKind
  reason: string
}

const TRANSIENT_SERVER = new Set([500, 502, 503, 504])

const NON_TRANSIENT_CODES = new Set([
  'AUTH',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'INVALID_REQUEST',
  'INVALID_MODEL',
  'INVALID_PREPARED_CALL',
  'INVALID_ARGS',
  'UNSUPPORTED_OPTION',
  'UNSUPPORTED_CONTENT',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
  'TOOL_ERROR',
  'CONTENT_FILTER',
  'ABORTED',
  'NO_ADAPTER',
  'DUPLICATE_ADAPTER',
  'EMPTY_RESPONSE',
  'UNKNOWN',
])

const FREE_ROUTE_GATE = /free tier can only be used from within opencode\b/iu

/** A positive rate-limit or quota signal; never inferred from unrelated text. */
function classifyLimit(failure: FailureView): Classification | undefined {
  if (failure.status === 429) return { failover: true, kind: 'rate-limit', reason: 'http-429' }
  if (failure.code === 'RATE_LIMIT') return { failover: true, kind: 'rate-limit', reason: 'code-rate-limit' }
  if (failure.code === 'QUOTA') return { failover: true, kind: 'quota', reason: 'code-quota' }
  return undefined
}

/** A transient availability failure that says nothing about the request itself. */
function classifyTransient(failure: FailureView): Classification | undefined {
  if (failure.status !== undefined && TRANSIENT_SERVER.has(failure.status)) {
    return { failover: true, kind: 'transient', reason: `http-${failure.status}` }
  }
  if (failure.code === 'SERVER') return { failover: true, kind: 'transient', reason: 'code-server' }
  if (failure.code === 'TIMEOUT') return { failover: true, kind: 'transient', reason: 'code-timeout' }
  if (failure.code === 'TRANSPORT') return { failover: true, kind: 'transient', reason: 'code-transport' }
  return undefined
}

/**
 * Classify one free-route failure.
 *
 * Fallback is reserved for a genuine rate limit, an exhausted free allowance,
 * the OpenCode free-tier provenance gate, or a transient provider outage.
 * Bad requests, authentication, invalid models, context errors, tool errors,
 * content filtering, and plugin defects keep their real error.
 */
export function classifyFailure(failure: FailureView | undefined): Classification {
  if (failure === undefined) return { failover: false, reason: 'no-failure' }

  const limit = classifyLimit(failure)
  if (limit !== undefined) return limit

  const message = typeof failure.message === 'string' ? failure.message : ''
  // The provenance gate is an exact, route-scoped sentence and is checked
  // before the generic auth code so a gateway that labels it AUTH/403 is still
  // recognized as a temporary free-route condition.
  if (FREE_ROUTE_GATE.test(message)) {
    return { failover: true, kind: 'route-rejected', reason: 'free-tier-provenance-gate' }
  }

  const code = typeof failure.code === 'string' ? failure.code : ''
  if (NON_TRANSIENT_CODES.has(code)) {
    return { failover: false, reason: `non-transient-${code}` }
  }

  const transient = classifyTransient(failure)
  if (transient !== undefined) return transient

  return { failover: false, reason: code === '' ? 'unclassified' : `unclassified-${code}` }
}
