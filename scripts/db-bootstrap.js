// scripts/db-bootstrap.js - deterministic bootstrap for a FRESH, EMPTY MySQL
// database. This is the ONLY supported path for a brand-new database.
//
//   npm run db:bootstrap
//
// Steps:
//   1. Create the target database (DB_NAME) if it does not exist.
//   2. Apply the foundational schema (sql/schema.sql + sql/oauth_login_codes.sql).
//   3. Record a baseline marker in schema_migrations.
//   4. Apply every versioned migration (sql/migrations_v*.sql) on top.
//   5. Verify the critical tables/columns exist.
//
// Idempotent and safe to re-run. NEVER point this at a database that already
// contains production data - it is designed for an empty/brand-new database.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = require('../config/db');
const {
  runMigrations, assertCriticalTables, ensureMigrationsTable,
  splitSqlStatements, isIdempotentError, MIGRATIONS_TABLE, BASELINE_MARKER,
} = require('./migrate');

const SQL_DIR = path.join(__dirname, '..', 'sql');
const BASELINE_FILES = ['schema.sql', 'oauth_login_codes.sql'];

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'anistrim2';

async function createDatabaseIfMissing() {
  const conn = await mysql.createConnection({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    charset: 'utf8mb4',
  });
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await conn.end();
  }
}

async function applyBaselineFiles() {
  for (const file of BASELINE_FILES) {
    const raw = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
    // splitSqlStatements already strips USE; skip CREATE DATABASE (target DB is
    // selected by the pool connection).
    const statements = splitSqlStatements(raw)
      .filter(s => !/^CREATE\s+DATABASE/i.test(s));
    const conn = await pool.getConnection();
    try {
      let step = 0;
      for (const stmt of statements) {
        step++;
        try { await conn.query(stmt); }
        catch (e) {
          if (isIdempotentError(e)) { continue; }
          throw new Error(`Baseline ${file} FAILED at statement ${step}/${statements.length}: ${e.message}`);
        }
      }
    } finally { conn.release(); }
    console.log(`  OK baseline ${file} applied`);
  }
}

async function recordBaseline() {
  const conn = await pool.getConnection();
  try {
    await ensureMigrationsTable(conn);
    await conn.query(`INSERT IGNORE INTO ${MIGRATIONS_TABLE} (filename) VALUES (?)`, [BASELINE_MARKER]);
  } finally { conn.release(); }
}

async function main() {
  console.log(`Bootstrapping database "${DB_NAME}" on ${DB_HOST}:${DB_PORT}...`);
  await createDatabaseIfMissing();
  await applyBaselineFiles();
  await recordBaseline();
  await runMigrations();
  await assertCriticalTables();
  console.log('Database bootstrap complete. Create an admin with: npm run admin:create');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Bootstrap failed:', e.message);
    process.exit(1);
  });
}

module.exports = { createDatabaseIfMissing, applyBaselineFiles, recordBaseline, main };
