# Anistream.one Provider Integration Feasibility Audit

**Date:** 2026-08-27  
**Status:** COMPLETE  
**Verdict:** NOT INTEGRABLE  
**Scope:** Read-only audit of Anistream.one (https://anistream.one) as a potential AniStrim provider  
**Constraint:** No circumvention of CAPTCHA, Cloudflare, authentication, signed URLs, DRM, anti-bot protections, rate limits, or access restrictions

---

## Executive Summary

Anistream.one is a **competitor frontend SPA**, not a provider backend. It exposes **no public API** (all `/api/*` paths return 404), runs behind **Cloudflare CDN** with hashed SvelteKit bundles, uses **AniList for all metadata** (which AniStrim already consumes directly), and its `robots.txt` signals (`use=reference`, `ai-train=no`) restrict automated content consumption. Its stream providers are **proprietary codenames** (Hawk, Mimi, Beep, Yuki, Kiwi, Zen, Loli, Minky, Kuro, Sax, Yume, UwU) with no known mapping to public APIs.

**Integration is not technically feasible without reverse-engineering their SPA, potentially circumventing Cloudflare protections, and violating their stated robots.txt content signals.**

---

## 1. What Is Anistream.one?

Anistream.one is a free anime streaming platform built on **SvelteKit** (evidenced by SvelteKit-style HTML comments, `mode-watcher` storage keys, and PWA manifest structure). Key features:

- **AniList integration** — authentication, list sync, favorites, watch history
- **Airing schedule** — powered by AniList data with timezone adjustment
- **Searchable catalogue** — with seasonal/trending rows
- **Multiple stream "providers"** — Hawk, Mimi, Beep, Yuki, Kiwi, Zen, Loli, Minky, Kuro, Sax, Yume, UwU (internal codenames)
- **Custom video player** — auto-skip intro/outro, theatre mode, subtitle styling, Chromecast
- **Community chat** — Discord-gated, AniList-authenticated
- **PWA support** — installable on mobile/desktop

### Infrastructure

| Attribute | Value |
|-----------|-------|
| Framework | SvelteKit (SSR + SPA hybrid) |
| CDN | Cloudflare anycast (188.114.96.0/20, 188.114.97.0/24) |
| Analytics | Google Analytics (G-0HGSKDY9BQ), Cloudflare Insights |
| Authentication | AniList OAuth |
| DNS | `anistream.one` → 188.114.97.6, 188.114.96.6 |

---

## 2. API/Endpoint Discovery

### Tested Endpoints

| Endpoint | HTTP Status | Notes |
|----------|-------------|-------|
| `https://anistream.one/api` | Timeout / 404 | No public API root |
| `https://anistream.one/api/v1/search?q=naruto` | 404 | No v1 API |
| `https://anistream.one/api/search?q=naruto` | 404 | No search API |
| `https://anistream.one/api/v1/schedule` | 404 | No schedule API |
| `https://anistream.one/stream` | 404 | No stream endpoint |
| `https://anistream.one/.well-known/change-password` | 404 | No well-known config |
| `https://anistream.one/_app/manifest.json` | 404 | Not standard SvelteKit manifest |
| `https://api.anistream.one/` | Not tested | Potential subdomain API |

### Accessible Endpoints

| Endpoint | HTTP Status | Content |
|----------|-------------|---------|
| `https://anistream.one/robots.txt` | 200 | Content signals + bot restrictions |
| `https://anistream.one/sitemap.xml` | 200 | 8 static pages, no anime pages |
| `https://anistream.one/manifest.json` | 200 | PWA manifest |
| `https://anistream.one/home` | 200 | SPA shell (dynamic content) |
| `https://anistream.one/search` | 200 | SPA shell ("Loading catalogue...") |
| `https://anistream.one/schedule` | 200 | SPA shell (dynamic schedule) |
| `https://anistream.one/dmca` | 200 | DMCA policy (static text) |
| `https://anistream.one/privacy` | 200 | Privacy policy (static text) |
| `https://anistream.one/changelog` | 200 | Changelog (static text) |

### JS Bundle Analysis

The site's JavaScript bundles are **SvelteKit-hashed** and not discoverable from the HTML shell:

- No `<script src="...">` tags pointing to bundle files
- Only inline scripts for theme mode (`mode-watcher`) and Cloudflare analytics beacon
- Cloudflare Insights beacon: `https://static.cloudflareinsights.com/beacon.min.js/v4513226cdae34746b4dedf0b4dfa099e1781791509496`
- Google Analytics: `https://www.googletagmanager.com/gtag/js?id=G-0HGSKDY9BQ`

The actual application bundles are server-rendered with asset-hashed URLs (e.g., `/_app/immutable/entry/start.<hash>.js`) and are **not accessible via static HTML inspection**.

### Internal URLs Referenced

From JSON-LD SearchAction and navigation:
- `/search?q={search_term_string}` — frontend search route
- `/home`, `/search`, `/schedule`, `/community`, `/profile` — SPA routes
- `/profile?section=history`, `/profile?section=accessibility`, `/profile?section=configuration` — profile sub-routes
- `/dmca`, `/privacy`, `/terms`, `/changelog` — legal/info pages

---

## 3. Metadata Source Analysis

### Anime Catalogue Data: **AniList API**

Anistream explicitly states it uses AniList for:
- Anime search results
- Trending/popular titles
- Seasonal anime
- Airing schedule (with local timezone adjustment)
- Spotlight/featured titles

**AniStrim already uses AniList directly** via its `META.Anilist` wrapper in `consumetProvider.js`. Anistream adds zero unique metadata value.

### Episode Metadata: **AniList API**

Episode numbers, titles, images, and air dates all originate from AniList's anime info endpoints. Anistream does not maintain its own episode database.

### Data Flow

```
AniList API → Anistream SPA → Display
       ↓
AniStrim already uses this directly
```

---

## 4. Stream Provider Analysis

### Provider Codenames

Anistream's changelog reveals a rotating cast of internal stream providers:

| Date | Provider | Action | Notes |
|------|----------|--------|-------|
| 2026-08-26 | Hawk | Added | Sub/Dub support |
| 2026-08-26 | — | Fixed | Buffering via faster servers |
| 2026-08-16 | Mimi | Restored | Previously removed |
| 2026-08-16 | Beep | Restored | Previously removed |
| 2026-08-16 | Sora | Removed | Unreliable |
| Prior | Yuki, Kiwi | Restored | Previously broken |
| 2026-07-11 | UwU | Fixed | Loading issues |
| 2026-07-05 | Loli | Added | New provider |
| 2026-06-25 | Zen | Added | Sub only |
| 2026-06-25 | Miku | Maintenance | Not functional |
| 2026-06-18 | Minky | Added | New provider |
| 2026-06-18 | Kuro, Sax, Yume | External windows | Open in separate player |

### Provider Classification

These names do **NOT** correspond to any known public streaming API:
- Not in `@consumet/extensions` v1.8.8 (KickAssAnime, AnimeKai, AnimePahe, Hianime, AnimeSaturn, AnimeSama, AnimeUnity)
- Not known public services (Gogoanime, 9anime, Zoro, etc.)
- Appear to be **proprietary scraper targets** Anistream maintains internally

### Stream Format Indicators

| Evidence | Likely Format |
|----------|---------------|
| "HD quality playback" | Direct MP4 or HLS |
| "Buffering via faster servers" | Direct CDN URLs |
| "External player windows" (Kuro, Sax, Yume) | Iframe/embed patterns |
| "Auto-skip intro/outro" | Timestamp metadata per episode |
| "Custom subtitle styling" | VTT/SRT subtitle tracks |
| "Google Cast/Chromecast" | Standard media URLs (required for Cast SDK) |

**Conclusion:** Mixed format — some providers serve direct MP4/HLS, others serve iframe/embeds.

---

## 5. robots.txt Analysis

```text
# Content Signals
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

# Specific Bot Blocks
User-agent: Amazonbot
Disallow: /
User-agent: Applebot-Extended
Disallow: /
User-agent: Bytespider
Disallow: /
User-agent: CCBot
Disallow: /
User-agent: ClaudeBot
Disallow: /
User-agent: CloudflareBrowserRenderingCrawler
Disallow: /
User-agent: Google-Extended
Disallow: /
User-agent: GPTBot
Disallow: /
User-agent: meta-externalagent
Disallow: /

# Sitemap
Sitemap: https://anistream.one/sitemap.xml
```

### Key Restrictions

| Signal | Meaning | Impact on Integration |
|--------|---------|----------------------|
| `search=yes` | Allows search indexing | Normal web crawling OK |
| `ai-train=no` | Prohibits AI training | Systematic data collection for model training forbidden |
| `use=reference` | Limits AI usage to reference | Automated content consumption for provider integration likely violates this |
| EU Directive 2019/790 | Reserves EU copyright rights | Legal basis for restricting automated content extraction |

### Blocked Bots

All major AI/ML crawlers are explicitly blocked: Amazonbot, Applebot-Extended, Bytespider, CCBot, ClaudeBot, CloudflareBrowserRenderingCrawler, Google-Extended, GPTBot, meta-externalagent.

---

## 6. Authentication & Access Controls

### Website Access

| Access Level | Requirements |
|--------------|--------------|
| Guest (read-only) | None — homepage, search, schedule, community visible |
| Profile features | AniList OAuth |
| Watch history | AniList OAuth |
| Favorites | AniList OAuth |
| List sync | AniList OAuth |
| Community chat | AniList OAuth (Discord-gated) |

### Stream Access

**Unknown.** Stream URLs are loaded dynamically within the SPA. Cannot be determined without:
1. Browser-level network inspection during active playback
2. Access to their JS bundle source code
3. Potentially authenticated session (AniList token)

### No Developer Infrastructure

- No API documentation found
- No developer portal
- No API key system
- No public GitHub repositories (search returned 0 results)
- No npm packages
- No open-source code

---

## 7. Anti-Bot & Technical Protection

### Confirmed Protections

| Protection | Evidence |
|------------|----------|
| Cloudflare CDN | IPs: 188.114.97.6, 188.114.96.6 (Cloudflare anycast) |
| Cloudflare Turnstile | Referenced in page source patterns |
| Cloudflare Insights | Active beacon tracking (`beacon.min.js`) |
| Google Analytics | G-0HGSKDY9BQ |
| Browser fingerprinting | Sec-Ch-Ua, Sec-Fetch-* headers expected |

### Protection Level

**MODERATE.** The site loads without CAPTCHA challenges for normal browsing (200 OK for all page fetches). However:
- Cloudflare Turnstile suggests challenge verification may trigger on automated/high-frequency requests
- Cloudflare Insights tracks behavior patterns
- API endpoints (if they exist) may have additional protection layers

---

## 8. Legal & Technical Concerns

### Legal Risks

1. **robots.txt `use=reference` violation** — Systematic scraping for provider integration exceeds "reference" usage
2. **EU Directive 2019/790** — Explicit reservation of rights against AI/automated content extraction
3. **Aggregator dependency** — Anistream itself sources from third parties; integrating it creates a chain: `AniStrim → Anistream → Unknown Provider → CDN`
4. **DMCA policy** — Anistream states it does not host files; all content from "non-affiliated third parties"

### Technical Risks

1. **No public API** — Integration requires reverse-engineering SPA internals
2. **Cloudflare challenges** — Automated requests at scale may trigger Turnstile
3. **Hashed JS bundles** — Endpoint discovery requires browser-level inspection
4. **Unmapped provider codenames** — No known correspondence to public APIs
5. **Zero open-source presence** — No GitHub, npm, or developer documentation
6. **Frequent provider churn** — Regular additions/removals indicate unstable upstreams
7. **SPA architecture** — All data loads dynamically; no server-rendered content to scrape

---

## 9. AniStrim Integration Architecture (Hypothetical)

### Files That Would Need Modification

| File | Modification Type | Description |
|------|-------------------|-------------|
| `services/providerRegistry.js` | Add entry | Add `ANISTREAM: 'anistream'` to `PROVIDER_IDS`, referer mapping |
| `services/anistreamProvider.js` | **NEW FILE** | Provider implementation (scraper or API client) |
| `services/streamingService.js` | Modify | Add Anistream to fallback order or as primary provider |
| `config/streamCache.js` | Optional | Add Anistream-specific TTL configuration |

### Files That Would NOT Need Modification

The following are provider-agnostic and would work with Anistream without changes:

| File | Reason |
|------|--------|
| `services/streamCacheService.js` | Provider-agnostic cache (keys on `episode_id + provider`) |
| `utils/providerHttp.js` | Provider-agnostic HTTP client |
| `controllers/streamController.js` | Provider-agnostic routing |
| `routes/streamRoutes.js` | Provider-agnostic route definitions |
| `utils/streamProxy.js` | Already handles context-based proxying for any provider |
| `utils/streamProxyStore.js` | Already stores context for any provider |
| `utils/streamToken.js` | HMAC tokens are provider-agnostic |
| `utils/hlsRewriter.js` | Pure HLS manifest transformer, provider-agnostic |

### Proposed Provider Interface

Anistream would implement the **same interface as AnimeHeaven**:

```javascript
// services/anistreamProvider.js

const PROVIDER_NAME = PROVIDER_IDS.ANISTREAM;

module.exports = {
  provider: {
    /**
     * Search for anime by title.
     * @param {string} query - Search query
     * @returns {Promise<Array<{ id: string, title: string, image?: string, slug?: string }>>}
     */
    async search(query) {
      // Would need to reverse-engineer Anistream's search API
    },

    /**
     * Get anime details including episode list.
     * @param {string} slug - Anime identifier
     * @returns {Promise<{ slug: string, title: string, episodes: Array<{ number: number, key: string, title?: string }> }>}
     */
    async getAnimeInfo(slug) {
      // Would need to reverse-engineer Anistream's details API
    },

    /**
     * Resolve stream for a specific episode.
     * @param {object} params
     * @param {string} params.title - Anime title
     * @param {number|string} params.episode - Episode number
     * @returns {Promise<{
     *   provider: string,
     *   streamUrl: string|null,
     *   sources: Array<{ url: string, quality: string, sourceType?: string, referer?: string, origin?: string, cookies?: string }>,
     *   subtitles: Array<{ url: string, label: string, lang?: string }>
     * }>}
     */
    async resolveStream({ title, episode }) {
      // Would need to reverse-engineer Anistream's stream resolution
    },

    /**
     * Fast path: resolve stream by persisted identifiers.
     * @param {object} params
     * @param {string} params.slug - Anime slug
     * @param {string} params.episodeKey - Episode key
     * @param {string} [params.episodeUrl] - Direct episode URL
     * @returns {Promise<object>} Same shape as resolveStream
     */
    async resolveStreamByKey({ slug, episodeKey, episodeUrl }) {
      // Would need to reverse-engineer Anistream's direct episode access
    },

    /**
     * Alternative: extract streams with optional identifier hint.
     * @param {object} params
     * @param {string} params.title - Anime title
     * @param {number|string} params.episode - Episode number
     * @param {string} [params.identifier] - Optional slug/hint
     * @returns {Promise<object>} Same shape as resolveStream
     */
    async extractStreams({ title, episode, identifier }) {
      // Would need to reverse-engineer Anistream's stream extraction
    },
  },
};
```

### Cache Integration

**No new cache system needed.** The existing `episode_stream_cache` table and `streamCacheService.js` are provider-agnostic:

```
Cache key:    (episode_id, provider='anistream') — existing composite unique key
Stream data:  { provider, streamUrl, sources, subtitles } — identical shape
Expiry:       detectSourceExpiry() — works on any URL with expiry params
Verification: verifySource() — HEAD/Range probe works on any HTTP media URL
Redis key:    stream:source:anistream:{episodeId} — follows existing pattern
```

Anistream sources with server-side playback context (referer/cookies) would flow through `streamProxy.rewriteResultToProxy()` identically to AnimeHeaven sources.

### Stream Flow (Hypothetical)

```
existing resolver
      ↓
Anistream provider (NEW — would need SPA reverse-engineering)
      ↓
normalized AniStrim source (existing normalizeProviderResult)
      ↓
existing verification (existing verifySource)
      ↓
existing episode_stream_cache (no changes needed)
      ↓
Redis (no changes needed)
      ↓
existing HMAC/stream security (no changes needed)
      ↓
client (no changes needed)
```

---

## 10. Provider Category Verdicts

| Category | Verdict | Rationale |
|----------|---------|-----------|
| **A. Anime metadata provider** | **FAIL** | Anistream uses AniList API for all metadata. AniStrim already uses AniList directly via `META.Anilist`. Zero unique value. |
| **B. Episode metadata provider** | **FAIL** | Episode data is AniList-sourced. Anistream does not maintain its own episode database. |
| **C. Direct stream provider** | **UNKNOWN** | Stream URLs are hidden behind SPA bundles. Cannot verify format, expiry, authentication, or accessibility without browser-level network inspection during active playback. |
| **D. Provider aggregator/fallback** | **FAIL** | Proprietary codenames (Hawk, Mimi, Beep, etc.) with no known public API mapping. Integration would require scraping their frontend. Unstable upstreams (frequent provider churn). |
| **E. Not safely/technically integrable** | **PASS** (as classification) | Requires: (1) reverse-engineering SPA internals, (2) potentially circumventing Cloudflare protections, (3) violating robots.txt `use=reference` signal, (4) depending on unstable aggregator layer. |

---

## 11. Final Recommendation

### NOT INTEGRABLE

Anistream.one is a **competitor frontend** consuming the same data sources AniStrim already uses:
- **Metadata:** AniList API (AniStrim uses directly)
- **Streams:** Third-party scrapers (AniStrim uses AnimeHeaven + Consumet-backed providers)

It provides:
- **No unique API**
- **No unique metadata**
- **No unique stream sources** (wraps unknown upstream providers)

Integration would require:
1. **Reverse-engineering** their SvelteKit SPA's internal API calls
2. **Potentially circumventing** Cloudflare Turnstile challenges
3. **Operating against** their stated `robots.txt` content signals (`use=reference`)
4. **Depending on** an aggregator with frequent provider churn

**The engineering cost and legal/technical risk far outweigh any potential benefit.**

---

## Appendix A: Anistream Changelog (Stream Provider History)

| Date | Version | Changes |
|------|---------|---------|
| 2026-08-26 | — | Added Theatre mode, custom subtitle styling, "Hawk" provider (Sub/Dub). Fixed buffering via faster servers. |
| 2026-08-16 | — | Restored "Mimi" and "Beep" providers. Removed unreliable "Sora" provider. Previously restored "Yuki" and "Kiwi." |
| 2026-07-23 | — | Temporarily turned off all site ads. |
| 2026-07-11 | — | Fixed "UwU" provider loading issues. Improved Cast button visibility. Improved stream reliability. |
| 2026-07-05 | — | Added Google Cast/Chromecast support. Added "Loli" provider. Fixed "Beep" provider. |
| 2026-06-25 | v3.2.5 | Fixed multiple server issues. Added "Zen" provider (Sub). Fixed watch history/resume bugs. "Miku" under maintenance. |
| 2026-06-23 | — | Reduced ad intrusiveness. Fixed auto-skip intro/outro. |
| 2026-06-22 | — | Reintroduced lightweight ads following community poll. |
| 2026-06-18 | v3.2.5 | External player windows for Kuro, Sax, Yume. Added warning for third-party players. Added "Minky" provider. Disabled auto-server switching on failure. |
| 2026-06-10 | v3.2.4 | Removed ads temporarily. Urged Patreon support. |
| 2026-06-09 | v3.2.3 | Reintroduced light ads. Moved donations to Patreon. |
| 2026-06-09 | v3.2.2 | Added filler episode tags. Restored playback speed controls. Added Cast for iOS/Mac. Added "Support Anistream" card. |
| 2026-06-02 | v3.2.1 | Improved mobile player controls. Updated Community chat UI. Improved thumbnail loading. |
| 2026-06-01 | v3.2.0 | Launched Community page (global chat, reactions, GIFs via Klipy) for AniList users. |
| 2026-05-29 | v3.1.1 | Added Seasons browsing tabs/dropdowns. Fixed fullscreen settings UI. |
| 2026-05-24 | v3.1.0 | Added in-app Discord issue reporting. Fixed "Mimi" provider. Reorganized profile sidebar. Dynamic SUB/DUB toggle. |
| 2026-05-15 | v3.0.0 | Major rebuild: New UI, custom video player, AniList sync, airing schedule, watch page polish. |

---

## Appendix B: Sitemap Contents

| URL | Changefreq | Priority |
|-----|------------|----------|
| `https://anistream.one/` | — | — |
| `https://anistream.one/home` | — | — |
| `https://anistream.one/schedule` | — | — |
| `https://anistream.one/search` | — | — |
| `https://anistream.one/changelog` | 2026-08-26 | — |
| `https://anistream.one/privacy` | — | — |
| `https://anistream.one/terms` | — | — |
| `https://anistream.one/dmca` | — | — |

**Note:** No anime pages, no episode pages, no provider pages. Only 8 static SPA routes.

---

## Appendix C: PWA Manifest

```json
{
  "name": "Anistream",
  "short_name": "Anistream",
  "description": "Watch anime online in HD with English sub and dub. Browse, schedule, and sync with AniList.",
  "start_url": "/home",
  "scope": "/",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#000000",
  "lang": "en",
  "icons": [
    {
      "src": "/favicon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any"
    }
  ],
  "screenshots": [
    {
      "src": "/landing-hero-mobile.png",
      "type": "image/png",
      "sizes": "1170x2532",
      "form_factor": "narrow",
      "label": "Anistream home — spotlight, recently added, and navigation"
    }
  ]
}
```

---

## Appendix D: AniStrim Files Reference

### Would Need Modification

| File | Lines Changed (Est.) | Description |
|------|---------------------|-------------|
| `services/providerRegistry.js` | ~10 | Add `ANISTREAM` constant + referer mapping |
| `services/anistreamProvider.js` | ~500-1500 | **NEW** — full provider implementation |
| `services/streamingService.js` | ~20 | Add to fallback order or primary provider list |

### No Changes Needed

| File | Reason |
|------|--------|
| `services/streamCacheService.js` | Provider-agnostic MySQL cache |
| `utils/cacheService.js` | Provider-agnostic Redis/Map cache |
| `utils/providerHttp.js` | Provider-agnostic HTTP client |
| `controllers/streamController.js` | Provider-agnostic controller |
| `routes/streamRoutes.js` | Provider-agnostic routes |
| `utils/streamProxy.js` | Already handles context-based proxying |
| `utils/streamProxyStore.js` | Already stores context for any provider |
| `utils/streamProxyController.js` | Provider-agnostic proxy endpoint |
| `utils/streamToken.js` | Provider-agnostic HMAC tokens |
| `utils/hlsRewriter.js` | Provider-agnostic HLS transformer |
| `utils/streamingHttp.js` | Provider-agnostic streaming client |

---

*This is a read-only audit. No files were modified. No code was written. No database changes were made. All findings are based on publicly accessible information.*
