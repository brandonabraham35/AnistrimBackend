# SEO / Sitemap Implementation Audit

**Date:** 2026-08-26
**Scope:** `anistrim.com` — public browser/web frontend (`Web/`) + backend SEO routes

---

## 1. Files Created

None. All SEO infrastructure already existed and was enhanced.

## 2. Files Modified

| File | Change |
|------|--------|
| `controllers/seoController.js` | Added Twitter/X card meta tags to `seoHead()`, added `/search` to sitemap static URLs, added `getSearchSeo` handler + `searchSeoPage()` builder |
| `routes/seoRoutes.js` | Added `GET /search` route → `seo.getSearchSeo` |
| `Web/vercel.json` | Added rewrite for `/search` → backend |
| `Web/index.html` | Added Twitter card meta tags (`twitter:card`, `twitter:title`, `twitter:description`), added `<meta name="language">` |

## 3. Routes Created / Confirmed

| Route | Source | Served Via | Purpose |
|-------|--------|-----------|---------|
| `GET /sitemap.xml` | `seoRoutes.js` → `seoController.getSitemap` | Vercel rewrite → Render backend | Dynamic XML sitemap |
| `GET /robots.txt` | `seoRoutes.js` → `seoController.getRobots` | Vercel rewrite → Render backend | Crawler rules |
| `GET /anime/:id` | `seoRoutes.js` → `seoController.getAnimeSeo` | Vercel rewrite → Render backend | Per-anime SEO page (HTML) |
| `GET /browse` | `seoRoutes.js` → `seoController.getBrowseSeo` | Vercel rewrite → Render backend | Catalogue hub page |
| `GET /search` | `seoRoutes.js` → `seoController.getSearchSeo` | Vercel rewrite → Render backend | Search landing page |

## 4. Sitemap Architecture

**Single-file sitemap** (not split). Rationale:
- Google's limit is 50,000 URLs per sitemap file or 50MB uncompressed
- Current `SITEMAP_MAX_URLS = 40,000` leaves headroom
- AniStrim's catalogue is well under this threshold
- If the catalogue ever exceeds ~40,000 published titles, the sitemap should be split into:
  - `/sitemap.xml` (index file) → references `/sitemap-static.xml` + `/sitemap-anime-1.xml`, etc.

**URLs generated:**
- `/` (homepage)
- `/browse` (catalogue hub)
- `/search` (search landing)
- `/browse?sort=popular` (popular browse)
- `/browse?sort=latest` (latest releases browse)
- `/anime/{id}` for every published anime (is_published = 1), with `<lastmod>` from `updated_at`

**Example generated URLs:**
```
https://anistrim.com/
https://anistrim.com/browse
https://anistrim.com/search
https://anistrim.com/browse?sort=popular
https://anistrim.com/browse?sort=latest
https://anistrim.com/anime/1
https://anistrim.com/anime/2
...
```

**Performance:**
- Single `SELECT id, updated_at FROM anime WHERE is_published = 1 ORDER BY id ASC LIMIT 40000` query
- `Cache-Control: public, max-age=3600` (1-hour cache)
- Query runs only when Google/someone requests `/sitemap.xml` — not on a timer
- Efficient: only fetches `id` and `updated_at`, no full row data

## 5. robots.txt Contents

```
User-agent: *
Allow: /
Disallow: /api/
# Legacy Render-hosted copies of the clients (canonical site is the root)
Disallow: /web
Disallow: /desktop-preview
Disallow: /admin

Sitemap: https://anistrim.com/sitemap.xml
```

**What is allowed:** All public content (`/`, `/browse`, `/search`, `/anime/:id`)
**What is blocked:** `/api/`, `/web/`, `/desktop-preview/`, `/admin/`
**Not blocked:** Public CSS, JS, images (no blanket block on static assets)

## 6. Routing Limitations

### Hash-based SPA (expected limitation)
The Web frontend uses hash routes (`#/anime/5`, `#/browse`). The SEO system works around this by:
1. Serving **separate server-rendered HTML pages** at path-based URLs (`/anime/5`, `/browse`, `/search`) via `seoRoutes.js`
2. Those pages contain real HTML content for crawlers + `<meta http-equiv="refresh">` + JS `location.replace()` to boot humans into the SPA
3. Vercel rewrites path-based URLs to the backend so `https://anistrim.com/anime/5` serves the SEO page, not the SPA shell

### No slug-based URLs
Anime URLs use numeric IDs (`/anime/5`) rather than slugs (`/anime/attack-on-titan`). This is because the database uses integer IDs as the primary key and has no dedicated `slug` column. Adding slugs would require:
- A new `slug` column on the `anime` table
- Slug generation logic (unique, URL-safe, stable)
- Route changes to resolve slugs to IDs
- Migration for existing data

This is a **low-priority enhancement** — numeric IDs are perfectly crawlable and indexable by Google.

### Episode-level pages not indexable
Individual episodes are not separate indexable URLs. The anime detail page (`/anime/:id`) is the canonical SEO unit for a title. Episodes are rendered as `<button>` elements with `onclick` handlers, not `<a href>` links. This is acceptable because:
- Episodes don't have standalone pages in the SPA
- The anime detail page contains all episode metadata
- Google can discover episodes from the anime detail page content

### Browse pagination not in sitemap
The browse page supports pagination (`/browse?page=2`), but paginated pages are not included in the sitemap. Only the first page (`/browse`, `/browse?sort=popular`, `/browse?sort=latest`) are listed. This is correct — paginated pages add little SEO value and can cause duplicate content issues.

## 7. Vercel Changes Required

**Already in place.** `Web/vercel.json` already had rewrites for `/sitemap.xml`, `/robots.txt`, `/anime/:id`, and `/browse`. Only one addition was needed:

```json
{
  "source": "/search",
  "destination": "https://anistrimbackend.onrender.com/search"
}
```

No other Vercel changes are required. The existing API proxy (`/api/:path*` → Render backend) is untouched.

## 8. Risks Discovered

**None.** All changes are additive:
- No existing API behavior changed
- No authentication behavior changed
- No OAuth behavior changed
- No mobile (`Frontend/`) behavior changed
- No Admin Dashboard behavior changed
- No database schema changes
- No new dependencies installed

## 9. Canonical URL Strategy

All canonical URLs use `https://anistrim.com/...`:
- The `PUBLIC_BASE` constant in `seoController.js` defaults to `https://anistrim.com` (overridable via `FRONTEND_URL` or `BACKEND_URL` env vars)
- `<link rel="canonical" href="https://anistrim.com/...">` is set on every SEO page
- No Render URLs (`anistrimbackend.onrender.com`) appear in sitemap or SEO pages
- No Vercel preview URLs appear

## 10. Structured Data (JSON-LD)

Per-anime pages include JSON-LD structured data:
```json
{
  "@context": "https://schema.org",
  "@type": "TVSeries" or "Movie",
  "name": "Anime Title",
  "url": "https://anistrim.com/anime/{id}",
  "description": "...",
  "image": "https://anistrim.com/...",
  "datePublished": "2024"
}
```

**Intentionally omitted** (not fabricated):
- `aggregateRating` / `review` — not verified user-facing data
- `actor` / `director` — not available in the database
- `episode` list — episodes are dynamic and access-controlled
- `duration` — not stored per-anime (only per-episode)

## 11. Internal Linking (Crawlability)

**Crawlable `<a href>` links exist for:**
- Anime cards on homepage, browse, search, recommendations: `<a href="/anime/{id}" onclick="...">`
- Rank items in sidebar: `<a href="/anime/{id}">`
- Browse SEO page: `<ul><li><a href="/anime/{id}">Title</a></li></ul>`
- Anime SEO page: `<a href="/browse">Browse all anime</a>`
- Search SEO page: `<a href="/browse">Browse all anime</a>`
- Header navigation: `<a href="#/">Home</a>`, `<a href="#/browse">Browse</a>`, etc.
- Footer links: `<a href="#/browse">Browse</a>`, etc.

**Not crawlable (acceptable):**
- Episode items use `<button onclick="...">` — episodes are not indexable pages
- Player actions, watchlist toggles, auth forms — not content pages

## 12. SEO Metadata Coverage

| Page | `<title>` | Description | Canonical | OG | Twitter | JSON-LD |
|------|-----------|-------------|-----------|----|---------|---------|
| Homepage (Web/index.html) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `/anime/:id` (SEO page) | ✅ (per-anime) | ✅ (per-anime) | ✅ | ✅ | ✅ | ✅ |
| `/browse` (SEO page) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `/search` (SEO page) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `/sitemap.xml` | — | — | — | — | — | — |
| `/robots.txt` | — | — | — | — | — | — |

---

## Google Search Console — Step-by-Step Instructions

### Prerequisites
1. You must own/verify `https://anistrim.com` in Google Search Console
2. The site must be live and accessible (backend running on Render, frontend on Vercel)

### Steps

1. **Open Google Search Console:** Go to https://search.google.com/search-console
2. **Add property:** Click "Add property" → Enter `https://anistrim.com` → Choose "Domain" or "URL prefix"
   - **Domain property** (recommended): Verify via DNS TXT record at your domain registrar
   - **URL prefix:** Verify via HTML file upload, meta tag, or Google Analytics
3. **Submit sitemap:** In the left sidebar, click "Sitemaps" → Enter `sitemap.xml` in the "Add a new sitemap" field → Click "Submit"
   - Full URL: `https://anistrim.com/sitemap.xml`
4. **Inspect a URL:** In the top search bar, enter a full URL like `https://anistrim.com/anime/1` → Click "Search" → Review the coverage report
5. **Request indexing:** On the inspection results page, click "Request indexing" for important pages (homepage, featured anime)
6. **Check sitemap status:** Go to "Sitemaps" → Click on your submitted sitemap → Review "Submitted URLs" vs "Indexed URLs"
7. **Check indexing errors:** Go to "Pages" in the left sidebar → Review "Not indexed" reasons → Fix any `disallowed by robots.txt` or `crawl anomaly` issues

### Important Notes from Google's Documentation
- **Submitting a sitemap does NOT guarantee indexing.** It only helps Google discover URLs.
- **Indexing is not immediate.** It can take days to weeks for Google to crawl and index new URLs.
- **Search visibility is not guaranteed.** Ranking depends on content quality, relevance, and many other factors.
- **Google recommends** sitemaps be under 50,000 URLs and 50MB uncompressed (our sitemap is well under both limits).
- **Re-submit the sitemap** after significant content changes (new anime added, titles updated).

### Verification URLs to Test After Deployment

| URL | Expected | Check |
|-----|----------|-------|
| `https://anistrim.com/sitemap.xml` | HTTP 200, valid XML | `curl -I https://anistrim.com/sitemap.xml` |
| `https://anistrim.com/robots.txt` | HTTP 200, text/plain | `curl -I https://anistrim.com/robots.txt` |
| `https://anistrim.com/anime/1` | HTTP 200, HTML with `<title>`, `<link rel="canonical">`, `<meta property="og:...">` | `curl https://anistrim.com/anime/1` |
| `https://anistrim.com/browse` | HTTP 200, HTML with anime links | `curl https://anistrim.com/browse` |
| `https://anistrim.com/search` | HTTP 200, HTML with search form | `curl https://anistrim.com/search` |

---

## What Was NOT Changed (Intentionally Preserved)

- `Frontend/` (mobile/tablet Capacitor frontend) — zero modifications
- `AdminDashboard/` — zero modifications
- `routes/authRoutes.js` — zero modifications
- `routes/paymentRoutes.js` — zero modifications
- `routes/streamRoutes.js` — zero modifications
- Google OAuth architecture — zero modifications
- Database schema — zero modifications
- Authentication system — zero modifications
- Subscription/payment logic — zero modifications
- Email/OTP system — zero modifications
- Admin routes/API/authentication — zero modifications
- Existing Vercel `/api/*` proxy — preserved, only added `/search` rewrite
