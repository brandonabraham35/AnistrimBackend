const logger = require('../utils/logger');
['info','warn','stream','streamAttempt','debugStream','debug','error'].forEach((k) => { if (logger[k]) logger[k] = () => {}; });
const { provider } = require('../services/animeHeavenProvider');

async function inspect(identifier) {
  const resolved = await provider.resolveEpisode({ identifier, episode: 1, title: identifier });
  const html = String((resolved && resolved.html) || '');
  const lines = html.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    if (/(getf\.|xmlhttprequest|xhr|open\(|send\(|responseText|onreadystatechange|gatea|player|source|subtitle|caption|track|m3u8|mp4|file)/i.test(lines[i])) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
        out.push(`${j + 1}:${lines[j]}`);
      }
      out.push('---');
    }
  }

  const attrs = [];
  const m = [...html.matchAll(/(data-[a-z0-9_-]+)=['\"]([^'\"]{1,220})['\"]/gi)];
  for (const hit of m.slice(0, 120)) attrs.push(`${hit[1]}=${hit[2]}`);

  console.log('IDENTIFIER', identifier);
  console.log('PAGE_URL', resolved && resolved.pageUrl);
  console.log('HTML_LEN', html.length);
  console.log('DATA_ATTRS', JSON.stringify(attrs.slice(0, 50), null, 2));
  console.log('SCRIPT_SNIPPETS_START');
  console.log(out.slice(0, 500).join('\n'));
  console.log('SCRIPT_SNIPPETS_END');
}

inspect(process.argv[2] || 'rk3og').catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
