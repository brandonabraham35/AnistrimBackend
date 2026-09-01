// scripts/generate-sitemap.js
//
// Generates a static sitemap.xml for Vercel deployment.
//
// Usage:
//   node scripts/generate-sitemap.js
//
// This script queries the database for published anime and genre data,
// then writes the sitemap to Web/sitemap.xml where Vercel serves it
// directly with the correct Content-Type: application/xml.
//
// Dependencies: mysql2, dotenv (same as the backend)
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PUBLIC_BASE = String(
  process.env.FRONTEND_URL ||
  process.env.BACKEND_URL ||
  'https://anistrim.com'
).replace(/\/+$/, '');

const SITEMAP_MAX_URLS = 40000;
const OUTPUT_PATH = path.join(__dirname, '..', 'Web', 'sitemap.xml');

function lastmodDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function sitemapXml(rows, genres) {
  const seen = new Set();
  const entries = [];
  const push = (path, lastmod) => {
    const loc = PUBLIC_BASE + path;
    if (seen.has(loc)) return;
    seen.add(loc);
    entries.push(
      '  <url><loc>' + loc + '</loc>' +
      (lastmod ? '<lastmod>' + lastmod + '</lastmod>' : '') +
      '</url>'
    );
  };

  // Static pages
  push('/', '');
  push('/browse', '');
  push('/search', '');
  push('/browse?sort=popular', '');
  push('/browse?sort=latest', '');

  // Genre pages (only genres with published anime)
  if (Array.isArray(genres) && genres.length) {
    for (const g of genres) {
      push('/genre/' + encodeURIComponent(g), '');
    }
  }

  // Anime detail pages
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.id == null) continue;
    push('/anime/' + encodeURIComponent(row.id), lastmodDate(row.updated_at));
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.join('\n') + '\n</urlset>\n';
}

async function main() {
  let pool;
  try {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'anistrim2',
      connectionLimit: 1,
      charset: 'utf8mb4',
    });

    console.log('Connected to database. Fetching published anime...');

    const [rows] = await pool.query(
      'SELECT id, updated_at FROM anime WHERE is_published = 1 ORDER BY id ASC LIMIT ' + SITEMAP_MAX_URLS
    );

    const [genreRows] = await pool.query(
      'SELECT DISTINCT g.name FROM genres g ' +
      'JOIN anime_genres ag ON ag.genre_id = g.id ' +
      'JOIN anime a ON a.id = ag.anime_id ' +
      'WHERE a.is_published = 1 ORDER BY g.name ASC'
    );

    const genreNames = genreRows.map(function (r) { return r.name; });
    const xml = sitemapXml(rows, genreNames);

    fs.writeFileSync(OUTPUT_PATH, xml, 'utf-8');
    console.log('✅ Sitemap written to:', OUTPUT_PATH);
    console.log('   URLs:', rows.length + 5 + genreNames.length);
    console.log('   Anime:', rows.length);
    console.log('   Genres:', genreNames.length);
    console.log('   Static pages: 5');
  } catch (err) {
    console.error('❌ Failed to generate sitemap:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.end();
  }
}

main();