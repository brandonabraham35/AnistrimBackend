// tests/streamTokenRevocation.test.js
// Regression tests for stream-token revocation semantics (Phase H fix).
//
// Root cause under test: the in-memory user-wide 'all:<userId>' marker never
// expired and poisoned FUTURE sessions after any revokeAllForUser() — every
// newly minted token (fresh login, new session) was rejected with
// TOKEN_REVOKED until process restart. User-wide invalidation is enforced
// authoritatively by streamProxyController's live DB checks
// (users.token_version, user_sessions.revoked_at); the in-memory set must
// only track per-session ('sid:') revocations.
'use strict';

const assert = require('assert');

// streamToken reads STREAM_TOKEN_SECRET at require time — set it first.
process.env.STREAM_TOKEN_SECRET =
  process.env.STREAM_TOKEN_SECRET || 'test-only-stream-token-secret';

const {
  mint,
  verify,
  revokeSid,
  revokeAllForUser,
  isRevoked,
  TTL_MS,
} = require('../utils/streamToken');

const IP = '203.0.113.7';

function mintToken(overrides) {
  return mint(Object.assign({
    userId: '42',
    episodeId: '1590',
    streamId: 's0e11bab',
    ip: IP,
    sid: 'S1',
    tv: 3,
  }, overrides || {}));
}

describe('streamToken revocation semantics', function () {
  it('CASE A: accepts a valid token for an active session', function () {
    const token = mintToken();
    const r = verify(token, { userId: '42', episodeId: '1590', streamId: 's0e11bab', ip: IP });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  });

  it('CASE B: revokeSid(sid) → token carrying that sid is TOKEN_REVOKED', function () {
    const token = mintToken({ sid: 'SESS-B' });
    assert.strictEqual(verify(token, { ip: IP }).ok, true);
    revokeSid('SESS-B');
    const r = verify(token, { ip: IP });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.reason, 'TOKEN_REVOKED');
    assert.strictEqual(isRevoked({ userId: '42', sid: 'SESS-B', tv: 3 }), true);
  });

  it('CASE B: revokeSid(sid) does not affect other sessions or users', function () {
    const other = mintToken({ sid: 'SESS-OTHER', userId: '43' });
    revokeSid('SESS-B');
    const r = verify(other, { ip: IP });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(isRevoked({ userId: '43', sid: 'SESS-OTHER' }), false);
  });

  it('CASE C (the bug): revokeAllForUser() must NOT poison newly minted tokens for the same user', function () {
    revokeAllForUser('42');
    const fresh = mintToken({ sid: 'SESS-C-NEW' });
    const r = verify(fresh, { ip: IP });
    assert.strictEqual(
      r.ok,
      true,
      'a fresh session token must be accepted after revokeAllForUser: ' + JSON.stringify(r)
    );
    assert.strictEqual(isRevoked({ userId: '42', sid: 'SESS-C-NEW', tv: 3 }), false);
  });

  it('CASE C: revokeAllForUser() leaves no user-wide marker behind', function () {
    revokeAllForUser('777', 9);
    assert.strictEqual(isRevoked({ userId: '777', sid: '' }), false);
    assert.strictEqual(isRevoked({ userId: '777', tv: 1 }), false);
  });

  it('HMAC tamper detection is unchanged', function () {
    const token = mintToken();
    const parts = token.split('.');
    const payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    assert.ok(payload.includes('"userId":"42"'), 'payload shape changed: ' + payload);
    const tampered = Buffer.from(payload.replace('"userId":"42"', '"userId":"43"')).toString('base64url');
    const r = verify(tampered + '.' + parts[1], {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'TOKEN_INVALID');
  });

  it('IP binding is unchanged (IP_MISMATCH on different ip, accepted on same ip)', function () {
    const token = mintToken();
    assert.strictEqual(verify(token, { ip: '198.51.100.9' }).reason, 'IP_MISMATCH');
    assert.strictEqual(verify(token, { ip: IP }).ok, true);
  });

  it('Expiry is unchanged (expired token → TOKEN_EXPIRED)', function () {
    const token = mintToken({ ttlMs: -1000 });
    const r = verify(token, {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'TOKEN_EXPIRED');
  });

  it('tv binding is unchanged (TV_MISMATCH on version bump)', function () {
    const token = mintToken({ tv: 3 });
    assert.strictEqual(verify(token, { tv: 4 }).reason, 'TV_MISMATCH');
    assert.strictEqual(verify(token, { tv: 3 }).ok, true);
  });

  it('Stream-token TTL remains 120 s', function () {
    assert.strictEqual(TTL_MS, 120 * 1000);
  });
});