// scripts/migrate.js — applies migrations from migrations/ AND sql/ in numeric order.
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

// Scan BOTH directories so legacy migrations/ files and the sql/migrations_v*.sql
// files are all applied. Numeric sort (v5 < v10 < v29) not lexicographic.
const MIGRATIONS_DIRS = [
  path.join(__dirname, '..', 'migrations'),
  path.join(__dirname, '..', 'sql'),
];

const CREATE_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS schema_migrations (' +
  'id INT AUTO_INCREMENT PRIMARY KEY, ' +
  'filename VARCHAR(255) NOT NULL UNIQUE, ' +
  'applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP' +
  ') ENGINE=InnoDB';

// Extract the numeric version from a migration filename:
//   "002_add_email_verification.sql"  -> 2
//   "migrations_v29_account_lifecycle.sql" -> 29
//   "schema.sql" -> -1 (apply FIRST — the base schema must exist before any
//                     versioned migration that references users/episodes/etc.)
//   "updates.sql" -> MAX_SAFE_INTEGER (apply LAST — post-schema updates)
//   anything else without a number -> MAX_SAFE_INTEGER (apply last)
function versionOf(filename) {
  // Base schema must run first so FK targets (users, episodes, anime) exist.
  if (filename === 'schema.sql') return -1;
  // Post-schema updates run last.
  if (filename === 'updates.sql') return Number.MAX_SAFE_INTEGER;
  const m = filename.match(/v?(\d+)/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  return parseInt(m[1], 10);
}

function collectMigrationFiles() {
  const files = [];
  for (const dir of MIGRATIONS_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.sql')) files.push({ name: f, dir });
    }
  }
  // Deduplicate by filename (if the same file exists in both dirs, prefer sql/).
  const seen = new Map();
  for (const f of files) {
    const existing = seen.get(f.name);
    if (!existing || f.dir.includes('sql')) seen.set(f.name, f);
  }
  // Sort by numeric version, then by name for stability.
  return [...seen.values()].sort((a, b) => {
    const va = versionOf(a.name);
    const vb = versionOf(b.name);
    if (va !== vb) return va - vb;
    return a.name.localeCompare(b.name);
  });
}

async function run() {
  const files = collectMigrationFiles();
  if (files.length === 0) {
    console.error('No migration files found in migrations/ or sql/.');
    process.exit(1);
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
      if (applied.has(file.name)) {
        console.log('skip ' + file.name + ' (already applied)');
        continue;
      }

      let sql = fs.readFileSync(path.join(file.dir, file.name), 'utf8');
      // Strip hard-coded `USE <db>;` statements — the runner connects to the
      // correct DB via DB_NAME already. A hard-coded USE would switch to a
      // possibly non-existent database (e.g. anistrim2) on a custom DB_NAME.
      sql = sql.replace(/^\s*USE\s+[`\w]+\s*;\s*$/gim, '');
      // Replace hard-coded schema names in information_schema guards with
      // DATABASE() so migrations work on any DB_NAME (FIX 2). The runner
      // connects to the correct database via DB_NAME already.
      sql = sql.replace(/TABLE_SCHEMA\s*=\s*'anistrim2'/gi, "TABLE_SCHEMA = DATABASE()");
      console.log('applying ' + file.name + ' ...');
      try {
        await conn.query(sql);
      } catch (err) {
        console.error(`Migration FAILED: ${file.name}`);
        console.error('  Reason:', err.message);
        console.error('  This migration was NOT recorded in schema_migrations.');
        console.error('  Fix the SQL and re-run `npm run migrate`.');
        process.exitCode = 1;
        return;
      }
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file.name]);
      console.log('applied ' + file.name);
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