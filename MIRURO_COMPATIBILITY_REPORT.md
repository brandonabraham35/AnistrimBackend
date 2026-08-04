# Miruro Compatibility Audit & Adapter Design Report

**Date:** 2025-06-06
**Scope:** Research + compatibility audit. No integration performed. No frontend changes. No invented endpoints.
**Status:** ⚠️ NOT COMPATIBLE — current Miruro resolver targets non-existent endpoints.

---

## 1. Executive Summary

The repository currently contains a **stub Miruro resolver** (`services/streamingService.js` → `buildMiruroResolver()`) that is registered in the provider pipeline but is **never activated** (no `MIRURO_API_URL` is set in `.env`/`.env.example`).

Live probing of the real Miruro service (miruro.tv v1.13.0) proves that **the endpoints the current resolver calls do not exist**:

| Current resolver calls                        | Live result                                 |
| --------------------------------------------- | ------------------------------------------- |
| `GET {MIRURO_API_URL}/search?query=...`       | **410 Gone** (endpoint does not exist)      |
| `GET {MIRURO_API_URL}/anime/{id}/episode/{n}` | **404 Not Found** (endpoint does not exist) |

The real Miruro API is a **same-origin, `/api/*` REST service** with a different request/response contract, optional **JWE end-to-end encryption**, and **AniList-ID-based** identifiers. Mapping Miruro's real schema into the app's internal stream model is **possible but non-trivial** and requires a purpose-built adapter. The current code must **not** be wired up as-is.

---

## 2. Does the Intended Miruro API Exist?

**Yes, but not the API the code assumes.** Two distinct things exist:

1. **The public website** — `https://www.miruro.tv/` returns HTTP 200 and serves a Vite/React SPA (v1.13.0). It is a functional anime streaming site.
2. **The site's internal API** — a same-origin REST API under `/api/*` (plus a `/health` endpoint). This is **not a documented public API**. It is the API the SPA itself consumes. There is **no official public API key**, **no dev portal**, and **no documented authentication/rate-limit contract**.

There is **no third-party "Miruro API"** (e.g. `api.miruro.tv`) — `https://api.miruro.tv/` returns HTTP 000 (no route / connection failure). The app's `PROVIDER_REFERERS.MIRURO = 'https://www.miruro.tv/'` is the correct base host.

---

## 3. Real Miruro Endpoint Structure (verified from the SPA bundle)

Endpoints are **same-origin** and must be called from the app's own origin to avoid CORS/Cloudflare issues. A client wrapper (`no.request(path, opts)`) prefixes `/api/` when the browser cannot do Web Crypto, otherwise routes through `/api/secure/pipe` (encrypted).

| Endpoint                   | Method   | Purpose                                 | Params                                                                                                                                                                                 |
| -------------------------- | -------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health`                  | GET      | Health check (returns `{ version }`)    | `_t` (cache bust)                                                                                                                                                                      |
| `/api/config`              | GET      | Streaming config (providers, messages)  | —                                                                                                                                                                                      |
| `/api/secure/jwks`         | GET      | ECDH-ES server public key (JWE)         | —                                                                                                                                                                                      |
| `/api/secure/pipe`         | GET/POST | JWE-encrypted request/response envelope | `e` (base64url of `{path, method, query, body}`)                                                                                                                                       |
| `/api/search`              | GET      | Quick search (used by navbar dropdown)  | `query`, `limit`, `offset`, `type`, `sort`                                                                                                                                             |
| `/api/search/browse`       | GET      | Paginated browse/advanced search        | `type`, `page`, `perPage`, `sort`, `genres`, `tags`, `status`, `format`, `season`, `seasonYear`, `countryOfOrigin`, `isAdult`, `averageScore_gte/lte`, `dubLanguage`, `startDate_like` |
| `/api/info/{id}`           | GET      | Merged anime info (by AniList ID)       | `live` (cache-bust), `_t`                                                                                                                                                              |
| `/api/info/anilist/{id}`   | GET      | Raw AniList info (by AniList ID)        | `live`, `_t`                                                                                                                                                                           |
| `/api/episodes`            | GET      | Episode list                            | `anilistId` (⚠️ AniList ID, not slug), `live`, `_t`                                                                                                                                    |
| `/api/sources`             | GET      | Stream sources for an episode           | `episodeId`, `provider`, `category` (`sub`/`dub`/`ssub`/`dub`), `anilistId`, `live`, `_t`, optional `ttl`                                                                              |
| `/api/schedule`            | GET      | Airing schedule                         | —                                                                                                                                                                                      |
| `/api/reports`             | POST     | Feedback/error reporting                | JSON body                                                                                                                                                                              |
| `/api/events`              | GET      | SSE (version/config pushes)             | —                                                                                                                                                                                      |
| `/api/token`, `/api/mal/*` | —        | AniList/MAL OAuth (auth, not streaming) | —                                                                                                                                                                                      |

**Streaming providers** (from `__SSR_CONFIG__.streaming`, provider order): `bonk, kiwi, hop, ally, pewe, bee, moo, nun, bun, twin, cog, telli`. Each has a `player` type (`native` vs `iframe`) and capabilities. Some providers are **embeds** (`parent`/`relationship: "embed"`), which are unusable for a backend scraper.

---

## 4. Authentication

- **No public API key.** The streaming/info/search endpoints are **unauthenticated** (they are consumed by the public SPA).
- **OAuth (AniList/MAL)** is used only for user features (list sync, notifications, history) — **not required** for fetching episodes/sources.
- **Cloudflare protection** is present on API routes (e.g. `/api/secure/jwks` returned **403** to `curl`). A backend scraper must send realistic browser headers and may need a proxy/Cloudflare-bypass strategy. This is a **hard compatibility risk**.
- **JWE encryption**: When the client supports Web Crypto, requests are wrapped via `/api/secure/pipe` (ECDH-ES + A256GCM). Node.js `crypto` does **not** implement the Web Crypto `crypto.subtle` ECDH-ES call chain used here; the existing `providerHttp` stack cannot transparently participate. The **plain-JSON** path (`/api/...` directly) is the only feasible server-side route, and it is **region/Cloudflare dependent**.

---

## 5. Rate Limits

- **No documented rate limits.** Observed behavior:
  - **429 Too Many Requests** is handled by the SPA for AniList GraphQL calls (`Too many requests`).
  - **503 Service Unavailable** with a `Retry-After` header is used for MyAnimeList syncing (client retries up to 3×, capped at 10s).
  - The SPA uses an **in-memory request-deduplication cache** (`to` Map) and a **30s abort timeout** (`Za=3e4`), implying the site expects conservative, burst-tolerant usage.
- **Recommendation:** treat Miruro as **rate-limited and unreliable**; place it **last** in the provider fallback queue and never let it degrade the pipeline. Bounded by the existing `PIPELINE_TIMEOUT_MS` (15s) and per-provider 10s streaming timeout.

---

## 6. Response Schema (Miruro)

### 6.1 Search (`/api/search`)

```
[ { id, title: { english, romaji, native },
    coverImage: { medium, large, color },
    bannerImage, format, episodes, averageScore,
    startDate: { year, month, day }, genres, dubLanguages } ]
```

- `id` is the **AniList ID** (integer).
- Top-level may be an array, or `{ media: [...], pageInfo: {...} }` for browse endpoints.

### 6.2 Episodes (`/api/episodes?anilistId=`)

```
[ { id, number, title, image, airDate, duration, description, filler, uncensored, url } ]
```

- `id` is the **episodeId** used for `/api/sources`.

### 6.3 Sources (`/api/sources?episodeId=&provider=&category=`)

Returns a provider-specific shape. The bundle's `ao` default episode shape and `oo` ttl map indicate sources are keyed by `provider` + `episodeId` + `category`. Native players receive a **playable stream list**; embed providers return an **iframe URL** (not directly playable). **Exact source-token shape is provider-dependent and not fully parsed from the bundle** — this is the chief unknown for the adapter.

---

## 7. Current Internal Model (the app expects this)

From `services/streamingService.js`, the canonical provider result that the pipeline consumes:

```js
{
  provider: string,          // e.g. 'miruro'
  streamUrl: string,         // best source URL
  sources: [ { url, quality } ],   // quality: '360'|'480'|'720'|'1080'|'2160'|'4k'|'default'|'auto'
  subtitles: [ { lang, url } ]
}
```

The pipeline's `normalizeProviderResult()` also accepts `allSources` (Consumet style) and `source`/`file`/`qualityLabel` aliases. The final payload exposed to the controller/frontend is:

```js
{
  (provider, streamUrl, sources, subtitles, bestQuality, tier);
}
```

**Quality tiers** are enforced by `filterSourcesByTier()`:

- Free: `max 720` → `['360','480','720','default','auto']`
- Premium: `max 4320` → `['360','480','720','1080','2160','4320','4k','default','auto']`

---

## 8. Compatibility Matrix (Miruro ↔ Internal Model)

| Concern          | Miruro (real)                                 | Internal model                       | Compatible?                                       |
| ---------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| Identifier       | AniList integer ID                            | Title string + episode number        | ⚠️ Adapter must map title→AniList ID via search   |
| Search endpoint  | `/api/search?query=`                          | (none — resolver builds its own)     | ⚠️ Current code uses wrong path                   |
| Episode endpoint | `/api/episodes?anilistId=`                    | (none — resolver builds its own)     | ⚠️ Current code uses wrong path                   |
| Sources endpoint | `/api/sources?episodeId=&provider=&category=` | (none — resolver builds its own)     | ⚠️ Current code uses wrong path                   |
| Source shape     | provider-dependent, possibly embed/iframe     | `{ url, quality }[]`                 | ⚠️ Requires normalization; embed sources unusable |
| Subtitles        | per-source, provider-specific                 | `{ lang, url }[]`                    | ⚠️ Mapping required                               |
| Quality labels   | provider-dependent                            | `360/480/720/1080/...`               | ⚠️ Must coerce to numeric tier                    |
| Auth             | none (public) / Cloudflare 403                | none                                 | ⚠️ Cloudflare/403 risk                            |
| Transport        | same-origin `/api/*`; optional JWE            | plain HTTP via `providerHttp`        | ❌ JWE not feasible in Node; must use plain path  |
| Rate limits      | undocumented (429/503)                        | provider health tracking             | ✅ fits existing health/degrade model             |
| Referer          | `https://www.miruro.tv/`                      | already registered                   | ✅                                                |
| Provider ID      | (new) `miruro`                                | already registered in `PROVIDER_IDS` | ✅                                                |

**Overall verdict: NOT compatible as wired.** The mapping is achievable through a dedicated adapter but carries **Cloudflare, JWE, and embed-provider risks** that make Miruro a **low-reliability fallback**, not a primary source.

---

## 9. Mapping Strategy (adapter design)

A new dedicated module `services/miruroProvider.js` should encapsulate all Miruro-specific logic and expose **exactly** the internal contract:

```js
async resolveStream({ title, episode }) ->
  { provider: 'miruro', streamUrl, sources: [{url, quality}], subtitles: [{lang, url}] }
```

### 9.1 Title → AniList ID resolution

1. `GET /api/search?query={title}&limit=5&type=ANIME&sort=POPULARITY_DESC`
2. Match the first result whose `title.english`/`title.romaji` best matches the input title (case-insensitive, contains-match), falling back to the first result.
3. Extract `id` (AniList ID).

### 9.2 Episodes

`GET /api/episodes?anilistId={id}` → find `episode.number === Number(episode)` → get `episode.id`.

### 9.3 Sources (iterative, provider-aware)

1. For each provider in Miruro's `providerOrder` whose `player === 'native'` (skip `iframe`/embed providers — they cannot be scraped server-side):
   - `GET /api/sources?episodeId={episode.id}&provider={p}&category=sub` (and `dub` if needed)
2. Normalize the returned source list into `{ url, quality }`:
   - Strip token/query noise; keep `url` as the playable `.m3u8`/`.mp4`/stream URL.
   - Coerce quality to an integer string (`2160/1080/720/480/360`) or `'auto'` when unknown.
3. Map any subtitles to `{ lang, url }`.
4. Return the **first provider** that yields ≥1 playable source (mirroring the pipeline's first-success semantics).

### 9.4 Seamless integration (no pipeline changes)

- Register the adapter in `buildResolverForProvider()` (replacing the fake `buildMiruroResolver()`) so it returns the **normalized internal shape**.
- The existing `normalizeProviderResult()`, `filterSourcesByTier()`, health tracking, retry, and caching all work unchanged.
- Keep `provider: 'miruro'` so the health key and referer registration stay valid.

### 9.5 Guard rails

- **Never crash the pipeline** — all Miruro calls wrapped in try/catch returning `null` on any failure.
- **Do not use JWE** — use the plain `/api/*` JSON path only; if 403/Cloudflare, skip immediately (`PROVIDER_DEGRADED`).
- **Skip embed providers** (`player === 'iframe'`).
- **Cache** the AniList-ID resolution and episode list (TTL ~6h) to minimize hits.

---

## 10. Implementation Plan

### Phase 0 — Gate (do not ship yet)

- ❌ Do **not** set `MIRURO_API_URL` in `.env`.
- ❌ Do **not** enable the current `buildMiruroResolver()` (it targets a 410/404 API).

### Phase 1 — Verify live schema (manual, ~1 day)

- [ ] With a real browser or headless browser + valid Cloudflare cookies, capture the exact JSON of:
  - `GET /api/search?query=attack`
  - `GET /api/episodes?anilistId=<id>`
  - `GET /api/sources?episodeId=<id>&provider=bonk&category=sub`
- [ ] Document the exact Playable URL + quality token shape for each native provider.
- [ ] Confirm whether `filter`/`subtitle`/`skip`/`thumbnail` fields are reusable.

### Phase 2 — Implement adapter (only after Phase 1 confirms schema)

- [ ] Create `services/miruroProvider.js` implementing §9.
- [ ] Add env vars: `MIRURO_API_URL` (default `https://www.miruro.tv`), `MIRURO_ENABLED` (default `false`), optional `MIRURO_PROXY`/referer override.
- [ ] Replace `buildMiruroResolver()` internals to delegate to the adapter; keep the `'miruro'` tag and health key.
- [ ] Add unit tests for the mapper (title→id, source normalization, quality coercion, embed skip).

### Phase 3 — Integrate & observe (opt-in)

- [ ] Set `MIRURO_ENABLED=true` **only** in a staging environment.
- [ ] Keep Miruro **last** in `PROVIDER_ORDER` (it already is, via `getDefaultProviderOrder()`).
- [ ] Monitor health endpoint (`/api/stream/providers` / health stats) for the `miruro` key (403/429/503 rates).
- [ ] Tune the Cloudflare/proxy strategy and `MIRURO_ENABLED` before any production rollout.

### Phase 4 — Production decision

- [ ] Promote to production only if the staging success rate is acceptable (≥ the current Tier-2 hosted-Consumet fallback) and Cloudflare/rate-limit impact is bounded.
- [ ] If embed/iframe providers dominate or 403 persists, **do not ship** — keep Miruro disabled.

**Frontend:** No changes required. The adapter preserves the existing response shape consumed by `watch.js` / player.

---

## 11. Risks & Open Questions

1. **Cloudflare (403)** — highest risk; the SPA's own `/api/secure/jwks` returned 403 to a plain `curl`. Real browser headers/cookies may be required.
2. **JWE encryption** — if the site forces the encrypted `/api/secure/pipe` path for streaming data, a Node.js backend without Web Crypto ECDH-ES cannot consume it. Must confirm the plain path is genuinely available.
3. **Embed providers** — several of the 12 providers are iframe embeds and cannot be scraped server-side; this reduces the effective provider pool.
4. **Source schema unknown** — the exact playable-token shape for native providers is not fully recoverable from the minified bundle; it must be captured live (Phase 1).
5. **Unofficial API** — no SLA; the API can change or break without notice. Miruro must remain a low-priority fallback, never a dependency.
6. **Legal/ToS** — Miruro streams third-party content; verify that scraping its internal API is acceptable for the product's use case/jurisdiction before production.

---

## 12. Conclusion

- The **intended Miruro API does not exist** in the form the current code assumes; the current resolver would fail against the real service (410/404).
- The real Miruro service exposes a **same-origin, unofficial `/api/*` REST API** that is **architecturally mappable** to the internal stream model via a dedicated adapter, but is gated by **Cloudflare, possible JWE, and embed-provider limitations**.
- **Recommended action:** leave Miruro **disabled**; implement the adapter (§9) only after a live schema-capture (Phase 1) confirms a scrapeable plain-JSON, native-provider streaming path. Treat Miruro strictly as a **last-resort fallback**.
