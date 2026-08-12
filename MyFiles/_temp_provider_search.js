// TEMPORARY audit helper — comprehensive provider-name scan (v2).
const fs = require('fs');
const path = require('path');

const root = '.';
const skipDirs = new Set(['node_modules', '.git', 'android', 'ios', 'build', 'dist', 'uchiha-admin-dashboard', '.vscode', 'NewVersion']);

const patterns = [
  { name: 'kickass', re: /kickass/i },
  { name: 'gogo', re: /gogo/i },
  { name: 'consumet', re: /consumet/i },
  { name: 'animekai', re: /animekai/i },
  { name: 'animepahe', re: /animepahe/i },
  { name: 'hianime', re: /hianime/i },
  { name: 'animesaturn', re: /animesaturn/i },
  { name: 'animesama', re: /animesama/i },
  { name: 'nineanime', re: /nineanime|9anime/i },
  { name: 'miruro', re: /miruro/i },
  { name: 'kitsu', re: /kitsu/i },
  { name: 'zoro/aniwatch', re: /zoro|\baniwatch\b/i },
  { name: 'providerOrder', re: /STREAM_PROVIDERS|PROVIDER_ORDER|DEFAULT_PROVIDERS|preferredProvider|preferredOrder/i },
];

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (skipDirs.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
    } else if (/\.(js|ts)$/.test(e.name)) {
      let content;
      try {
        content = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      content.split('\n').forEach((line, i) => {
        const hits = [];
        for (const pat of patterns) {
          if (pat.re.test(line)) {
            hits.push(pat.name);
            break;
          }
        }
        if (hits.length) {
          console.log(`${p}:${i + 1} [${hits.join(',')}] ${line.trim()}`);
        }
      });
    }
  }
}

walk(root);
console.log('--- SEARCH COMPLETE ---');

