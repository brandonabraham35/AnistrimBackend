// test/cors.test.js — automated CORS boundary tests.
//
// Verifies the environment-driven CORS configuration (config/cors.js):
//   - allowed web origin
//   - allowed admin origin
//   - allowed Capacitor origin
//   - disallowed origin
//   - missing Origin
//   - OPTIONS preflight
//   - Authorization header preserved
//
// These are unit + integration tests that do NOT require a live database.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const ROOT = path.join(__dirname, '..');

// ── Helper: run a request against a minimal express app using the CORS config ──
function createAppForTest(envOverrides) {
  // Preserve the original env, apply overrides for the test, restore after.
  const originalEnv = { ...process.env };
  Object.keys(envOverrides || {}).forEach((k) => {
    if (envOverrides[k] === undefined) delete process.env[k];
    else process.env[k] = envOverrides[k];
  });

  // Re-require the module fresh so it reads the patched env.
  delete require.cache[require.resolve('../config/cors')];
  const corsConfig = require('../config/cors');
  const corsMiddleware = require('cors');

  const app = express();
  app.use(corsMiddleware(corsConfig.buildCorsOptions()));

  // Echo endpoint to verify Authorization header and simple GET response.
  app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', auth: req.headers.authorization || null });
  });
  app.options('/api/health', corsMiddleware(corsConfig.buildCorsOptions()), (req, res) => {
    res.status(200).json({ ok: true });
  });

  const server = http.createServer(app);
  return server.listen(0, () => {});
}

function request(server, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, ...options }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 1. Unit: parseOrigins ──────────────────────────────────────
test('CORS: parseOrigins parses comma-separated origins', () => {
  const { parseOrigins } = require('../config/cors');
  const set = parseOrigins('https://a.com, https://b.com ,,https://c.com');
  assert.deepEqual([...set], ['https://a.com', 'https://b.com', 'https://c.com']);
});

test('CORS: parseOrigins returns empty set for empty input', () => {
  const { parseOrigins } = require('../config/cors');
  assert.equal(parseOrigins('').size, 0);
  assert.equal(parseOrigins(undefined).size, 0);
});

test('CORS: parseOrigins handles whitespace/commas only', () => {
  const { parseOrigins } = require('../config/cors');
  assert.equal(parseOrigins(' , , ').size, 0);
});

// ── 2. Unit: buildAllowedOrigins (dev auto-adds localhost) ─────
test('CORS: dev mode auto-adds localhost, 127.0.0.1, capacitor, and https://localhost', () => {
  const originalEnv = { ...process.env };
  process.env.NODE_ENV = 'development';
  delete process.env.API_ALLOWED_ORIGINS;
  delete require.cache[require.resolve('../config/cors')];
  const { buildAllowedOrigins } = require('../config/cors');

  const set = buildAllowedOrigins();
  assert.ok(set.has('http://localhost:3000'), 'must include localhost:3000');
  assert.ok(set.has('http://127.0.0.1:3000'), 'must include 127.0.0.1:3000');
  assert.ok(set.has('capacitor://localhost'), 'must include capacitor://localhost');
  assert.ok(set.has('https://localhost'), 'must include https://localhost');
  process.env = originalEnv;
});

test('CORS: production mode does NOT auto-add localhost', () => {
  const originalEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  delete process.env.API_ALLOWED_ORIGINS;
  delete require.cache[require.resolve('../config/cors')];
  const { buildAllowedOrigins } = require('../config/cors');

  const set = buildAllowedOrigins();
  assert.ok(!set.has('http://localhost:3000'), 'production must NOT auto-add localhost');
  assert.ok(!set.has('capacitor://localhost'), 'production must NOT auto-add capacitor');
  process.env = originalEnv;
});

// ── 3. Unit: isOriginAllowed ───────────────────────────────────
test('CORS: allowed explicit web origin is accepted', () => {
  const { isOriginAllowed } = require('../config/cors');
  const set = new Set(['https://anistrim.com']);
  assert.equal(isOriginAllowed('https://anistrim.com', set), true);
});

test('CORS: allowed admin origin is accepted', () => {
  const { isOriginAllowed } = require('../config/cors');
  const set = new Set(['https://admin.anistrim.com']);
  assert.equal(isOriginAllowed('https://admin.anistrim.com', set), true);
});

test('CORS: allowed Capacitor origin is accepted', () => {
  const { isOriginAllowed } = require('../config/cors');
  const set = new Set(['capacitor://localhost', 'https://localhost']);
  assert.equal(isOriginAllowed('capacitor://localhost', set), true);
  assert.equal(isOriginAllowed('https://localhost', set), true);
});

test('CORS: disallowed origin is rejected', () => {
  const { isOriginAllowed } = require('../config/cors');
  const set = new Set(['https://anistrim.com']);
  assert.equal(isOriginAllowed('https://evil.com', set), false);
  assert.equal(isOriginAllowed('https://anistrim.com.evil.com', set), false);
});

test('CORS: missing Origin (curl/server-to-server) is allowed', () => {
  const { isOriginAllowed } = require('../config/cors');
  const set = new Set(['https://anistrim.com']);
  assert.equal(isOriginAllowed(undefined, set), true);
  assert.equal(isOriginAllowed(null, set), true);
  assert.equal(isOriginAllowed('', set), true);
});

// ── 4. Integration: express app with cors middleware ───────────
test('CORS: OPTIONS preflight to allowed origin returns Access-Control-Allow-Origin and 200', async (t) => {
  const originalEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.API_ALLOWED_ORIGINS = 'https://anistrim.com,https://admin.anistrim.com';
  const server = createAppForTest({ NODE_ENV: 'production', API_ALLOWED_ORIGINS: 'https://anistrim.com,https://admin.anistrim.com' });
  t.after(() => server.close());

  const res = await request(server, {
    method: 'OPTIONS',
    path: '/api/health',
    headers: {
      Origin: 'https://anistrim.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Content-Type, Authorization',
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'https://anistrim.com');
  assert.ok(!res.headers['access-control-allow-credentials'], 'credentials must NOT be allowed (Bearer JWT auth)');
  process.env = originalEnv;
});

test('CORS: OPTIONS preflight preserves Authorization header in allowed headers', async (t) => {
  const originalEnv = { ...process.env };
  const server = createAppForTest({ NODE_ENV: 'production', API_ALLOWED_ORIGINS: 'https://anistrim.com' });
  t.after(() => server.close());

  const res = await request(server, {
    method: 'OPTIONS',
    path: '/api/health',
    headers: {
      Origin: 'https://anistrim.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Authorization',
    },
  });

  assert.equal(res.status, 200);
  assert.ok(res.headers['access-control-allow-headers'].includes('Authorization'), 'must allow Authorization header');
  process.env = originalEnv;
});

test('CORS: disallowed origin does NOT get Access-Control-Allow-Origin', async (t) => {
  const originalEnv = { ...process.env };
  const server = createAppForTest({ NODE_ENV: 'production', API_ALLOWED_ORIGINS: 'https://anistrim.com' });
  t.after(() => server.close());

  const res = await request(server, {
    method: 'GET',
    path: '/api/health',
    headers: { Origin: 'https://evil.com', Authorization: 'Bearer test-token' },
  });

  // The request may still return 200 (it's a valid API path), but must NOT
  // include the CORS allow-origin header — browser will block it.
  assert.notEqual(res.headers['access-control-allow-origin'], 'https://evil.com');
  process.env = originalEnv;
});

test('CORS: allowed web origin GET with Authorization header works', async (t) => {
  const originalEnv = { ...process.env };
  const server = createAppForTest({ NODE_ENV: 'production', API_ALLOWED_ORIGINS: 'https://anistrim.com' });
  t.after(() => server.close());

  const res = await request(server, {
    method: 'GET',
    path: '/api/health',
    headers: { Origin: 'https://anistrim.com', Authorization: 'Bearer test-token' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'https://anistrim.com');
  const body = JSON.parse(res.body);
  assert.equal(body.auth, 'Bearer test-token', 'Authorization header must reach the endpoint');
  process.env = originalEnv;
});

test('CORS: request without Origin (curl / server-to-server) works', async (t) => {
  const originalEnv = { ...process.env };
  const server = createAppForTest({ NODE_ENV: 'production', API_ALLOWED_ORIGINS: 'https://anistrim.com' });
  t.after(() => server.close());

  const res = await request(server, { method: 'GET', path: '/api/health' });
  assert.equal(res.status, 200);
  process.env = originalEnv;
});

// ── 5. Static: server.js uses the config module (not hardcoded origins) ──
test('CORS: server.js delegates to config/cors.js (no hardcoded origin set)', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(serverSrc, /config\/cors.*buildCorsOptions/, 'server.js must use config/cors.js');
  assert.ok(!serverSrc.includes('allowedOrigins = new Set(['), 'server.js must not hardcode origins');
  assert.ok(!serverSrc.includes('http://10.5.50.55:3000'), 'server.js must not hardcode LAN origin');
});

test('CORS: config module does not use a wildcard * in production', () => {
  const corsSrc = fs.readFileSync(path.join(ROOT, 'config', 'cors.js'), 'utf8');
  assert.ok(!/origin\s*\(\s*origin\s*,\s*callback\s*\)\s*\{\s*return callback\(null, ['"]\*['"]\)/.test(corsSrc), 'must never return * origin');
  assert.ok(!corsSrc.includes('credentials: true'), 'credentials must not be true (Bearer JWT auth)');
});
