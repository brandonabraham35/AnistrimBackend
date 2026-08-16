const logger = require('../utils/logger');
['info','warn','stream','streamAttempt','debugStream','debug','error'].forEach((k) => { if (logger[k]) logger[k] = () => {}; });
const { provider } = require('../services/animeHeavenProvider');

async function run(identifier) {
  const resolved = await provider.resolveEpisode({ identifier, episode: 1, title: identifier });
  const html = String((resolved && resolved.html) || '');
  const scriptSrc = [...html.matchAll(/<script[^>]+src=['\"]([^'\"]+)['\"]/gi)].map((m) => m[1]);
  const vars = html.split(/\r?\n/).filter((l) => /(var\s+|let\s+|const\s+).*(sk|vd|id|ep|sub|capt|track)|\b(sk|vd)\s*=/.test(l));
  const keys = [...html.matchAll(/gatea\(["']([a-f0-9]{16,})["']\)/gi)].map((m) => m[1]);
  const lines = html.split(/\r?\n/).filter((l) => /sub|capt|track|vtt|srt|ass|ssa|jwplayer|videojs|playlist|manifest|player/i.test(l));

  console.log(JSON.stringify({
    identifier,
    pageUrl: resolved && resolved.pageUrl,
    htmlLength: html.length,
    scriptSrc,
    keyMentions: keys.slice(0, 10),
    variableLines: vars.slice(0, 80),
    subtitleLikeLines: lines.slice(0, 120),
  }, null, 2));
}

run(process.argv[2] || 'rk3og').catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
