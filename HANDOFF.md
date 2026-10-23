# Handoff

## 2026-10-23 — initial native implementation

Status: released `v0.1.2`, installed in the live host profiles `web` and `headless`, verified.

- Source: this repository.
- Runtime: DeepSeek Harness 0.2.1-rc.2 on Node 24.
- Verified seams: `agent/request` route selection, `agent/request-error`
  same-step retry, `session/event` free-success recovery.
- Tests: `npm run check` (classifier, health, engine, plugin wiring; no
  provider traffic).
- Release: `v0.1.2`; installed in `/root/.dsh/profiles/{web,headless}` from the tag,
  with rows in each profile patch after `dsh-offpeak`. The installed
  `dist/index.js` sha256 matches the tag.
- Host verification: `python3 /root/scripts/dsh_verify.py --live`,
  `node /root/scripts/dsh_verify_runtime.mjs`, and
  `node /root/scripts/dsh_verify_plugins.mjs`.
- Known limitation: OpenCode Zen free models are gated to OpenCode clients; the
  host free route is the OpenCode Go zero-cost `beam-free` model.
