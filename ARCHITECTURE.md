# Architecture

`dsh-free-first` is one DeepSeek Harness plugin package:

1. `src/classify.ts` — conservative mapping from Harness `LlmFailure` values to
   rate-limit, quota, free-route gate, transient, or no-fallback.
2. `src/health.ts` — pure health record, bounded cooldown ladder, and one
   recovery-probe lease.
3. `src/engine.ts` — managed-session detection, route selection, failure
   recording, recovery, and one-timer waits.
4. `src/index.ts` — Harness wiring: `agent/request`, `agent/request-error`,
   `session/event`, and `/free-first` commands.

## Route selection

```text
agent/request
  -> next() returns the Harness/free-first current route
  -> explicit model/selection?  free = managed; paid/other = unmanaged
  -> healthy or probe winner?   free
  -> otherwise                  paid
  -> if paid is peak-blocked:   race free recovery vs paid boundary
```

The `agent/request` waterfall runs before the request header is logged, so a
switch is durable and reconstructable. A model change is visible in the session
log; no synthetic prompt is added.

## Failure path

`agent/request-error` is registered with `prepend`, so free-first sees the
failure before the generic retry executor. It reads the failed route from the
session's logged request header, classifies it, and returns `{ kind: 'retry' }`
only for a temporary free-route condition. The Harness then re-runs the same
step; `agent/request` selects the paid fallback. Completed tool calls are not
replayed because the retry is an uncommitted model attempt.

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
records. Absolute cooldown instants are authoritative; in-process timers only
wake waiters early. Writes are atomic (temp file + rename, mode 0600).

## Non-goals

No pricing policy, proxy, queue, scheduler, database, web dashboard, credential
store, or out-of-band provider probe.
