# Decisions

## 2026-10-23 — OpenCode Go is the only managed provider

Free-first manages `opencode-go` and nothing else. Configuration rejects any
other provider for either route and both waterfalls short-circuit before
evaluation. Direct DeepSeek is an independently configured, manually selected
provider: it is never rewritten, never failed over to, and never shares health
state with OpenCode Go. This is a structural boundary, not a runtime toggle.

## 2026-10-23 — Three persistent usage modes, saved choice wins

`free-first`, `peak-only`, and `disabled` are routing policies layered on top
of availability. Precedence is saved override > configured mode > `free-first`.
The override lives in its own atomic `mode.json`, separate from health, so
neither document can clobber the other. `mode configured` deletes the override
and restores the configured default. No new database or service is introduced.

## 2026-10-23 — `peak-only` consumes one canonical pricing answer

Peak Only asks `ctx.offpeak.evaluate()` about the paid OpenCode Go fallback. It
never copies the weekly windows, holidays, or a second clock. Only a positive
`PEAK` state qualifies; `OFF_PEAK`, `FLAT`, `UNTRACKED`, `UNKNOWN`, a missing
service, and a failed call are all not-PEAK, so free quota cannot be spent by
accident.

## 2026-10-23 — `disabled` affects free-first only

Disabling free-first removes route selection, failover, recovery, probes, and
waits, and lets normal DSH routing apply. It does not touch `dsh-offpeak`, its
holds, or the session's chosen model.

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
