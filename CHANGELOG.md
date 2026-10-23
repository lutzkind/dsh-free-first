# Changelog

## 0.1.2 — 2026-10-23

- Honor `respectExplicitModelSelection: false` explicitly; the default remains
  true, so an explicit paid or unrelated model still stops management.

## 0.1.1 — 2026-10-23

- Default the free route to `opencode-go/beam-free`, a zero-cost OpenCode Go
  model usable by DSH. The Zen `deepseek-v4.1-flash-free` route remains
  supported but is refused by OpenCode's provenance gate outside OpenCode.

## 0.1.0 — 2026-10-23

- First DeepSeek Harness native release.
- Free-route preference and explicit-selection respect.
- Conservative rate-limit, quota, provenance-gate, and transient failover.
- Same-step paid retry, shared cooldown, one recovery probe lease.
- Off-peak cooperation through `ctx.offpeak`.
- `/free-first` status and reset.
