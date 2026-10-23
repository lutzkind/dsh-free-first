# Roadmap

## Current

- OpenCode Go-only provider boundary for free-first; direct DeepSeek always
  bypasses it (dsh-offpeak manages Direct pricing separately).
- Persistent free usage modes: `free-first`, `peak-only`, `disabled`, and
  `configured` reset.
- Free-route preference with explicit-selection respect.
- Conservative rate-limit, quota, provenance-gate, and transient failover.
- Same-step retry on the paid OpenCode Go fallback.
- Shared bounded cooldown with one recovery probe lease.
- Off-peak cooperation through `ctx.offpeak`; Peak Only consumes its canonical
  PEAK answer.
- `/free-first` status, mode, and reset commands.

## Next

- Observe Harness provider failure taxonomy changes and extend the classifier
  only with positive, provider-documented signals.
- Add a status line for compaction route ownership if the Harness adds a
  pre-dispatch compaction seam.

## Explicitly out of scope

- Pricing windows or holiday calendars.
- Cross-provider fallback, including OpenCode Go to direct DeepSeek.
- An HTTP proxy or header injection.
- Background health probes or cache warming.
- A queue, daemon, database, or second agent runtime.
