# TODO — Phase 6: Concurrent Streaming Resolver

## Goal

Redesign the streaming resolver to execute providers concurrently with a configurable concurrency limit, returning the first successful playable stream while preventing unnecessary provider load and preserving the existing response format.

## Steps

- [x] 1. Add configurable concurrency limit (`STREAM_CONCURRENCY`, default 3) — no hardcoding.
- [x] 2. Build a health-aware execution queue (preferred → healthy → degraded → cooldown last).
- [x] 3. Add a `raceWithConcurrency` sliding-window scheduler: launch first batch, resolve on first success, cancel/ignore remaining, launch next provider on failure.
- [x] 4. Rewrite `resolveStream` to use the concurrent race (no sequential-first phase), preserving response shape exactly.
- [x] 5. Update `resolveAllProviders` to respect concurrency limit but continue collecting ALL successful providers.
- [x] 6. Add structured logging: provider name, latency, success/failure, timeout, skipped (cooldown/degraded), winner, total pipeline duration.
- [x] 7. Update header comment to reflect new concurrent model.
- [x] 8. Validation: syntax check, verify concurrency limit, single winner, no unnecessary launches, `resolveAllProviders` returns all successes, response structure unchanged, health metrics still recorded.
