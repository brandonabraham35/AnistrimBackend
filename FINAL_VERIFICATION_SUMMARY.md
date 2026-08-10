# READ-ONLY CACHE STATE AUDIT — Summary

**Mode:** READ-ONLY CACHE STATE AUDIT (no fixes, no refresh) · **Date:** 2026-08-09
**Database:** `anistrim_requirebut` (selected by `.env`)
**Target:** `episode_id=33` · `provider=animeheaven`

---

## VERDICT = NOT VERIFIED

> **Reason:** "The persistent cache entry was expired at audit start. A valid persistent-cache HIT could not be exercised without first refreshing or modifying the cache, which is prohibited by the read-only verification scope."

The persistent cache row was **expired** at audit start, so the audit **stopped immediately** and reported **NOT VERIFIED** (never converted to PASS).

---

## Read-only cache state audit (phase 0 — first)

Connected to the actual `.env`-selected database (`anistrim_requirebut`) and read the persistent cache row for `episode_id=33 · provider=animeheaven`:

| Check                                 | Result                                                  |
| ------------------------------------- | ------------------------------------------------------- |
| episode_id = 33                       | PASS                                                    |
| provider = animeheaven                | PASS                                                    |
| cache row count                       | PASS (1 row, id=6)                                      |
| **expires_at**                        | **FAIL (expired)** — `2026-08-09T08:55:31.000Z`         |
| current DB time (NOW())               | `2026-08-09T16:40:27.000Z`                              |
| **remaining TTL**                     | **FAIL** — `TTL_LEFT_MS = -27,896,000` (`EXPIRED=true`) |
| stream_data present                   | PASS                                                    |
| raw CDN source                        | PASS                                                    |
| absence of `/api/stream-proxy` URLs   | PASS (`HAS_PROXY_URL=false`)                            |
| absence of `&error`/`&error2` sources | PASS (`HAS_ERROR_SRC=false`)                            |

---

## Stopped immediately (expires_at ≤ NOW())

- ❌ Did NOT call `resolveStream()`
- ❌ Did NOT call AnimeHeaven
- ❌ Did NOT call `saveStream()`
- ❌ Did NOT update/delete/insert the row
- ❌ Did NOT modify the expiration timestamp
- ✅ Only `SELECT`s — no DB mutation

---

## Verification status by system (clearly distinguished)

| System                   | Status                 | Evidence                                                                               |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------- |
| **Source-selection fix** | ✅ previously VERIFIED | `FORENSIC_SOURCE_SELECTION.md`, 10/10 unit tests                                       |
| **Cold playback**        | ✅ previously VERIFIED | `COLD_PLAYBACK_REPORT.md` / `POST_FIX_COLD_PLAYBACK_REPORT.md`                         |
| **Proxy security**       | ✅ previously VERIFIED | `RUNTIME_SECURITY_REPORT.md` / `REAL_HTTP_RANGE_PLAYBACK_REPORT.md` / 12/12 SSRF tests |
| **Persistent cache HIT** | ❌ **NOT VERIFIED**    | cache entry was expired at audit start                                                 |

---

## Regression / syntax (read-only, run afterward)

- `node --check` ×5 → **5/5 clean**
- `node --test` ×3 files → **46/46 pass, 0 fail**

---

## Artifacts

- **Permanent report:** `CACHE_HIT_FINAL_VERIFICATION_REPORT.md` ✓
- Temporary `_final_cache_hit_verify.js` deleted ✓
- Temporary `_cache_state_audit.js` deleted ✓
- No source/config/frontend/routes/auth/CMS/payments/git changes made ✓
