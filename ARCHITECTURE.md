# Architecture

`dsh-free-first` is one DeepSeek Harness plugin package:

1. `src/classify.ts` — conservative mapping from Harness `LlmFailure` values to
   rate-limit, quota, free-route gate, transient, or no-fallback.
2. `src/health.ts` — pure health record, bounded cooldown ladder, and one
   recovery-probe lease.
3. `src/mode.ts` — durable free-usage mode override (`free-first`, `peak-only`,
   `disabled`) in its own atomic document.
4. `src/engine.ts` — provider boundary, managed-session detection, route
   selection, failure recording, recovery, and one-timer waits.
5. `src/index.ts` — Harness wiring: `agent/request`, `agent/request-error`,
   `session/event`, and `/free-first` commands.

## Provider boundary

Only `opencode-go` is managed:

```text
provider == opencode-go  -> free-first may select free or the paid fallback
provider != opencode-go  -> immediate pass-through, untouched
```

Configuration rejects a `free` or `fallback` route outside `opencode-go`. Both
waterfalls return before touching health, timers, or `ctx.offpeak` for any other
provider. Consequently:

- a direct DeepSeek (`deepseek/...`) request is never rewritten, waited on, or
  failed over;
- a direct DeepSeek 429/5xx/auth failure surfaces unchanged;
- an OpenCode Go failure always retries on the configured OpenCode Go fallback,
  never on the direct provider;
- no health, cooldown, probe, or session-management state is shared across the
  provider boundary.

## Route selection

```text
agent/request
  -> next() returns the Harness/free-first current route
  -> provider outside opencode-go?  unmanaged, return unchanged
  -> mode disabled?                 unmanaged, return unchanged
  -> explicit model/selection?      free = managed; paid/other = unmanaged
  -> peak-only and pricing != PEAK? paid OpenCode Go route, no free request
  -> healthy or probe winner?       free
  -> otherwise                      paid
  -> if paid is peak-blocked:       race free recovery vs paid boundary
```

The `agent/request` waterfall runs before the request header is logged, so a
switch is durable and reconstructable. A model change is visible in the session
log; no synthetic prompt is added.

## Modes

The effective mode is `saved override > configured mode > free-first`.

- `free-first` — historical behaviour: prefer free whenever health allows it.
- `peak-only` — free eligibility is the conjunction of free health and a
  positive `PEAK` answer from `ctx.offpeak.evaluate(fallback.provider,
  fallback.model)`. Everything else is not-PEAK. At not-PEAK the plugin returns
  the paid OpenCode Go route immediately, does not claim a probe, and does not
  send a free request. At PEAK the normal health/failover/recovery machine is
  unchanged, and the paid request remains subject to `dsh-offpeak`'s hold.
- `disabled` — `agent/request` returns the resolved route unchanged,
  `agent/request-error` always calls the next handler, and no recovery or wait
  work runs. `dsh-offpeak` is independent and unaffected.

A mode change wakes current waiters so the next safe boundary applies it; an
in-flight provider request is never recalled.

## Failure path

`agent/request-error` is registered with `prepend`, so free-first sees the
failure before the generic retry executor. It reads the failed route from the
session's logged request header, rejects any non-OpenCode-Go route immediately,
classifies the rest, and returns `{ kind: 'retry' }` only for a temporary
free-route condition. The Harness then re-runs the same step; `agent/request`
selects the paid OpenCode Go fallback. Completed tool calls are not replayed
because the retry is an uncommitted model attempt.

## Health and probe

One shared health record:

```text
HEALTHY --temporary failure--> COOLDOWN (absolute deadline, bounded ladder)
COOLDOWN --deadline---------> first managed session claims PROBE lease
PROBE --free success--------> HEALTHY
PROBE --temporary failure---> COOLDOWN (next rung)
PROBE --non-transient-------> release lease, keep the real error
```

The probe is a real session request, never an extra call. A foreign probe lease
keeps other sessions on the fallback until it settles or expires.

## Persistence

`$DSH_HOME/free-first/state.json` holds the health record and managed-session
records. `$DSH_HOME/free-first/mode.json` holds only the explicit mode override
(`{ "version": 1, "mode": "peak-only", "updatedAt": 0 }`). The documents are
separate so a health write cannot clobber the operator's choice and a
`configured` reset cannot discard health evidence. Writes are atomic (temp file
+ rename, mode 0600). Absolute cooldown instants are authoritative; in-process
timers only wake waiters early.

## Non-goals

No pricing policy, peak calendar, proxy, queue, scheduler, database, web
dashboard, credential store, out-of-band provider probe, or cross-provider
fallback.
