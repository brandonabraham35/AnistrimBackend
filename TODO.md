# AnimeHeaven Search Ranking — Task Tracker

## Objective

Redesign the AnimeHeaven search ranking tie-break so candidate selection reflects
**search relevance** rather than lexicographic (alphabetical) order. Keep the existing
scoring system, add a composite relevance score as the tie-breaker, and add
instrumentation, regression tests, and a before/after report.

## Steps

- [x] Analyze the AnimeHeaven provider pipeline (`services/animeHeavenProvider.js`)
- [x] Confirm root cause: `runSearch()` uses `localeCompare` as the score tie-breaker
- [x] Define plan + refinements (composite relevance score, confidence metric,
      accepted-result sets for ambiguous queries, top-5 debug logging, keep iframe crawling)
- [x] Add `RELEVANCE_WEIGHTS` + `computeRelevanceScore()` (10 prioritized components)
- [x] Add `computeSearchConfidence()`
- [x] Persist `aliases` on search rows
- [x] Replace `localeCompare` tie-break in `runSearch()` with relevance-based sort + `localeCompare` fallback
- [x] Thread optional `episode` through `searchAnime()` / `runSearch()` and pass from `resolveEpisode()`
- [x] Add debug-mode instrumentation (top-5 candidates) gated by `ANIMEHEAVEN_SEARCH_DEBUG`
- [ ] Add regression tests `test-animeheaven-ranking.js` (unambiguous + ambiguous queries)
- [ ] Run tests and verify the intended anime is always ranked first
- [ ] Generate `ANIMEHEAVEN_SEARCH_RANKING_REPORT.md` (before/after, confidence, iframe audit)
- [ ] Keep iframe crawling intact (document `<source>` as preferred primary path)

## Key Change

```js
// BEFORE (alphabetical tie-break)
.sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.title.localeCompare(b.title))

// AFTER (relevance tie-break, localeCompare is final fallback)
// score DESC → relevance DESC → localeCompare
```

## Debug Output

Set `ANIMEHEAVEN_SEARCH_DEBUG=1` to log top-5 candidates with:
Candidate, Title, Original score, Exact match, Prefix match, Alias match,
Token overlap, Edit distance, Final ranking score, Final position.
