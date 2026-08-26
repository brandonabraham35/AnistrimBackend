// controllers/seoController.js — crawlable SEO surface for anistrim.com.
//
// Serves search-engine-facing XML/HTML at PATH-BASED URLs while the human
// application remains the existing hash-routed Web SPA:
//
//   GET /sitemap.xml   → dynamic XML sitemap built from the anime catalogue
//   GET /robots.txt    → crawler rules + sitemap reference
//   GET /anime/:id     → per-anime SEO page (title / description / Open Graph /
//                        JSON-LD / canonical) that boots humans into the SPA
//   GET /browse        → crawlable catalogue hub linking published titles
//
// Only PUBLISHED catalogue rows are exposed (anime.is_published = 1). No
// private user data, admin pages, API URLs, or OAuth URLs appear here, and no
// metadata is fabricated: ratings/review counts are deliberately omitted from
// structured data because they are not surfaced as verified user-facing data.
const pool = require('../config/db');

const PUBLIC_BASE = String(
  process.env.FRONTEND_URL ||
  process.env.BACKEND_URL ||
  'https://anistrim.com'
).replace(/\/+$/, '');

const SITE_NAME = 'AniStrim';
const DEFAULT_TITLE = SITE_NAME + ' — Stream Anime Online';
const DEFAULT_DESCRIPTION =
  'AniStrim — browse and stream anime online. Trending, popular, and latest releases with your personal watchlist.';
// Keep the sitemap far under Google's 50k-URL / 50MB per-file limits.
const SITEMAP_MAX_URLS = 40000;
// Catalogue links embedded on the /browse hub page (crawlable internal links).
const BROWSE_HUB_LIMIT = 200;

function escHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// W3C datetime date (YYYY-MM-DD) from a DB DATETIME, or '' when unknown.
// Never fabricated: rows without updated_at simply omit <lastmod>.
function lastmodDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// Covers may be absolute provider URLs or relative /uploads/... paths.
function absoluteImageUrl(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return PUBLIC_BASE + (v.charAt(0) === '/' ? v : '/' + v);
}

function truncateDescription(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/[\s,.;:!-]+$/, '') + '…';
}

/** Build sitemap XML from published catalogue rows. Pure (unit-testable). */
function sitemapXml(rows) {
  const seen = new Set();
  const entries = [];
  const push = (path, lastmod) => {
    const loc = PUBLIC_BASE + path;
    if (seen.has(loc)) return; // never emit duplicate URLs
    seen.add(loc);
    entries.push(
      '  <url><loc>' + loc + '</loc>' +
      (lastmod ? '<lastmod>' + lastmod + '</lastmod>' : '') +
      '</url>'
    );
  };
  // Homepage and /browse have no single authoritative modification date, so
  // they intentionally carry no <lastmod> rather than a fabricated one.
  push('/', '');
  push('/browse', '');
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.id == null) continue;
    push('/anime/' + encodeURIComponent(row.id), lastmodDate(row.updated_at));
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.join('\n') + '\n</urlset>';
}

function robotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '# Legacy Render-hosted copies of the clients (canonical site is the root)',
    'Disallow: /web',
    'Disallow: /desktop-preview',
    'Disallow: /admin',
    '',
    'Sitemap: ' + PUBLIC_BASE + '/sitemap.xml',
    '',
  ].join('\n');
}

/** Shared head: canonical, description, Open Graph, optional JSON-LD. */
function seoHead(opts) {
  const title = opts.title || DEFAULT_TITLE;
  const description = opts.description || DEFAULT_DESCRIPTION;
  const canonical = PUBLIC_BASE + opts.canonicalPath;
  let h = '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '  <title>' + escHtml(title) + '</title>\n' +
    '  <meta name="description" content="' + escHtml(description) + '">\n' +
    '  <meta name="robots" content="index,follow">\n' +
    '  <link rel="canonical" href="' + escHtml(canonical) + '">\n' +
    '  <meta property="og:site_name" content="' + escHtml(SITE_NAME) + '">\n' +
    '  <meta property="og:title" content="' + escHtml(title) + '">\n' +
    '  <meta property="og:description" content="' + escHtml(description) + '">\n' +
    '  <meta property="og:type" content="website">\n' +
    '  <meta property="og:url" content="' + escHtml(canonical) + '">\n';
  if (opts.imageUrl) {
    h += '  <meta property="og:image" content="' + escHtml(opts.imageUrl) + '">\n';
  }
  if (opts.jsonLd) {
    // JSON.stringify output is not HTML-safe inside <script>; escape '<'.
    h += '  <script type="application/ld+json">' +
      JSON.stringify(opts.jsonLd).replace(/</g, '\\u003c') + '</scr' + 'ipt>\n';
  }
  return h;
}

// Humans land in the existing SPA; crawlers also get meta-refresh + noscript.
function bootRedirectMeta(hashPath) {
  return '  <meta http-equiv="refresh" content="0;url=/#' + escHtml(hashPath) + '">\n';
}

function animeJsonLd(row) {
  const isMovie = String(row.media_type || '').toUpperCase() === 'MOVIE';
  const ld = {
    '@context': 'https://schema.org',
    '@type': isMovie ? 'Movie' : 'TVSeries',
    name: String(row.title || ''),
    url: PUBLIC_BASE + '/anime/' + encodeURIComponent(row.id),
  };
  const description = truncateDescription(row.description, 500);
  if (description) ld.description = description;
  const image = absoluteImageUrl(row.cover_image || row.banner_image);
  if (image) ld.image = image;
  if (row.year) ld.datePublished = String(row.year); // schema.org accepts a bare year
  // No aggregateRating/review data is emitted — it is not verified user-facing
  // data, and fabricated ratings violate search guidelines.
  return ld;
}

/** Per-anime SEO page: real content for crawlers, instant SPA boot for humans. */
function animeSeoPage(row) {
  const id = encodeURIComponent(row.id);
  const title = row.title || 'Anime';
  const pageTitle = title + ' — Watch Online | ' + SITE_NAME;
  const description = truncateDescription(row.description, 300) ||
    ('Watch ' + title + ' on ' + SITE_NAME + '.');
  const image = absoluteImageUrl(row.cover_image || row.banner_image);
  const hashPath = '/anime/' + row.id;
  const body =
    '  <h1>' + escHtml(title) + '</h1>\n' +
    (image ? '  <img src="' + escHtml(image) + '" alt="' + escHtml(title) + ' poster" width="220">\n' : '') +
    '  <p>' + escHtml(description) + '</p>\n' +
    '  <p><a href="/browse">Browse all anime on ' + escHtml(SITE_NAME) + '</a></p>\n' +
    '  <noscript><p><a href="' + escHtml(PUBLIC_BASE + '/#' + hashPath) + '">Open ' +
      escHtml(title) + ' on ' + escHtml(SITE_NAME) + '</a></p></noscript>\n' +
    '  <script>try{location.replace("/#' + escHtml(hashPath) + '")}catch(e){}</scr' + 'ipt>\n';
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    seoHead({
      title: pageTitle,
      description: description,
      canonicalPath: '/anime/' + id,
      imageUrl: image,
      jsonLd: animeJsonLd(row),
    }) +
    bootRedirectMeta(hashPath) +
    '</head>\n<body>\n' + body + '</body>\n</html>\n';
}

/** Crawlable catalogue hub: internal links to listed published titles. */
function browseSeoPage(rows) {
  const list = Array.isArray(rows) ? rows.filter(function (r) {
    return r && r.id != null && r.title;
  }) : [];
  const links = list.map(function (r) {
    return '      <li><a href="/anime/' + encodeURIComponent(r.id) + '">' +
      escHtml(r.title) + '</a></li>';
  }).join('\n');
  const body =
    '  <h1>Browse Anime</h1>\n' +
    '  <p>' + escHtml(DEFAULT_DESCRIPTION) + '</p>\n' +
    (links ? '  <ul id="catalogue">\n' + links + '\n  </ul>\n'
           : '  <p>No titles are published yet.</p>\n') +
    '  <noscript><p><a href="' + escHtml(PUBLIC_BASE + '/#/browse') +
      '">Open the catalogue</a></p></noscript>\n' +
    '  <script>try{location.replace("/#/browse")}catch(e){}</scr' + 'ipt>\n';
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    seoHead({
      title: 'Browse Anime — ' + SITE_NAME,
      description: 'Browse the full ' + SITE_NAME +
        ' anime catalogue — trending, popular, and latest releases.',
      canonicalPath: '/browse',
    }) +
    bootRedirectMeta('/browse') +
    '</head>\n<body>\n' + body + '</body>\n</html>\n';
}

function notFoundPage(message) {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '  <meta charset="UTF-8"><title>Not found | ' + escHtml(SITE_NAME) + '</title>\n' +
    '  <meta name="robots" content="noindex,follow">\n' +
    '</head>\n<body>\n  <h1>Not found</h1>\n  <p>' +
    escHtml(message || 'This page does not exist.') + '</p>\n' +
    '  <p><a href="/">Go to ' + escHtml(SITE_NAME) + '</a></p>\n</body>\n</html>\n';
}

// ── Handlers ─────────────────────────────────────────────────
async function getSitemap(req, res) {
  try {
    const [rows] = await pool.query(
      'SELECT id, updated_at FROM anime WHERE is_published = 1 ' +
      'ORDER BY id ASC LIMIT ' + SITEMAP_MAX_URLS
    );
    res.status(200)
      .type('application/xml; charset=utf-8')
      .set('Cache-Control', 'public, max-age=3600')
      .send(sitemapXml(rows));
  } catch (err) {
    console.error('[seo] sitemap generation failed:', err.message);
    res.status(500).type('text/plain').send('Sitemap temporarily unavailable.');
  }
}

function getRobots(req, res) {
  res.status(200)
    .type('text/plain; charset=utf-8')
    .set('Cache-Control', 'public, max-age=3600')
    .send(robotsTxt());
}

async function getAnimeSeo(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).type('html; charset=utf-8').send(notFoundPage());
  }
  try {
    const [rows] = await pool.query(
      'SELECT id, title, description, cover_image, banner_image, year, media_type ' +
      'FROM anime WHERE id = ? AND is_published = 1 LIMIT 1',
      [id]
    );
    if (!rows.length) {
      return res.status(404)
        .type('html; charset=utf-8')
        .set('X-Robots-Tag', 'noindex')
        .send(notFoundPage('This title is not available.'));
    }
    res.status(200)
      .type('html; charset=utf-8')
      .set('Cache-Control', 'public, max-age=600')
      .send(animeSeoPage(rows[0]));
  } catch (err) {
    console.error('[seo] anime page failed:', err.message);
    // Fail closed without leaking internals; humans still get a way in.
    res.status(500)
      .type('html; charset=utf-8')
      .set('X-Robots-Tag', 'noindex')
      .send(notFoundPage('This page is temporarily unavailable.'));
  }
}

async function getBrowseSeo(req, res) {
  try {
    const [rows] = await pool.query(
      'SELECT id, title FROM anime WHERE is_published = 1 ' +
      'ORDER BY view_count DESC, id ASC LIMIT ' + BROWSE_HUB_LIMIT
    );
    res.status(200)
      .type('html; charset=utf-8')
      .set('Cache-Control', 'public, max-age=600')
      .send(browseSeoPage(rows));
  } catch (err) {
    console.error('[seo] browse hub failed:', err.message);
    res.status(500).type('html; charset=utf-8')
      .set('X-Robots-Tag', 'noindex')
      .send(notFoundPage('This page is temporarily unavailable.'));
  }
}

module.exports = {
  getSitemap,
  getRobots,
  getAnimeSeo,
  getBrowseSeo,
  // Pure builders exported for testing.
  sitemapXml,
  robotsTxt,
  animeSeoPage,
  browseSeoPage,
};
