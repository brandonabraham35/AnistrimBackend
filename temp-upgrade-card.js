const fs = require('fs');
const path = 'Web/js/ui.js';
let c = fs.readFileSync(path, 'utf8');

const start = c.indexOf('function card(');
if (start === -1) { console.log('NOT FOUND'); process.exit(1); }

const end = c.indexOf('\n  function', start + 10);
if (end === -1) { console.log('END NOT FOUND'); process.exit(1); }

const oldLen = c.substring(start, end).length;
console.log('Old card fn found, length:', oldLen);

const newCard = [
  '  function card(a) {',
  "    var img = (a && (a.cover_image || a.poster || a.coverImage)) || '';",
  "    var title = (a && a.title) || '';",
  '    var id = a && (a.id != null ? a.id : a.animeId);',
  "    var type = a && (a.type || a.media_type || '');",
  "    var eps = a && (a.episode_count || a.total_episodes || '');",
  "    return '<div class=\"anime-card\" onclick=\"AniStrimUI.goAnime(' + id + ')\">' +",
  "      '<div class=\"anime-card-img\"><img src=\"' + (img || fallback(title)) + '\" alt=\"' + esc(title) + '\" loading=\"lazy\" ' +",
  "      'onerror=\"this.src=AniStrimUI.fallback(\\'' + esc(title) + '\\')\">' +",
  "      (type ? '<span class=\"badge-type\">' + esc(type) + '</span>' : '') +",
  "      (a && a.is_premium ? '<span class=\"badge-premium\">&#x1F451;</span>' : '') +",
  "      (a && a.rating ? '<span class=\"badge-rating\">&#9733; ' + esc(a.rating) + '</span>' : '') +",
  "      (eps ? '<span class=\"badge-ep\">' + esc(eps) + '</span>' : '') +",
  "      '</div><div class=\"anime-card-body\"><div class=\"anime-card-title\">' + esc(title) + '</div>' +",
  "      '<div class=\"anime-card-sub\">' + (type || 'Anime') + (eps ? ' &middot; ' + esc(eps) + ' EP' : '') +",
  "      (a && a.year ? ' &middot; ' + esc(a.year) : '') + '</div></div></div>';",
  '  }',
].join('\n');

c = c.substring(0, start) + newCard + c.substring(end);
fs.writeFileSync(path, c, 'utf8');
console.log('card() upgraded OK');