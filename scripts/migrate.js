// scripts/migrate.js — applies migrations/*.sql in filename order.
// Tracks applied files in schema_migrations so each runs once.
//
// IMPORTANT: uses its OWN mysql2 connection with multipleStatements enabled so
// a migration file containing many SET/PREPARE/EXECUTE statements (the
// information_schema-guarded pattern used by 002_add_email_verification.sql)
// executes correctly. The runtime pool (config/db.js) is left untouched.
// Usage: npm run migrate
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
require('dotenv').config();

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const CREATE_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS schema_migrations (' +
  'id INT AUTO_INCREMENT PRIMARY KEY, ' +
  'filename VARCHAR(255) NOT NULL UNIQUE, ' +
  'applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP' +
  ') ENGINE=InnoDB';

async function run() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error('No migrations directory found at ' + MIGRATIONS_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('No migration files found.');
    return;
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'anistrim2',
    multipleStatements: true,
    charset: 'utf8mb4',
  });

  try {
    await conn.query(CREATE_TABLE_SQL);
    const [rows] = await conn.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map(r => r.filename));
    let ran = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log('skip ' + file + ' (already applied)');
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log('applying ' + file + ' ...');
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      console.log('applied ' + file);
      ran++;
    }

    console.log('Done. ' + ran + ' migration(s) applied, ' + (files.length - ran) + ' already applied.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

run();