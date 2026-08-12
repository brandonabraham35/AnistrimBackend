// READ-ONLY: Report DB state relevant to verification.
'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const p = await mysql.createConnection({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const [prem] = await p.query('SELECT COUNT(*) n FROM episodes WHERE is_premium=1');
  console.log('PREMIUM EPISODES:', prem[0].n);
  const [vu] = await p.query('SELECT COUNT(*) n FROM episodes WHERE video_url IS NOT NULL AND video_url <> \'\'');
  console.log('EPISODES WITH video_url:', vu[0].n);
  const [cacheTab] = await p.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=? AND table_name='episode_stream_cache'", [process.env.DB_NAME]);
  console.log('episode_stream_cache table exists:', cacheTab[0].n > 0);
  const [cacheRows] = await p.query('SELECT COUNT(*) n FROM episode_stream_cache');
  console.log('episode_stream_cache rows:', cacheRows[0].n);
  const [cacheSamples] = await p.query('SELECT id, episode_id, provider, stream_type, expires_at FROM episode_stream_cache LIMIT 10');
  console.log('cache samples:', JSON.stringify(cacheSamples));
  const [users] = await p.query("SELECT id, email, is_premium, is_admin FROM users WHERE is_admin=1 OR is_premium=1 LIMIT 5");
  console.log('premium/admin users:', JSON.stringify(users.map(u => ({ id: u.id, email: u.email, is_premium: u.is_premium, is_admin: u.is_admin }))));
  await p.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
