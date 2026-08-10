# Final Cache-Hit Verification — Task TODO

## Phase 0 (MUST BE FIRST) — Precondition audit (READ-ONLY)

- [x] Load `.env` via dotenv
- [x] Connect to MySQL (active DB = `anistrim_requirebut`)
- [x] Verify episode 33 exists
- [x] Count episode_stream_cache rows (episode_id=33, provider=animeheaven) → 1
- [x] Read expires_at
- [x] Compare expires_at vs DB NOW()
- [x] Calculate remaining TTL → **-26,122,000 ms (EXPIRED)**
- [x] Verify TTL > 0 → **FAIL**
- [x] Verify TTL <= COOKIE_TTL_MS (480000) → **FAIL**
- [x] Verify stream_data contains raw CDN source → PASS
- [x] Verify no /api/stream-proxy persisted → PASS
- [x] Verify no &error/&error2 placeholder → PASS

## HARD STOP (row EXPIRED)

- [x] Set VERDICT = NOT VERIFIED
- [x] Do NOT call resolveStream() / AnimeHeaven / saveStream / update / extend / delete
- [x] Do NOT modify DB, source, .env, frontend, routes, auth, CMS, payments, git

## Regression / Syntax (run after hard stop)

- [x] node --check on 5 in-scope files → 5/5 clean
- [x] node --test test/animeHeavenProvider.test.js test/hlsRewriter.test.js test/ssrfGuard.test.js → 46/46 pass, 0 fail

## Report & cleanup

- [x] Generate CACHE_HIT_FINAL_VERIFICATION_REPORT.md (NOT VERIFIED)
- [x] Delete \_final_cache_hit_verify.js (confirmed gone)
- [x] Final DB comparison — row unchanged (no mutation)
- [x] Leave only the Markdown report as the permanent audit artifact
