# HTTP Header Audit & Provider Compatibility

## Steps

### 1. `services/aniSkipService.js` — Migrate to shared HTTP client

- [x] Replace raw `axios` with `providerHttp.request()`/`get()`
- [x] Preserve 3s timeout for AniSkip primary
- [x] Preserve 5s timeout for Anime-Skip fallback
- [x] Preserve `skipProxy=true` (metadata service, not streaming)
- [x] Gain shared logging, retry, and health tracking
- [x] Preserve existing API behavior (`fetchSkipTimes` signature unchanged)

### 2. `services/consumetProvider.js` — Remove duplicate header override

- [x] Remove request interceptor that forcibly overwrites `Origin` and `Referer`
- [x] `buildHeaders(providerName)` becomes single source of truth
- [x] Keep proxy rotation interceptor (only remove header override)
- [x] Keep 403 retry interceptor (only remove header override)

### 3. `services/consumet/server.js` — Remove duplicate Origin/Referer

- [x] Remove `Origin` and `Referer` from `extraHeaders` in the adapter
- [x] These are already produced by `buildHeaders('consumet')` via sharedHeaders

### 4. Verification

- [x] All three files modified and verified
- [ ] All streaming providers still function (needs runtime testing)
- [ ] AniSkip returns skip timestamps correctly (needs runtime testing)
- [x] Provider-specific Origin/Referer values remain correct (buildHeaders still sets them)
- [x] No duplicate browser headers exist (removed overrides in consumetProvider.js and server.js)
- [x] No provider receives incorrect Origin/Referer (single source of truth)
- [ ] Playback behavior unchanged (needs runtime testing)
- [x] No regressions in proxy usage or retry behavior (interceptors preserved)
