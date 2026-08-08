// READ-ONLY: print episode ids for specific anime titles to use as test targets.
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const p = await mysql.createConnection({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const titles = ['Naruto', 'Jujutsu Kaisen', 'Jujutsu Kaisen 0', 'Boruto: Naruto Next Generations', 'Naruto: Shippuuden'];
  for (const t of titles) {
    const [rows] = await p.query(
      'SELECT a.id aid, a.title, e.id eid, e.episode_number FROM anime a JOIN episodes e ON e.anime_id=a.id WHERE a.title=? ORDER BY e.episode_number LIMIT 5',
      [t]
    );
    console.log(`\n=== ${t} ===`);
    console.log(JSON.stringify(rows));
  }
  await p.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

