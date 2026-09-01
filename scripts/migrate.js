// scripts/migrate.js — ordered, idempotent, recorded migration runner.
//
// Creates a `schema_migrations` table, discovers every sql/migrations_v*.sql
// file in version order, and applies any that are not yet recorded. Each
// applied migration is recorded with its filename + applied_at so re-runs are
// no-ops. Run on boot (server.js) or explicitly via `npm run migrate`.
//
// Usage:
//   node scripts/migrate.js            # apply all pending migrations
//   node scripts/migrate.js --check    # verify all migrations are applied
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'sql');
const MIGRATIONS_TABLE = 'schema_migrations';

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
    'manual_video_url',
    'is_published', 'access_tier', 'premium_until', 'is_premium',
    'consumet_id', 'updated_at', 'created_at',
  ],
};


// Critical tables that MUST exist before services that depend on them start.
// Prompt 10: fail loudly — never silently fall back to a legacy path.
const CRITICAL_TABLES = [
  'subscriptions',      // v35 — plans + subscriptions entitlement
  'plans',              // v35 — plan tiers
  'user_recommendations', // v34 — recommendation engine
  'user_genre_vector',  // v34 — genre affinity
];

/**
 * Ensure the schema_migrations table exists.
 */
async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
}

/**
 * Discover all migration files in version order.
 * Matches sql/migrations_vNN_*.sql (e.g. migrations_v34_recommendations.sql).
 */
function discoverMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^migrations_v\d+_.*\.sql$/.test(f))
    .sort((a, b) => {
      const va = parseInt(a.match(/^migrations_v(\d+)_/)[1], 10);
      const vb = parseInt(b.match(/^migrations_v(\d+)_/)[1], 10);
      return va - vb;
    });
  return files;
}

/**
 * Get the set of already-applied migration filenames.
 */
async function getAppliedMigrations() {
  const [rows] = await pool.query(`SELECT filename FROM ${MIGRATIONS_TABLE}`);
  return new Set(rows.map(r => r.filename));
}

/**
 * Strip SQL comments so a `;` inside a `--` line comment or a `/* ... *​/`
 * block comment can never be mistaken for a statement terminator.
 * Handles:
 *   - `--` line comments (to end of line)
 *   - `/* ... *​/` block comments (may span multiple lines)
 *   - single-quoted string literals (so `--` or `;` inside a string is kept)
 *   - backtick-quoted identifiers (so `;` inside a backtick name is kept)
 */
function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // Line comment: -- to end of line
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }

    // Block comment: /* ... */
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2; // skip closing */
      continue;
    }

    // Single-quoted string literal
    if (c === "'") {
      out += c;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'") {
          // Handle escaped '' inside the string
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Backtick-quoted identifier
    if (c === '`') {
      out += c;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') {
            out += sql[i + 1];
            i += 2;
            continue;
          }
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
 *
 * MySQL supports `IF NOT EXISTS` for CREATE TABLE / CREATE DATABASE, but NOT for
 * ALTER TABLE ... ADD COLUMN / ADD [UNIQUE|FULLTEXT|SPATIAL] INDEX, nor for
 * CREATE INDEX. Several migration files were written for MariaDB and use these
 * non-MySQL forms (e.g. `ADD COLUMN IF NOT EXISTS intro_start_time INT DEFAULT NULL`),
 * which cause a MySQL parse error and block startup.
 *
 * We strip `IF NOT EXISTS` from exactly those statements and rely on the existing
 * idempotent handling in applyMigration (ER_DUP_FIELDNAME / ER_DUP_KEYNAME /
 * "already exists") to skip objects that already exist. CREATE TABLE IF NOT EXISTS
 * and CREATE DATABASE IF NOT EXISTS are left untouched because MySQL accepts them.
 */
function normalizeMariaDB(sql) {
  // ADD COLUMN IF NOT EXISTS col def  →  ADD COLUMN col def
  let out = sql.replace(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi, 'ADD COLUMN');

  // ADD [UNIQUE|FULLTEXT|SPATIAL] INDEX IF NOT EXISTS ...  →  ADD ... INDEX ...
  out = out.replace(/\bADD\s+(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi, 'ADD $1INDEX');

  // CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX IF NOT EXISTS ...  →  CREATE ... INDEX ...
  out = out.replace(/\bCREATE\s+(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi, 'CREATE $1INDEX');

  return out;
}

/**
 * Apply a single migration file. Each file may contain multiple statements
 * (CREATE TABLE, ALTER, INSERT, etc.) — mysql2's multipleStatements is not
 * enabled by default, so we split on `;` at line boundaries and execute each
 * statement separately. Comments are stripped first so a `;` inside a comment
 * can never be mistaken for a statement terminator.
 */
async function applyMigration(filename) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const rawSql = fs.readFileSync(filePath, 'utf8');

  // Strip comments, translate MariaDB-only syntax (ADD COLUMN IF NOT EXISTS,
  // ADD INDEX IF NOT EXISTS, CREATE INDEX IF NOT EXISTS) into MySQL-compatible
  // form, then split into statements. Skip empty/comment-only chunks and USE.
  const statements = normalizeMariaDB(stripSqlComments(rawSql))
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !/^USE\s/i.test(s));

  // Run ALL statements on a SINGLE dedicated connection so that session
  // variables (@var) and PREPARE/EXECUTE/DEALLOCATE blocks work correctly.
  // Using pool.query() for each statement round-robins across connections in
  // the pool, so session state set by one statement would not be visible to the
  // next — silently breaking migrations that rely on PREPARE + session vars.
  const conn = await pool.getConnection();
  try {
    for (const stmt of statements) {
      try {
        await conn.query(stmt);
      } catch (e) {
        // Idempotent: if the object already exists, treat as applied.
        if (e.code === 'ER_TABLE_EXISTS_ERROR' || e.code === 'ER_DUP_KEYNAME' ||
            e.code === 'ER_DUP_FIELDNAME' || (e.message && /already exists/i.test(e.message))) {
          console.log(`  ↪ ${filename}: object already exists (idempotent skip)`);
          continue;
        }
        throw e;
      }
    }

    // Record the migration on the same connection.
    await conn.query(
      `INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES (?)`,
      [filename]
    );
    console.log(`  ✓ ${filename} applied`);
  } finally {
    conn.release();
  }
}

/**
 * Run all pending migrations.
 */
async function runMigrations() {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = discoverMigrations();

  let pending = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  = ${file} (already applied)`);
      continue;
    }
    pending++;
    await applyMigration(file);
  }

  if (pending === 0) {
    console.log('✅ No pending migrations.');
  } else {
    console.log(`✅ Applied ${pending} migration(s).`);
  }
}

/**
 * Verify all critical tables exist. Fails loudly (throws) if any are missing.
 * Prompt 10: never silently fall back to a legacy path.
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
    const err = new Error(
      `❌ [MIGRATIONS] Critical tables missing: ${missing.join(', ')}. ` +
      `Run \`npm run migrate\` to apply migrations. Refusing to start.`
    );
    console.error(err.message);
    throw err;
  }
  console.log('✅ Critical tables verified:', CRITICAL_TABLES.join(', '));
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

/**
 * Check-only mode: verify all migrations are applied without applying.
 */
async function checkMigrations() {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = discoverMigrations();
  const missing = files.filter(f => !applied.has(f));
  if (missing.length) {
    console.error(`❌ [MIGRATIONS] ${missing.length} migration(s) not applied: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('✅ All migrations applied.');
  await assertCriticalTables();
}

// ── CLI entry ─────────────────────────────────────────────────
if (require.main === module) {
  const isCheck = process.argv.includes('--check');
  (async () => {
    try {
      if (isCheck) {
        await checkMigrations();
      } else {
        await runMigrations();
        await assertCriticalTables();
      }
      process.exit(0);
    } catch (e) {
      console.error('❌ Migration failed:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { runMigrations, assertCriticalTables, checkMigrations, CRITICAL_TABLES, CRITICAL_COLUMNS };
