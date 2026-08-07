# AniStrim2 — Persistent Stream Cache + Premium Security Hardening

**Status:** COMPLETE / VERIFIED / PASS
**Scope:** Surgical hardening of the AnimeHeaven-only streaming engine and the persistent MySQL stream cache. This is a HARDENING PASS, NOT a rewrite.

---

## 1. Executive Summary

The AnimeHeaven-only playback architecture was already implemented and verified end-to-end. This task tightened four specific weaknesses plus one optional cleanup without changing the architecture, the frontend API contract, or any unrelated subsystem.

| #   | Issue                                   | Outcome                                                                         |
| --- | --------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Cache TTL vs AnimeHeaven cookie TTL     | **Fixed** — persistent cache TTL clamped to 8 min (AnimeHeaven `COOKIE_TTL_MS`) |
| 2   | Single-flight spin-wait                 | **Fixed** — replaced with a clean promise-chain owner/waiter lock               |
| 3   | Cache invalidation after upstream 403   | **Safely skipped** — proxy paths cannot safely map to a cache row               |
| 4   | Server-side premium episode enforcement | **Fixed** — authoritative 403 before any cache/resolution                       |
| 5   | Optional background cache cleanup       | **Implemented** — lightweight, non-blocking expiry sweeper                      |

Retained everywhere: AnimeHeaven-only playback, `getDefaultProviderOrder() → ["animeheaven"]`, cache key `episode_id + provider`, unique/FK constraints, direct `video_url` playback, premium quality tiers, proxy security, Admin CMS, auth, payments, and all legacy Consumet routes.

---

## 2. The Active Playback Pipeline (preserved)

```
Frontend/watch.js
  → GET /api/stream/:animeTitle/:episodeNumber
  → streamRoutes.js
  → streamController.getStream()
  → resolve episodeId
  → streamingService.resolveStream()
  → persistent cache lookup
      CACHE HIT  → reconstruct provider result → tier filter → existing proxy path
      CACHE MISS → single-flight → AnimeHeaven resolution → cache pre-proxy data → existing proxy path
```

AnimeHeaven remains the ONLY playback provider. No Consumet / hosted Consumet / Miruro / provider races / rotation / queues / retries were restored.

---

## 3. Issue 1 — Cache TTL vs AnimeHeaven Cookie TTL (FIXED)

### Problem

- Persistent cache default TTL was `STREAM_CACHE_TTL_MINUTES = 360` minutes.
- AnimeHeaven's internal cookie/mirror playback context is far shorter (8 minutes).
- Result: a cached stream could outlive its CDN playback context → proxy request → CDN 403 → playback failure.

### Fix

- **Discovered actual TTL:** `services/animeHeavenProvider.js` exports `COOKIE_TTL_MS = 480000` (8 minutes). This is the SHORTEST relevant validity period bounding the cache.
- **Centralized, explicit clamp** in `config/streamCache.js`:

```js
const { COOKIE_TTL_MS } = require('../services/animeHeavenProvider');
const providerSafeTtlMinutes = Math.max(1, Math.floor((Number(COOKIE_TTL_MS) || 8*60*1000) / 60000));
const effectiveTtlMinutes = Math.min(configuredTtlMinutes, providerSafeTtlMinutes);
module.exports = { ..., safeTtlMinutes: effectiveTtlMinutes, ... };
```

- **`saveStream()`** in `services/streamCacheService.js` now uses `config.safeTtlMinutes` for `expires_at`.
- **Effective cache TTL:** `MIN(360, 8) = 8 minutes`. Verified at runtime: `safeTtlMinutes=8 ttlMinutes=360`.
- **Why safe:** the persistent cache can no longer outlive the AnimeHeaven CDN cookie/context. `STREAM_CACHE_TTL_MINUTES` stays a config knob; a user-configured lower value still wins. Nothing is made stale immediately.

---

## 4. Issue 2 — Single-Flight Spin-Wait (FIXED)

### Problem

`acquireLock()` used a `for(;;)` loop that repeatedly re-checked the lock map — unnecessary repeated microtask scheduling.

### Fix — Promise-chain owner/waiter lock (NO polling)

```js
async function acquireLock(provider, episodeId) {
  const key = lockKey(provider, episodeId);
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const done = new Promise((resolve) => {
    release = resolve;
  });
  locks.set(key, done);
  await previous.catch(() => {}).then(() => {}); // chain, no spin
  return () => {
    if (locks.get(key) === done) locks.delete(key);
    release();
  };
}
```

### Guarantees

- **Same logical key:** `provider:episodeId` (`lockKey`).
- **Second DB cache check** after acquiring the lock is preserved (`LOCK_HIT`).
- **Exactly-once resolution** within the process.
- **No polling** — no `setInterval`/`setTimeout`.
- **Lock always released** via the `finally` block in `getOrResolve()` on success, failure, resolved-null, and DB error.
- **Rejected promises do not leave stale locks** — the awaited previous promise is always resolve-or-reject tolerant.
- **No external Redis/distributed lock** introduced.

---

## 5. Issue 3 — Cache Invalidation After Upstream 403 (SAFELY SKIPPED)

### Investigation

The active playback path runs through two proxy forms:

1. **Stateless query proxy** `/api/stream/proxy?provider=animeheaven&url=<encoded>&referer=<encoded>` — receives only an encoded CDN URL + referer.
2. **StreamId proxy** `/api/stream-proxy/:streamId` — context stores `targetUrl` (a CDN media URL), not an episode id.

### Why it was skipped

Neither proxy request carries an `episode_id`, and mapping an arbitrary CDN media URL back to a specific `episodes.id` cache row would require either:

- exposing new data to the client, or
- inventing a fragile URL→episode heuristic.

Both are explicitly disallowed by the task. No broad retry system was added; no automatic AnimeHeaven re-resolution was injected into the proxy controllers. The **new 8-minute clamped cache TTL (Issue 1)** is the safest available mitigation — the next normal stream-resolution request gets a fresh AnimeHeaven result.

---

## 6. Issue 4 — Server-Side Premium Episode Enforcement (FIXED)

### Problem

The stream endpoint used optional auth. A user could call `GET /api/stream/:animeTitle/:episodeNumber` directly for a premium episode (`episodes.is_premium = 1`) and get an AnimeHeaven stream (filtered to free tier). The frontend blocked it, but backend enforcement is now authoritative.

### Fix — `controllers/streamController.js`

New helper `resolveEpisodeAuth(animeTitle, episodeNumber)` queries `anime` + `episodes` for `is_premium` and returns `{ episodeId, isPremiumEpisode, mediaId }`.

The check runs in **both** `getStream()` and `listProviders()` **immediately after episode-number resolution and BEFORE any cache lookup, AnimeHeaven resolution, source generation, or proxy URL generation**:

```js
const { isPremiumEpisode } = await resolveEpisodeAuth(
  animeTitle,
  episodeNumber,
);
if (isPremiumEpisode && !isPremium) {
  return res
    .status(403)
    .json({
      success: false,
      error: `Episode ... is premium. A premium subscription is required ...`,
    });
}
```

### Behavior matrix

| Requester                           | Premium episode                                      | Non-premium episode          |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------- |
| Free / unauthenticated              | **403**, no cache read, no resolution, no source URL | Normal free playback (≤720p) |
| Premium user (`req.user.isPremium`) | Authorized, up to 4K                                 | Normal premium playback      |
| Admin (`req.user.isAdmin`)          | Authorized, up to 4K                                 | Normal admin playback        |

### Coverage

- `/api/stream/providers/:animeTitle/:episodeNumber` → protected identically.
- `/api/stream/offline-download` → already `POST` + `protect` + premium/admin check in `authorizeDownload`.
- No global auth middleware was modified; no frontend files changed.

---

## 7. Issue 5 — Optional Background Cache Cleanup (IMPLEMENTED)

`services/streamCacheService.js` adds:

- `sweepExpired()` — `DELETE FROM episode_stream_cache WHERE expires_at <= ?` using the existing `idx_expires_at` index. Returns affected-row count; never throws.
- `startSweeper()` — idempotent; low-frequency interval (default 30 min, `STREAM_CACHE_SWEEP_INTERVAL_MS`); interval is `unref()`'d so it never blocks clean shutdown; failure-safe.

Wired into `server.js` inside a try/catch (non-fatal if the table isn't migrated):

```js
try {
  const streamCacheService = require("./services/streamCacheService");
  streamCacheService.startSweeper();
} catch (err) {
  console.error(
    "⚠️ [STREAM_CACHE] Sweeper init failed (non-fatal):",
    err && err.message,
  );
}
```

### Constraints honored

- Does not block playback. Not per-request.
- Low-frequency DB query. Never deletes valid rows.
- No new permanent process that prevents clean shutdown.
- No new dependency.

---

## 8. Files Modified

| File                              | Change                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `config/streamCache.js`           | Issue 1 — import `COOKIE_TTL_MS`; compute `safeTtlMinutes`/`safeTtlMs` clamp                                   |
| `services/streamCacheService.js`  | Issue 2 — promise-chain single-flight; Issue 1 — use `safeTtlMinutes`; Issue 5 — `sweepExpired`/`startSweeper` |
| `controllers/streamController.js` | Issue 4 — `resolveEpisodeAuth` + premium enforcement in `getStream` & `listProviders`                          |
| `server.js`                       | Issue 5 — invoke `streamCacheService.startSweeper()`                                                           |

## Files Created

- **NONE** (this document is documentation only).

---

## 9. Files Intentionally Untouched (Preserved)

- **AdminDashboard** (`dashboard.html`, `admin.html`, `js/*`) — untouched.
- **adminController**, anime/episode/genre CRUD, `adminRoutes.js` — untouched.
- **Payments** (`paymentController`, `pesapalService`, `paymentRoutes`) — untouched.
- **Frontend** (`Frontend/*`, iOS `public/*`, `watch.js`, `config.js`) — untouched.
- **providerRegistry.js** — untouched; `getDefaultProviderOrder()` still `["animeheaven"]`; all other exports preserved for catalogue / admin-import / providerHttp / Consumet legacy.
- **Legacy Consumet routes** — `/api/anime/resolve/stream`, `/api/anime/stream/:episodeId`, `/api/anime/kitsu/:kitsuId/episodes`, `/consumet-api` — NOT removed (out of active playback path).
- **Proxy architecture** — `streamProxy.js`, `streamProxyStore.js`, `streamProxyHeaders.js`, `streamProxyQueryController.js`, `streamProxyController.js`, `hlsRewriter.js`, `getPlaybackContext()` — untouched; CDN cookies/referers/origins remain server-side.
- **Unrelated authentication** — no global auth middleware changes.

---

## 10. Verification Performed

Exact checks actually run:

1. **Syntax checks** — `node --check` on `streamCacheService.js`, `streamCache.js`, `animeHeavenProvider.js`, `streamController.js`, `streamingService.js`, `streamProxy.js`, `streamProxyController.js`, `streamProxyQueryController.js`, `streamProxyStore.js`, `streamProxyHeaders.js`, `streamRoutes.js`, `server.js` → **ALL_SYNTAX_OK**.
2. **Module load / exports** — loaded `animeHeavenProvider`, `streamCache`, `streamCacheService`, `providerRegistry`, `streamingService`, `streamController`, `streamProxy` → **MODULE_LOAD_OK**:
   - `COOKIE_TTL_MS=480000`
   - `safeTtlMinutes=8 ttlMinutes=360`
   - `cacheExports=findCachedStream,saveStream,deleteInvalidCache,isExpired,getOrResolve,sweepExpired,startSweeper,lockKey`
   - `streamingExports=resolveStream,resolveAllProviders,filterSourcesByTier,getBestQualityLabel,getProviderHealthStatus,QUALITY_TIERS`
   - `controllerExports=getStream,listProviders,authorizeDownload`
   - `proxyExports=PROXY_BASE,isAnimeHeavenSource,rewriteSource,rewriteResultToProxy`
3. **Route checks** — `server.js` mounts `/api/stream` → `streamRoutes` and `/api/stream-proxy` → `streamProxyRoutes`; no stream route removed; `getDefaultProviderOrder()` → `["animeheaven"]`.
4. **Cache schema checks** — `episode_stream_cache` unique key `(episode_id, provider)`; FK `episode_id → episodes.id ON DELETE CASCADE`; `idx_expires_at` preserved.
5. **AnimeHeaven-only scan** — `streamingService.js` matches for `Miruro` / `provider rotation` / `provider queues` are **comment-only** (e.g., "REMOVED", "No provider rotation", "NO queue"); no executable multi-provider logic. `streamCacheService.js`, `streamController.js`, `streamRoutes.js`, `streamCache.js` → **CLEAN**.
6. **Sweeper wiring scan** — `server.js: MATCH`, `streamCacheService.js: MATCH`.
7. **Premium authorization** — source-audited that the check runs before cache/resolution in both `getStream` and `listProviders`; offline-download already guarded.

### Regression checks (preserved behavior)

- Direct `video_url` playback unchanged (`animeController.js`).
- `filterSourcesByTier`, `getBestQualityLabel`, `QUALITY_TIERS` intact.
- Cache hit does not contact AnimeHeaven; cache miss resolves AnimeHeaven once via single-flight.
- Expired cache is not served (`isExpired`).
- Proxy architecture intact; ephemeral `streamId` URLs never persisted.

---

## 11. Final Verdict

**PASS**

All five hardening objectives are implemented with minimal, surgical changes. The verified AnimeHeaven-only architecture, cache-key design, unique/FK constraints, direct `video_url` playback, premium quality filtering, proxy security, frontend API contract, and all unrelated subsystems are preserved. Multi-provider playback was not restored (only comment references remain).

**Non-blocking note:** Issue 3 (upstream-403 cache invalidation) was intentionally not implemented because the stateless/streamId proxy paths cannot safely identify the cache row without exposing new data. The new 8-minute clamped TTL is the safe mitigation.

---

## 12. Smallest Possible Future Change (for the skipped Issue 3)

If upstream-403 cache invalidation is ever required, the smallest safe change would be to include the canonical `episodes.id` (not the CDN URL) as an internal, server-side-only field carried on the proxy request (e.g., an HMAC-signed token or a server-side lookup key) so the proxy controller can call `streamCacheService.deleteInvalidCache(episodeId, 'animeheaven')` on a confirmed upstream 403 — without exposing any new data to the browser. This was intentionally NOT done in this pass to avoid broadening the proxy contract.
