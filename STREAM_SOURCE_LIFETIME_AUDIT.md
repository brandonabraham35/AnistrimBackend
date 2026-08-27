# AniStrim Stream Source Lifetime Audit Report

**Date:** 2026-08-27
**Type:** READ-ONLY AUDIT (Phase A)
**Scope:** Full stream resolution, caching, proxy, and source lifetime infrastructure

---

## Executive Summary

The AniStrim streaming pipeline already has a **mature multi-layer caching architecture** with Redis, MySQL persistent cache, in-memory fallbacks, and an in-flight resolver deduplicator. The primary gaps are:

1. **No upstream URL expiry parsing** — source URLs contain expiry parameters but they are never extracted or tracked
2. **No Redis → DB → Resolver hierarchy** — Redis exists but is not used as the first tier in the resolution flow
3. **No automatic failure recovery** — playback failures are only detected via manual user reports
4. **No background source verification** — cached sources are never proactively verified

The existing `episode_stream_cache` MySQL table (migration v18) already covers the persistent storage requirement. The `inFlightResolverManager` already handles concurrent request deduplication. Redis is available and configured.

---

## 1. Source URL Resolution

### Where It Happens

| Component | File | Function | Line |
|-----------|------|----------|------|
| Entry point | `controllers/streamController.js` | `getStream()` | ~90 |
| Main resolver | `services/streamingService.js` | `resolveStream()` | ~689 |
| AnimeHeaven (fast path) | `services/animeHeavenProvider.js` | `resolveStreamByKey()` | N/A |
| AnimeHeaven (fallback) | `services/animeHeavenProvider.js` | `extractStreams()` / `resolveStream()` | N/A |
| Consumet fallback | `services/consumetProvider.js` | `resolveStreamUrl()` | ~295 |

### Resolution Flow

```
Client → /api/stream/:title/:episode
  → streamController.getStream() (auth + premium check)
  → streamingService.resolveStream()
    → Check MySQL episode_stream_cache
    → DB lookup: anime.animeheaven_slug + episodes.animeheaven_episode_key
    → animeHeavenProvider.resolveStreamByKey(slug, episodeKey)
      → gate.php scrape → mirror parse → CDN URL extract
    → On failure (3 attempts): Consumet fallback providers
    → Filter by quality tier (free ≤720p, premium ≤4K)
    → Save to MySQL cache
    → streamProxy.rewriteResultToProxy() — sanitize + store context
  → Return { streamUrl, sources, subtitles, providerUsed }
```

---

## 2. Residential Proxy Usage

### When Proxy is Used

| Scenario | File | Condition |
|----------|------|-----------|
| Provider HTTP scraping | `utils/providerHttp.js` | `PROXY_LIST` env var has entries → all outbound requests round-robin through proxies |
| 403 retry | `consumetProvider.js` | 403 response → retry with next proxy → fallback to no proxy |
| Playback streaming | `controllers/streamProxyController.js` | `/api/stream-proxy/:streamId` pipes bytes from upstream through server |
| Cache liveness probe | `services/streamCacheService.js` | **Explicitly disabled** (`skipProxy: true`) |

### Proxy is NOT Used For

- Cache liveness probes (HEAD requests to verify cached URLs)
- Direct MP4 streams that don't require referer/origin headers
- Anonymous sources (no playback context stored)

---

## 3. Source Formats

| Provider | Format | Notes |
|----------|--------|-------|
| **AnimeHeaven** | MP4 or HLS (.m3u8) | Inferred by URL suffix in `streamCacheService.js` line ~189 |
| **Consumet (KickAssAnime)** | Typically HLS | Via `@consumet/extensions` |
| **Consumet (Hianime)** | Typically HLS | Via `@consumet/extensions` |
| **Consumet (AnimePahe)** | Typically HLS | Via `@consumet/extensions` |

Format detection logic:
```js
streamType = url.endsWith('.m3u8') ? 'hls' : 'direct';
```

---

## 4. HMAC Stream Token vs Upstream URL

**They are completely separate and serve different purposes.**

| Aspect | HMAC Token | Upstream URL |
|--------|-----------|-------------|
| **Purpose** | Authorize client access to `/api/stream-proxy/:streamId` | The actual video source on the CDN |
| **Location** | Query param: `?token=<hmac>` | Stored server-side in `streamProxyStore` |
| **TTL** | 120 seconds | 8 minutes (COOKIE_TTL_MS) or provider-defined |
| **Binding** | `{userId, episodeId, streamId, ipHash, sid, tv}` | None — it's a raw CDN URL |
| **Exposed to client** | Yes (as query param) | Never — client receives `/api/stream-proxy/:streamId` |
| **File** | `utils/streamToken.js` | `services/animeHeavenProvider.js`, `services/streamingService.js` |

The client **never sees the upstream URL**. It only sees the proxied path `/api/stream-proxy/:streamId`.

---

## 5. Upstream URL Expiry Detection

### Current State: NOT IMPLEMENTED

- Upstream URLs from AnimeHeaven contain expiry/signature parameters (e.g., `?token=...&expires=...`)
- **The application never parses or inspects these parameters**
- No `expires_at` field is populated from URL analysis
- The only expiry tracking is the **8-minute cookie TTL** (`COOKIE_TTL_MS`) which is a conservative upper bound

### What IS Tracked

| Item | TTL | File |
|------|-----|------|
| CDN playback cookie | 8 minutes | `animeHeavenProvider.js` line ~14 |
| Stream proxy store | 8 minutes | `utils/streamProxyStore.js` line ~30 |
| Persistent cache | Clamped to 8 min max | `config/streamCache.js` |
| HMAC token | 120 seconds | `utils/streamToken.js` line ~14 |

### Gap

The application treats all cached sources as valid for up to 8 minutes regardless of the actual upstream URL's expiry. If a URL expires after 2 minutes, the cache may serve a dead URL for up to 6 minutes.

---

## 6. Redis Availability

**Confirmed available.** Both `redis` (v6.1.0) and `ioredis` (v5.11.1) are in `package.json`.

### Configuration

**File:** `utils/cacheService.js`

```js
client = createClient({
  url: process.env.REDIS_URL,
  socket: { connectTimeout: 1500, reconnectStrategy: false }
});
```

- Falls back to in-memory `Map` if `REDIS_URL` not set or connection fails
- Operations: `get(key)`, `set(key, value, ttlSeconds)`, `delByPrefix(prefix)`
- Used by: anime controller cache, generic caching, stream resolution results

### NOT Used By

- Stream proxy store (pure in-memory Map in `utils/streamProxyStore.js`)
- Provider HTTP health tracking (in-memory Map)
- In-flight resolver manager (in-memory Map)

---

## 7. Existing Cache Layers

| # | Cache Layer | File | Storage | TTL | What It Caches |
|---|------------|------|---------|-----|---------------|
| 1 | HTML page cache | `animeHeavenProvider.js` | Map | 120s | Scraped AnimeHeaven HTML pages |
| 2 | Search cache | `animeHeavenProvider.js` | Map | 90s | Search results |
| 3 | Base URL cache | `animeHeavenProvider.js` | Map | 10 min | AnimeHeaven domain candidates |
| 4 | Cookie jar | `animeHeavenProvider.js` | Map | 8 min | Set-Cookie values per domain |
| 5 | Mirror health cache | `animeHeavenProvider.js` | Map | 10 min | Mirror availability |
| 6 | Subtitle probe cache | `animeHeavenProvider.js` | Map | 20 min | Subtitle availability |
| 7 | Redis / generic cache | `utils/cacheService.js` | Redis or Map | 300s (default) | Stream resolution payloads |
| 8 | **Persistent stream cache (MySQL)** | `services/streamCacheService.js` | MySQL `episode_stream_cache` | Clamped to 8 min max | Pre-proxy AnimeHeaven source data |
| 9 | In-flight resolver | `services/inFlightResolverManager.js` | Map | Configurable | Deduplicates concurrent resolutions |
| 10 | Stream proxy store | `utils/streamProxyStore.js` | Map | 8 min | Playback context (cookies/referer/origin) |
| 11 | Provider health store | `utils/providerHttp.js` | Map | 60s degrade cooldown | Success/failure rates |

### Key Finding

**8 cache layers exist** — a comprehensive caching infrastructure is already in place. The gaps are not in the number of layers but in their coordination (Redis is not the first tier, no expiry-based invalidation, no failure recovery).

---

## 8. Database Tables

### Anime Table

**File:** `sql/schema.sql` line ~35

| Column | Type | Notes |
|--------|------|-------|
| `id` | INT PK | Auto-increment |
| `title` | VARCHAR | Human-readable title |
| `title_japanese` | VARCHAR | Japanese title |
| `animeheaven_slug` | VARCHAR | Provider identifier |
| `animeheaven_last_synced_at` | DATETIME | Last import time |
| `source_provider` | VARCHAR | Provider name |
| `source_id` | VARCHAR | Provider-specific ID |
| `source_slug` | VARCHAR | Canonical slug |
| `access_tier` | ENUM | free/premium |
| `is_premium` | TINYINT | Premium flag |
| `media_type` | VARCHAR | TV/Movie/OVA |

### Episodes Table

**File:** `sql/schema.sql` line ~106

| Column | Type | Notes |
|--------|------|-------|
| `id` | INT PK | Auto-increment |
| `anime_id` | INT FK | → anime(id) ON DELETE CASCADE |
| `episode_number` | INT | Episode number |
| `season` | INT | Season number |
| `animeheaven_episode_key` | VARCHAR | Provider episode key |
| `animeheaven_episode_url` | VARCHAR | Cached upstream URL |
| `consumet_id` | VARCHAR | Consumet provider ID |
| `access_tier` | ENUM | free/premium |
| `is_premium` | TINYINT | Premium flag |
| `premium_until` | DATETIME | Premium expiry window |

Unique: `(anime_id, episode_number)`

### Episode Stream Cache Table

**File:** `sql/migrations_v18_episode_stream_cache.sql`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INT PK | Auto-increment |
| `episode_id` | INT FK | → episodes(id) |
| `provider` | VARCHAR | Provider name |
| `stream_type` | VARCHAR | hls/direct |
| `stream_data` | JSON | Full source data |
| `resolved_at` | DATETIME | Resolution timestamp |
| `expires_at` | DATETIME | Expiry (set to resolved_at + TTL) |
| `last_used_at` | DATETIME | Last access time |

Unique: `(episode_id, provider)`

**Gap:** The `expires_at` is set to `resolved_at + TTL` (time-based) rather than parsed from the upstream URL's actual expiry parameters.

---

## 9. Client/Player Stream Reception

### Full Flow

```
1. Client calls GET /api/stream/:animeTitle/:episodeNumber [Bearer JWT]
2. Controller validates auth, resolves episode number, checks premium entitlement
3. Streaming service resolves stream (MySQL cache → DB lookup → provider → fallback)
4. streamProxy.rewriteResultToProxy() sanitizes and stores playback context
5. Client receives JSON: { streamUrl: "/api/stream-proxy/<streamId>/index.m3u8", sources: [...], subtitles: [...] }
6. Client player (hls.js for HLS, native <video> for MP4) loads /api/stream-proxy/<streamId>
7. Proxy controller retrieves context, fetches upstream with headers, pipes to client
```

### Authorization Flow (Separate)

```
1. Client POST /api/stream/authorize { episodeId } [Bearer JWT]
2. Controller checks entitlement via canWatch()
3. For each streamId: mint HMAC token (120s TTL, bound to userId + episodeId + streamId + ip)
4. Return { streamUrls: ["/api/stream-proxy/<streamId>?token=<hmac>"], ... }
```

---

## 10. Playback Failure Detection

### Current Detection Methods

| Method | File | How It Works |
|--------|------|-------------|
| Provider health tracking | `utils/providerHttp.js` | `markSuccess()`, `markFailure()`, `markTimeout()` — tracks per-provider metrics, marks degraded after 3 consecutive failures |
| Structured logging | `utils/logger.js` | `logger.streamAttempt()` logs `result`, `failureReason`, `httpStatus`, `timedOut`, `latencyMs` |
| Source liveness probe | `services/streamCacheService.js` | `isCachedSourceAlive()` — HEAD request to cached URLs, returns false on 403/404 |
| In-flight resolver | `services/inFlightResolverManager.js` | Detects concurrent timeout while resolver still running |

### Reporting

| Response | Condition |
|----------|-----------|
| HTTP 502 `{ success: false, error: "Could not resolve a stream..." }` | Resolution fails entirely |
| HTTP 403 | Premium episode, user not authorized |
| Provider list with `metadataOnly: true` | Lists providers without attempting resolution |

### Gap

**No client-side failure reporting endpoint.** Users can report broken streams via `/api/reports/stream` but this is a manual form, not an automated playback failure signal. There is no endpoint like `POST /api/stream/failure` that the player can call when playback stalls.

---

## 11. Complete Flow Summary

### Stream Resolution

```
Client (browser)
  ↓ GET /api/stream/:title/:episode [Bearer JWT]
routes/streamRoutes.js (protect middleware → JWT verify + DB reload)
  ↓
controllers/streamController.js::getStream
  1. Resolve episode number (?ep=N or URL param or movie override)
  2. resolveEpisodeAuth() → DB: is this episode premium? is user authorized?
  3. Look up episodeId from episodes table (anime_id + episode_number)
  4. streamingService.resolveStream(title, episode, { isPremium, episodeId })
    ↓
    Check MySQL episode_stream_cache → HIT: return cached pre-proxy data
    → MISS: continue
    ↓
    DB lookup: anime.animeheaven_slug + episodes.animeheaven_episode_key
    ↓
    animeHeavenProvider.resolveStreamByKey({ slug, episodeKey })
      → gate.php scrape → parse mirrors → extract CDN URL
      → collect Set-Cookie headers
      → return { streamUrl, sources, subtitles }
    ↓
    On failure (3 attempts): fallback to ConsumetProvider (KickAssAnime, Hianime, AnimePahe)
    ↓
    Filter by tier (free ≤720p, premium ≤4K) → pick best quality
    ↓
    Save to MySQL episode_stream_cache
    ↓
    streamProxy.rewriteResultToProxy(result, userId, episodeId, ipHash)
      → For AnimeHeaven sources (has referer/origin/cookies):
        streamProxyStore.store({ targetUrl, referer, origin, cookies, userAgent })
        → Generate streamId: sha256("stream|url|userId|episodeId|ipHash")
        → Return sanitized: { url: "/api/stream-proxy/<streamId>/index.m3u8", quality: "720", proxied: true }
      → For anonymous sources: pass through unchanged
    ↓
  5. Return JSON to client
```

### Client Playback

```
Client player (hls.js or native <video>)
  ↓ GET /api/stream-proxy/<streamId>/index.m3u8?token=<HMAC>
routes/streamProxyRoutes.js (proxyLimiter)
  ↓
controllers/streamProxyController.js::streamMedia
  1. Look up streamId in streamProxyStore → { targetUrl, referer, origin, cookies, userAgent }
  2. If HLS: fetch manifest, rewrite child URIs to proxy URLs
  3. If MP4: stream with Range header support (Accept-Ranges: bytes)
  4. Inject headers: Referer, Origin, Cookie, User-Agent from stored context
  5. Fetch upstream via providerHttp.request() (through residential proxy if configured)
  6. Pipe response to client
```

---

## Phase B Readiness Assessment

| Requirement | Current State | Gap | Effort |
|-------------|-------------|-----|--------|
| Database table for source cache | ✅ `episode_stream_cache` exists | `expires_at` is time-based, not URL-parsed | Low — add URL expiry parser |
| Source expiry detection | ❌ Not implemented | No parsing of URL expiry parameters | Medium — add URL parser |
| Cheap verification (HEAD/Range) | ✅ `isCachedSourceAlive()` exists | Only checks 403/404, doesn't parse headers | Low — extend existing probe |
| Redis → DB → Resolver flow | ⚠️ Partial — Redis exists but not first tier | Not integrated into resolution flow | Medium — add Redis as tier 1 |
| Per-episode locking | ✅ `inFlightResolverManager` exists | Already implemented | None |
| Playback failure recovery | ❌ Manual reports only | No automated failure endpoint | Medium — add endpoint |
| Background verification | ❌ Not implemented | No scheduled job | Medium — add cron job |
| Source lifetime analytics | ❌ Not implemented | No metrics | Low — add counters |
| Preserve existing contracts | ✅ All preserved | N/A | None |

**Overall: Phase B is 60% ready.** The database table, in-flight resolver, Redis, and liveness probe already exist. The gaps are in expiry parsing, Redis integration as the first cache tier, failure recovery, and background verification.
