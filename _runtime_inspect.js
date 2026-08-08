// READ-ONLY: Inspect persisted cache + expiration logic + stored context.
'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');
const streamCacheService = require('./services/streamCacheService');

(async () => {
  const p = await mysql.createConnection({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  // Inspect ep2 (559) and ep1 (558) rows
  const [rows] = await p.query('SELECT id, episode_id, provider, stream_type, expires_at, stream_data FROM episode_stream_cache ORDER BY id');
  for (const r of rows) {
    let data;
    try { data = typeof r.stream_data === 'string' ? JSON.parse(r.stream_data) : r.stream_data; } catch (_) { data = null; }
    const srcs = (data && data.sources) || [];
    console.log(JSON.stringify({
      id: r.id,
      episode_id: r.episode_id,
      provider: r.provider,
      stream_type: r.stream_type,
      expires_at: r.expires_at,
      now: new Date().toISOString(),
      expired: new Date(r.expires_at).getTime() <= Date.now(),
      sourceCount: srcs.length,
      firstSourcePicture: srcs[0] ? { hasReferer: !!srcs[0].referer, hasOrigin: !!srcs[0].origin, hasCookies: !!srcs[0].cookies, urlPrefix: String(srcs[0].url||'').substring(0, 80) } : null,
      subtitleCount: (data && data.subtitles) ? data.subtitles.length : 0,
    }, null, 2));
  }

  // Test findCachedStream on the expired ep1 (558) row — should return result:null
  if (rows.length) {
    const expiredRow = rows.find(r => new Date(r.expires_at).getTime() <= Date.now());
    if (expiredRow) {
      const lookup = await streamCacheService.findCachedStream(expiredRow.episode_id, 'animeheaven');
      console.log('\nfindCachedStream(expired eid ' + expiredRow.episode_id + ') -> result:', lookup.result ? 'PRESENT (should be null)' : 'null (EXPIRED, not served)');
    } else {
      console.log('\nNo expired row currently present.');
    }
  }

  // Duplicate row check
  const [dups] = await p.query('SELECT episode_id, provider, COUNT(*) c FROM episode_stream_cache GROUP BY episode_id, provider HAVING c > 1');
  console.log('\nDuplicate cache rows:', dups.length, dups);

  await p.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

