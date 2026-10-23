# dsh-free-first

DeepSeek Harness (`dsh`) native free-route preference with conservative
failover and automatic recovery.

```
FREE -> rate limit / quota / free-route gate / transient outage -> PAID fallback
     -> bounded cooldown -> FREE recovery -> FREE
```

The governing rule:

> Temporary free-route availability problems use the configured paid fallback.
> Bad requests, credentials, configuration, context, tool, content, and plugin
> failures keep their real error.

## Install

```sh
dsh plugin --profile web add git+https://github.com/lutzkind/dsh-free-first.git#v0.1.2
dsh plugin --profile headless add git+https://github.com/lutzkind/dsh-free-first.git#v0.1.2
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
        preferAsDefault: true
        reasoningEffort: max
```

Provider credentials come from the Harness credential store or the referenced
environment variable. This package holds no credential of its own.

## Behaviour

- New managed sessions start on the free route when it is healthy. The shipped
  default is `opencode-go/beam-free`: it is a zero-cost model on the same
  OpenCode Go subscription, so it is not subject to the Zen free-tier
  provenance gate that refuses non-OpenCode clients.
- A genuine `RATE_LIMIT` / HTTP 429 / `QUOTA`, the exact OpenCode free-tier
  provenance gate, HTTP 500/502/503/504, `SERVER`, `TIMEOUT`, or `TRANSPORT`
  failure arms a shared bounded cooldown and retries the **same step** on the
  paid fallback.
- Authentication, missing/invalid credentials, invalid requests/models,
  context overflow, tool errors, content filtering, empty responses, aborts,
  and unknown failures never fall back.
- After a cooldown, exactly one session claims a single recovery probe. Other
  sessions stay on the fallback until the probe settles or its lease expires;
  this prevents a thundering herd without extra provider traffic.
- A successful free assistant message clears the cooldown. The next request
  returns to free; there is no background probe and no cache-warming traffic.
- An explicit `model/selection` for another route, or for the paid fallback,
  stops free-first from managing that session. A persisted managed record
  survives a restart without overriding a later explicit choice.

## Interaction with off-peak

Free-first owns only free-route availability. It asks `ctx.offpeak` (provided
by `@lutzkind/dsh-offpeak`) whether the paid fallback may run:

- free healthy -> free;
- free unavailable, paid allowed -> paid in the same step;
- free unavailable, paid peak -> wait for either free recovery or the next
  off-peak boundary, then continue once;
- free recovers while waiting -> continue on free.

If off-peak is not mounted, free-first falls back to paid immediately; it never
implements pricing windows itself.

## Commands

```text
/free-first status
/free-first reset
/free-first help
```

`status` shows free health, cooldown reason and deadline, consecutive failures,
the recovery probe owner, the last committed route, and whether this session is
managed. `reset` clears the shared cooldown and wakes waiting requests; it sends
no provider request.

## Persistence

`$DSH_HOME/free-first/state.json` (mode 0600) stores the shared health record
and managed-session records. One atomic document; no database, queue, or
scheduler. Cooldowns are absolute instants, so a restart neither loses nor
duplicates them.

## Limits

- Compaction follows the session's last committed route. A free failure during
  compaction is surfaced; the primary step's next failover moves later
  compaction to the paid route.
- Title generation is configured separately on the free/flat route.
- There is no out-of-band health probe: the first real request after a cooldown
  is the probe.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```
