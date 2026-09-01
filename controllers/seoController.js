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
function sitemapXml(rows, genres) {
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
  // Homepage and catalogue hub pages have no single authoritative modification
  // date, so they intentionally carry no <lastmod> rather than a fabricated one.
  push('/', '');
  push('/browse', '');
  push('/search', '');
  // Additional public catalogue discovery pages (crawlable, no auth required).
  push('/browse?sort=popular', '');
  push('/browse?sort=latest', '');
  // Genre pages — only include genres that have published anime.
  if (Array.isArray(genres) && genres.length) {
    for (const g of genres) {
      push('/genre/' + encodeURIComponent(g), '');
    }
  }
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
    h += '  <meta property="og:image" content="' + escHtml(opts.imageUrl) + '">\n' +
      '  <meta name="twitter:card" content="summary_large_image">\n' +
      '  <meta name="twitter:image" content="' + escHtml(opts.imageUrl) + '">\n';
  } else {
    h += '  <meta name="twitter:card" content="summary">\n';
  }
  h += '  <meta name="twitter:title" content="' + escHtml(title) + '">\n' +
    '  <meta name="twitter:description" content="' + escHtml(description) + '">\n';
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

function animeJsonLd(row, genres) {
  const isMovie = String(row.media_type || '').toUpperCase() === 'MOVIE';
  var genreList = [];
  if (Array.isArray(genres)) {
    genreList = genres.slice(0, 5).map(function (g) { return g.name; }).filter(Boolean);
  }
  var breadcrumb = {
    '@type': 'BreadcrumbList',
    'itemListElement': [
      { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': PUBLIC_BASE + '/' },
      { '@type': 'ListItem', 'position': 2, 'name': 'Browse', 'item': PUBLIC_BASE + '/browse' },
      { '@type': 'ListItem', 'position': 3, 'name': row.title || 'Anime' },
    ],
  };
  if (genreList.length) {
    breadcrumb.itemListElement.push(
      { '@type': 'ListItem', 'position': 2.5, 'name': genreList[0], 'item': PUBLIC_BASE + '/genre/' + encodeURIComponent(genreList[0]) }
    );
    // Re-number positions after inserting genre
    breadcrumb.itemListElement.sort(function (a, b) { return a.position - b.position; });
    breadcrumb.itemListElement.forEach(function (item, idx) { item.position = idx + 1; });
  }
  var ld = {
    '@context': 'https://schema.org',
    '@graph': [
      siteJsonLd(),
      breadcrumb,
      {
        '@type': isMovie ? 'Movie' : 'TVSeries',
        name: String(row.title || ''),
        url: PUBLIC_BASE + '/anime/' + encodeURIComponent(row.id),
        genre: genreList.length ? genreList : undefined,
      },
    ],
  };
  var mainEntity = ld['@graph'][2];
  var description = truncateDescription(row.description, 500);
  if (description) mainEntity.description = description;
  var image = absoluteImageUrl(row.cover_image || row.banner_image);
  if (image) mainEntity.image = image;
  if (row.year) mainEntity.datePublished = String(row.year);
  return ld;
}

/** Per-anime SEO page: real content for crawlers, instant SPA boot for humans. */
function animeSeoPage(row, genres) {
  const id = encodeURIComponent(row.id);
  const title = row.title || 'Anime';
  const pageTitle = title + ' — Watch Online | ' + SITE_NAME;
  const description = truncateDescription(row.description, 300) ||
    ('Watch ' + title + ' on ' + SITE_NAME + '.');
  const image = absoluteImageUrl(row.cover_image || row.banner_image);
  const hashPath = '/anime/' + row.id;
  var genreTags = '';
  if (Array.isArray(genres) && genres.length) {
    genreTags = '  <p><strong>Genres:</strong> ' +
      genres.slice(0, 5).map(function (g) {
        return '<a href="/genre/' + encodeURIComponent(g.name) + '">' + escHtml(g.name) + '</a>';
      }).join(', ') + '</p>\n';
  }
  const body =
    '  <h1>' + escHtml(title) + '</h1>\n' +
    (image ? '  <img src="' + escHtml(image) + '" alt="' + escHtml(title) + ' poster" width="220" height="330">\n' : '') +
    '  <p>' + escHtml(description) + '</p>\n' +
    genreTags +
    '  <p><a href="/browse">Browse all anime on ' + escHtml(SITE_NAME) + '</a></p>\n' +
    '  <noscript><p><a href="' + escHtml(PUBLIC_BASE) + '/#' + hashPath +
      '">Open ' + escHtml(title) + ' on ' + escHtml(SITE_NAME) + '</a></p></noscript>\n' +
    '  <script>try{location.replace("/#' + escHtml(hashPath) + '")}catch(e){}<\/script>\n';
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    seoHead({
      title: pageTitle,
      description: description,
      canonicalPath: '/anime/' + id,
      imageUrl: image,
      jsonLd: animeJsonLd(row, genres),
    }) +
    bootRedirectMeta(hashPath) +
    '</head>\n<body>\n' + body + '</body>\n</html>\n';
}

/** Crawlable catalogue hub: internal links to listed published titles. */
function browseSeoPage(rows, genres) {
  const list = Array.isArray(rows) ? rows.filter(function (r) {
    return r && r.id != null && r.title;
  }) : [];
  const links = list.map(function (r) {
    return '      <li><a href="/anime/' + encodeURIComponent(r.id) + '">' +
      escHtml(r.title) + '</a></li>';
  }).join('\n');
  var genreNav = '';
  if (Array.isArray(genres) && genres.length) {
    genreNav = '  <nav aria-label="Browse by genre">\n    <h2>Genres</h2>\n    <ul>\n' +
      genres.map(function (g) {
        return '      <li><a href="/genre/' + encodeURIComponent(g) + '">' + escHtml(g) + '</a></li>';
      }).join('\n') +
      '\n    </ul>\n  </nav>\n';
  }
  const body =
    '  <h1>Browse Anime</h1>\n' +
    '  <p>' + escHtml(DEFAULT_DESCRIPTION) + '</p>\n' +
    genreNav +
    (links ? '  <h2>Catalogue</h2>\n  <ul id="catalogue">\n' + links + '\n  </ul>\n'
           : '  <p>No titles are published yet.</p>\n') +
    '  <noscript><p><a href="' + escHtml(PUBLIC_BASE) + '/#/browse' +
      '">Open the catalogue</a></p></noscript>\n' +
    '  <script>try{location.replace("/#/browse")}catch(e){}<\/script>\n';
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    seoHead({
      title: 'Browse Anime — ' + SITE_NAME,
      description: 'Browse the full ' + SITE_NAME +
        ' anime catalogue — trending, popular, and latest releases.',
      canonicalPath: '/browse',
      jsonLd: siteJsonLd(),
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

// ─ Handlers ─────────────────────────────────────────────────
async function getSitemap(req, res) {
  try {
    const [rows] = await pool.query(
      'SELECT id, updated_at FROM anime WHERE is_published = 1 ' +
      'ORDER BY id ASC LIMIT ' + SITEMAP_MAX_URLS
    );
    // Fetch genres that have at least one published anime.
    const [genreRows] = await pool.query(
      'SELECT DISTINCT g.name FROM genres g ' +
      'JOIN anime_genres ag ON ag.genre_id = g.id ' +
      'JOIN anime a ON a.id = ag.anime_id ' +
      'WHERE a.is_published = 1 ' +
      'ORDER BY g.name ASC'
    );
    const genreNames = genreRows.map(function (r) { return r.name; });
    res.status(200)
      .type('application/xml; charset=utf-8')
      .set('Cache-Control', 'public, max-age=3600')
      .send(sitemapXml(rows, genreNames));
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
    return res.status(404).type('html').send(notFoundPage());
  }
  try {
    const [rows] = await pool.query(
      'SELECT id, title, description, cover_image, banner_image, year, media_type ' +
      'FROM anime WHERE id = ? AND is_published = 1 LIMIT 1',
      [id]
    );
    if (!rows.length) {
      return res.status(404)
        .type('html')
        .set('X-Robots-Tag', 'noindex')
        .send(notFoundPage('This title is not available.'));
    }
    // Fetch genres for this anime.
    const [genreRows] = await pool.query(
      'SELECT g.name FROM genres g ' +
      'JOIN anime_genres ag ON ag.genre_id = g.id ' +
      'WHERE ag.anime_id = ? ' +
      'ORDER BY g.name ASC',
      [id]
    );
    res.status(200)
      .type('html')
      .set('Cache-Control', 'public, max-age=600')
      .send(animeSeoPage(rows[0], genreRows));
  } catch (err) {
    console.error('[seo] anime page failed:', err.message);
    // Fail closed without leaking internals; humans still get a way in.
    res.status(500)
      .type('html')
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
    // Fetch genres that have at least one published anime.
    const [genreRows] = await pool.query(
      'SELECT DISTINCT g.name FROM genres g ' +
      'JOIN anime_genres ag ON ag.genre_id = g.id ' +
      'JOIN anime a ON a.id = ag.anime_id ' +
      'WHERE a.is_published = 1 ' +
      'ORDER BY g.name ASC'
    );
    const genreNames = genreRows.map(function (r) { return r.name; });
    res.status(200)
      .type('html')
      .set('Cache-Control', 'public, max-age=600')
      .send(browseSeoPage(rows, genreNames));
  } catch (err) {
    console.error('[seo] browse hub failed:', err.message);
    res.status(500).type('html')
      .set('X-Robots-Tag', 'noindex')
      .send(notFoundPage('This page is temporarily unavailable.'));
  }
}

/** Crawlable search landing page: form + genre filters for discovery. */
function searchSeoPage(genres) {
  const genreLinks = Array.isArray(genres) && genres.length
    ? '\n  <nav aria-label="Genres">\n    <p>Popular genres:</p>\n    <ul>\n' +
      genres.map(g => '      <li><a href="/genre/' + encodeURIComponent(g) + '">' + escHtml(g) + '</a></li>').join('\n') +
      '\n    </ul>\n  </nav>'
    : '';
  const body =
    '  <h1>Search Anime</h1>\n' +
    '  <p>Search the ' + escHtml(SITE_NAME) + ' anime catalogue by title, genre, or status.</p>\n' +
    '  <form action="/browse" method="get" role="search">\n' +
    '    <label>Search: <input type="search" name="q" placeholder="Enter an anime title..."></label><br>\n' +
    '    <button type="submit">Search</button>\n' +
    '  </form>\n' +
    genreLinks +
    '  <p><a href="/browse">Browse all anime on ' + escHtml(SITE_NAME) + '</a></p>\n' +
    '  <noscript><p><a href="' + escHtml(PUBLIC_BASE) + '/#/search' +
      '">Open search on ' + escHtml(SITE_NAME) + '</a></p></noscript>\n' +
    '  <script>try{location.replace("/#/search")}catch(e){}<\/script>\n';
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    seoHead({
      title: 'Search Anime — ' + SITE_NAME,
      description: 'Search and discover anime in the ' + SITE_NAME +
        ' catalogue — by title, genre, or status.',
      canonicalPath: '/search',
    }) +
    bootRedirectMeta('/search') +
    '</head>\n<body>\n' + body + '</body>\n</html>\n';
}

/** Crawlable genre page: lists anime in a specific genre. */
function genreSeoPage(genreName, rows) {
  const list = Array.isArray(rows) ? rows.filter(function (r) {
    return r && r.id != null && r.title;
  }) : [];
  const links = list.map(function (r) {
    return '      <li><a href="/anime/' + encodeURIComponent(r.id) + '">' +
      escHtml(r.title) + '</a></li>';
  }).join('\n');
  const body =
    '  <h1>' + escHtml(genreName) + ' Anime</h1>\n' +
    '  <p>Browse ' + escHtml(genreName) + ' anime on ' + escHtml(SITE_NAME) +
    '.</p>\n' +
    (links ? '  <ul id="catalogue">\n' + links + '\n  </ul>\n'
           : '  <p>No titles found in this genre.</p>\n') +
    '  <p><a href="/browse">Browse all anime</a></p>\n' +
    '  <noscript><p><a href="' + escHtml(PUBLIC_BASE) + '/#/browse?genre=' +
      encodeURIComponent(genreName) + '">Open ' + escHtml(genreName) +
      ' on ' + escHtml(SITE_NAME) + '</a></p></noscript>\n' +
    '  <script>try{location.replace("/#/browse?genre=' +
      encodeURIComponent(genreName) + '")}catch(e){}<\/script>\n';
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    seoHead({
      title: escHtml(genreName) + ' Anime — ' + SITE_NAME,
      description: 'Browse ' + escHtml(genreName) + ' anime on ' + SITE_NAME +
        '. Watch ' + escHtml(genreName) + ' series and movies online.',
      canonicalPath: '/genre/' + encodeURIComponent(genreName),
    }) +
    bootRedirectMeta('/browse?genre=' + encodeURIComponent(genreName)) +
    '</head>\n<body>\n' + body + '</body>\n</html>\n';
}

// Shared structured data for WebSite + Organization (injected on public pages).
function siteJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: SITE_NAME,
        url: PUBLIC_BASE,
        potentialAction: {
          '@type': 'SearchAction',
          target: PUBLIC_BASE + '/browse?q={search_term_string}',
          'query-input': 'required name=search_term_string',
        },
      },
      {
        '@type': 'Organization',
        name: SITE_NAME,
        url: PUBLIC_BASE,
      },
    ],
  };
}

async function getSearchSeo(req, res) {
  try {
    // Fetch genres for the search page genre links.
    const [genreRows] = await pool.query(
      'SELECT DISTINCT g.name FROM genres g ' +
      'JOIN anime_genres ag ON ag.genre_id = g.id ' +
      'JOIN anime a ON a.id = ag.anime_id ' +
      'WHERE a.is_published = 1 ' +
      'ORDER BY g.name ASC'
    );
    const genreNames = genreRows.map(function (r) { return r.name; });
    res.status(200)
      .type('html')
      .set('Cache-Control', 'public, max-age=600')
      .send(searchSeoPage(genreNames));
  } catch (err) {
    console.error('[seo] search page failed:', err.message);
    res.status(500).type('html')
      .set('X-Robots-Tag', 'noindex')
      .send(notFoundPage('This page is temporarily unavailable.'));
  }
}

/** Crawlable genre page handler. */
async function getGenreSeo(req, res) {
  const genreName = decodeURIComponent(req.params.name || '').trim();
  if (!genreName) {
    return res.status(404).type('html').send(notFoundPage());
  }
  try {
    // Verify genre exists.
    const [genreCheck] = await pool.query(
      'SELECT id, name FROM genres WHERE name = ? LIMIT 1',
      [genreName]
    );
    if (!genreCheck.length) {
      return res.status(404)
        .type('html')
        .set('X-Robots-Tag', 'noindex')
        .send(notFoundPage('This genre does not exist.'));
    }
    // Fetch published anime in this genre.
    const [rows] = await pool.query(
      'SELECT a.id, a.title FROM anime a ' +
      'JOIN anime_genres ag ON ag.anime_id = a.id ' +
      'WHERE ag.genre_id = ? AND a.is_published = 1 ' +
      'ORDER BY a.view_count DESC, a.id ASC LIMIT ' + BROWSE_HUB_LIMIT,
      [genreCheck[0].id]
    );
    res.status(200)
      .type('html')
      .set('Cache-Control', 'public, max-age=600')
      .send(genreSeoPage(genreCheck[0].name, rows));
  } catch (err) {
    console.error('[seo] genre page failed:', err.message);
    res.status(500)
      .type('html')
      .set('X-Robots-Tag', 'noindex')
      .send(notFoundPage('This page is temporarily unavailable.'));
  }
}

module.exports = {
  getSitemap,
  getRobots,
  getAnimeSeo,
  getBrowseSeo,
  getSearchSeo,
  getGenreSeo,
  // Pure builders exported for testing.
  sitemapXml,
  robotsTxt,
  animeSeoPage,
  browseSeoPage,
  searchSeoPage,
  genreSeoPage,
};
