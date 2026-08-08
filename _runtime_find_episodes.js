// READ-ONLY: find premium episodes and video_url episodes for runtime testing.
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

  const [prem] = await p.query(
    'SELECT e.id, e.episode_number, e.is_premium, LEFT(e.video_url,60) AS vurl, a.title FROM episodes e JOIN anime a ON a.id=e.anime_id WHERE e.is_premium=1 LIMIT 15'
  );
  console.log('=== PREMIUM EPISODES ===');
  console.log(JSON.stringify(prem, null, 1));

  const [vurl] = await p.query(
    "SELECT e.id, e.episode_number, e.is_premium, LEFT(e.video_url,80) AS vurl, a.title FROM episodes e JOIN anime a ON a.id=e.anime_id WHERE e.video_url IS NOT NULL AND e.video_url<>'' LIMIT 15"
  );
  console.log('\n=== VIDEO_URL EPISODES ===');
  console.log(JSON.stringify(vurl, null, 1));

  const [tot] = await p.query('SELECT COUNT(*) n FROM episodes');
  const [pc] = await p.query('SELECT COUNT(*) n FROM episodes WHERE is_premium=1');
  const [vc] = await p.query("SELECT COUNT(*) n FROM episodes WHERE video_url IS NOT NULL AND video_url<>''");
  console.log('\nTOTALS ep=%s prem=%s vurl=%s', tot[0].n, pc[0].n, vc[0].n);

  await p.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
