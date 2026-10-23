# dsh-free-first

DeepSeek Harness (`dsh`) native free-route preference for **OpenCode Go only**,
with persistent usage modes, conservative failover, and automatic recovery.

```
FREE -> rate limit / quota / free-route gate / transient outage -> PAID fallback
     -> bounded cooldown -> FREE recovery -> FREE
```

The governing rule:

> Temporary OpenCode Go free-route availability problems use the configured
> OpenCode Go paid fallback. Bad requests, credentials, configuration, context,
> tool, content, and plugin failures keep their real error.

## Provider boundary

This plugin manages one provider: `opencode-go`.

```text
opencode-go/beam-free                  -> managed free route
opencode-go/deepseek-v4.1-flash        -> managed paid fallback
deepseek/... (direct DeepSeek API)     -> unmanaged, normal Harness routing
any other provider                     -> unmanaged, normal Harness routing
```

`free.provider` and `fallback.provider` must both be `opencode-go`; the plugin
rejects any other configuration. A direct DeepSeek request, failure, or 429/5xx
never triggers OpenCode Go fallback, and an OpenCode Go failure never falls
through to the direct API. There is no automatic cross-provider routing.

## Install

```sh
dsh plugin --profile web add git+https://github.com/lutzkind/dsh-free-first.git#v0.2.0
dsh plugin --profile headless add git+https://github.com/lutzkind/dsh-free-first.git#v0.2.0
```

Mount it after `@lutzkind/dsh-offpeak`:

```yaml
- insert:
    - id: dsh-offpeak
      name: '@lutzkind/dsh-offpeak'
      config: { enabled: true, displayTimeZone: UTC }
    - id: dsh-free-first
      name: '@lutzkind/dsh-free-first'
      config:
        free: { provider: opencode-go, model: beam-free }
        fallback: { provider: opencode-go, model: deepseek-v4.1-flash }
        mode: free-first
        preferAsDefault: true
        reasoningEffort: max
```

Provider credentials come from the Harness credential store or the referenced
environment variable. This package holds no credential of its own.

## Usage modes

The effective mode precedence is **saved choice > configured `mode` >
`free-first`**. A saved choice survives new sessions, plugin reloads, and
restarts. `mode configured` forgets the saved choice.

| Label | `mode` | Behaviour |
|---|---|---|
| **Free First** | `free-first` (default) | Prefer the free route whenever it is healthy, at any hour. |
| **Peak Only** | `peak-only` | Use free only when `dsh-offpeak` positively reports **PEAK** for the paid OpenCode Go fallback. `OFF_PEAK`, `FLAT`, `UNTRACKED`, `UNKNOWN`, a missing `offpeak` service, or a failed evaluation all route to the paid OpenCode Go route directly, without a free request or probe. |
| **Disabled** | `disabled` | Free-first routing is off: no route selection, failover, recovery, probe, wait, or default-model preference. Normal DSH routing applies. `dsh-offpeak` is unchanged. |

`peak-only` never copies peak windows, holidays, or a second clock.
`@lutzkind/dsh-offpeak` remains the sole canonical pricing owner; the plugin
consumes its `evaluate()` answer. Only a positive `PEAK` state spends free
quota, so `UNKNOWN` can never accidentally consume it.

## Behaviour

- New managed sessions start on the free route when the mode and health allow
  it. The shipped free route is `opencode-go/beam-free`: a zero-cost model on
  the same OpenCode Go subscription, so it is not subject to the Zen free-tier
  provenance gate that refuses non-OpenCode clients.
- A genuine `RATE_LIMIT` / HTTP 429 / `QUOTA`, the exact OpenCode free-tier
  provenance gate, HTTP 500/502/503/504, `SERVER`, `TIMEOUT`, or `TRANSPORT`
  failure arms a shared bounded cooldown and retries the **same step** on the
  paid OpenCode Go fallback.
- Authentication, missing/invalid credentials, invalid requests/models,
  context overflow, tool errors, content filtering, empty responses, aborts,
  and unknown failures never fall back.
- After a cooldown, exactly one session claims a single recovery probe. Other
  sessions stay on the fallback until the probe settles or its lease expires;
  this prevents a thundering herd without extra provider traffic.
- A successful free assistant message clears the cooldown. The next request
  returns to free when the mode allows it; there is no background probe and no
  cache-warming traffic.
- An explicit `model/selection` for another route, or for the paid fallback,
  stops free-first from managing that session. A persisted managed record
  survives a restart without overriding a later explicit choice.

## Interaction with off-peak

Free-first owns only free-route availability. It asks `ctx.offpeak` (provided
by `@lutzkind/dsh-offpeak`) for two things:

- in `peak-only`, whether the paid fallback is in a positive `PEAK` window;
- whether the paid fallback may run now.

Routes and waits:

- free healthy and allowed by the mode -> free;
- free unavailable, paid allowed -> paid in the same step;
- free unavailable, paid peak -> wait for either free recovery or the next
  off-peak boundary, then continue once;
- free recovers while waiting -> continue on free.

If off-peak is not mounted, `peak-only` treats pricing as not-PEAK and
free-first falls back to paid immediately. Neither plugin implements the
other's policy.

## Commands

```text
/free-first
/free-first status
/free-first mode free-first
/free-first mode peak-only
/free-first mode disabled
/free-first mode configured
/free-first reset
/free-first help
```

`status` shows the effective mode and its source, the configured mode, the
canonical pricing state (`peak-only`), free health, cooldown reason and
deadline, consecutive failures, the recovery probe owner, the last committed
route, whether this session is managed, and the next request route. `reset`
clears the shared cooldown and wakes waiting requests; it sends no provider
request. `/free-first` and `/free-first status` are equivalent: DSH has no
native selector widget, so the command surface is the UI.

## Persistence

`$DSH_HOME/free-first/state.json` (mode 0600) stores the shared health record
and managed-session records. `$DSH_HOME/free-first/mode.json` (mode 0600) stores
only an explicit mode choice, in a separate atomic document so a health write
can never clobber it. Cooldowns are absolute instants, so a restart neither
loses nor duplicates them. No database, queue, or scheduler.

## Limits

- Compaction follows the session's last committed route. A free failure during
  compaction is surfaced; the primary step's next failover moves later
  compaction to the paid route.
- Title generation is configured separately on the free/flat route.
- There is no out-of-band health probe: the first real request after a cooldown
  is the probe.
- Direct DeepSeek is manual/explicit only. No cross-provider fallback exists.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```
