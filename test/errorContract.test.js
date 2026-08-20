// test/errorContract.test.js — automated tests for the centralized API error contract.
//
// Verifies utils/apiError.js, middleware/requestId.js, and middleware/errorHandler.js:
//   - all errors carry { success:false, error: { code, message, details, requestId } }
//   - machine-readable codes mapped for 400/401/403/404/409/422/429/500/502/503/504
//   - requestId present and echoed in X-Request-Id header
//   - never leaks stack traces in production
//   - preserves HTTP status codes
//   - premium details (requiredTier, availableAt) preserved in details

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const {
  ApiError,
  STATUS_CODES,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  validation,
  rateLimited,
  internal,
  badGateway,
  serviceUnavailable,
  gatewayTimeout,
  buildErrorBody,
} = require('../utils/apiError');
const requestId = require('../middleware/requestId');
const errorHandler = require('../middleware/errorHandler');

// ── Helper: minimal express app with requestId + errorHandler ──
function createErrorApp() {
  const app = express();
  app.use(requestId);
  app.get('/api/throw/:status', (req, res, next) => {
    const status = Number(req.params.status);
    const err = new ApiError(status, 'TEST_ERROR', 'test message', { foo: 'bar' });
    next(err);
  });
  app.get('/api/plain-error', (req, res, next) => {
    const err = new Error('internal DB secret table/users password_hash=xxx');
    next(err);
  });
  app.get('/api/premium', (req, res, next) => {
    const err = new ApiError(403, 'PREMIUM_REQUIRED', 'Premium subscription required.', {
      requiredTier: 'premium',
      availableAt: '2026-09-01',
    });
    next(err);
  });
  app.use(errorHandler);
  const server = http.createServer(app);
  return server.listen(0, () => {});
}

function request(server, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 1. ApiError class ─────────────────────────────────────────
test('ApiError: defaults code from status, message from code', () => {
  const e = new ApiError(404);
  assert.equal(e.status, 404);
  assert.equal(e.code, 'NOT_FOUND');
  assert.equal(e.isApiError, true);
});

test('ApiError: preserves custom code/message/details', () => {
  const e = new ApiError(403, 'PREMIUM_REQUIRED', 'Upgrade needed.', { requiredTier: 'gold' });
  assert.equal(e.code, 'PREMIUM_REQUIRED');
  assert.equal(e.message, 'Upgrade needed.');
  assert.deepEqual(e.details, { requiredTier: 'gold' });
});

// ── 2. STATUS_CODES mapping ───────────────────────────────────
test('STATUS_CODES: maps all required statuses', () => {
  assert.equal(STATUS_CODES[400], 'BAD_REQUEST');
  assert.equal(STATUS_CODES[401], 'UNAUTHORIZED');
  assert.equal(STATUS_CODES[403], 'FORBIDDEN');
  assert.equal(STATUS_CODES[404], 'NOT_FOUND');
  assert.equal(STATUS_CODES[409], 'CONFLICT');
  assert.equal(STATUS_CODES[422], 'VALIDATION_ERROR');
  assert.equal(STATUS_CODES[429], 'RATE_LIMITED');
  assert.equal(STATUS_CODES[500], 'INTERNAL_ERROR');
  assert.equal(STATUS_CODES[502], 'BAD_GATEWAY');
  assert.equal(STATUS_CODES[503], 'SERVICE_UNAVAILABLE');
  assert.equal(STATUS_CODES[504], 'GATEWAY_TIMEOUT');
});

// ── 3. Factory helpers ────────────────────────────────────────
test('factory helpers produce correct statuses + codes', () => {
  assert.equal(badRequest('BAD', 'm').status, 400);
  assert.equal(unauthorized('UNAUTH', 'm').status, 401);
  assert.equal(forbidden('FORBID', 'm').status, 403);
  assert.equal(notFound('NF', 'm').status, 404);
  assert.equal(conflict('CONF', 'm').status, 409);
  assert.equal(validation('VAL', 'm').status, 422);
  assert.equal(rateLimited('RATE', 'm').status, 429);
  assert.equal(internal('INT', 'm').status, 500);
  assert.equal(badGateway('BG', 'm').status, 502);
  assert.equal(serviceUnavailable('SU', 'm').status, 503);
  assert.equal(gatewayTimeout('GT', 'm').status, 504);
});

// ── 4. buildErrorBody ─────────────────────────────────────────
test('buildErrorBody: includes requestId when req.requestId set', () => {
  const body = buildErrorBody(new ApiError(404, 'NOT_FOUND', 'gone'), { requestId: 'req_abc' });
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(body.error.message, 'gone');
  assert.equal(body.error.requestId, 'req_abc');
});

test('buildErrorBody: never leaks stack for plain Error in production', () => {
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const body = buildErrorBody(new Error('secret password_hash=abc path=/etc/passwd'), { requestId: 'req_1' });
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.ok(!body.error.message.includes('password_hash'), 'must not leak internal fields');
  assert.ok(!body.error.message.includes('/etc/passwd'), 'must not leak paths');
  process.env.NODE_ENV = origEnv;
});

test('buildErrorBody: preserves premium details in business error', () => {
  const err = new ApiError(403, 'PREMIUM_REQUIRED', 'Upgrade.', { requiredTier: 'premium', availableAt: '2026-09-01' });
  const body = buildErrorBody(err, { requestId: 'req_2' });
  assert.equal(body.error.code, 'PREMIUM_REQUIRED');
  assert.equal(body.error.details.requiredTier, 'premium');
  assert.equal(body.error.details.availableAt, '2026-09-01');
});

// ── 5. Integration: requestId + errorHandler ──────────────────
test('integration: error responses carry success:false, error object, and X-Request-Id', async (t) => {
  const server = createErrorApp();
  t.after(() => server.close());
  const res = await request(server, '/api/throw/404');
  assert.equal(res.status, 404);
  assert.equal(res.json.success, false);
  assert.equal(res.json.error.code, 'TEST_ERROR');
  assert.equal(res.json.error.message, 'test message');
  assert.deepEqual(res.json.error.details, { foo: 'bar' });
  assert.ok(res.json.error.requestId, 'must include requestId');
  assert.ok(res.headers['x-request-id'], 'must include X-Request-Id header');
});

test('integration: plain Error → 500 INTERNAL_ERROR without leaking internals', async (t) => {
  const server = createErrorApp();
  t.after(() => server.close());
  const res = await request(server, '/api/plain-error');
  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, 'INTERNAL_ERROR');
  assert.ok(!res.json.error.message.includes('password_hash'), 'must not leak');
  assert.ok(!res.json.error.message.includes('/etc/passwd'), 'must not leak paths');
});

test('integration: premium error preserves requiredTier + availableAt in details', async (t) => {
  const server = createErrorApp();
  t.after(() => server.close());
  const res = await request(server, '/api/premium');
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'PREMIUM_REQUIRED');
  assert.equal(res.json.error.details.requiredTier, 'premium');
  assert.equal(res.json.error.details.availableAt, '2026-09-01');
});