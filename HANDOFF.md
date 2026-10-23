# Handoff

## 2026-10-23 — OpenCode Go boundary, usage modes, direct DeepSeek bypass

Status: released `v0.2.0`, installed in the live host profiles `web`, `headless`, `acp`, and `sdk`, verified.

- Source: this repository.
- Runtime: DeepSeek Harness 0.2.1-rc.2 on Node 24.
- Provider boundary: only `opencode-go` is managed by free-first. `deepseek/...`
  and every other provider pass through free-first without route selection,
  pricing calls, holds, or failover. `dsh-offpeak` manages Direct API pricing
  independently; free-first never observes it. Config rejects any other provider
  for `free` or `fallback`.
- Modes: `free-first` (default), `peak-only`, `disabled`, plus
  `mode configured` to clear the saved override. Precedence is saved override >
  configured mode > `free-first`.
- `peak-only` consumes the canonical PEAK answer from `ctx.offpeak`; missing,
  failed, `OFF_PEAK`, `FLAT`, `UNTRACKED`, and `UNKNOWN` all mean not-PEAK, so
  free quota is not spent by accident.
- Persistence: `state.json` (health/sessions) and `mode.json` (explicit mode)
  in `$DSH_HOME/free-first/`, both atomic and mode 0600.
- Tests: `npm run check` (48 tests: classifier, health, engine, modes,
  persistence, combined plugin wiring, provider boundary; no provider traffic).
- Release: `v0.2.0`; installed in `/root/.dsh/profiles/{web,headless,acp,sdk}`
  from the tag, with rows in each profile patch after `dsh-offpeak`. The
  installed `dist/index.js` sha256 matches the tag.
- Host verification: `python3 /root/scripts/dsh_verify.py --live`,
  `node /root/scripts/dsh_verify_runtime.mjs`, and
  `node /root/scripts/dsh_verify_plugins.mjs`.
- Known limitation: OpenCode Zen free models are gated to OpenCode clients; the
  host free route is the OpenCode Go zero-cost `beam-free` model.

## 2026-10-23 — initial native implementation

Status: released `v0.1.2`, installed in the live host profiles `web`, `headless`, `acp`, and `sdk`, verified.

- Source: this repository.
- Runtime: DeepSeek Harness 0.2.1-rc.2 on Node 24.
- Verified seams: `agent/request` route selection, `agent/request-error`
  same-step retry, `session/event` free-success recovery.
- Tests: `npm run check` (classifier, health, engine, plugin wiring; no
  provider traffic).
- Release: `v0.1.2`; installed in `/root/.dsh/profiles/{web,headless,acp,sdk}` from the tag,
  with rows in each profile patch after `dsh-offpeak`. The installed
  `dist/index.js` sha256 matches the tag.
- Host verification: `python3 /root/scripts/dsh_verify.py --live`,
  `node /root/scripts/dsh_verify_runtime.mjs`, and
  `node /root/scripts/dsh_verify_plugins.mjs`.
- Known limitation: OpenCode Zen free models are gated to OpenCode clients; the
  host free route is the OpenCode Go zero-cost `beam-free` model.
