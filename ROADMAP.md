# Roadmap

## Current

- Free-route preference with explicit-selection respect.
- Conservative rate-limit, quota, provenance-gate, and transient failover.
- Same-step retry on the paid fallback.
- Shared bounded cooldown with one recovery probe lease.
- Off-peak cooperation through `ctx.offpeak`.
- `/free-first` status and reset.

## Next

- Observe Harness provider failure taxonomy changes and extend the classifier
  only with positive, provider-documented signals.
- Add a status line for compaction route ownership if the Harness adds a
  pre-dispatch compaction seam.

## Explicitly out of scope

- Pricing windows or holiday calendars.
- An HTTP proxy or header injection.
- Background health probes or cache warming.
- A queue, daemon, database, or second agent runtime.
