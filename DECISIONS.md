# Decisions

## 2026-10-23 — Use `agent/request` and `agent/request-error`

The Harness already re-runs a failed step inside the same open turn. Free-first
marks the free route unhealthy and returns `{ kind: 'retry' }`; the next
`agent/request` pass selects the paid fallback. This preserves the session, the
prompt, and completed tool work without a synthetic continuation.

## 2026-10-23 — No out-of-band probe

The first real request after a cooldown is the probe. A separate probe would
spend an extra provider call, could warm a cache for no reason, and would still
need the same lease. A single lease prevents a thundering herd.

## 2026-10-23 — Fallback is conservative

Only positive rate-limit/quota signals, the exact OpenCode free-tier gate, and
transient 5xx/timeout/transport failures fail over. Everything else keeps its
real error.

## 2026-10-23 — Delegate paid timing to off-peak

Free-first asks `ctx.offpeak`. It never embeds peak windows, holidays, or a
second timing engine. The two plugins cooperate through one small service
interface.

## 2026-10-23 — Explicit model selection wins

A `model/selection` event for an unrelated route or the paid fallback stops
management. A persisted fallback record is used only while the session's last
committed route is still the fallback.

## 2026-10-23 — Persist absolute cooldowns

A restart must not immediately hammer a rate-limited free route. The health
record and managed-session records live in one small atomic JSON document.
