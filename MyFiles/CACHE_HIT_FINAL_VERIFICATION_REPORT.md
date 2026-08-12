# CACHE HIT FINAL VERIFICATION REPORT

**Mode:** READ-ONLY CACHE STATE AUDIT (no fixes, no refresh) · **Date:** 2026-08-09
**Target:** `episode_id=33` · `provider=animeheaven`
**Database:** `anistrim_requirebut` (selected by `.env`)

---

## VERDICT = NOT VERIFIED

> **Reason:** "The persistent cache entry was expired at audit start. A valid persistent-cache HIT could not be exercised without first refreshing or modifying the cache, which is prohibited by the read-only verification scope."

The persistent cache row for `episode_id=33` was **expired** at audit start. Per the hard-stop rule, this audit **stopped immediately**: it did **NOT** call `resolveStream()`, did **NOT** call AnimeHeaven, did **NOT** call `saveStream()`, and did **NOT** update/delete/insert the row or modify its expiration timestamp.

---

## 1. Read-Only Cache State Audit (phase 0 — first)

Connected to the actual `.env`-selected database (`anistrim_requirebut`) and read the persistent cache row for `episode_id=33 · provider=animeheaven`:

| Check                                 | Result             | Detail                                                                                                  |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| episode_id                            | PASS               | 33                                                                                                      |
| provider                              | PASS               | animeheaven                                                                                             |
| cache row count                       | PASS               | 1 (exactly one row)                                                                                     |
| cache row id                          | PASS               | 6                                                                                                       |
| stream_type                           | PASS               | direct                                                                                                  |
| **expires_at**                        | **FAIL (expired)** | `2026-08-09T08:55:31.000Z`                                                                              |
| **current DB time (NOW())**           | INFO               | `2026-08-09T16:40:27.000Z`                                                                              |
| **remaining TTL**                     | **FAIL**           | `TTL_LEFT_MS = -27,896,000` (expired; `EXPIRED=true`)                                                   |
| stream_data present                   | PASS               | valid JSON with sources                                                                                 |
| raw CDN source                        | PASS               | `https://co.animeheaven.me/video.mp4?d4dfb40b72870f4f7377c89479af784b&85b0a226f1ecfb2265aaf12e6ba5976f` |
| absence of `/api/stream-proxy` URLs   | PASS               | `HAS_PROXY_URL=false`                                                                                   |
| absence of `&error`/`&error2` sources | PASS               | `HAS_ERROR_SRC=false`                                                                                   |
| source count                          | PASS               | 2 (video + download link)                                                                               |

Because `expires_at <= NOW()`, the audit **stopped immediately**. The row was not refreshed, extended, updated, deleted, or recreated. The expiration timestamp was **not modified**.

---

## 2. What This Audit Did NOT Do

- ❌ Did **NOT** call `resolveStream()`
- ❌ Did **NOT** call AnimeHeaven
- ❌ Did **NOT** call `saveStream()`
- ❌ Did **NOT** `UPDATE` / `DELETE` / `INSERT` the cache row
- ❌ Did **NOT** modify the expiration timestamp
- ❌ Did **NOT** mutate the database in any way (only `SELECT`s)

---

## 3. Verification Status by System

The following were **PREVIOUSLY VERIFIED** (independent of this audit) and are clearly distinguished from the persistent-cache HIT:

| System                   | Status              | Evidence                                                                                                                                                                                                                                     |
| ------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source-selection fix** | ✅ **VERIFIED**     | `FORENSIC_SOURCE_SELECTION.md` / `ANIMEHEAVEN_PLAYBACK_REPORT.md` — genuine video source deterministically wins over dead `&error2`/`&error` and `&d` download links; unit-tested (10/10).                                                   |
| **Cold playback**        | ✅ **VERIFIED**     | `COLD_PLAYBACK_REPORT.md` / `POST_FIX_COLD_PLAYBACK_REPORT.md` — fresh AnimeHeaven resolution produces a playable stream.                                                                                                                    |
| **Proxy security**       | ✅ **VERIFIED**     | `RUNTIME_SECURITY_REPORT.md` / `REAL_HTTP_RANGE_PLAYBACK_REPORT.md` / `test/ssrfGuard.test.js` — browser only sees `/api/stream-proxy/:streamId`; cookies/referers/origins/targets stay server-side; no header leaks; 12/12 SSRF tests pass. |
| **Persistent cache HIT** | ❌ **NOT VERIFIED** | The cache entry was **expired** at audit start; a valid HIT could not be exercised without refreshing/modifying the cache, which is prohibited by the read-only scope.                                                                       |

---

## 4. Regression / Syntax Tests (read-only, run afterward)

- `node --check` on 5 in-scope files (`streamingService`, `streamCacheService`, `animeHeavenProvider`, `streamProxy`, `streamProxyStore`) → **5/5 clean**
- `node --test test/animeHeavenProvider.test.js test/hlsRewriter.test.js test/ssrfGuard.test.js` → **46/46 pass, 0 fail**

---

## 5. Constraint Compliance

- ✅ **READ-ONLY** — no source/config/frontend/route/auth/CMS/payment/git changes.
- ✅ **No `.env` changes.**
- ✅ **No DB mutation** — only `SELECT`s; the persistent row was not refreshed, its `expires_at` was not modified, and no insert/update/delete occurred.
- ✅ **No `resolveStream()` / AnimeHeaven / `saveStream()` calls.**
- ✅ **No fixes implemented.**
- ✅ **VERDICT = NOT VERIFIED** (never converted to PASS).

---

## 6. How to Reach a Genuine PASS Later

A fresh, **unexpired** persistent-cache row for `episode_id=33` must be established **outside this read-only test** (e.g., by a normal user playback that re-populates the cache), then this audit re-run. The audit itself never refreshes the cache.
