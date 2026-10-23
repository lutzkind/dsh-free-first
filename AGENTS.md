# AGENTS.md — dsh-free-first

## What this repo is

A DeepSeek Harness native plugin package. It owns free-route availability only.
It does not implement off-peak windows, a proxy, a scheduler, or a queue.

## Commands

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## Invariants

- Fallback only for positively identified temporary free-route failures.
- Never fall back for auth, invalid request/model, context, tool, content,
  plugin, abort, or unknown failures.
- Retry the same step and session; never resend a prompt or replay a completed
  tool call.
- One recovery probe lease; no thundering herd and no background probe traffic.
- Paid timing is delegated to `ctx.offpeak`; do not duplicate pricing policy.
- Respect explicit model selection, including an explicit paid selection.
- Keep tests deterministic and provider-free.
