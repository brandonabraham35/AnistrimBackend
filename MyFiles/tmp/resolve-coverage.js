const logger = require('../utils/logger');
['info','warn','stream','streamAttempt','debugStream','debug','error'].forEach((k) => { if (logger[k]) logger[k] = () => {}; });
const { provider } = require('../services/animeHeavenProvider');

const queries = [...'abcdefghijklmnopqrstuvwxyz', ...'0123456789', 'anime', 'movie', 'season', 'hero', 'demon', 'piece', 'attack', 'naruto', 'bleach', 'one'];

async function run() {
  const found = new Map();
  for (const q of queries) {
    if (found.size >= 220) break;
    try {
      const rows = await provider.searchAnime(q, 12);
      for (const row of rows || []) {
        if (!row || !row.identifier || found.has(row.identifier)) continue;
        found.set(row.identifier, row.title || row.identifier);
        if (found.size >= 220) break;
      }
    } catch {}
  }

  let checked = 0;
  let resolved = 0;
  const ok = [];
  const bad = [];

  for (const [identifier, title] of found.entries()) {
    if (checked >= 200) break;
    checked += 1;
    try {
      const ep = await provider.resolveEpisode({ identifier, title, episode: 1 });
      if (ep && ep.episode) {
        resolved += 1;
        if (ok.length < 30) ok.push({ identifier, ep: ep.episode.number });
      } else if (bad.length < 30) {
        bad.push({ identifier, reason: ep && ep.reason ? ep.reason : 'none' });
      }
    } catch (e) {
      if (bad.length < 30) bad.push({ identifier, reason: e.message || 'error' });
    }
  }

  console.log(JSON.stringify({ checked, resolved, unresolved: checked - resolved, ok, bad }, null, 2));
}

run().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
