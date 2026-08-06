# AnimeHeaven Playback Verification — Task Tracking

## Goal

Verify AnimeHeaven playback works end-to-end through the new proxy and produce a clean, evidence-based baseline report.

## Deliverables

- `_verify_animeheaven_playback.js` — verification tool (resolves 24 episodes, full staged checks, latency/redirects/failures)
- `ANIMEHEAVEN_PLAYBACK_REPORT.md` — human-readable report (overall score, successful/failed episodes, root causes, recommendations)
- `animeheaven-playback-verification.json` — structured machine-readable data

## Progress

- [x] Step 0 — Understand task & analyze existing tooling
- [x] Step 1 — Read `_verify_animeheaven_playback.js`, proxy controllers, provider, registry, HTTP layer
- [x] Step 2 — Confirm tool already satisfies all 12 stated requirements
- [x] Step 3 — Get user approval (Option A: run existing tool, regenerate reports, add root-cause comparison vs `_diag_animeheaven_full.js`)
- [x] Step 4 — Run `node _verify_animeheaven_playback.js`
- [x] Step 5 — Inspect regenerated `ANIMEHEAVEN_PLAYBACK_REPORT.md` + `animeheaven-playback-verification.json`
- [x] Step 6 — Root cause identified from logs: **race condition in `streamingService.raceWithConcurrency`** — with `STREAM_CONCURRENCY=1` and 1 provider, `trySchedule()` resolves `all_failed` synchronously right after launching the in-flight provider (no `inFlight` tracking), BEFORE the provider settles. Evidence: `get https://animeheaven.me` at 14:29:20.265 → `all_failed providers:[]` at 14:29:20.270 (5ms later) → provider later succeeds at 14:29:26.473 (4514ms). This is a genuine scheduling bug, NOT a timeout or search-ranking issue.
- [x] Step 7 — Update `ANIMEHEAVEN_PLAYBACK_REPORT.md` with accurate root cause + recommendations (optionally fix `raceWithConcurrency` to track in-flight count).

## Notes

- No production code changes in this run — objective is a trustworthy baseline before any streaming/search logic changes.
- Pipeline timeout raised to 60s (test-only) so episodes can actually resolve; result classified as "timeout sensitivity" if it fails under 15s.
