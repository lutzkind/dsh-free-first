# AGENTS.md — dsh-free-first

## Start here

Read `README.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `ROADMAP.md`, and the latest
`HANDOFF.md` before changing behavior. A local checkout is not proof of
`origin/main`: run `git status -sb` and inspect `git log -1`; deployed
production is the live DeepSeek Harness profile described in `HANDOFF.md`.
The host repository map is `/root/REPO_MAP.md`.

## What this repo is

A DeepSeek Harness native plugin package. It owns free-route availability only.
It does not implement off-peak windows, a proxy, a scheduler, or a queue.

## Production

The live integration is the DeepSeek Harness host at `/root/.dsh`, with the
guarded launcher `/root/cli-persistence/bin/dsh` and this package pinned in
`/root/.dsh/profiles/{headless,web}/package.json` to a release tag. Verify with
`python3 /root/scripts/dsh_verify.py --live` and
`node /root/scripts/dsh_verify_runtime.mjs`; see `HANDOFF.md`.

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
