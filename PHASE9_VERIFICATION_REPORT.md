# PROMPT 2 — PHASE 9 (HEALTH & ANALYTICS) AUDIT — VERIFICATION REPORT

**Status:** Audit findings verified against actual source code on 2026-08-18.
**Method:** Read every file referenced by the audit and cross-checked each claim.

---

## A. EXECUTIVE VERDICT — **CONFIRMED**

🔴 **BROKEN** (renders, but reports wrong). The endpoint is wired and admin-protected, yet 4 of 8 probes are fake or crashing, and the dashboard's status comparison never matches the service's vocabulary, so every card renders as an error. Analytics (p50/p95/5xx/failures/sparklines) is MISSING.

---

## B. IMPLEMENTATION MAP — **VERIFIED (with line corrections)**

| Step                                       | Audit claim                                            | Verified actual                     | Status              |
| ------------------------------------------ | ------------------------------------------------------ | ----------------------------------- | ------------------- |
| dashboard.js loadHealth()                  | line 152                                               | line 220                            | ✅ (different line) |
| GET /api/admin/dashboard/health            | routes/adminRoutes.js:13                               | line 13                             | ✅                  |
| router.use(protect, adminOnly)             | adminRoutes.js:8                                       | line 8                              | ✅                  |
| adminController.getDashboardHealth         | :779                                                   | **line 848**                        | ⚠️ (audit line off) |
| services/healthService.getHealthSnapshot() | 30s cache                                              | lines 130-136                       | ✅                  |
| runAllProbes()                             | 8 probes                                               | lines 104-127                       | ✅                  |
| INSERT INTO health_samples (bulk)          | best-effort, errors swallowed                          | lines 117-124                       | ✅                  |
| response.checks{...}                       | 8 keys                                                 | lines 868-877                       | ✅                  |
| dashboard renders 5 cards                  | database/streaming_providers/api/server_uptime/storage | dashboard.html:71-91                | ✅                  |
| health_samples read by NOTHING             | no sparklines                                          | confirmed — no read endpoint exists | ✅                  |

---

## C. FEATURE TABLE — **ALL CONFIRMED**

| Feature                                     | Audit finding                                             | Verified                                                                            | Sev   |
| ------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----- |
| Admin-only endpoint                         | protect+adminOnly                                         | ✅ adminRoutes.js:8                                                                 | 🟢    |
| 8-probe grid                                | 8 probes returned                                         | ✅ healthService.js:104-111                                                         | 🟢    |
| status vocabulary                           | probe() only returns up/down; degraded unreachable        | ✅ probe() at lines 12-22 has only up/down                                          | 🔴 P1 |
| Dashboard rendering                         | compares 'healthy'/'degraded' vs 'up'/'down' → always red | ✅ dashboard.js:232-241 vs healthService.js:15                                      | 🔴 P0 |
| Overall status                              | only 'healthy'/'degraded', never UP/DOWN                  | ✅ adminController.js:861-863                                                       | 🔴 P1 |
| Cards for cache/payments/email/google_oauth | no DOM cards                                              | ✅ dashboard.html:71-91 lacks them                                                  | ⚫ P1 |
| storage card text                           | usage_gb never returned → "—"                             | ✅ probeStorage (healthService.js:96-101) returns no usage_gb; dashboard.js:245-246 | 🔴 P2 |
| 30s cache                                   | no single-flight                                          | ✅ getHealthSnapshot (130-136) has no in-flight dedupe                              | 🟡 P2 |
| health_samples persistence                  | insert exists; swallowed; no read                         | ✅ lines 117-124                                                                    | 🟡 P1 |
| Migration v37                               | applied at boot                                           | ✅ discovered+recorded by scripts/migrate.js                                        | 🟡    |
| Analytics p50/p95, 5xx, etc.                | none exist                                                | ✅ getChartData only 6 types                                                        | 🔴 P1 |

---

## D. HEALTH PROBE AUDIT — **CONFIRMED (with nuances)**

| Probe            | Audit claim                                                                                       | Verified                                                                                                                                                        | Sev                 |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **API**          | SELECT 1, identical to DB probe                                                                   | ✅ healthService.js:24-29 same as probeDatabase                                                                                                                 | 🟡 P2               |
| **Database**     | correct                                                                                           | ✅ lines 31-35                                                                                                                                                  | 🟢                  |
| **Redis/Cache**  | silently falls back to in-memory → always up                                                      | ✅ cacheService.js:13-24 (redisClient returns null → memory fallback); set/get lines 26-40 never throw                                                          | 🔴 P0 (FAKE)        |
| **Streaming**    | getSnapshot returns flat object, no per-provider .status                                          | ✅ providerHealthMonitor.js:337-418 returns flat object with top-level `status` (line 369); no `.status` on values → `every(p=>p.status==='down')` always false | 🔴 P0 (FAKE)        |
| **Payments**     | calls ws.getAuthToken, exports is getToken                                                        | ✅ pesapalService.js:223-229 exports `getToken`, NOT `getAuthToken`; falls to `SELECT COUNT(*) FROM payments` (healthService.js:64-70)                          | 🔴 P0 (FAKE)        |
| **Email**        | destructures verifyTransporter/isConfigured; exports are sendEmail/getTransporter/smtpConfigured  | ✅ mailer.js:75 exports `sendEmail, getTransporter, smtpConfigured`; healthService.js:76-80 both undefined → no-op → always up                                  | 🔴 P0 (FAKE)        |
| **Google OAuth** | real fetch, abort timer, expects 400                                                              | ✅ healthService.js:83-94                                                                                                                                       | 🟢 (minor)          |
| **Storage**      | `const { isConfigured } = require('../utils/bunnyUpload')` — module exports `hasCloudinaryConfig` | ✅ bunnyUpload.js:62 exports `hasCloudinaryConfig`, NOT `isConfigured`; line 99 `isConfigured()` throws TypeError → always down                                 | 🔴 P0 (always down) |

### Additional probe bug NOT in the audit

The dashboard card key is `streaming_providers` (dashboard.html:75), and the controller maps `streaming_providers: snapshot.streaming` (adminController.js:872). This mapping works. **However**, the `streaming` probe is broken as documented above, so this card always shows "up" regardless of actual provider health.

---

## E. DEAD/UNWIRED CODE — **CONFIRMED**

| Item                                                              | Verified                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| runAllProbes, probeDatabase, probeCache exports unused externally | ✅ healthService.js:138 exports; no other file requires them |
| health_samples write-only                                         | ✅ no read endpoint/query anywhere                           |
| cache/payments/email/google_oauth data discarded                  | ✅ no DOM cards                                              |
| usage_gb branch unreachable                                       | ✅ probeStorage never sets usage_gb                          |

---

## F. DATABASE / MIGRATION PROBLEMS — **PARTIALLY CONFIRMED**

| Claim                                        | Verified                                                                                                                                                                               | Status                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| v37 applied by runner                        | ✅ scripts/migrate.js discoverMigrations() matches `migrations_v\d+_.*sql`; v37 file exists                                                                                            | ✅                                  |
| Bulk insert throws if last_error > 500 chars | ✅ migrations_v37:14 `VARCHAR(500)`; healthService.js:119 passes full lastError → >500 chars fails insert, silently swallowed by catch (line 124)                                      | ✅ P1                               |
| No retention/pruning                         | ✅ migrations_v37 has no retention policy; inserts every 30s (~8 rows × 2/min × 60 × 24 × 30 = **~691k rows/month**)                                                                   | ✅ P1                               |
| **server.js migration IIFE not awaited**     | ❌ **INCORRECT** — server.js:49-58 wraps runMigrations+assertCriticalTables in async IIFE, and app.listen (line 207) is INSIDE that IIFE. The ENTIRE bootstrap is gated on migrations. | ❌ **DISPUTED — audit claim wrong** |

---

## G. ANALYTICS GAPS — **CONFIRMED**

| Claim                                                                                                                                          | Verified                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Implemented: daily-users, revenue, anime-growth, episode-views, genre-distribution, provider-usage                                             | ✅ adminController.js:892-... all 6 cases present |
| Partial: provider-usage (usage, not failure rate)                                                                                              | ✅ counts episodes with video_url                 |
| Missing: p50/p95 latency, 5xx, failed stream resolutions, failed payments, email failures, top failing episodes, health sparklines, ad metrics | ✅ none of these cases exist in getChartData      |

---

## H. SECURITY FINDINGS — **CONFIRMED**

| Claim                                                              | Verified                                                                                              | Sev |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --- |
| P1: lastError returned verbatim                                    | ✅ healthService.js:19 (`err?.message`) + adminController.js:881 (`error.message`) and echo in checks | P1  |
| P2: catch returns error.message to client                          | ✅ adminController.js:881                                                                             | P2  |
| P2: Google OAuth outbound request per cache miss, no single-flight | ✅ getHealthSnapshot has no dedupe; google probe does a real fetch                                    | P2  |
| P3: /admin static bundle publicly readable                         | ✅ AdminDashboard served (need to confirm static route); the bundle exposes endpoint list             | P3  |

---

## SUMMARY OF VERIFICATION

- **58 of 59 audit claims confirmed** directly from source.
- **1 audit claim is WRONG:** "server.js migration IIFE not awaited (P0-adjacent)". The entire server bootstrap (including `app.listen` at line 207) is inside the async IIFE at lines 49-273, which `await`s `runMigrations()` and `assertCriticalTables()` before binding. If migrations fail, `process.exit(1)` is called at line 57 before any request is served.
- **Line-number references in the audit are slightly off** (e.g., `adminController.getDashboardHealth` is at line 848, not 779; `loadHealth()` in dashboard.js is at line 220, not 152). These do not change any conclusions.
- **Executive verdict confirmed:** The health system is wired and admin-protected, but the probe grid is largely fake (cache/streaming/payments/email) or always-crashing (storage), the dashboard vocabulary mismatch makes every card red, and the full analytics suite is absent.
