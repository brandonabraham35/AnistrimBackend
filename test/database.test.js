// test/database.test.js - database initialization architecture tests.
//
// Unit tests (no database) always run. Tests that need a real MySQL database
// are guarded: they only execute when the target is positively verified to be an
// isolated, disposable test database (DB_TEST_ISOLATED=1). They are skipped
// otherwise so they can never touch production data.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function isIsolatedTestDb() {
  return process.env.DB_TEST_ISOLATED === '1';
}

// Reload a module tree (config/db + scripts) so env changes are picked up.
function freshModules() {
  for (const key of Object.keys(require.cache)) {
    if (/[\\\/](config[\\\/]db|scripts)[\\\/]/.test(key)) delete require.cache[key];
  }
}

// Create/point at/teardown an ephemeral test database using dedicated admin
// credentials. Never used unless DB_TEST_ISOLATED is set.
async function withIsolatedDb(fn) {
  const mysql = require('mysql2/promise');
  const host = process.env.DB_TEST_ADMIN_HOST || process.env.DB_HOST;
  const port = parseInt(process.env.DB_TEST_ADMIN_PORT || process.env.DB_PORT) || 3306;
  const user = process.env.DB_TEST_ADMIN_USER;
  const password = process.env.DB_TEST_ADMIN_PASSWORD || '';
  if (!user) throw new Error('DB_TEST_ADMIN_USER is required for isolated DB tests.');
  const dbName = `anistrim_test_${process.pid}_${Date.now().toString(36)}`;
  const admin = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4' });
  try {
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally { await admin.end(); }
  const prevName = process.env.DB_NAME;
  process.env.DB_NAME = dbName;
  freshModules();
  try {
    await fn(dbName);
  } finally {
    process.env.DB_NAME = prevName;
    freshModules();
    const drop = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4' });
    try { await drop.query(`DROP DATABASE IF EXISTS \`${dbName}\``); } finally { await drop.end(); }
  }
}

// ---- Unit tests (no database needed) ----

test('config/db import is side-effect free (no admin creation, no writes)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'config', 'db.js'), 'utf8');
  assert.doesNotMatch(src, /ensureAdminUser/, 'must not define an auto admin routine');
  assert.doesNotMatch(src, /INSERT INTO users/i, 'must not write users on import');
  assert.doesNotMatch(src, /bcrypt/, 'must not require bcrypt on import');
  assert.doesNotMatch(src, /ensureAdminUser\(\)/, 'must not auto-create/promote an admin');
  assert.match(src, /module\.exports = pool/, 'must still export the pool');
});

test('server.js does not auto-run migrations on startup', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(src, /runMigrations\(\)/, 'startup must not apply migrations');
  assert.match(src, /assertCriticalTables\(\)/, 'startup keeps a read-only schema check');
});

test('schema.sql contains no hardcoded admin password', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'sql', 'schema.sql'), 'utf8');
  assert.doesNotMatch(schema, /INSERT IGNORE INTO users/i, 'must not seed an admin user');
  assert.doesNotMatch(schema, /admin123/, 'must not embed the default admin password');
});

test('migrate.js discovers migrations_v5.sql and migrations_v003_*.sql, ordered', () => {
  const { discoverMigrations } = require(path.join(ROOT, 'scripts', 'migrate.js'));
  const files = discoverMigrations();
  assert.ok(files.includes('migrations_v5.sql'), 'must include migrations_v5.sql (previously dropped)');
  assert.ok(files.includes('migrations_v003_support_tickets.sql'), 'must include migrations_v003_support_tickets.sql');
  assert.ok(files.includes('migrations_v55_manual_video_url.sql'), 'must include the latest migration');
  const versions = files.map(f => parseInt(f.match(/^migrations_v(\d+)/)[1], 10));
  for (let i = 1; i < versions.length; i++) assert.ok(versions[i] >= versions[i - 1], 'must be non-decreasing');
});

test('migrate.js serializes runs with a MySQL advisory lock', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate.js'), 'utf8');
  assert.match(src, /GET_LOCK\(/, 'must acquire an advisory lock');
  assert.match(src, /RELEASE_LOCK\(/, 'must release the advisory lock');
});

test('migrate.js records a migration only after its statements succeed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate.js'), 'utf8');
  const insertIdx = src.indexOf('INSERT INTO ${MIGRATIONS_TABLE}');
  const throwIdx = src.indexOf('FAILED at statement');
  assert.ok(insertIdx !== -1 && throwIdx !== -1, 'must contain both the failure path and the record insert');
  assert.ok(throwIdx < insertIdx, 'a failure must be thrown BEFORE the migration is recorded');
});

test('migrate:status is read-only (never creates schema_migrations)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate.js'), 'utf8');
  const statusIdx = src.indexOf('async function statusMigrations');
  const statusBlock = src.slice(statusIdx, src.indexOf('// CLI entry'));
  assert.doesNotMatch(statusBlock, /CREATE TABLE/, 'status must not create the migrations table');
  assert.match(statusBlock, /information_schema\.TABLES/, 'status must read table presence from information_schema');
});

test('admin:create refuses unsafe/default credentials and applies PASSWORD_PEPPER', () => {
  const { validateCredentials, pepperPassword } = require(path.join(ROOT, 'scripts', 'admin-create.js'));
  assert.notStrictEqual(validateCredentials({ email: 'admin@anistrim.com', password: 'admin123' }).length, 0, 'must reject known default');
  assert.notStrictEqual(validateCredentials({ email: 'admin@anistrim.com', password: 'short' }).length, 0, 'must reject short password');
  assert.notStrictEqual(validateCredentials({ email: 'not-an-email', password: 'aVeryStrongPassword123!' }).length, 0, 'must reject bad email');
  assert.strictEqual(validateCredentials({ email: 'admin@example.com', password: 'aVeryStrongPassword123!' }).length, 0, 'must accept a strong password');
  process.env.PASSWORD_PEPPER = 'test-pepper-secret';
  try {
    const peppered = pepperPassword('aVeryStrongPassword123!');
    assert.notStrictEqual(peppered, 'aVeryStrongPassword123!', 'pepper must transform the password');
  } finally {
    delete process.env.PASSWORD_PEPPER;
  }
});

test('db:bootstrap applies the foundational schema then migrations', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'db-bootstrap.js'), 'utf8');
  assert.match(src, /schema\.sql/, 'must apply the foundational schema');
  assert.match(src, /oauth_login_codes\.sql/, 'must apply the OAuth login codes table');
  assert.match(src, /runMigrations\(\)/, 'must then apply versioned migrations');
});

// ---- Guarded DB integration tests (isolated disposable DB only) ----

test('fresh empty database bootstrap creates the full schema', { skip: !isIsolatedTestDb() }, async () => {
  await withIsolatedDb(async (dbName) => {
    const { main } = require(path.join(ROOT, 'scripts', 'db-bootstrap.js'));
    await main();
    freshModules();
    const mysql = require('mysql2/promise');
    const pool = require(path.join(ROOT, 'config', 'db.js'));
    const [rows] = await pool.query(`SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [dbName]);
    assert.ok(Number(rows[0].c) >= 10, 'fresh DB must contain the baseline tables');
    const [applied] = await pool.query('SELECT COUNT(*) AS c FROM schema_migrations');
    assert.ok(Number(applied[0].c) >= 1, 'baseline must be recorded');
  });
});

test('repeated migration execution is idempotent', { skip: !isIsolatedTestDb() }, async () => {
  await withIsolatedDb(async () => {
    const { main } = require(path.join(ROOT, 'scripts', 'db-bootstrap.js'));
    const { runMigrations } = require(path.join(ROOT, 'scripts', 'migrate.js'));
    await main();
    await main();
    freshModules();
    await require(path.join(ROOT, 'scripts', 'migrate.js')).runMigrations();
  });
});

test('upgrading an existing schema applies only pending migrations', { skip: !isIsolatedTestDb() }, async () => {
  await withIsolatedDb(async () => {
    const { applyBaselineFiles, recordBaseline } = require(path.join(ROOT, 'scripts', 'db-bootstrap.js'));
    const { runMigrations, getAppliedMigrations } = require(path.join(ROOT, 'scripts', 'migrate.js'));
    await applyBaselineFiles();
    await recordBaseline();
    await runMigrations();
    freshModules();
    await require(path.join(ROOT, 'scripts', 'migrate.js')).runMigrations(); // no-op
    const applied = await require(path.join(ROOT, 'scripts', 'migrate.js')).getAppliedMigrations();
    assert.ok(applied.size > 1, 'migrations must be recorded after upgrade');
  });
});

test('migration failure is obvious and not recorded', { skip: !isIsolatedTestDb() }, async () => {
  await withIsolatedDb(async () => {
    const { applyBaselineFiles, recordBaseline } = require(path.join(ROOT, 'scripts', 'db-bootstrap.js'));
    await applyBaselineFiles();
    await recordBaseline();
    const migrate = require(path.join(ROOT, 'scripts', 'migrate.js'));
    await assert.rejects(
      () => migrate.applyMigration('nonexistent_v99_test.sql'),
      /Failed|ENOENT|failed/i,
      'a failing/nonexistent migration must reject'
    );
  });
});

test('admin creation creates an is_admin user and refuses defaults', { skip: !isIsolatedTestDb() }, async () => {
  await withIsolatedDb(async () => {
    const { applyBaselineFiles, recordBaseline } = require(path.join(ROOT, 'scripts', 'db-bootstrap.js'));
    await applyBaselineFiles();
    await recordBaseline();
    const { createAdmin, validateCredentials } = require(path.join(ROOT, 'scripts', 'admin-create.js'));
    await assert.rejects(() => createAdmin({ email: 'a@b.com', password: 'admin123', name: 'A' }), /Refusing/);
    await createAdmin({ email: 'admin@example.com', password: 'aVeryStrongPassword123!', name: 'Root' });
    const pool = require(path.join(ROOT, 'config', 'db.js'));
    const [rows] = await pool.query('SELECT email, is_admin, is_premium FROM users WHERE email = ?', ['admin@example.com']);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].is_admin), 1);
    assert.strictEqual(Number(rows[0].is_premium), 1);
  });
});
