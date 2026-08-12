const logger = require('../utils/logger');
['info','warn','stream','streamAttempt','debugStream','debug','error'].forEach((k) => { if (logger[k]) logger[k] = () => {}; });
const { provider } = require('../services/animeHeavenProvider');

const queries = [...'abcdefghijklmnopqrstuvwxyz', ...'0123456789', 'anime', 'season', 'movie', 'hero', 'demon', 'piece', 'attack'];

async function discover(limit = 60) {
  const found = new Map();
  for (const q of queries) {
    if (found.size >= limit) break;
    try {
      const rows = await provider.searchAnime(q, 12);
      for (const row of rows || []) {
        if (!row || !row.identifier || found.has(row.identifier)) continue;
        found.set(row.identifier, row.title || row.identifier);
        if (found.size >= limit) break;
      }
    } catch {}
  }
  return [...found.entries()].map(([identifier, title]) => ({ identifier, title }));
}

async function run() {
  const seeds = await discover();
  let tested = 0;
  let withM3u8 = 0;
  let withMpd = 0;
  let withMp4Only = 0;
  const sample = [];
  for (const s of seeds) {
    try {
      const result = await provider.extractStreams({ title: s.title, identifier: s.identifier, episode: 1 });
      const src = Array.isArray(result && result.sources) ? result.sources : [];
      if (!src.length) continue;
      tested += 1;
      const urls = src.map((x) => String(x.url || ''));
      const hasM3u8 = urls.some((u) => /\.m3u8(\?|$)/i.test(u));
      const hasMpd = urls.some((u) => /\.mpd(\?|$)/i.test(u));
      const hasMp4 = urls.some((u) => /\.mp4(\?|$)|video\.mp4\?/i.test(u));
      if (hasM3u8) withM3u8 += 1;
      if (hasMpd) withMpd += 1;
      if (hasMp4 && !hasM3u8 && !hasMpd) withMp4Only += 1;
      if (sample.length < 20) sample.push({ id: s.identifier, hasM3u8, hasMpd, hasMp4, top: urls[0] || null });
    } catch {}
  }
  console.log(JSON.stringify({ tested, withM3u8, withMpd, withMp4Only, sample }, null, 2));
}

run().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
