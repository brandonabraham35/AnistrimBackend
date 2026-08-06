# TODO — AnimeHeaven Search Ranking (Composite Relevance) Implementation

## Approved Plan

- Sort by: `provider score DESC → composite relevance DESC → localeCompare()`
- `relevanceTier`/`relevanceFlags` retained but ONLY for diagnostics.
- Add a regression assertion guarding against alphabetical tie-breaking.

## Steps

- [x] 1. Remove `relevanceTier` comparison from `runSearch()` sort in `services/animeHeavenProvider.js`
- [x] 2. Update stale doc comments on `computeRelevanceScore` and the sort block
- [x] 3. Add regression assertion in `test-animeheaven-ranking.js` verifying composite relevance (not alphabetical) orders equal-score candidates
- [ ] 4. Run `node test-animeheaven-ranking.js` to verify all unit + live tests pass
