// test/lifecycle.test.js — production runtime/readiness behavior tests.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---- 1. Production configuration validation ----
test('validateConfig requires core vars in production', () => {
  const { validateConfig } = require(path.join(ROOT, 'config', 'validateEnv.js'));
  const env = { NODE_ENV: 'production', POSTMARK_TEST_MODE: 'true', JWT_SECRET: 'x', JWT_RESET_SECRET: 'x', STREAM_TOKEN_SECRET: 'x', DB_HOST: 'h', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'n' };
  const { errors } = validateConfig(env);
  assert.strictEqual(errors.length, 0);
});

test('validateConfig flags missing core vars in production', () => {
  const { validateConfig } = require(path.join(ROOT, 'config', 'validateEnv.js'));
  const env = { NODE_ENV: 'production', JWT_SECRET: 'x' }; // everything else missing
  const { errors } = validateConfig(env);
  assert.ok(errors.some((e) => e.includes('DB_NAME')), 'must flag DB_NAME');
});

test('validateConfig does not require optional feature creds when feature is off', () => {
  const { validateConfig } = require(path.join(ROOT, 'config', 'validateEnv.js'));
  const env = { NODE_ENV: 'production', POSTMARK_TEST_MODE: 'true', JWT_SECRET: 'x', JWT_RESET_SECRET: 'x', STREAM_TOKEN_SECRET: 'x', DB_HOST: 'h', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'n' };
  const { errors } = validateConfig(env);
  // No Google/Postmark/Pesapal/Flutterwave configured -> no errors about them.
  assert.ok(!errors.some((e) => e.includes('POSTMARK_SERVER_TOKEN')), 'Postmark must not be required when not enabled');
  assert.ok(!errors.some((e) => e.includes('PESAPAL_CONSUMER_KEY')), 'Pesapal must not be required when not enabled');
});

test('validateConfig requires paired optional creds when the feature is partially configured', () => {
  const { validateConfig } = require(path.join(ROOT, 'config', 'validateEnv.js'));
  const env = { NODE_ENV: 'production', GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com' }; // secret missing
  const { errors } = validateConfig(env);
  assert.ok(errors.some((e) => e.includes('GOOGLE_CLIENT_SECRET')), 'must require secret when client id is set');
});

// ---- 2. Release identification ----
test('getReleaseInfo returns a safe, non-secret descriptor', () => {
  const { getReleaseInfo } = require(path.join(ROOT, 'config', 'releaseInfo.js'));
  const info = getReleaseInfo();
  assert.ok(typeof info === 'object');
  assert.ok('commit' in info && 'version' in info && 'deployVersion' in info && 'environment' in info);
  // No secret keys present.
  assert.ok(!('token' in info) && !('secret' in info) && !('password' in info));
});

// ---- 3. Readiness ----
function fakeDb({ select1Error, tableCount }) {
  return {
    async query(sql) {
      if (/SELECT 1/.test(sql)) {
        if (select1Error) throw select1Error;
        return [];
      }
      if (/information_schema/.test(sql)) {
        // mysql2 resolves to [rows, fields]; checkReadiness destructures `const [rows] = ...`.
        return [[{ c: tableCount }]];
      }
      return [];
    },
  };
}

test('checkReadiness returns ready when DB + schema are present', async () => {
  const { checkReadiness } = require(path.join(ROOT, 'config', 'readiness.js'));
  const result = await checkReadiness({ db: fakeDb({ tableCount: 2 }), requiredTables: ['t1', 't2'] });
  assert.strictEqual(result.ready, true);
  assert.strictEqual(result.checks.mysql, true);
  assert.strictEqual(result.checks.schema, true);
});

test('checkReadiness is not ready when MySQL is unreachable', async () => {
  const { checkReadiness } = require(path.join(ROOT, 'config', 'readiness.js'));
  const result = await checkReadiness({ db: fakeDb({ select1Error: new Error('connect failed') }), requiredTables: ['t1', 't2'] });
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reason, 'mysql-unreachable');
});

test('checkReadiness is not ready when schema state is missing', async () => {
  const { checkReadiness } = require(path.join(ROOT, 'config', 'readiness.js'));
  const result = await checkReadiness({ db: fakeDb({ tableCount: 0 }), requiredTables: ['t1', 't2'] });
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.checks.schema, false);
});

// ---- 4. Graceful shutdown ----
test('graceful shutdown closes the server and the db pool', async () => {
  const { installGracefulShutdown } = require(path.join(ROOT, 'config', 'shutdown.js'));
  const origExit = process.exit;
  let exitCode = null;
  process.exit = (c) => { exitCode = c; };

  const closed = [];
  const server = {
    close: (cb) => { closed.push('close'); cb(); },
    closeIdleConnections: () => {},
  };
  const poolEnded = [];
  const pool = { end: async () => { poolEnded.push('end'); } };

  try {
    const shutdown = installGracefulShutdown(server, { pool, timeoutMs: 1000 });
    shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(closed.length, 1, 'server.close must be called');
    assert.strictEqual(poolEnded.length, 1, 'pool.end must be called');
    assert.strictEqual(exitCode, 0, 'must exit cleanly');
  } finally {
    process.exit = origExit;
  }
});
