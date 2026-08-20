// test/observability.test.js — automated tests for API request-ID observability.
//
// Verifies:
//   - every API request receives a unique request ID (req.requestId + X-Request-Id header)
//   - incoming well-formed request IDs are accepted (safe policy)
//   - incoming malformed / unsafe request IDs are rejected and regenerated
//   - errors return the same requestId in the response body
//   - request IDs are unique across requests
//   - requestId is included in the per-request API log (api_request_log)
//   - sensitive tokens/credentials are redacted (never logged)

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const requestIdMiddleware = require('../middleware/requestId');
const errorHandler = require('../middleware/errorHandler');
const requestMetricsMiddleware = require('../middleware/requestMetrics');
const { redact, redactString } = require('../utils/redact');
const { ApiError } = require('../utils/apiError');

// ── Helper: minimal app with requestId + errorHandler ─────────
function createApp() {
  const app = express();
  app.use(requestIdMiddleware);

  // Echo endpoint: returns req.requestId and an endpoint-specific marker.
  app.get('/api/echo', (req, res) => {
    res.json({ requestId: req.requestId, ok: true });
  });

  // Error endpoint: throws ApiError — response body must carry same requestId.
  app.get('/api/error', (req, res, next) => {
    next(new ApiError(500, 'TEST_BOOM', 'boom', {}));
  });

  app.use(errorHandler);
  const server = http.createServer(app);
  return server.listen(0, () => {});
}

function request(server, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 1. Every request receives an ID ────────────────────────────
test('observability: every API request receives a request ID', async (t) => {
  const server = createApp();
  t.after(() => server.close());
  const res = await request(server, '/api/echo');
  assert.ok(res.json.requestId, 'req.requestId must be set');
  assert.match(res.json.requestId, /^req_[A-Za-z0-9_-]+$/, 'must match req_ format');
  assert.ok(res.headers['x-request-id'], 'must echo X-Request-Id header');
  assert.equal(res.headers['x-request-id'], res.json.requestId);
});

// ── 2. Errors return the same requestId ────────────────────────
test('observability: error responses carry the requestId in the body', async (t) => {
  const server = createApp();
  t.after(() => server.close());
  const res = await request(server, '/api/error');
  assert.equal(res.status, 500);
  assert.ok(res.json.error.requestId, 'error body must include requestId');
  assert.match(res.json.error.requestId, /^req_/, 'error requestId must be req_ prefixed');
  assert.equal(res.json.error.requestId, res.headers['x-request-id'], 'body + header requestIds must match');
});

// ── 3. Well-formed incoming ID is accepted (safe policy) ───────
test('observability: well-formed incoming X-Request-Id is accepted', async (t) => {
  const server = createApp();
  t.after(() => server.close());
  const incoming = 'req_myTraceId123';
  const res = await request(server, '/api/echo', { 'X-Request-Id': incoming });
  assert.equal(res.json.requestId, incoming, 'well-formed incoming ID must be used');
});

// ── 4. Malformed / unsafe incoming ID is rejected + regenerated ─
test('observability: malformed incoming X-Request-Id is ignored and a fresh ID generated', async (t) => {
  const server = createApp();
  t.after(() => server.close());
  // Unsafe: lacks req_ prefix, contains spaces / injection characters.
  const res = await request(server, '/api/echo', { 'X-Request-Id': 'evil||inject <script>alert(1)</script>' });
  assert.notEqual(res.json.requestId, 'evil||inject <script>alert(1)</script>');
  assert.match(res.json.requestId, /^req_/, 'must generate a fresh req_ ID');
});

test('observability: overly long incoming X-Request-Id is rejected + regenerated', async (t) => {
  const server = createApp();
  t.after(() => server.close());
  const giant = 'req_' + 'x'.repeat(200);
  const res = await request(server, '/api/echo', { 'X-Request-Id': giant });
  assert.notEqual(res.json.requestId, giant);
  assert.ok(res.json.requestId.length <= 100, 'generated ID must be bounded');
});

// ── 5. IDs are unique across requests ──────────────────────────
test('observability: generated request IDs are unique across requests', async (t) => {
  const server = createApp();
  t.after(() => server.close());
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const res = await request(server, '/api/echo');
    const id = res.json.requestId;
    assert.ok(!seen.has(id), 'request ID must be unique');
    seen.add(id);
  }
});

// ── 5b. requestId is included in per-request API logs ─────────
test('observability: requestId is included in the api_request_log record', async (t) => {
  // Mock the DB driver so no real connection is needed. Capture the INSERT so
  // we can assert requestId is persisted alongside method/path/status/latency.
  const dbMock = require('../config/db');
  const originalQuery = dbMock.query;
  const inserts = [];
  dbMock.query = (sql, params) => {
    inserts.push({ sql, params });
    return Promise.resolve({ rows: [] });
  };
  t.after(() => { dbMock.query = originalQuery; });

  const app = express();
  app.use(requestIdMiddleware);
  app.use((req, res, next) => { req.originalUrl = '/api/echo-probe'; next(); });
  app.use(requestMetricsMiddleware);
  app.get('/api/echo-probe', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app).listen(0, () => {});
  t.after(() => server.close());

  const res = await request(server, '/api/echo-probe');
  assert.equal(res.status, 200);
  assert.ok(inserts.length >= 1, 'must emit an api_request_log INSERT');

  const insert = inserts.find((r) => r.sql.includes('api_request_log') && r.sql.includes('request_id'));
  assert.ok(insert, 'INSERT must include request_id column');
  assert.equal(insert.params[0], res.headers['x-request-id'], 'requestId must match the response header');
  assert.equal(insert.params[1], 'GET', 'method must be recorded');
  assert.equal(insert.params[2], '/api/echo-probe', 'path must be recorded');
  assert.equal(insert.params[3], 200, 'status must be recorded');
  assert.ok(insert.params[4] >= 0, 'latency must be recorded');
});

// ── 6. Sensitive tokens/credentials are redacted ───────────────
test('observability: redactString scrubs access tokens', () => {
  const out = redactString('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig1234567890');
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), 'must redact JWT');
  assert.ok(out.includes('[REDACTED]'), 'must replace with [REDACTED]');
});

test('observability: redactString scrubs passwords', () => {
  const out = redactString('password=supersecret123');
  assert.ok(!out.includes('supersecret123'), 'must redact password value');
  assert.ok(out.includes('[REDACTED]'), 'must replace with [REDACTED]');
});

test('observability: redactString scrubs stream tokens', () => {
  const out = redactString('token=7f3a9b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a');
  assert.ok(!out.includes('7f3a9b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a'), 'must redact stream token');
});

test('observability: redactString scrubs refresh tokens', () => {
  const out = redactString('refresh_token=abcdef1234567890abcdef1234567890');
  assert.ok(!out.includes('abcdef1234567890abcdef1234567890'), 'must redact refresh token');
});

test('observability: redactString scrubs emails', () => {
  const out = redactString('user email is jirabo@example.com');
  assert.ok(!out.includes('jirabo@example.com'), 'must redact email');
  assert.ok(out.includes('[REDACTED]'), 'must replace email');
});

test('observability: redactObject scrubs sensitive keys anywhere in an object', () => {
  const obj = {
    requestId: 'req_1',
    user: { password: 'secret', email: 'a@b.com', name: 'Jirabo' },
    config: { client_secret: 'xyz' },
  };
  const out = redact(obj);
  assert.equal(out.user.password, '[REDACTED]');
  assert.equal(out.config.client_secret, '[REDACTED]');
  assert.ok(!Object.values(JSON.parse(JSON.stringify(out))).join('|').includes('secret'));
});

test('observability: errorHandler does not leak tokens in the response body', async (t) => {
  // Build a special app whose error message contains a fake token/secret.
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/api/leak', (req, res, next) => {
    const err = new Error('DB error: token=SECRETTOKEN123 password=password123 email=jirabo@example.com');
    err.status = 500;
    next(err);
  });
  app.use(errorHandler);
  const server = http.createServer(app).listen(0, () => {});
  t.after(() => server.close());

  const res = await request(server, '/api/leak');
  // In production the generic message is used; but regardless, no tokens leak.
  const bodyString = JSON.stringify(res.json);
  assert.ok(!bodyString.includes('SECRETTOKEN123'), 'must not leak the token in response');
  assert.ok(!bodyString.includes('password123'), 'must not leak password in response');
});