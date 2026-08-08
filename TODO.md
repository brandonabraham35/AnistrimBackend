# TODO — AnimeHeaven Source-Selection Defect Fix

## Approved Surgical Fix (services/animeHeavenProvider.js ONLY)

### Steps

1. [x] Audit existing source parsing/sorting logic + forensic evidence
2. [x] Approve plan (adjustment: `&d` is a valid Class-2 fallback, NOT dead)
3. [ ] Add `isConfirmedDeadOnErrorSource(url)` — flags only confirmed AnimeHeaven `&error`/`&error2` onerror placeholders
4. [ ] Add `sourceClass(src)` — Class 1 (genuine video), Class 2 (valid link/download fallback), Class 3 (dead onerror)
5. [ ] Update `sortSourcesByQuality()` — source-class priority before quality rank
6. [ ] Update `extractStreams()` — filter out Class-3 dead placeholders before selecting `sources[0]`/`streamUrl`
7. [ ] Add deterministic unit tests `test/animeHeavenProvider.test.js` (forensic scenario + edge cases)
8. [ ] Run `node --check services/animeHeavenProvider.js`
9. [ ] Run `node --test test/animeHeavenProvider.test.js`
10. [ ] Run existing `node --test test/hlsRewriter.test.js` + `node --test test/ssrfGuard.test.js`
11. [ ] Verify exports intact + report

## Explicitly OUT of scope (do NOT touch)

- Proxy layer, streamProxyStore, SSRF guard, cache architecture, playback context, browser security
- Proxy-side alternate-source fallback
- Database migrations
- Auth, premium logic, tier filtering, cache TTL
- Other providers/subsystems
- Frontend / controllers / routes
