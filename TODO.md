# AnimeHeaven Provider Diagnostic — Task Tracker

## Objective

Instrument every stage of the AnimeHeaven resolver pipeline (search → anime page → episode page → iframe → mirror → player → stream extraction) and produce a step-by-step report identifying the FIRST failing stage. NO production fixes until the exact failure point is identified with runtime evidence.

## Steps

- [x] Analyze the AnimeHeaven provider pipeline (`services/animeHeavenProvider.js`)
- [x] Understand the HTTP layer (`utils/providerHttp.js`, `utils/streamingHttp.js`)
- [x] Understand provider registration (`services/providerRegistry.js`) and logger (`utils/logger.js`)
- [x] Review existing diagnostic scripts (`_diag_provider.js`, `_diag_extract.js`, `_diag_stream_route.js`)
- [x] Define plan (user approved)
- [x] Build instrumented diagnostic harness (`_diag_animeheaven_full.js`) — monkeypatch `providerHttp.request` to capture full HTTP responses (status, headers, set-cookie, redirects, final URL, timing, Cloudflare/Ray ID) without modifying production code
- [x] Walk full pipeline for a test title (One Piece Ep 1) capturing every stage
- [x] Run selector-diagnostic checks at each parse stage (selector searched, matches, expected, first element, HTML snippet)
- [x] Categorize failures (Network/DNS/Timeout/Cloudflare/CAPTCHA/403/404/429/5xx/Selector mismatch/Missing iframe/Mirror unavailable/Player/Stream/Unknown)
- [x] Save evidence (HTML, headers, cookies, redirect history) under `diagnostics/animeheaven/`
- [x] Generate `ANIMEHEAVEN_PROVIDER_DIAGNOSTIC.md` (full report + pipeline summary at top)
- [x] Generate `animeheaven-diagnostic.json` (structured trace)
- [x] Run the harness and identify the first failing stage
- [x] Report findings (no production changes until root cause confirmed)

## KEY FINDING

**FIRST FAILING STAGE: SEARCH** — the search stage resolves the WRONG anime.

Querying `One Piece` returned:

1. `3jccu` "My Unique Skill Makes Me OP even at Level 1" (score 307) ← WRONGLY SELECTED
2. `1ht8d` "One Piece" (score 307) ← CORRECT, but lost the tie-break

### Root Cause

In `services/animeHeavenProvider.js` → `runSearch()`, the final sort is:

```js
.sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.title.localeCompare(b.title))
```

When scores TIE at 307, the tie-breaker is **alphabetical title ordering** (`localeCompare`). "My Unique Skill..." (M) sorts before "One Piece" (O), so the WRONG anime wins. The pipeline then resolves episode 1 of the wrong show.

### Supporting Evidence

- Both `3jccu` and `1ht8d` scored exactly **307** (tie)
- `uniqueByIdentifier()` keeps the first-seen highest-scoring identifier; the tie is decided by alphabetical sort
- All downstream stages (anime page, gate, iframe, stream) then correctly resolve the WRONG title's content — so stages 2-7 "pass" but for the wrong anime
- Subtitle probes all returned HTTP 404 (expected for AnimeHeaven's embedded-subtitle model) — not the primary failure

### Implication

The pipeline is functionally "working" (finds a playable stream) but returns the WRONG anime whenever the top scores tie. This is a correctness bug in the search ranking tie-break, not a network/Cloudflare/selector issue.

### Suggested next action

Fix the search tie-break in `runSearch()` to prefer exact/prefix title matches over alphabetical ordering (e.g., prioritize `c === q` / `c.startsWith(q)` exact-match signals, or a Levenshtein/length preference) before falling back to `localeCompare`.
