// scripts/migrate.js - ordered, idempotent, recorded, serialized migration runner.
//
// Applies every sql/migrations_v*.sql file (in numeric version order) that is not
// yet recorded in the `schema_migrations` table. Runs are serialized with a MySQL
// advisory lock (GET_LOCK) so two deployments can never migrate simultaneously.
//
// A brand-new database is bootstrapped via `npm run db:bootstrap`
// (scripts/db-bootstrap.js), which applies the foundational schema
// (sql/schema.sql + sql/oauth_login_codes.sql) and then delegates here to apply
// the versioned migrations on top. `npm run migrate` is the UPGRADE path for an
// EXISTING database.
//
// Usage:
//   node scripts/migrate.js            # apply all pending migrations
//   node scripts/migrate.js --check    # verify all migrations applied (read-only)
//   node scripts/migrate.js --status   # print applied/pending status (read-only)
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'sql');
const MIGRATIONS_TABLE = 'schema_migrations';
const LOCK_NAME = 'anistrim_schema_migrations';
const LOCK_TIMEOUT_SECONDS = 30;
const BASELINE_MARKER = '0000_schema_baseline';

// Table presence alone cannot detect a historical CREATE TABLE IF NOT EXISTS
// drift. These are the subscription columns used by checkout, IPN handling,
// entitlement resolution, and admin grants.
const CRITICAL_COLUMNS = {
  subscriptions: [
    'user_id', 'reference', 'amount', 'currency', 'status', 'plan',
    'order_tracking_id', 'plan_id', 'starts_at', 'ends_at', 'state',
    'source', 'auto_renew', 'paid_at', 'expires_at', 'created_at',
  ],
  episodes: [
    'anime_id', 'episode_number', 'season', 'title', 'video_url',
    'manual_video_url', 'is_published', 'access_tier', 'premium_until',
    'is_premium', 'consumet_id', 'updated_at', 'created_at',
  ],
};

const CRITICAL_TABLES = [
  'subscriptions', 'plans', 'user_recommendations', 'user_genre_vector',
];

async function ensureMigrationsTable(conn) {
  const c = conn || pool;
  await c.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
}

// Discover every versioned migration file in numeric order. Matches both
// `migrations_v5.sql` and `migrations_v003_support_tickets.sql` (the suffix is
// optional). Fixes the previous bug where `migrations_v5.sql` was silently
// skipped because the old pattern required a trailing `_`.
function discoverMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^migrations_v\d+(?:_[^/]+)?\.sql$/.test(f))
    .sort((a, b) => {
      const va = parseInt(a.match(/^migrations_v(\d+)/)[1], 10);
      const vb = parseInt(b.match(/^migrations_v(\d+)/)[1], 10);
      return va - vb;
    });
  return files;
}

async function getAppliedMigrations(conn) {
  const c = conn || pool;
  const [rows] = await c.query(`SELECT filename FROM ${MIGRATIONS_TABLE}`);
  return new Set(rows.map(r => r.filename));
}

/**
 * Strip SQL comments so a `;` inside a `--` line comment or a block comment
 * can never be mistaken for a statement terminator.
 */
function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'") {
      out += c;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '`') {
      out += c;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') { out += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Translate MariaDB-only `IF NOT EXISTS` clauses into MySQL-compatible form.
 */
function normalizeMariaDB(sql) {
  let out = sql.replace(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi, 'ADD COLUMN');
  out = out.replace(/\bADD\s+(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi, 'ADD $1INDEX');
  out = out.replace(/\bCREATE\s+(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi, 'CREATE $1INDEX');
  return out;
}

// Split a SQL file into individual statements (comments stripped, MariaDB-only
// syntax normalized). Reused by db-bootstrap.js for the foundational schema.
function splitSqlStatements(rawSql) {
  return normalizeMariaDB(stripSqlComments(rawSql))
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !/^USE\s/i.test(s));
}

function isIdempotentError(e) {
  return e.code === 'ER_TABLE_EXISTS_ERROR' || e.code === 'ER_DUP_KEYNAME' ||
    e.code === 'ER_DUP_FIELDNAME' || (e.message && /already exists/i.test(e.message));
}

/**
 * Apply a single migration file. Each statement runs on ONE dedicated
 * connection so session variables and PREPARE/EXECUTE blocks work. The
 * migration is recorded ONLY after every statement succeeds, so a failure is
 * obvious and the migration is retried (idempotently) on the next run.
 */
async function applyMigration(filename) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const statements = splitSqlStatements(fs.readFileSync(filePath, 'utf8'));
  const conn = await pool.getConnection();
  try {
    let step = 0;
    for (const stmt of statements) {
      step++;
      try {
        await conn.query(stmt);
      } catch (e) {
        if (isIdempotentError(e)) {
          console.log(`  -> ${filename}: object already exists (idempotent skip)`);
          continue;
        }
        throw new Error(`Migration ${filename} FAILED at statement ${step}/${statements.length}: ${e.message}`);
      }
    }
    await conn.query(`INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES (?)`, [filename]);
    console.log(`  OK ${filename} applied`);
  } finally {
    conn.release();
  }
}

/**
 * Run all pending migrations, serialized with a MySQL advisory lock.
 */
async function runMigrations() {
  // GET_LOCK / RELEASE_LOCK are connection-scoped; hold the lock on one
  // dedicated connection for the whole run.
  const lockConn = await pool.getConnection();
  let acquired = false;
  try {
    const [lockRows] = await lockConn.query('SELECT GET_LOCK(?, ?) AS ok', [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    acquired = Number(lockRows[0]?.ok) === 1;
    if (!acquired) {
      throw new Error(`Could not acquire migration lock "${LOCK_NAME}" within ${LOCK_TIMEOUT_SECONDS}s. Another migration may be running. Aborting.`);
    }
    await ensureMigrationsTable(lockConn);
    const applied = await getAppliedMigrations(lockConn);
    const files = discoverMigrations();

    let pending = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  = ${file} (already applied)`);
        continue;
      }
      pending++;
      await applyMigration(file); // each migration on its own connection
    }

    if (pending === 0) {
      console.log('No pending migrations.');
    } else {
      console.log(`Applied ${pending} migration(s).`);
    }
  } finally {
    if (acquired) {
      try { await lockConn.query('SELECT RELEASE_LOCK(?) AS ok', [LOCK_NAME]); } catch (e) { /* ignore */ }
    }
    lockConn.release();
  }
}

/**
 * Verify all critical tables/columns exist. Pure read-only (information_schema).
 */
async function assertCriticalTables() {
  const missing = [];
  for (const table of CRITICAL_TABLES) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    if (!rows[0]?.c) missing.push(table);
  }
  if (missing.length) {
    throw new Error(
      `Critical tables missing: ${missing.join(', ')}. ` +
      `Run \`npm run migrate\` (fresh DB: \`npm run db:bootstrap\`). Refusing to start.`
    );
  }
  const missingColumns = [];
  for (const [table, requiredColumns] of Object.entries(CRITICAL_COLUMNS)) {
    const placeholders = requiredColumns.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         AND COLUMN_NAME IN (${placeholders})`,
      [table, ...requiredColumns]
    );
    const present = new Set(rows.map(row => row.COLUMN_NAME));
    const absent = requiredColumns.filter(column => !present.has(column));
    if (absent.length) missingColumns.push(`${table}.${absent.join(', ')}`);
  }
  if (missingColumns.length) {
    throw new Error(
      `Critical schema columns missing: ${missingColumns.join('; ')}. ` +
      'Apply the pending reconciliation migrations before accepting traffic.'
    );
  }
}

// Read-only: verify all migrations applied + critical tables exist. Does NOT
// create the schema_migrations table.
async function checkMigrations() {
  const [tblRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [MIGRATIONS_TABLE]);
  const hasTable = Number(tblRows[0]?.c) > 0;
  const files = discoverMigrations();
  const applied = hasTable ? await getAppliedMigrations() : new Set();
  const missing = files.filter(f => !applied.has(f));
  if (!hasTable || missing.length) {
    console.error(`Migrations not applied (${hasTable ? missing.length : files.length} pending).`);
    throw new Error('Migrations not applied. Run `npm run migrate`.');
  }
  console.log('All migrations applied.');
  await assertCriticalTables();
}

// Read-only status listing. Never creates the schema_migrations table.
async function statusMigrations() {
  const [tblRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [MIGRATIONS_TABLE]);
  const hasTable = Number(tblRows[0]?.c) > 0;
  const applied = hasTable ? await getAppliedMigrations() : new Set();
  const files = discoverMigrations();
  const baselineApplied = applied.has(BASELINE_MARKER);
  console.log(`schema_migrations table : ${hasTable ? 'present' : 'MISSING (fresh DB - run npm run db:bootstrap)'}`);
  console.log(`baseline (${BASELINE_MARKER}): ${baselineApplied ? 'applied' : 'not applied'}`);
  console.log('---');
  let pending = 0;
  for (const file of files) {
    if (!applied.has(file)) pending++;
    console.log(`  ${applied.has(file) ? 'applied' : 'pending'}  ${file}`);
  }
  console.log('---');
  console.log(`${files.length} migration(s), ${pending} pending.`);
  await assertCriticalTables();
}

// CLI entry
if (require.main === module) {
  const mode = process.argv.includes('--status') ? 'status'
    : process.argv.includes('--check') ? 'check' : 'apply';
  (async () => {
    try {
      if (mode === 'status') await statusMigrations();
      else if (mode === 'check') await checkMigrations();
      else { await runMigrations(); await assertCriticalTables(); }
      process.exit(0);
    } catch (e) {
      console.error('Migration failed:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  runMigrations, assertCriticalTables, checkMigrations, statusMigrations,
  discoverMigrations, applyMigration, ensureMigrationsTable, splitSqlStatements,
  isIdempotentError, CRITICAL_TABLES, CRITICAL_COLUMNS,
  MIGRATIONS_TABLE, BASELINE_MARKER,
};
