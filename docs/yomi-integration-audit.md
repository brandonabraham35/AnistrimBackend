# Yomi.to Provider Integration Feasibility Audit

**Date:** 2026-08-27  
**Status:** COMPLETE  
**Verdict:** CONDITIONALLY INTEGRABLE (as stream fallback only)  
**Scope:** Read-only audit of Yomi.to (https://yomi.to) as a potential AniStrim provider  
**Constraint:** No circumvention of CAPTCHA, Cloudflare, authentication, signed URLs, DRM, anti-bot protections, rate limits, or access restrictions

---

## Executive Summary

Yomi.to is a **Next.js-based anime streaming SPA** that aggregates content from **six third-party embed providers** (MegaPlay, Anilink, TryEmbed, Cinextream, Nontongo, 4Animo). It uses **AniList GraphQL** for metadata (same as AniStrim), **Jikan API** as a fallback metadata source, and **iframe embeds** for all streams. Yomi has its own authentication system, watch party feature, and skip-times API.

**Yomi is conditionally integrable as a stream fallback provider** — not as a metadata source (AniStrim already uses AniList directly). The stream providers are accessible via predictable iframe URL patterns using AniList IDs, which AniStrim already has. However, integration carries moderate legal risk (robots.txt restrictions, Cloudflare protection, third-party embed dependency chain).

---

## 1. Website Architecture

### Framework & Hosting

| Attribute | Value | Confidence |
|-----------|-------|------------|
| Framework | Next.js (App Router) | HIGH — `self.__next_f.push`, RSC payload, `/_next/static/` paths |
| Build ID | `3fsLUdA1u0-AqQHv5JZub` | HIGH — from RSC manifest |
| Rendering | SSR + SPA hybrid (Next.js App Router) | HIGH — server-serialized RSC + client hydration |
| CDN | Cloudflare anycast | HIGH — IPs: 104.21.52.214, 172.67.204.27 |
| CSS | Tailwind CSS | HIGH — `tw-merge`, `clsx` utilities in bundles |
| Icons | Lucide React | HIGH — SVG icon components in bundle |
| Analytics | Cloudflare Insights, Google Tag Manager | HIGH — beacon scripts present |
| Ad Network | `aqle3.com`, `obvioussecretive.com` | HIGH — ad injection code found |

### URL Patterns

| Route | Pattern | Example | Status |
|-------|---------|---------|--------|
| Homepage | `/` | `https://yomi.to/` | 200 |
| Browse | `/browse?sort={sort}&genre={genre}&format={format}` | `/browse?sort=TRENDING_DESC` | 200 |
| Search | `/search?q={query}` | `/search?q=one+piece` | 200 |
| Anime Detail | `/anime/{slug}-{id}` | `/anime/cowboy-bebop-1` | 200 |
| Watch/Player | `/watch/{slug}-{id}/{episode}` | `/watch/cowboy-bebop-1/1` | 200 |
| Seasonal | `/seasonal?season={season}&year={year}` | `/seasonal?season=summer&year=2026` | 200 |
| Schedule | `/schedule` | `https://yomi.to/schedule` | 200 |
| Top | `/top` | `https://yomi.to/top` | 200 |
| Watchlist | `/watchlist` | `https://yomi.to/watchlist` | 200 (auth required for content) |
| Profile | `/profile` | `https://yomi.to/profile` | 200 |
| Awards | `/awards` | `https://yomi.to/awards` | 200 |

### Slug Generation

```
Title priority: english > romaji > native
1. Unicode NFKD normalization
2. Remove diacritics ([\u0300-\u036f])
3. Lowercase
4. Replace non-alphanumeric with hyphens ([^a-z0-9]+ → -)
5. Trim leading/trailing hyphens
6. Slice to max 60 characters
7. Remove trailing hyphens
8. Fallback: "anime"
```

Example: `"One Piece"` → `"one-piece"`, `"Cowboy Bebop"` → `"cowboy-bebop"`

### Key Finding: Dev URL in User-Agent

The AniList GraphQL client sends this User-Agent:
```
Mozilla/5.0 (compatible; Yomi/1.0; +https://yomi-28.pages.dev)
```

This references a **Cloudflare Pages dev URL** (`yomi-28.pages.dev`), suggesting Yomi is deployed on Cloudflare Pages and this is their 28th deployment iteration.

---

## 2. Public API

### Internal API Endpoints (Discovered)

| URL | Method | Auth | Purpose | Status | Classification |
|-----|--------|------|---------|--------|----------------|
| `/api/presence` | POST | Session | Presence ping | 405 (GET blocked) | INTERNAL ENDPOINT |
| `/api/skip?malId={id}&episode={ep}` | GET | None | Skip times (OP/ED timestamps) | 200 | PUBLIC UNDOCUMENTED ENDPOINT |
| `/api/party` | POST | Session | Create watch party room | Unknown | AUTHENTICATED ENDPOINT |
| `/api/party/{code}?memberId={id}` | GET | Session | Get watch party state | Unknown | AUTHENTICATED ENDPOINT |
| `/api/party/{code}` | POST | Session | Join/leave/chat/update playback | Unknown | AUTHENTICATED ENDPOINT |
| `/api/report` | POST | Session | Report broken stream | Unknown | AUTHENTICATED ENDPOINT |
| `/api/auth/signup` | POST | None | User registration | Unknown | PUBLIC UNDOCUMENTED ENDPOINT |
| `/api/auth/signin` | POST | None | User login | Unknown | PUBLIC UNDOCUMENTED ENDPOINT |
| `/api/auth/me` | GET | Session | Current user session | Unknown | AUTHENTICATED ENDPOINT |
| `/api/auth/signout` | POST | Session | User logout | Unknown | AUTHENTICATED ENDPOINT |
| `/id-map.json` | GET | None | MAL ↔ AniList ID mapping | 200 (523KB JSON) | PUBLIC UNDOCUMENTED ENDPOINT |

### External API Dependencies

| API | URL | Purpose | Classification |
|-----|-----|---------|----------------|
| AniList GraphQL | `POST https://graphql.anilist.co` | Primary metadata source | PUBLIC DOCUMENTED API |
| Jikan API | `GET https://api.jikan.moe/v4` | Fallback metadata (MAL) | PUBLIC DOCUMENTED API |

### Skip Times API Response Format

```json
{
  "op": { "startTime": 57.397, "endTime": 145.737 },
  "ed": { "startTime": 1357.923, "endTime": 1480 },
  "recap": null
}
```

This matches the AniSkip API format exactly (https://api.aniskip.com).

### No Official API Documentation

- No `/api/docs`, `/swagger`, `/graphql`, or developer portal found
- No OpenAPI/Swagger specification
- No publicly documented API for third-party integration

---

## 3. Anime Metadata

### Primary Source: AniList GraphQL

Yomi queries `https://graphql.anilist.co` directly for:

- Anime search (`searchAnime`)
- Trending anime (`getTrending`)
- Seasonal anime (`getSeasonal`)
- Anime details (`getAnimeEntry`) — includes tags, trailer, external links, streaming episodes, relations, recommendations, characters, staff
- Random anime (`getRandomAnime`)
- Airing schedule (`getAiringSchedule`)
- Character details (`getCharacter`)
- Browse with filters (genre, sort, format, status, season, year, tag)

**AniStrim already uses AniList** via its `META.Anilist` wrapper in `consumetProvider.js`. Yomi provides **zero unique metadata value**.

### Fallback Source: Jikan API (MyAnimeList)

When AniList fails, Yomi falls back to Jikan API (`https://api.jikan.moe/v4`) for:
- Search: `/anime?q={query}&limit={limit}&sfw=true&order_by=popularity&sort=asc`
- Top anime: `/top/anime?limit={limit}&filter=bypopularity`
- Top airing: `/top/anime?limit={limit}&filter=airing`
- Current season: `/seasons/now?limit={limit}`
- Upcoming: `/seasons/upcoming?limit={limit}`
- Specific anime: `/anime/{id}`
- Episode lists: `/anime/{malId}/episodes?page={page}`

### ID Mapping

Yomi maintains a 523KB JSON file (`/id-map.json`) mapping MAL IDs ↔ AniList IDs:
```json
{ "fwd": { "762": 154037, "973": 20562, ... } }
```

This is cached in `localStorage` as `yomi_mal_anilist_map` and `yomi_anilist_mal_map`.

### Client-Side Caching

API responses are cached in `localStorage` with keys prefixed by `yomi_cache_v1_`. Cache expiry is based on airing times (`airingAt`, `nextAiringEpisode`).

### Verdict

**FAIL** — Yomi's metadata is entirely derived from AniList (primary) and Jikan/MAL (fallback). AniStrim already uses AniList directly and has Consumet-backed providers for MAL data. No unique metadata value.

---

## 4. Episode Metadata

### Episode Identification

Yomi uses a **compound identifier** for episodes:
- **Anime:** `{slug}-{id}` where `id` is the **AniList ID**
- **Episode:** episode number (integer)
- **Full watch URL:** `/watch/{slug}-{anilist-id}/{episode-number}`

Example: `/watch/cowboy-bebop-1/1` where `1` is the AniList ID for Cowboy Bebop and `1` is episode 1.

### Episode Data Sources

1. **AniList GraphQL** — episode count, airing status, next airing episode
2. **Jikan API** — episode titles, air dates, fillers (`/anime/{malId}/episodes?page={page}`)
3. **Local storage** — `yomi_progress` tracks watch progress per anime/episode
4. **Skip times API** — OP/ED timestamps per episode (via `/api/skip?malId={id}&episode={ep}`)

### Episode Features

- **Filler Guide:** Episodes marked as Canon, Filler, or Recap (from Jikan)
- **Skip Timestamps:** Community-sourced OP/ED timestamps (from AniSkip-format API)
- **Watch Progress:** Local tracking of episode completion
- **Episode Order:** User-configurable ascending/descending (`yomi_ep_order`)

### Stable Identifiers

- **AniList ID** — stable, numeric, publicly accessible
- **Episode number** — stable, integer
- **MAL ID** — stable, mapped via `/id-map.json`

### Verdict

**FAIL** — Episode metadata is derived from AniList + Jikan, both already accessible to AniStrim. Yomi adds no unique episode data.

---

## 5. Stream Sources

### Critical Discovery: Six Embed Providers

Yomi does **NOT host streams directly**. It uses iframe embeds from six third-party providers:

| Server # | Name | Base URL | URL Pattern (AniList) | URL Pattern (MAL) |
|----------|------|----------|----------------------|-------------------|
| 1 | MegaPlay / MegaCloud | `https://megaplay.buzz` | `/stream/ani/{animeId}/{episode}/{lang}?t={startTime}` | `/stream/mal/{malId}/{episode}/{lang}?t={startTime}` |
| 2 | Anilink / VidCloud | `https://anilink.cc` | `/watch/{animeId}/{episode}?variant={lang}&autoplay=1` | N/A |
| 3 | TryEmbed | `https://tryembed.us.cc` | `/embed/anime/{animeId}/{episode}/{lang}?t={startTime}` | N/A |
| 4 | Cinextream | `https://cinextream.cc` | `/api/embed/anime/{lang}/{animeId}/{episode}?color=7c6ee0` | N/A |
| 5 | Nontongo | `https://nontongo.win` | `/anime/{animeId}/{episode}/play` | N/A |
| 6 | 4Animo | `https://cdn.4animo.xyz` | `/embed/ani/{animeId}/{episode}/{lang}` | N/A |

### URL Construction Logic

```javascript
// Server ID → embed URL
function buildEmbedUrl(server, animeId, episode, lang, startTime, malId) {
  switch (server) {
    case 1: // MegaPlay
      return malId
        ? `https://megaplay.buzz/stream/mal/${malId}/${episode}/${lang}?t=${startTime}`
        : `https://megaplay.buzz/stream/ani/${animeId}/${episode}/${lang}?t=${startTime}`;
    case 2: // Anilink
      return `https://anilink.cc/watch/${animeId}/${episode}?variant=${lang}&autoplay=1`;
    case 3: // TryEmbed
      return `https://tryembed.us.cc/embed/anime/${animeId}/${episode}/${lang}?t=${startTime}`;
    case 4: // Cinextream
      return `https://cinextream.cc/api/embed/anime/${lang}/${animeId}/${episode}?color=7c6ee0`;
    case 5: // Nontongo
      return `https://nontongo.win/anime/${animeId}/${episode}/play`;
    case 6: // 4Animo
      return `https://cdn.4animo.xyz/embed/ani/${animeId}/${episode}/${lang}`;
  }
}
```

### Player Implementation

- **Iframe-based** — all providers load via `<iframe>` elements
- **Message passing** — parent listens for `window.postMessage` events:
  - `timeupdate` — playback progress
  - `complete` — episode finished
  - `error` — playback error
  - `anilink-player:*` — provider-specific events
- **No direct video.js/hls.js/plyr** — playback delegated entirely to embed providers

### Default Server Order

`[1, 3, 2, 4, 6, 5]` — MegaPlay → TryEmbed → Anilink → Cinextream → 4Animo → Nontongo

User's last-used server is stored in `localStorage` key `yomi_server`.

### Language Support

- **Sub** (`lang = "sub"`) — default
- **Dub** (`lang = "dub"`) — toggle via `yomi_dub_mode` localStorage

### Stream Source Chain

```
Yomi.to → Embed Provider (megaplay.buzz / anilink.cc / etc.) → Actual CDN/Host → Video file
```

Yomi is a **two-hop aggregator** — it doesn't host or even directly resolve streams. It simply embeds third-party iframe players.

### Verdict

**CONDITIONAL PASS** — Stream URLs are constructible using AniList IDs (which AniStrim has). However, streams are iframe embeds from third-party providers, not direct MP4/HLS URLs. AniStrim's player is designed for direct stream URLs (via its proxy system), not iframe embeds. Integration would require significant player changes.

---

## 6. Stream Format

### Format: **IFRAME EMBED** (all providers)

All six providers deliver content via iframe embeds. The actual video format inside the iframe is **unknown** (likely a mix of HLS `.m3u8` and MP4, handled by each provider's internal player).

### What Each Provider Likely Serves

| Provider | Likely Format | Evidence |
|----------|---------------|----------|
| MegaPlay | HLS/MP4 (proprietary player) | `/stream/` path, supports `?t=` timestamp |
| Anilink | HLS/MP4 (custom player) | `/watch/` path, `?variant=` param |
| TryEmbed | HLS/MP4 (embed player) | `/embed/` path, `?t=` timestamp |
| Cinextream | HLS/MP4 (API-driven embed) | `/api/embed/` path |
| Nontongo | HLS/MP4 (direct play page) | `/play` path |
| 4Animo | HLS/MP4 (CDN embed) | `cdn.` subdomain, `/embed/` path |

### Not Directly Playable in AniStrim

AniStrim's architecture expects **direct stream URLs** (MP4 or HLS) that flow through its server-side proxy system (`streamProxy.rewriteResultToProxy()`). Yomi's iframe embeds **cannot** be proxied through this system — they are full HTML pages with their own JavaScript players.

### Verdict

**IFRAME EMBED** — not directly compatible with AniStrim's proxy-based stream pipeline.

---

## 7. Source Expiry

### Observable Parameters

| Parameter | Providers Using It | Format |
|-----------|-------------------|--------|
| `?t={startTime}` | MegaPlay, TryEmbed | Unix timestamp or seconds offset |

The `t` parameter in MegaPlay and TryEmbed URLs appears to be a **start time** (for resuming playback), not an expiry token. No explicit `expires`, `exp`, `sig`, `token`, or `policy` parameters were observed in the URL patterns.

### Unknown

Since the actual stream URLs exist inside iframe sandboxes, the outer embed URL is the only observable layer. The inner video CDN URLs (`.m3u8` / `.mp4`) are hidden inside the iframe's origin and cannot be observed without embedding and inspecting the iframe's network traffic.

### Verdict

**UNKNOWN** — No expiry information observable from embed URLs alone. Inner stream URLs are hidden inside iframe sandboxes.

---

## 8. Proxy Requirements

### Classification

| Component | Classification | Rationale |
|-----------|---------------|-----------|
| AniList GraphQL | DIRECT HTTP | Public API, no anti-bot measures observed |
| Jikan API | DIRECT HTTP | Public API, rate-limited but accessible |
| `/id-map.json` | NORMAL SERVER REQUEST | Static JSON file, no protection |
| `/api/skip` | DIRECT HTTP | Returns data without auth |
| Embed iframes | BROWSER-ONLY | Require browser rendering (iframe) |
| Inner stream URLs | UNKNOWN | Hidden inside iframe sandbox |
| `/api/auth/*` | AUTHENTICATED | Requires Yomi user session |
| `/api/party` | AUTHENTICATED | Requires Yomi user session |

### AniStrim Compatibility

AniStrim's existing infrastructure **could theoretically support**:

1. **AniList GraphQL** — already used via `META.Anilist`
2. **Jikan API** — already accessible via `providerHttp`
3. **ID mapping** — could use `/id-map.json` or implement locally

**Cannot support without changes:**

1. **Iframe embeds** — AniStrim's player expects direct stream URLs, not iframes
2. **Embed provider CDN URLs** — hidden inside iframes, cannot be proxied through `streamProxy`
3. **Provider-specific authentication** — unknown whether embed providers require their own auth

### Existing Infrastructure Assessment

| AniStrim Component | Would Work? | Notes |
|-------------------|-------------|-------|
| `utils/providerHttp.js` | YES | Already handles AniList + Jikan |
| `utils/streamProxy.js` | NO | Designed for direct URLs, not iframes |
| `utils/streamingHttp.js` | YES | For direct HTTP, not iframes |
| `utils/hlsRewriter.js` | NO | For HLS manifests, not iframe embeds |
| `utils/streamToken.js` | YES | Auth layer is provider-agnostic |
| `services/streamCacheService.js` | PARTIAL | Could cache embed URLs, but not inner streams |

### Verdict

**PROXY NOT REQUIRED for metadata** (AniList/Jikan already accessible). **BROWSER RENDERING REQUIRED for streams** (iframe embeds). AniStrim's proxy architecture is not designed for iframe embeds.

---

## 9. Robots / Terms / Access Restrictions

### robots.txt

```text
# Content Signals
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

# Specific Bot Blocks (identical to Anistream)
User-agent: Amazonbot, Applebot-Extended, Bytespider, CCBot, ClaudeBot,
            CloudflareBrowserRenderingCrawler, Google-Extended, GPTBot,
            meta-externalagent, anthropic-ai, PetalBot, SemrushBot,
            AhrefsBot, MJ12bot, DotBot, DataForSeoBot
Disallow: /

# Path Restrictions
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/
Disallow: /watch/
Disallow: /watchlist
Disallow: /profile
Disallow: /settings
Crawl-delay: 10

Sitemap: https://yomi.to/sitemap.xml
```

### Key Restrictions

| Signal | Meaning | Impact |
|--------|---------|--------|
| `search=yes` | Allows search indexing | Normal crawling OK |
| `ai-train=no` | Prohibits AI training | Systematic data collection forbidden |
| `use=reference` | Limits AI usage to reference | Automated integration likely violates this |
| `Disallow: /api/` | Blocks API crawling | API endpoints not intended for public consumption |
| `Disallow: /watch/` | Blocks watch pages | Stream pages noindex |
| `Crawl-delay: 10` | Rate limits crawlers | Max 1 request per 10 seconds |
| EU Directive 2019/790 | Reserves EU copyright rights | Legal basis for restricting automated extraction |

### Disclaimer

Footer states: *"Yomi does not host any video files. Content served by third-party embeds."*

### Terms/Privacy

No readable terms of service or privacy policy found in static pages (likely rendered dynamically).

### Cloudflare Protection

- **CDN:** Cloudflare anycast (104.21.52.214, 172.67.204.27)
- **Insights:** Active Cloudflare Insights beacon
- **Challenges:** No CAPTCHA observed for normal browsing, but Cloudflare Turnstile may trigger on automated/high-frequency requests

### Verdict

**RESTRICTED** — robots.txt explicitly disallows `/api/` crawling, limits AI usage to `reference`, and imposes a 10-second crawl delay. Integration would operate against these signals.

---

## 10. AniStrim Compatibility

### Metadata Layer: Compatible

Yomi's metadata sources (AniList + Jikan) are already accessible to AniStrim:

| Yomi Source | AniStrim Equivalent | Compatible? |
|-------------|-------------------|-------------|
| AniList GraphQL (`graphql.anilist.co`) | `META.Anilist` in `consumetProvider.js` | YES — already used |
| Jikan API (`api.jikan.moe/v4`) | Available via `providerHttp` | YES — accessible |
| `/id-map.json` (MAL↔AniList) | Not currently used | YES — could add |
| Skip times (`/api/skip`) | AniSkip API (`aniskip`) in AniStrim | YES — same format |

### Stream Layer: Incompatible (without significant changes)

| Aspect | Yomi | AniStrim | Compatible? |
|--------|------|----------|-------------|
| Stream format | Iframe embeds | Direct MP4/HLS URLs | NO |
| Proxy support | Cannot be proxied (iframe) | Server-side proxy with cookie/referer injection | NO |
| Player | Provider's own iframe player | hls.js / native `<video>` | NO |
| Authentication | None required for embeds | JWT + HMAC tokens | N/A |
| Stream resolution | URL construction from AniList ID | Scraper → gate → mirrors → nested iframes | Different approach |
| Cache | localStorage `yomi_cache_v1_` | MySQL `episode_stream_cache` + Redis | Different architecture |

### What Would Be Needed for Integration

To integrate Yomi as a stream source, AniStrim would need:

1. **A new provider type** that returns iframe embed URLs instead of direct stream URLs
2. **A player change** to support iframe embeds alongside direct URL playback
3. **A bypass of the proxy system** for iframe sources (or an iframe proxy)
4. **AniList ID to embed URL** mapping logic

### Verdict

**Metadata: PASS** (already compatible). **Streams: CONDITIONAL** (requires iframe support, which AniStrim's architecture does not currently provide).

---

## 11. Files That Would Require Modification

### New Files

| File | Description | Est. Lines |
|------|-------------|------------|
| `services/yomiProvider.js` | NEW — Provider that constructs embed URLs from AniList IDs | ~200-400 |

### Modified Files

| File | Modification | Est. Lines |
|------|-------------|------------|
| `services/providerRegistry.js` | Add `YOMI: 'yomi'` to `PROVIDER_IDS`, add referer mapping | ~10 |
| `services/streamingService.js` | Add Yomi to fallback provider order OR as a separate iframe provider type | ~30-50 |
| `config/streamCache.js` | Add Yomi-specific TTL for embed URLs | ~5 |
| `controllers/streamController.js` | Handle iframe embed URL response shape (different from direct stream) | ~20-40 |
| Web player (`Web/`) | Add iframe embed support alongside hls.js/native player | ~100-200 |
| Frontend/mobile player (`Frontend/`) | Add iframe embed support | ~50-100 |
| Desktop player (`Desktop/`) | Add iframe embed support | ~50-100 |

### No Changes Needed

| File | Reason |
|------|--------|
| `utils/providerHttp.js` | Already handles AniList + Jikan |
| `utils/streamToken.js` | Auth layer is provider-agnostic |
| `utils/hlsRewriter.js` | Not applicable to iframes |
| `routes/streamRoutes.js` | Route structure unchanged |
| `utils/streamProxyStore.js` | Could store iframe context, but not needed for embeds |

---

## 12. Risk Assessment

### Technical Risk: MODERATE

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Embed providers go offline | HIGH | MODERATE (6 providers = redundancy) | Fallback to other providers |
| Embed URL patterns change | HIGH | HIGH (no public API contract) | Regular monitoring, quick provider updates |
| Cloudflare challenges on Yomi | MEDIUM | MODERATE | Use existing proxy rotation |
| Yomi changes ID mapping | MEDIUM | LOW | Regenerate from AniList/MAL directly |
| Iframe embeds blocked by CSP | MEDIUM | LOW | Update CSP headers |

### Legal Risk: MODERATE-HIGH

| Risk | Severity | Rationale |
|------|----------|-----------|
| robots.txt violation | MODERATE | `/api/` disallowed, `use=reference` restriction, `Crawl-delay: 10` |
| EU Directive 2019/790 | MODERATE | Explicit reservation of rights against automated extraction |
| Third-party embed liability | HIGH | Embed providers (megaplay.buzz, anilink.cc, etc.) may host unlicensed content |
| DMCA exposure | HIGH | Yomi itself is a DMCA-shielded aggregator; consuming its embeds creates a chain |
| Dependency on unlicensed sources | HIGH | All six embed providers are unlicensed anime streaming sources |

### Maintenance Risk: HIGH

| Risk | Rationale |
|------|-----------|
| No public API contract | Embed URL patterns can change without notice |
| Six providers to maintain | Each embed URL pattern must be kept up to date |
| No versioning | No API versioning; breaking changes are silent |
| Provider churn | Yomi's own providers change frequently (observed in Anistream audit) |
| Iframe dependency | Browser rendering required; cannot be cached or proxied server-side |

---

## 13. Provider Category Verdict

| Category | Verdict | Rationale |
|----------|---------|-----------|
| Anime metadata provider | **FAIL** | Uses AniList + Jikan — AniStrim already uses both directly |
| Episode metadata provider | **FAIL** | Episode data from AniList + Jikan — already accessible |
| Direct stream provider | **CONDITIONAL PASS** | Provides accessible embed URLs constructible from AniList IDs, but format is iframe embeds (not direct MP4/HLS) |
| Stream fallback provider | **CONDITIONAL PASS** | Six redundant embed providers available, but iframe format incompatible with AniStrim's current player architecture |
| Aggregator/provider gateway | **PASS** | Yomi acts as an aggregator layer that normalizes six embed providers behind a single interface using AniList IDs |
| Legitimate public API | **FAIL** | No documented public API; `/api/` paths are disallowed in robots.txt |
| Technically integrable | **CONDITIONAL** | Metadata layer is trivially integrable; stream layer requires iframe support (significant player changes) |
| Safely integrable | **FAIL** | robots.txt restrictions, EU Directive reservations, unlicensed embed sources, dependency chain liability |

---

## 14. Final Recommendation

### CONDITIONALLY INTEGRABLE — as stream fallback only, with significant caveats

**What works:**
- Metadata sources (AniList + Jikan) are already accessible to AniStrim
- Embed URLs are constructible from AniList IDs (which AniStrim already has)
- Six redundant embed providers offer good coverage
- Skip times API uses the same format as AniStrim's existing AniSkip integration

**What doesn't work:**
- Stream format is iframe embeds, incompatible with AniStrim's direct URL + proxy architecture
- No public API contract — embed URL patterns can break without notice
- robots.txt disallows `/api/` crawling and restricts usage to `reference`
- All embed providers are unlicensed third-party sources
- Integration would require significant player changes (iframe support across Web, Frontend, Desktop)

**Recommendation:** **Do not integrate at this time.** The engineering cost (player rewrite for iframe support), legal risk (robots.txt, unlicensed sources), and maintenance burden (six providers with no API contract) outweigh the marginal benefit of six additional embed fallbacks. AniStrim's existing AnimeHeaven + Consumet-backed provider stack already offers robust stream resolution with direct URL support and server-side proxy security.

---

## 15. Evidence

### Architecture Claims

| Claim | Evidence | Confidence |
|-------|----------|------------|
| Next.js App Router | `self.__next_f.push`, `/_next/static/` paths, RSC payload in HTML | HIGH |
| Cloudflare CDN | DNS: 104.21.52.214, 172.67.204.27 (Cloudflare anycast range) | HIGH |
| SSR + SPA hybrid | Server-serialized RSC payload + client-side hydration | HIGH |
| Tailwind CSS | `tw-merge`, `clsx` utilities in chunk `2201-06ceedf8ae88cf85.js` | HIGH |
| Cloudflare Pages deployment | User-Agent references `yomi-28.pages.dev` | HIGH |

### API Claims

| Claim | URL | HTTP Status | Observation | Confidence |
|-------|-----|-------------|-------------|------------|
| `/api/presence` exists | `POST https://yomi.to/api/presence` | 405 (GET) | Method Not Allowed — confirms POST-only endpoint | HIGH |
| `/api/skip` returns skip times | `GET https://yomi.to/api/skip?malId=1&episode=1` | 200 | Returns `{ op: {...}, ed: {...}, recap: null }` | HIGH |
| `/id-map.json` is 523KB | `GET https://yomi.to/id-map.json` | 200 | MAL↔AniList ID mapping, 523,627 bytes | HIGH |
| AniList GraphQL used | Layout bundle (module 4762) | N/A | `POST https://graphql.anilist.co` with custom User-Agent | HIGH |
| Jikan API used as fallback | Page bundle `page-e5fb3eb655d79dde.js` | N/A | `https://api.jikan.moe/v4` with fallback trigger logic | HIGH |
| `/api/` disallowed in robots.txt | `GET https://yomi.to/robots.txt` | 200 | `Disallow: /api/` + `Disallow: /watch/` + `Crawl-delay: 10` | HIGH |

### Stream Provider Claims

| Claim | Evidence | Confidence |
|-------|----------|------------|
| 6 embed providers | Watch page chunk `page-d2bfb484b9db62f6.js` — `buildEmbedUrl` function | HIGH |
| MegaPlay (server 1) | `https://megaplay.buzz/stream/ani/{id}/{ep}/{lang}?t={t}` | HIGH |
| Anilink (server 2) | `https://anilink.cc/watch/{id}/{ep}?variant={lang}&autoplay=1` | HIGH |
| TryEmbed (server 3) | `https://tryembed.us.cc/embed/anime/{id}/{ep}/{lang}?t={t}` | HIGH |
| Cinextream (server 4) | `https://cinextream.cc/api/embed/anime/{lang}/{id}/{ep}?color=7c6ee0` | HIGH |
| Nontongo (server 5) | `https://nontongo.win/anime/{id}/{ep}/play` | HIGH |
| 4Animo (server 6) | `https://cdn.4animo.xyz/embed/ani/{id}/{ep}/{lang}` | HIGH |
| Default server order | `[1, 3, 2, 4, 6, 5]` in watch page chunk | HIGH |
| Iframe-based player | `<iframe>` elements + `window.postMessage` event handling | HIGH |
| Sub/Dub support | `yomi_dub_mode` localStorage, `lang` parameter in URLs | HIGH |

### URL Pattern Claims

| Claim | Evidence | Confidence |
|-------|----------|------------|
| Anime detail: `/anime/{slug}-{id}` | `e2` function in layout bundle | HIGH |
| Watch page: `/watch/{slug}-{id}/{ep}` | `Lu` function in layout bundle + watch page HTML | HIGH |
| Slug: english > romaji > native, max 60 chars, lowercase, hyphenated | `n` function in layout bundle (slugify logic) | HIGH |

### Metadata Claims

| Claim | Evidence | Confidence |
|-------|----------|------------|
| Primary: AniList GraphQL | Module 4762, `POST https://graphql.anilist.co` | HIGH |
| Fallback: Jikan API | Module 2143, `https://api.jikan.moe/v4` | HIGH |
| ID map: MAL↔AniList | `/id-map.json` (523KB), `yomi_mal_anilist_map` localStorage | HIGH |
| Watch progress: localStorage | `yomi_progress` key | HIGH |
| Episode order: localStorage | `yomi_ep_order` key | HIGH |
| Title language preference | `yomi_title_lang` key | HIGH |
| Watchlist: localStorage | `yomi_animelist` key (migrated from `yomi_watchlist`) | HIGH |
| Theme: localStorage | `yomi_theme` key (dark/light) | HIGH |
| API response caching | `yomi_cache_v1_*` keys with expiry logic | HIGH |

### Comparison to AniStrim

| Claim | Evidence | Confidence |
|-------|----------|------------|
| Yomi uses same AniList source as AniStrim | Both use `META.Anilist` / `graphql.anilist.co` | HIGH |
| Yomi skip times match AniStrim AniSkip format | `/api/skip` returns `{ op, ed, recap }` — same schema as aniskip.com | HIGH |
| Yomi streams are iframe embeds (not direct URLs) | Watch page chunk shows `<iframe>` + `postMessage` pattern | HIGH |
| AniStrim expects direct stream URLs | `streamProxy.rewriteResultToProxy()` operates on `{ url, quality }` source objects | HIGH |

---

## Appendix A: Complete Internal API Summary

| Endpoint | Method | Auth | Response | Purpose |
|----------|--------|------|----------|---------|
| `/api/presence` | POST | Session | Unknown | Presence ping |
| `/api/skip?malId={id}&episode={ep}` | GET | None | `{ op: {start, end}, ed: {start, end}, recap }` | Skip times |
| `/api/party` | POST | Session | Unknown | Create watch party |
| `/api/party/{code}` | GET/POST | Session | Unknown | Join/leave/chat/sync |
| `/api/report` | POST | Session | Unknown | Report broken stream |
| `/api/auth/signup` | POST | None | Unknown | Register user |
| `/api/auth/signin` | POST | None | Unknown | Login user |
| `/api/auth/me` | GET | Session | Unknown | Get current user |
| `/api/auth/signout` | POST | Session | Unknown | Logout user |
| `/id-map.json` | GET | None | `{ fwd: { oldId: newId, ... } }` | MAL↔AniList ID map |

## Appendix B: Embed Provider Details

| Provider | Base URL | Supports AniList ID | Supports MAL ID | Timestamp Param | Language Param | Notes |
|----------|----------|-------------------|-----------------|-----------------|----------------|-------|
| MegaPlay | `megaplay.buzz` | YES (`/stream/ani/`) | YES (`/stream/mal/`) | `?t=` | `/{lang}` | Only provider supporting both ID types |
| Anilink | `anilink.cc` | YES | NO | NO | `?variant=` | `&autoplay=1` |
| TryEmbed | `tryembed.us.cc` | YES | NO | `?t=` | `/{lang}` | Cloudflare Pages subdomain (`.us.cc`) |
| Cinextream | `cinextream.cc` | YES | NO | NO | `/{lang}` (in path) | API-driven embed (`/api/embed/`) |
| Nontongo | `nontongo.win` | YES | NO | NO | NO | `.win` TLD |
| 4Animo | `cdn.4animo.xyz` | YES | NO | NO | `/{lang}` | CDN subdomain |

## Appendix C: Yomi LocalStorage Keys

| Key | Purpose | Example Value |
|-----|---------|---------------|
| `yomi_theme` | Dark/light mode | `"dark"` |
| `yomi_server` | Last used server ID | `1` (MegaPlay) |
| `yomi_dub_mode` | Sub/Dub preference | `"0"` (Sub) or `"1"` (Dub) |
| `yomi_progress` | Watch progress | `{ animeId: 1, episode: 5, timestamp: 120.5 }` |
| `yomi_ep_order` | Episode sort order | `"asc"` or `"desc"` |
| `yomi_animelist` | User's anime list | Synced from AniList |
| `yomi_mal_anilist_map` | MAL→AniList ID map | `{ "1": 1, "20": 20, ... }` |
| `yomi_anilist_mal_map` | AniList→MAL ID map | `{ "1": 1, "20": 20, ... }` |
| `yomi_cache_v1_*` | API response cache | Varies |
| `yomi_title_lang` | Title language pref | `"english"`, `"romaji"`, `"native"` |
| `yomi_party_myid` | Watch party user ID | UUID |
| `yomi_party_myname` | Watch party display name | String |
| `yomi_notify_list` | Notification preferences | Array |

---

*This is a read-only audit. No files were modified. No code was written. No database changes were made. All findings are based on publicly accessible information and normal permitted HTTP/browser behavior.*
