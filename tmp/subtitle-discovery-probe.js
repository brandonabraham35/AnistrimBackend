const logger = require('../utils/logger');
['info','warn','stream','streamAttempt','debugStream','debug','error'].forEach((k) => { if (logger[k]) logger[k] = () => {}; });
const { provider } = require('../services/animeHeavenProvider');

const queries = [...'abcdefghijklmnopqrstuvwxyz', 'anime', 'movie', 'season', 'hero', 'demon', 'attack', 'piece'];

async function run() {
  const found = new Map();
  for (const q of queries) {
    if (found.size >= 35) break;
    try {
      const rows = await provider.searchAnime(q, 12);
      for (const row of rows || []) {
        if (!row || !row.identifier || found.has(row.identifier)) continue;
        found.set(row.identifier, row.title || row.identifier);
        if (found.size >= 35) break;
      }
    } catch {
      // ignore
    }
  }

  const evidence = {
    tested: 0,
    withTrack: 0,
    withSubWord: 0,
    withFetch: 0,
    withXHR: 0,
    withApi: 0,
    withJw: 0,
    withVjs: 0,
    withM3u8: 0,
    withVtt: 0,
    candidateLines: [],
    candidateUrls: [],
    sampleIds: [],
  };

  const urlSet = new Set();
  for (const [identifier, title] of found.entries()) {
    try {
      const player = await provider.resolvePlayer({ identifier, episode: 1, title });
      const html = String((player && player.html) || '');
      if (!html) continue;
      evidence.tested += 1;
      if (evidence.sampleIds.length < 20) evidence.sampleIds.push(identifier);

      const lower = html.toLowerCase();
      if (/<track\b/i.test(html)) evidence.withTrack += 1;
      if (/subtitles?|captions?|tracks\s*:|subtitles\s*:|webvtt|\.vtt|\.srt|\.ass|\.ssa/i.test(html)) evidence.withSubWord += 1;
      if (/fetch\(/i.test(html)) evidence.withFetch += 1;
      if (/xmlhttprequest|xhr|new\s+xhr/i.test(html)) evidence.withXHR += 1;
      if (/\/api\/|subtitleapi|captions?\?|tracks\?|subtitles?\?/.test(lower)) evidence.withApi += 1;
      if (/jwplayer\s*\(/i.test(lower)) evidence.withJw += 1;
      if (/videojs\s*\(/i.test(lower)) evidence.withVjs += 1;
      if (/\.m3u8(\?|$)/i.test(lower)) evidence.withM3u8 += 1;
      if (/\.vtt(\?|$)/i.test(lower)) evidence.withVtt += 1;

      const lines = html.split(/\r?\n/);
      for (const line of lines) {
        if (!/fetch\(|xmlhttprequest|subtitles?|captions?|tracks\s*:|jwplayer|videojs|\.vtt|\.srt|\.ass|\.ssa|\/api\//i.test(line)) continue;
        if (evidence.candidateLines.length < 120) evidence.candidateLines.push(line.trim().slice(0, 380));
        const urls = line.match(/https?:\/\/[^'"\s<>]+|\/(?:api|ajax|subtitle|captions?|tracks?)[^'"\s<>]*/gi) || [];
        for (const u of urls) {
          const norm = u.trim();
          if (urlSet.has(norm) || urlSet.size >= 120) continue;
          urlSet.add(norm);
          evidence.candidateUrls.push(norm);
        }
      }
    } catch {
      // ignore title-level failures
    }
  }

  console.log(JSON.stringify(evidence, null, 2));
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
