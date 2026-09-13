// test/authRemediation.test.js - authentication/authorization security remediation.
//
// Unit tests (no database) always run. Integration tests that need a real MySQL
// database are guarded: they only run when DB_TEST_ISOLATED=1 and a dedicated
// admin connection is provided (DB_TEST_ADMIN_USER), creating/dropping an
// ephemeral anistrim_test_* database. They are skipped otherwise.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function isIsolatedTestDb() { return process.env.DB_TEST_ISOLATED === '1'; }

// ---- 1. Password reset replay protection (persistent, atomic) ----

test('resetPassword consumes the token atomically from the DB (no in-memory store)', () => {
  const src = read('controllers/authController.js');
  assert.doesNotMatch(src, /usedResetJtis/, 'must not use an in-memory replay store');
  assert.match(src, /UPDATE password_reset_tokens/, 'must consume via the persistent table');
  assert.match(src, /used_at IS NULL AND expires_at > NOW\(\)/, 'consume must require unused + unexpired');
  assert.match(src, /consume\.affectedRows !== 1/, 'only the atomic winner may proceed');
  assert.match(src, /INSERT INTO password_reset_tokens/, 'forgotPassword must persist the token');
});

test('password reset fails closed if the persistent table is unavailable', () => {
  const src = read('controllers/authController.js');
  assert.match(src, /ER_NO_SUCH_TABLE/, 'must detect a missing table');
  assert.match(src, /Password reset is temporarily unavailable/, 'must not fall back to in-memory');
});

// ---- 2. PASSWORD_PEPPER consistency ----

test('utils/password hash/verify round-trips and peppers consistently', async () => {
  const { pepperPassword, hashPassword, verifyPassword } = require(path.join(ROOT, 'utils', 'password.js'));
  process.env.PASSWORD_PEPPER = 'remediation-test-pepper';
  try {
    const hash = await hashPassword('aVeryStrongPassword123!');
    assert.notStrictEqual(hash, 'aVeryStrongPassword123!');
    assert.strictEqual(await verifyPassword('aVeryStrongPassword123!', hash), true);
    assert.strictEqual(await verifyPassword('wrong-password', hash), false);
    assert.notStrictEqual(pepperPassword('aVeryStrongPassword123!'), 'aVeryStrongPassword123!');
  } finally {
    delete process.env.PASSWORD_PEPPER;
  }
});

test('authController and admin:create use the shared password policy', () => {
  const auth = read('controllers/authController.js');
  const admin = read('scripts/admin-create.js');
  assert.match(auth, /require\('..\/utils\/password'\)/, 'authController must import the shared policy');
  assert.doesNotMatch(auth, /function pepperPassword/, 'must not define a local pepper function');
  assert.match(admin, /require\('..\/utils\/password'\)/, 'admin:create must import the shared policy');
  assert.match(auth, /hashPassword\(/, 'password-writing paths must use hashPassword');
  assert.match(auth, /verifyPassword\(/, 'verification paths must use verifyPassword');
});

// ---- 3. Administrator authorization (fail closed) ----

test('hasRole is fail-closed: no is_admin query/fallback, deny on lookup failure', () => {
  const src = read('utils/hasRole.js');
  assert.doesNotMatch(src, /SELECT[^;]*\bis_admin\b/i, 'must not read the users.is_admin flag');
  assert.doesNotMatch(src, /\bu\[0\]\.is_admin\b/, 'must not fall back to the legacy flag');
  assert.match(src, /role lookup failed \(deny\)/, 'must log a denial on lookup failure');
  assert.match(src, /return \['user'\];/, 'must resolve to non-privileged on failure');
});

test('admin:create grants the authoritative user_roles admin role', () => {
  const src = read('scripts/admin-create.js');
  assert.match(src, /INSERT IGNORE INTO user_roles/, 'must grant the admin role in user_roles');
  assert.match(src, /grantRole/, 'must use the shared grant helper');
});

// ---- 4. Legacy public stream resolver removed ----

test('legacy public /api/anime/resolve/stream route and handler are removed', () => {
  const routes = read('routes/animeRoutes.js');
  const controller = read('controllers/animeController.js');
  assert.doesNotMatch(routes, /router\.get\('\/resolve\/stream'/, 'route must be removed');
  assert.doesNotMatch(controller, /exports\.resolveStream/, 'handler must be removed');
});

// ---- 5. Signup rate limiting (layered, email-cycling resistant) ----

test('signup is throttled per-IP AND per-IP+email (layered)', () => {
  const rl = read('middleware/rateLimit.js');
  const routes = read('routes/authRoutes.js');
  assert.match(rl, /const signupIpLimiter = rateLimit\(/, 'must define a per-IP limiter');
  assert.match(routes, /router\.post\('\/signup', signupIpLimiter, signupLimiter/, 'must apply both limiters');
});

// ---- 6. JWT / session regression guard (protections preserved) ----

test('session/JWT protections remain intact (no regression)', () => {
  const ss = read('services/sessionService.js');
  const auth = read('middleware/auth.js');
  assert.match(ss, /ACCESS_TOKEN_TTL = '15m'/, 'short-lived access tokens');
  assert.match(ss, /refresh_hash/, 'refresh tokens stored hashed');
  assert.match(ss, /session_refresh_tokens/, 'refresh rotation/reuse tracking present');
  assert.match(auth, /user\.status !== 'active'/, 'account-status gate present');
  assert.match(auth, /Number\(decoded\.tv\) !== Number\(user\.token_version\)/, 'token-version check present');
  assert.match(auth, /revoked_at/, 'session revocation check present');
});

// ---- Guarded DB integration tests (isolated disposable DB only) ----

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
  const prev = process.env.DB_NAME;
  process.env.DB_NAME = dbName;
  for (const key of Object.keys(require.cache)) {
    if (/[\\\/](config[\\\/]db|utils[\\\/]hasRole|scripts)[\\\/]/.test(key)) delete require.cache[key];
  }
  try {
    await fn(dbName);
  } finally {
    process.env.DB_NAME = prev;
    const drop = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4' });
    try { await drop.query(`DROP DATABASE IF EXISTS \`${dbName}\``); } finally { await drop.end(); }
  }
}

test('reset token is single-use (atomic consumption)', { skip: !isIsolatedTestDb() }, async () => {
  await withIsolatedDb(async () => {
    const pool = require(path.join(ROOT, 'config', 'db.js'));
    await pool.query(`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(191) UNIQUE, password_hash VARCHAR(255), is_admin TINYINT DEFAULT 0)`);
    const [u] = await pool.query(`INSERT INTO users (email) VALUES ('a@b.com')`);
    await pool.query(`CREATE TABLE password_reset_tokens (jwt_id VARCHAR(64) PRIMARY KEY, user_id INT, email VARCHAR(191), expires_at DATETIME, used_at DATETIME NULL)`);
    await pool.query(`INSERT INTO password_reset_tokens (jwt_id, user_id, email, expires_at) VALUES ('jti-1', ?, 'a@b.com', DATE_ADD(NOW(), INTERVAL 1 HOUR))`, [u.insertId]);
    const [r1] = await pool.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE jwt_id = 'jti-1' AND used_at IS NULL AND expires_at > NOW()`);
    const [r2] = await pool.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE jwt_id = 'jti-1' AND used_at IS NULL AND expires_at > NOW()`);
    assert.strictEqual(Number(r1.affectedRows), 1, 'first consume must succeed');
    assert.strictEqual(Number(r2.affectedRows), 0, 'second consume must be rejected');
  });
});

test('hasRole is fail-closed at the DB level', { skip: !isIsolatedTestDb() }, async () => {
  await withIsolatedDb(async () => {
    const pool = require(path.join(ROOT, 'config', 'db.js'));
    await pool.query(`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(191) UNIQUE, is_admin TINYINT DEFAULT 0)`);
    await pool.query(`CREATE TABLE user_roles (user_id INT, role VARCHAR(16), PRIMARY KEY (user_id, role))`);
    const [u] = await pool.query(`INSERT INTO users (email, is_admin) VALUES ('legacy@b.com', 1)`);
    const { hasRole, grantRole } = require(path.join(ROOT, 'utils', 'hasRole.js'));
    // is_admin=1 but no user_roles row -> NOT admin (fail closed)
    assert.strictEqual(await hasRole(u.insertId, 'admin'), false, 'is_admin alone must not grant admin');
    await grantRole(u.insertId, 'admin');
    assert.strictEqual(await hasRole(u.insertId, 'admin'), true, 'user_roles row grants admin');
  });
});
