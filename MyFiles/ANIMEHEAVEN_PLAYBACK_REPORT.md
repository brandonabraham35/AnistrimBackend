# ANIMEHEAVEN PLAYBACK REPORT

**Generated:** 2026-08-06T14:29:32.321Z
**Node:** v24.18.0 · **Platform:** win32 10.0.26200 (x64)
**Commit:** `2df3c84`
**Environment:** `animeheaven` · Pipeline timeout `60000ms`

## Overall Score

| Metric               | Score                  |
| -------------------- | ---------------------- |
| **Resolution Score** | **0%** (0/24 resolved) |
| **Playback Score**   | **0%** (0/24 playable) |
| Proxy URL score      | 0% (0/24)              |

## Successful Episodes

_None._

## Failed Episodes

| Title                           | Ep  | Stage       | Error                                                                                                               |
| ------------------------------- | --- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| One Piece                       | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Naruto                          | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Jujutsu Kaisen                  | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Demon Slayer                    | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Steins Gate                     | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Attack on Titan                 | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Fullmetal Alchemist Brotherhood | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| My Hero Academia                | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Sword Art Online                | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Re:Zero                         | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Bleach                          | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Death Note                      | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Tokyo Ghoul                     | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Hunter x Hunter                 | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Fairy Tail                      | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Black Clover                    | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Dragon Ball Z                   | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| One Punch Man                   | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Mob Psycho 100                  | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Vinland Saga                    | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Code Geass                      | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Cowboy Bebop                    | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Neon Genesis Evangelion         | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |
| Naruto Shippuden                | 1   | API resolve | API returned 502: {"success":false,"error":"Could not resolve a stream. Try another provider or check back later."} |

## Failures by Stage

| Stage                | Episodes |
| -------------------- | -------- |
| API resolve          | 24       |
| Provider resolution  | 0        |
| Proxy URL generation | 0        |
| Proxy request        | 0        |
| Manifest fetch       | 0        |
| Segment fetch        | 0        |
| Range support        | 0        |
| Playback readiness   | 0        |

## Latency

| Phase            | Avg (ms) |
| ---------------- | -------- |
| API resolve      | 608      |
| Proxy first-byte | 0        |
| Manifest         | 0        |
| First playable   | 0        |

## Redirects

Total redirects across all streams: **0** · Redirect escapes (outside proxy): **0**

## Root Causes

### Primary: Race condition in `raceWithConcurrency` (services/streamingService.js)

All 24 episodes fail at the **API resolve** stage with a telling signature — the pipeline resolves **`all_failed` with an empty `providers:[]` in ~250–600ms**, long before any provider could possibly finish. This is **not** a timeout and **not** a provider/search failure.

**Smoking-gun evidence from the run log:**

```
14:29:20.265  get https://animeheaven.me            ← provider launched, still in-flight
14:29:20.270  ✅ unknown resolved "all_failed" providers:[]   ← pipeline resolves 5ms later!
14:29:26.473  [streamingHttp] ← 200 https://animeheaven.me (4514ms)  ← provider LATER succeeds
```

**Why it happens:** In `raceWithConcurrency`, `trySchedule()` immediately launches the provider (async, `executeProvider(...).then(...)`) and then, because there is **no in-flight counter**, falls through to the `cursor >= providerTags.length` branch and resolves `{ result: null }` — _synchronously_, before the launched provider settles. The provider's base-URL/`pickBaseUrl()` probe (which round-trips through the shared proxy and takes 2.3–6.2s) finishes _after_ the race has already declared "all providers failed". The line `✅ unknown resolved (…ms) … providers:[]` is the exact code path logging the prematurely-resolved empty result.

### Contributing: AnimeHeaven resolution is slow (proxy round-trips)

Each AnimeHeaven resolve performs multiple sequential proxied HTTP hops (base-URL probe, fastsearch, search page, anime page, gate page) that individually take 2.3–6.2s. Because the race resolves before the first hop completes, the real latency of the provider is never even reached. Fixing the race is a prerequisite to observing actual resolution/playback.

### NOT the cause (per evidence)

- **Provider search/ranking tie-break** — the diagnostic (`_diag_animeheaven_full.js`) did tie-break "One Piece" to the wrong anime in an earlier run, but the current run never reaches search because the pipeline resolves empty before the provider's first request completes.
- **Pipeline timeout** — the verification ran with `STREAM_PIPELINE_TIMEOUT_MS=60000` (60s), yet still failed in ~600ms. The default 15s was already overridden; the failure is the race, not the deadline.

## Recommendations

1. **Fix the race in `raceWithConcurrency` (production-critical).** Track the number of in-flight providers (`inFlight++` on launch, `inFlight--` on settle) and only resolve with `result: null` when `cursor >= providerTags.length && inFlight === 0`. The provider execution is already error-isolated (never throws), so waiting for the last in-flight provider to settle is safe and correct. This is the single change that should restore 24/24 resolution.
2. **Re-run `_verify_animeheaven_playback.js` after the fix** to confirm resolution reaches the proxy stage and playback becomes playable.
3. **Consider a warm/parallel base-URL probe** — `pickBaseUrl()` per resolve adds sequential latency; warming it (or caching it across the batch) reduces time-to-first-request.
4. **Keep the pipeline timeout at or above the slowest provider** — AnimeHeaven's multi-hop proxied resolve can legitimately exceed 15s; if the race fix is applied, confirm the production deadline (or a per-provider allowance) accommodates it.
5. **Re-run this tool periodically** to catch playback regressions, and compare the generated report against the previous run.

---

### Reproducibility

- **Timestamp:** 2026-08-06T14:29:32.321Z
- **Node:** v24.18.0
- **Platform:** win32 10.0.26200 (x64)
- **Commit:** 2df3c84
- **Environment:**
  - `PORT`=`5087`
  - `STREAM_PROVIDERS`=`animeheaven`
  - `STREAM_PIPELINE_TIMEOUT_MS`=`60000`
  - `STREAM_CONCURRENCY`=`1`

_Full structured trace: `animeheaven-playback-verification.json`_
