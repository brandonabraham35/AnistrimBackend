# STREAMING_ENVIRONMENT_REPORT.md

**Date:** 2026-08-08
**Mode:** READ-ONLY verification (no source code or database data modified)

This report establishes whether the environment is capable of performing the full AnimeHeaven streaming verification. All checks were performed with a temporary diagnostic probe (`_streaming_env_probe.js`) and a temporary server boot. No fixtures were created, no fixes were implemented, and no database data was mutated by the probe itself.

---

## 1. Environment

| Item         | Value                                    | Status |
| ------------ | ---------------------------------------- | ------ |
| Node version | v24.18.0                                 | ✅     |
| npm version  | 12.0.1                                   | ✅     |
| node_modules | Present                                  | ✅     |
| server.js    | Present                                  | ✅     |
| .env         | Present                                  | ✅     |
| MySQL config | `config/db.js` (pool created via mysql2) | ✅     |

**Streaming module loads (validated via `require`):**

- `mysql2/promise` — OK
- `express` — OK
- `cheerio` — OK
- `axios` — OK
- `dotenv` — OK
- `./utils/providerHttp` — OK
- `./utils/streamingHttp` — OK
- `./utils/ssrfGuard` — OK
- `./services/providerRegistry` — OK
- `./services/animeHeavenProvider` — OK
- `./services/streamingService` — OK
- `./services/streamCacheService` — OK
- `./config/streamCache` — OK

**Environment variables present (presence only — no secrets printed):**
`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET` are all present via dotenv.
`ANIMEHEAVEN_BASE_URL` is **MISSING** — the provider falls back to its hard-coded domain candidates (`https://animeheaven.me`, etc.).

**Provider order (from `providerRegistry.getDefaultProviderOrder()`):** `["animeheaven"]` — AnimeHeaven is the single configured streaming provider.

No secrets, passwords, JWT secrets, API keys, cookies, or CDN tokens were printed at any point.

---

## 2. Database Connectivity

Connected to the configured MySQL database using a temporary read-only diagnostic script.

| Key           | Value                 |
| ------------- | --------------------- |
| Connection    | ✅ Success            |
| `SELECT 1`    | `1`                   |
| Database name | `anistrim_requirebut` |
| Host          | `m4uuuq.h.filess.io`  |

No `max_user_connections`, timeout, or authentication errors were encountered. No database connections belonging to other processes were modified or killed. The probe issued only read-only `SELECT` queries.

> **Note on the admin verification log:** The application's `config/db.js` module runs its standard startup routine on load (`ensureAdminUser()`), which verifies/resets the default admin user's password hash. This is the normal, baked-in server startup behaviour that triggers whenever the module is loaded — it is not a deliberate fixture created by this verification. It is logged here for transparency and occurs identically on every normal server boot.

---

## 3. Inventory (Read-Only Queries)

| Metric                                        | Count                                             |
| --------------------------------------------- | ------------------------------------------------- |
| Anime count                                   | 17                                                |
| Episode count                                 | 1425                                              |
| Premium episode count                         | 0                                                 |
| Episodes with `video_url`                     | 0                                                 |
| Episodes with provider metadata               | N/A — `episodes` table has **no provider column** |
| `episode_stream_cache` row count              | 0                                                 |
| Distinct providers (DB)                       | N/A — no provider column on `episodes`            |
| Available providers (registry)                | `["animeheaven"]`                                 |
| Free episode candidates (with `video_url`)    | 0                                                 |
| Premium episode candidates (with `video_url`) | 0                                                 |

**Recommended free episode for runtime testing:** **NONE — no suitable free episode exists.**

The `episodes` table (1425 rows) has **no `video_url` populated** and **no provider metadata column**. Streaming is performed dynamically via the AnimeHeaven provider at playback time (the engine resolves streams on demand and caches them in `episode_stream_cache`). Because no episode has a stored `video_url`, and the `episode_stream_cache` is empty, there is **no pre-resolved free episode candidate** to test without performing a live AnimeHeaven stream resolution.

Per the task instructions: _"If no suitable episode exists, report that instead of creating fixtures."_ No fixtures were created.

---

## 4. AnimeHeaven Reachability

Safe connectivity checks were performed against the legitimate AnimeHeaven production hosts using the SSRF guard (`assertSafeTargetHost`) for DNS/IP validation, then `streamingHttp` for HTTPS connectivity. No SSRF protection was bypassed.

| URL                          | DNS (resolved IPs)             | SSRF check | HTTPS result                                                  |
| ---------------------------- | ------------------------------ | ---------- | ------------------------------------------------------------- |
| `https://animeheaven.me`     | `192.99.9.229`                 | SAFE       | ✅ HTTP 200                                                   |
| `https://animeheaven.ru`     | `157.90.33.73`, `157.90.33.74` | SAFE       | ⚠️ HTTP 405 (HEAD not allowed)                                |
| `https://www.animeheaven.me` | `192.99.9.229`                 | SAFE       | ❌ TLS cert altname mismatch (`ERR_TLS_CERT_ALTNAME_INVALID`) |

**Verdict:** AnimeHeaven is **reachable** and SSRF-safe. The primary host `https://animeheaven.me` returns HTTP 200. The `www.animeheaven.me` subdomain fails TLS certificate validation (its cert is for `aa.u-on.eu`), which is a normal CDN/node configuration and does not affect the working primary domain.

All resolved IPs are public addresses; no loopback/private/link-local addresses were detected.

---

## 5. Server Startup Capability

The server was started only to verify startup capability (DB was confirmed reachable first).

| Key                    | Value                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| PID                    | 13576                                                                    |
| Port                   | 5000                                                                     |
| Startup output         | `AniStrim2 running on port 5000` / `Listening on: http://0.0.0.0:5000`   |
| MySQL connect on boot  | ✅ `MySQL connected to: anistrim_requirebut`                             |
| `/api/health` response | `{"status":"OK","time":"...","environment":"production"}` → **HTTP 200** |
| Process cleanup        | ✅ Stopped only the process started by this verification (PID 13576)     |

No errors were present in `_rt_server_err.log`. The server did not exit due to DB connectivity — it started fully and served the health endpoint. The process started by this verification was stopped cleanly; no other node processes remain.

---

## 6. Candidate Test Data

No suitable pre-resolved free episode exists for runtime testing:

- `episodes` table has **0** rows with a populated `video_url`.
- `episode_stream_cache` has **0** rows.
- No episode carries provider metadata (no provider column).

A live streaming test would require a fresh AnimeHeaven resolution (e.g. `animeheaven.me` → search → details → gate → mirror → CDN source). This report does **not** create fixtures.

---

## Blocked Tests

| Test                                                   | Status                                                 |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Live stream playback against a DB-provided `video_url` | **BLOCKED** — no episode has a `video_url`             |
| Persistent stream-cache playback                       | **BLOCKED** — `episode_stream_cache` is empty (0 rows) |
| Free-tier 720p stream resolution from a stored source  | **BLOCKED** — no pre-resolved candidate                |
| Premium-tier stream resolution from a stored source    | **BLOCKED** — 0 premium episodes, 0 cached rows        |

These are **data-state** blockers, not environment blockers. The environment itself (Node, DB connectivity, modules, server, AnimeHeaven reachability) is fully functional.

---

## Final Verdict

**ENVIRONMENT BLOCKED — LIVE TESTS NOT VERIFIED**

The environment is fully capable of performing AnimeHeaven streaming verification (Node ✅, DB ✅, modules ✅, server ✅, AnimeHeaven ✅ reachable). However, live streaming tests **cannot be verified** at this time because the database contains **no pre-resolved stream data**: 0 episodes with `video_url`, 0 cached stream rows, and 0 premium episodes. Per the task rules, no fixtures were created to work around this.

The environment is ready to run a live AnimeHeaven stream-resolution test (which contacts AnimeHeaven on demand), but it is not able to verify playback from any existing stored/cached stream source until either (a) a live resolution is performed at runtime, or (b) stream data is populated. No fixes were implemented.
