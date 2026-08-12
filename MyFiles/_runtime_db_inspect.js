// READ-ONLY DB inspection for runtime verification. Does not modify any data.
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const p = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [ep] = await p.query('SHOW COLUMNS FROM episodes');
  console.log('=== EPISODES COLUMNS ===');
  console.log(ep.map(c => `${c.Field}:${c.Type}`).join(' | '));

  const [cache] = await p.query("SHOW TABLES LIKE 'episode_stream_cache'");
  console.log('\n=== CACHE TABLE EXISTS ===', cache.length > 0);

  if (cache.length > 0) {
    const [cc] = await p.query('SHOW COLUMNS FROM episode_stream_cache');
    console.log('CACHE COLS:', cc.map(c => `${c.Field}:${c.Type}`).join(' | '));
    const [rows] = await p.query('SELECT COUNT(*) AS n FROM episode_stream_cache');
    console.log('CACHE ROW COUNT:', rows[0].n);
  }

  const [users] = await p.query('SELECT id, email, name, is_admin, is_premium, status FROM users LIMIT 10');
  console.log('\n=== USERS ===');
  console.log(JSON.stringify(users, null, 1));

  const [anime] = await p.query('SELECT id, title, media_type FROM anime LIMIT 10');
  console.log('\n=== ANIME ===');
  console.log(JSON.stringify(anime, null, 1));

  // Find a free episode and a premium episode with/without video_url
  const [eps] = await p.query(
    'SELECT e.id, e.episode_number, e.is_premium, e.video_url IS NOT NULL AND e.video_url <> "" AS has_video_url, a.title FROM episodes e JOIN anime a ON a.id=e.anime_id ORDER BY e.id LIMIT 30'
  );
  console.log('\n=== EPISODES (first 30) ===');
  console.log(JSON.stringify(eps, null, 1));

  await p.end();
})().catch(e => { console.error('INSPECT FAIL:', e.message); process.exit(1); });

