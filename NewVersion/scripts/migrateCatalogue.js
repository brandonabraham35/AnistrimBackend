require('dotenv').config();
const db = require('../config/db');

async function hasColumn(table, column) {
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  return rows.length > 0;
}

async function hasIndex(table, index) {
  const [rows] = await db.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [index]);
  return rows.length > 0;
}

async function addColumn(column, definition) {
  if (!await hasColumn('anime', column)) await db.query(`ALTER TABLE anime ADD COLUMN \`${column}\` ${definition}`);
}

async function main() {
  await addColumn('source_provider', "VARCHAR(32) NOT NULL DEFAULT 'admin'");
  await addColumn('source_id', 'VARCHAR(191) DEFAULT NULL');
  await addColumn('source_slug', 'VARCHAR(255) DEFAULT NULL');
  if (!await hasIndex('anime', 'uq_anime_source')) await db.query('ALTER TABLE anime ADD UNIQUE INDEX uq_anime_source (source_provider, source_id)');
  if (!await hasIndex('anime', 'idx_anime_created_at')) await db.query('ALTER TABLE anime ADD INDEX idx_anime_created_at (created_at)');
  await db.query(`CREATE TABLE IF NOT EXISTS anime_mappings (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, kitsu_id VARCHAR(191) NOT NULL,
    provider VARCHAR(64) NOT NULL, provider_slug VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_anime_mapping (kitsu_id, provider), INDEX idx_provider_slug (provider, provider_slug)
  ) ENGINE=InnoDB`);
  for (const table of ['anime_cache', 'episode_cache', 'stream_cache']) {
    await db.query(`CREATE TABLE IF NOT EXISTS \`${table}\` (
      cache_key VARCHAR(255) PRIMARY KEY, payload JSON NOT NULL, expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_expiry (expires_at)
    ) ENGINE=InnoDB`);
  }
  console.log('Catalogue automation migration complete.');
}

main().then(() => db.end()).catch(async error => { console.error(error); await db.end(); process.exitCode = 1; });
