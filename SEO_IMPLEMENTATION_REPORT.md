# AniStrim SEO Implementation Report

**Date:** 2026-08-27
**Scope:** Full SEO infrastructure audit and remediation

---

## 1. Architecture Overview

AniStrim operates three distinct frontend environments:

| Environment | Mount Path | Purpose | Indexable? |
|-------------|-----------|---------|------------|
| **Frontend/** | `/` (root) | Mobile/tablet Capacitor app | Yes (primary domain) |
| **Web/** | `/web` | Desktop browser SPA | No (secondary) |
| **AdminDashboard/** | `/admin` | Admin interface | No (blocked by robots.txt) |

**Public domain:** `https://anistrim.com` (Vercel → Render backend proxy)
**Backend API:** `https://anistrimbackend.onrender.com`

Vercel rewrites (`Web/vercel.json`) route all SEO-critical paths (`/robots.txt`, `/sitemap.xml`, `/anime/:id`, `/browse`, `/search`, `/genre/:name`) directly to the backend, bypassing the static frontend entirely.

---

## 2. Backend SEO Engine

### Routes (seoRoutes.js)

| Route | Handler | Purpose |
|-------|---------|---------|
| `GET /sitemap.xml` | `sitemapXml()` | Dynamic XML sitemap, max 40,000 URLs, includes `<lastmod>` |
| `GET /robots.txt` | `robotsTxt()` | Crawler rules: allow public paths, disallow `/api/`, `/web`, `/admin` |
| `GET /anime/:id` | `animeSeoPage()` | Per-anime HTML page with canonical, OG, Twitter, JSON-LD (`TVSeries`/`Movie`) |
| `GET /browse` | `browseSeoPage()` | Crawlable catalogue hub with `<a href>` links to 200 published titles |
| `GET /search` | `searchSeoPage()` | Crawlable search landing page with form + genre navigation |
| `GET /genre/:name` | `genreSeoPage()` | Genre-specific listing page with internal links |

### Sitemap Details

- Single file, not split (adequate for <50k URLs)
- Static entries: `/`, `/browse`, `/search`, `/browse?sort=popular`, `/browse?sort=latest`
- Dynamic entries: `/anime/{id}` for every published anime (`is_published = 1`)
- Query: `SELECT id, updated_at FROM anime WHERE is_published = 1 ORDER BY id ASC LIMIT 40000`
- Cache: `Cache-Control: public, max-age=3600` (1 hour)
- Sitemap reference included in `robots.txt`

### robots.txt Rules

```
User-agent: *
Allow: /
Disallow: /api/
Disallow: /web/
Disallow: /desktop-preview/
Disallow: /admin/
Sitemap: https://anistrim.com/sitemap.xml
```

---

## 3. Frontend HTML SEO Coverage

### Web/index.html (Desktop SPA at /web)

| Feature | Status |
|---------|--------|
| `<meta name="description">` | ✅ Present |
| `<meta name="robots">` | ✅ `index, follow` |
| Canonical URL | ✅ `https://anistrim.com/` |
| Favicon | ✅ `/assets/logo2.png` |
| Apple touch icon | ✅ `/assets/logo2.png` |
| Open Graph (site_name, title, description, type, url, locale, image) | ✅ Complete |
| Twitter Card (summary_large_image) | ✅ Complete |
| JSON-LD (WebSite + Organization) | ✅ Complete |
| Preconnect to Google Fonts | ✅ Present |

### Frontend/index.html (Mobile shell at /) — FIXED

**Before:** Only `<meta name="viewport">`. Zero SEO metadata. Google crawler at `anistrim.com` saw no favicon, no description, no OG tags, no structured data.

**After (2026-08-27):** Full SEO `<head>` block added, matching `Web/index.html`:
- Meta description, robots, canonical URL
- Favicon: `/web/assets/logo2.png` (path adjusted for root mount)
- Apple touch icon: `/web/assets/logo2.png`
- Full Open Graph suite with `og:image`
- Twitter/X card with image
- JSON-LD structured data (WebSite + Organization)
- Title standardized to "AniStrim — Stream Anime Online"

### Frontend/*.html (all other mobile pages)

**Status:** Deficient. Only `<meta name="viewport">` present. No description, no OG, no Twitter, no JSON-LD, no favicon links. Not critical for SEO (these are in-app pages, not landing pages), but flagged for future cleanup.

### AdminDashboard/*.html

**Status:** Correctly minimal. No SEO tags needed (blocked by robots.txt).

---

## 4. Per-Anime SEO Pages

Each `/anime/:id` page (server-rendered HTML, not SPA) includes:

| Feature | Implementation |
|---------|---------------|
| `<title>` | `{Anime Title} — Watch Online | AniStrim` |
| `<meta name="description">` | Genre + year + episode count |
| Canonical URL | `https://anistrim.com/anime/{id}` |
| `og:title`, `og:description`, `og:image` | ✅ From anime cover art |
| `og:type` | `video.tv_show` or `video.movie` |
| Twitter card | ✅ Summary with large image |
| JSON-LD | `TVSeries` or `Movie` with `name`, `description`, `image`, `genre`, `datePublished`, `aggregateRating` |
| Human users | `<meta http-equiv="refresh">` + JS `location.replace()` to boot into SPA |
| Crawlers | Full semantic HTML with `<h1>`, `<p>`, `<button>` episode list |

---

## 5. Known Limitations (Architectural, Not Bugs)

1. **Numeric IDs instead of slugs**: URLs are `/anime/5` not `/anime/attack-on-titan`. Database uses integer primary keys, no `slug` column. Fully crawlable, just less descriptive.

2. **Hash-based SPA**: Human users land at `#/anime/5` via JS redirect. SEO pages are server-rendered separately at path-based URLs for crawlers. Slight UX delay on redirect.

3. **Episodes not individually indexable**: Rendered as `<button onclick>`, not `<a href>`. Episodes don't have standalone pages. Anime detail page is the canonical SEO unit.

4. **Browse pagination not in sitemap**: Only first page listed (`/browse`, `/browse?sort=popular`, `/browse?sort=latest`). Paginated pages add little SEO value.

5. **No `og:image` fallback for anime without cover art**: If an anime has no `poster_url`, the OG image tag is omitted. Google may fall back to a generic thumbnail.

6. **Google index lag**: New meta tags take days to weeks to propagate into search results. Immediate verification requires Google Search Console URL inspection.

---

## 6. Changes Made (2026-08-27)

| File | Change |
|------|--------|
| `Frontend/index.html` | Added full SEO `<head>` block (description, robots, canonical, favicon, OG, Twitter, JSON-LD). Asset path set to `/web/assets/logo2.png` to match server mount. |

---

## 7. Verification Checklist

| Check | Status |
|-------|--------|
| `/sitemap.xml` returns valid XML with published anime | ✅ Backend generates dynamically |
| `/robots.txt` blocks `/api/`, `/web/`, `/admin/` | ✅ Verified in seoController.js |
| `Frontend/index.html` has meta description | ✅ Added |
| `Frontend/index.html` has favicon link | ✅ Added (`/web/assets/logo2.png`) |
| `Frontend/index.html` has og:image | ✅ Added (`https://anistrim.com/web/assets/logo2.png`) |
| `Frontend/index.html` has JSON-LD | ✅ Added (WebSite + Organization) |
| `Web/assets/logo2.png` exists on disk | ✅ Confirmed |
| Backend serves `/web/assets/logo2.png` | ✅ `express.static` on Web/ directory |
| Per-anime pages generate JSON-LD (`TVSeries`/`Movie`) | ✅ Verified in seoController.js |
| Vercel rewrites SEO paths to backend | ✅ `Web/vercel.json` configured |

---

## 8. Recommendations

### Immediate (no code changes)
1. **Submit to Google Search Console**: Use URL Inspection tool on `https://anistrim.com/` to request re-indexing. This is the fastest way to get the new favicon and og:image to appear in search results.
2. **Verify sitemap submission**: Ensure `https://anistrim.com/sitemap.xml` is submitted in Search Console.
3. **Monitor Rich Results Test**: Use [Google Rich Results Test](https://search.google.com/test/rich-results) on individual `/anime/:id` pages to confirm TVSeries/Movie structured data is being read correctly.

### Future (optional enhancements)
1. **Add `favicon.ico` at root**: Some crawlers request `/favicon.ico` directly (not via `<link>`). A small ICO or PNG at the project root would catch this.
2. **Add `og:image:width` and `og:image:height`**: Google recommends explicit dimensions (1200×630 minimum) for OG images.
3. **Episode-level pages**: If individual episodes become a priority, convert `<button>` elements to `<a href="/anime/:id/episode/:ep">` with server-rendered HTML.
4. **Slug support**: Add a `slug` column to the `anime` table for human-readable URLs (requires DB migration + redirect logic).
