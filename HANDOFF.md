# Handoff

## 2026-10-23 — initial native implementation

Status: implementation complete, repository release pending host installation.

- Source: this repository.
- Runtime: DeepSeek Harness 0.2.1-rc.2 on Node 24.
- Verified seams: `agent/request` route selection, `agent/request-error`
  same-step retry, `session/event` free-success recovery.
- Tests: `npm run check` (classifier, health, engine, plugin wiring; no
  provider traffic).
- Host install: `dsh plugin --profile <profile> add <tag>` then mount the row
  after `dsh-offpeak`. See the server handoff for live verification.
