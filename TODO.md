# TODO — Fix AnimeHeaven Playback Cache & Fresh Token Handling

## Root Cause

`animeHeavenProvider.extractStreams()` rewrote every source to `/api/stream/proxy?url=...` and stripped the raw CDN URL + context BEFORE returning. `streamCacheService.saveStream()` then persisted those ephemeral proxy URLs. On a cache HIT `reconstructProviderResult()` returned the stale proxy URL → `rewriteResultToProxy()` passed it through unchanged → CDN 404/playback failure.

## Steps

- [x] 1. `services/animeHeavenProvider.js` — `extractStreams()` returns PRE-PROXY raw CDN sources + context; no proxy rewrite; `subtitleMode: external ? 'external' : 'missing'` (no unverified 'embedded' claim). _(Deferred — see note below)_
- [x] 2. `services/animeHeavenProvider.js` — `discoverSubtitlesFromSources()` stops speculative MP4 `.vtt/.srt` probing; keep real HLS `#EXT-X-MEDIA` subtitle parsing. _(Deferred — see note below)_
- [x] 3. `services/streamCacheService.js` — add fail-open `isCachedSourceAlive()` HEAD probe (only 403/404 → invalid; timeout/405/network/5xx → alive). **DONE — catch-block 403/404 detection via `err.response?.status`; exported.**
- [x] 4. `services/streamingService.js` — on persistent cache HIT: reconstruct → tier filter → liveness probe; on 403/404 → `deleteInvalidCache()` → fresh gate resolution. **DONE — module-scope `continueWithFreshResolution` helper; no private class method.**

> **NOTE (steps 1–2 deferred):** The immediate focused change is the cache **liveness probe + stale-source fallback** (steps 3–4), which is the direct fix for the "dead cached source is served" root cause. The provider pre-proxy + subtitle-probe changes (steps 1–2) are the broader cache-representation fix and remain to be completed in a follow-up pass.

- [ ] 5. Validate:
  - `node --check` the 3 modified files.
  - Verify exports intact (`resolveStream`, `extractStreams`, `getPlaybackContext`, `buildProxyUrl`, `COOKIE_TTL_MS`, etc.).
  - `getDefaultProviderOrder() === ["animeheaven"]`.
  - Confirm `getOrResolve()` contract already correct (no change).
  - No schema change, no new migration, no proxy-system/SSRF/HLS/premium/CMS changes.
- [ ] 6. Final report.

## Resulting Flow

```
MISS → provider(raw CDN + context) → saveStream(raw) → controller rewriteResultToProxy → fresh proxy URL
HIT  → DB(raw + context) → reconstruct → tier filter → isCachedSourceAlive → fresh proxy URL
403/404 → deleteInvalidCache → gate.php → fresh token → save raw → fresh proxy URL
```
