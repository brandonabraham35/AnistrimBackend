// test/successContract.test.js — automated tests for the centralized SUCCESS
// response contract (mirrors utils/response.js).
//
// Verifies:
//   - sendSuccess produces { success:true, data, meta? }
//   - sendAuth preserves { token, refreshToken, sessionId, user } under data
//   - sendPaginated produces { success:true, data:[...], meta:{ pagination } }
//   - buildPaginationMeta computes page/perPage/totalItems/totalPages/ hasNext/hasPrev
//   - the frontend envelope shim (Frontend/js/api.js unwrapEnvelope) and the
//     admin shim (AdminDashboard/js/api.js unwrapAdminEnvelope) unwrap the
//     envelope back so legacy consumers keep working.

const { test } = require('node:test');
const assert = require('node:assert');
const { sendSuccess, sendAuth, sendPaginated, buildPaginationMeta } = require('../utils/response');

// ── Mock Express res ───────────────────────────────────────
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (body) { res.body = body; return res; };
  return res;
}

// ── 1. buildPaginationMeta ────────────────────────────────
test('buildPaginationMeta: totalPages, hasNext, hasPrev', () => {
  const meta = buildPaginationMeta(1, 20, 408);
  assert.equal(meta.pagination.page, 1);
  assert.equal(meta.pagination.perPage, 20);
  assert.equal(meta.pagination.totalItems, 408);
  assert.equal(meta.pagination.totalPages, 21); // ceil(408/20)
  assert.equal(meta.pagination.hasNext, true);
  assert.equal(meta.pagination.hasPrev, false);
});

test('buildPaginationMeta: hasPrev true when page > 1', () => {
  const meta = buildPaginationMeta(2, 10, 50);
  assert.equal(meta.pagination.totalPages, 5);
  assert.equal(meta.pagination.hasNext, true);
  assert.equal(meta.pagination.hasPrev, true);
});

test('buildPaginationMeta: handles invalid/zico inputs', () => {
  const meta = buildPaginationMeta(0, 0, 0);
  assert.equal(meta.pagination.page, 1);
  assert.equal(meta.pagination.perPage, 1);
  assert.equal(meta.pagination.totalItems, 0);
  assert.equal(meta.pagination.totalPages, 1);
});

// ── 2. sendSuccess ─────────────────────────────────────────
test('sendSuccess: single resource envelope', () => {
  const res = mockRes();
  sendSuccess(res, { id: 1, title: 'One' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data, { id: 1, title: 'One' });
  assert.equal(res.body.meta, undefined);
});

test('sendSuccess: includes meta and custom status', () => {
  const res = mockRes();
  sendSuccess(res, { id: 5 }, { message: 'Created!' }, 201);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.meta, { message: 'Created!' });
});

// ── 3. sendAuth ────────────────────────────────────────────
test('sendAuth: preserves token/refreshToken/sessionId/user under data', () => {
  const res = mockRes();
  const auth = {
    token: 'abc',
    refreshToken: 'def',
    sessionId: 'sid-1',
    user: { id: 7, name: 'Test' },
  };
  sendAuth(res, auth);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.token, 'abc');
  assert.equal(res.body.data.refreshToken, 'def');
  assert.equal(res.body.data.sessionId, 'sid-1');
  assert.deepEqual(res.body.data.user, { id: 7, name: 'Test' });
});

test('sendAuth: merges extra fields onto data', () => {
  const res = mockRes();
  sendAuth(res, { token: 't', user: { id: 1 }, extra: { message: 'Welcome' } });
  assert.equal(res.body.data.message, 'Welcome');
});

// ── 4. sendPaginated ───────────────────────────────────────
test('sendPaginated: list envelope with pagination meta', () => {
  const res = mockRes();
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  sendPaginated(res, items, { page: 1, perPage: 20, totalItems: 408 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data, items);
  assert.deepEqual(res.body.meta.pagination, buildPaginationMeta(1, 20, 408).pagination);
});

test('sendPaginated: merges extra meta alongside pagination', () => {
  const res = mockRes();
  sendPaginated(res, [{ id: 1 }], { page: 1, perPage: 2, totalItems: 10 }, { summary: { total: 10 } });
  assert.equal(res.body.meta.summary.total, 10);
  assert.ok(res.body.meta.pagination, 'pagination present');
});

test('sendPaginated: coerces non-array data to []', () => {
  const res = mockRes();
  sendPaginated(res, null, { page: 1, perPage: 10, totalItems: 0 });
  assert.deepEqual(res.body.data, []);
});

// ── 5. Frontend shim model (unwrapEnvelope-equivalent) ─────
// Mirrors the exact logic in Frontend/js/api.js so the promise of backward
// compatibility is locked in by a test.
function unwrapFrontend(envelope) {
  if (!envelope || !envelope.data || typeof envelope.data !== 'object') return envelope;
  var body = envelope.data;
  // Paginated list branch FIRST (matches Frontend/js/api.js updated order).
  if (body.success === true && Object.prototype.hasOwnProperty.call(body, 'data') && Array.isArray(body.data)) {
    var arr = body.data;
    return { ok: envelope.ok, status: envelope.status, data: Object.assign({ items: arr, rows: arr }, body.meta) };
  }
  if (body.success === true && Object.prototype.hasOwnProperty.call(body, 'data')) {
    var inner = body.data;
    var result = (typeof inner === 'object' && inner !== null) ? Object.assign({}, inner) : inner;
    if (body.meta && typeof body.meta === 'object' && result !== null && typeof result === 'object') {
      result = Object.assign(result, body.meta);
    }
    if (result === null || result === undefined) result = {};
    return { ok: envelope.ok, status: envelope.status, data: result };
  }
  return envelope;
}

test('frontend shim: unwraps single-resource envelope + merges meta', () => {
  const envelope = { ok: true, status: 200, data: { success: true, data: { id: 1, title: 'Anime' }, meta: { extra: 1 } } };
  const out = unwrapFrontend(envelope);
  assert.equal(out.data.id, 1);
  assert.equal(out.data.title, 'Anime');
  assert.equal(out.data.extra, 1);
});

test('frontend shim: unwraps auth envelope → data.token/user preserved', () => {
  const envelope = { ok: true, status: 200, data: { success: true, data: { token: 'abc', user: { id: 1 } } } };
  const out = unwrapFrontend(envelope);
  assert.equal(out.data.token, 'abc');
  assert.equal(out.data.user.id, 1);
});

test('frontend shim: paginated list → items/rows/pagination', () => {
  const envelope = { ok: true, status: 200, data: { success: true, data: [{ id: 1 }], meta: { pagination: { page: 1, totalPages: 2 } } } };
  const out = unwrapFrontend(envelope);
  assert.deepEqual(out.data.items, [{ id: 1 }]);
  assert.deepEqual(out.data.rows, [{ id: 1 }]);
  assert.equal(out.data.pagination.page, 1);
});

// ── 6. Admin shim model (unwrapAdminEnvelope-equivalent) ───
function unwrapAdmin(body) {
  if (!body || typeof body !== 'object') return body;
  if (body.success === true && Object.prototype.hasOwnProperty.call(body, 'data')) {
    const inner = body.data;
    if (Array.isArray(inner)) {
      const merged = { items: inner, rows: inner };
      if (body.meta && typeof body.meta === 'object') Object.assign(merged, body.meta);
      return merged;
    }
    if (typeof inner === 'object' && inner !== null) {
      const merged = Object.assign({}, inner);
      if (body.meta && typeof body.meta === 'object') Object.assign(merged, body.meta);
      return merged;
    }
    return inner;
  }
  return body;
}

test('admin shim: unwraps envelope data + merges meta', () => {
  const body = { success: true, data: { overview: { users: { total: 5 } } } };
  const out = unwrapAdmin(body);
  assert.equal(out.overview.users.total, 5);
});

test('admin shim: unwraps paginated list → items/rows/summary/pagination', () => {
  const body = { success: true, data: [{ id: 1 }], meta: { pagination: { page: 1 }, summary: { total: 3 } } };
  const out = unwrapAdmin(body);
  assert.deepEqual(out.items, [{ id: 1 }]);
  assert.deepEqual(out.rows, [{ id: 1 }]);
  assert.equal(out.pagination.page, 1);
  assert.equal(out.summary.total, 3);
});