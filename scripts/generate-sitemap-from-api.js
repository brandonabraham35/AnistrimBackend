// scripts/generate-sitemap-from-api.js
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const OUTPUT_PATH = path.join(__dirname, '..', 'Web', 'sitemap.xml');
function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function lastmodDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
async function main() {
  console.log('Fetching genres...');
  const genresRes = await fetch('https://anistrim.com/api/anime/genres');
  const genres = (genresRes.data || []).filter(g => g && g.trim());
  console.log('  ' + genres.length + ' genres');
  console.log('Fetching all anime pages...');
  const allAnime = [];
  let page = 1, totalPages = 42;
  while (page <= totalPages) {
    const res = await fetch('https://anistrim.com/api/anime/trending?page=' + page);
    const items = res.data || [];
    if (res.meta && res.meta.pagination) totalPages = res.meta.pagination.totalPages;
    for (const a of items) allAnime.push({ id: a.id, updated_at: a.updated_at || a.created_at || null });
    if (page % 10 === 0) console.log('  Page ' + page + '/' + totalPages + ' (' + allAnime.length + ' total)');
    page++;
    await new Promise(r => setTimeout(r, 50));
  }
  const BASE = 'https://anistrim.com', seen = new Set(), entries = [];
  function push(p, lm) {
    const loc = BASE + p;
    if (seen.has(loc)) return;
    seen.add(loc);
    entries.push('  <url><loc>' + loc + '</loc>' + (lm ? '<lastmod>' + lm + '</lastmod>' : '') + '</url>');
  }
  push('/', ''); push('/browse', ''); push('/search', ''); push('/browse?sort=popular', ''); push('/browse?sort=latest', '');
  for (const g of genres) push('/genre/' + encodeURIComponent(g), '');
  for (const a of allAnime) { if (a && a.id != null) push('/anime/' + a.id, lastmodDate(a.updated_at)); }
  const xml = '<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n' + entries.join('\n') + '\n</urlset>\n';
  fs.writeFileSync(OUTPUT_PATH, xml, 'utf-8');
  console.log('\n=== DONE ===');
  console.log('Total URLs: ' + entries.length + ' (static 5, genres ' + genres.length + ', anime ' + allAnime.length + ')');
  console.log('First 5 IDs: ' + allAnime.slice(0,5).map(x => x.id).join(','));
  console.log('Has 61,70,224,472: ' + [61,70,224,472].map(i => allAnime.some(x => x.id === i)).join(','));
  console.log('Has any ID 1-8: ' + [1,2,3,4,5,6,7,8].some(i => allAnime.some(x => x.id === i)));
  console.log('Duplicates: ' + (entries.length !== seen.size ? 'YES' : 'NONE'));
}
main().catch(err => { console.error(err); process.exit(1); });
