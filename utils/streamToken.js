// utils/streamToken.js — Phase 10 (item 21) short-lived stream authorization.
//
// POST /api/stream/authorize { episodeId } → canWatch() → mints an HMAC-signed
// token bound to userId + episodeId + streamId + ip, valid 120 s. /api/stream-
// proxy/:streamId accepts ONLY this token (via ?token= or Bearer).
//
// FIX 5 (P1): adds sid (session id) + tv (token_version) to the payload, plus
// an in-memory revocation set for revoked SESSION ids. Session revocation
// (logout / revokeSession) adds the sid to the set; user-wide invalidation
// (logout-all / password change / suspension / refresh-token reuse) is
// enforced by the proxy's live DB checks — users.token_version vs the token's
// tv, and user_sessions.revoked_at vs the token's sid — NOT by an in-memory
// user-wide marker (a permanent user-wide marker poisoned every future
// session; see revokeAllForUser). This kills in-flight playback (within one
// segment fetch) after logout/suspend/premium-expiry, while the 120 s TTL
// remains as defense in depth.
const crypto = require('crypto');

const TTL_MS = 120 * 1000; // 120 s

// Long-lived TTL for scoped "hls-child" tokens embedded in rewritten HLS child
// URLs (segments/variant playlists/keys). A manifest rewrite happens once per
// playback start, so child URLs must stay valid for a whole viewing session —
// they can ONLY be used for child (?url=) requests, never for the parent
// manifest (scope is enforced in streamProxyController).
const CHILD_TTL_MS = 6 * 60 * 60 * 1000; // 6 h

// ── In-memory revocation set ──────────────────────────────
// Contains revoked SESSION ids only ('sid:<sessionId>'), added by revokeSid()
// on logout / session revocation. Checked on every /api/stream-proxy/:streamId
// request (see isRevoked).
//
// USER-WIDE INVALIDATION IS DELIBERATELY NOT TRACKED HERE. A previous
// implementation also stored a permanent 'all:<userId>' marker on logout-all /
// password change / suspension. That marker had NO expiry and permanently
// poisoned every FUTURE session: after any revokeAllForUser(), newly minted
// tokens (fresh login, new session) were rejected with TOKEN_REVOKED until
// process restart. User-wide invalidation is instead enforced
// authoritatively at verify time by streamProxyController's live DB checks:
//   • users.token_version      vs the token's tv claim  → TV_MISMATCH
//   • user_sessions.revoked_at vs the token's sid       → session revoked
// revokeAllSessions() revokes every user_sessions row BEFORE calling
// revokeAllForUser(), so all pre-existing tokens die via the session check
// (within one segment fetch), while future sessions remain unaffected.
const revoked = new Set();
// 'sid:' entries only need to outlive the 120 s token TTL; the DB session
// check remains authoritative afterwards. Cap the set to bound memory.
const MAX_REVOKED_ENTRIES = 20000;
function capRevoked() {
  if (revoked.size > MAX_REVOKED_ENTRIES) {
    // Drop oldest — the exact order doesn't matter because a revoked session
    // is only meaningful within its 120s token window anyway.
    const it = revoked.values();
    while (revoked.size > MAX_REVOKED_ENTRIES / 2) {
      const v = it.next();
      if (v.done) break;
      revoked.delete(v.value);
    }
  }
}

/**
 * Mark a session id (sid) as revoked so any stream token minted with it is
 * immediately refused. Called by sessionService on logout / revokeSession.
 * @param {string} sid
 */
function revokeSid(sid) {
  if (!sid) return;
  revoked.add('sid:' + String(sid));
  capRevoked();
}

/**
 * Revoke all stream tokens for a userId (logout-all, password change,
 * suspension, refresh-token reuse).
 *
 * COMPATIBILITY NO-OP for the in-memory set: user-wide revocation is NOT
 * tracked here, and must not be. The previous implementation stored a
 * permanent 'all:<userId>' marker that never expired, so after any
 * logout-all every FUTURE session's tokens — minted after a fresh login —
 * were rejected with TOKEN_REVOKED until process restart. That poisoned
 * legitimate new sessions.
 *
 * User-wide invalidation is enforced authoritatively by the live DB checks
 * in streamProxyController.streamMedia():
 *   • users.token_version vs the token's tv claim      → rejects old-tv tokens
 *   • user_sessions.revoked_at vs the token's sid      → rejects revoked
 *     sessions (revokeAllSessions() revokes every user_sessions row BEFORE
 *     calling this, so all pre-existing tokens die via the session check)
 * Tokens minted between revocation and the next login carry a revoked sid
 * and are refused by the session check; freshly logged-in sessions get new,
 * unrevoked sids and must keep working.
 *
 * @param {number|string} userId — accepted for signature compatibility
 * @param {number} [tv] — accepted for signature compatibility; the live
 *   users.token_version comparison is the authoritative enforcement.
 */
function revokeAllForUser(userId, tv) {
  // Intentionally no in-memory user-wide marker. See doc above.
}

/**
 * True if a token payload is rejected by the in-memory revocation set.
 * Only SESSION-level revocations ('sid:<sessionId>') are tracked here.
 * User-wide invalidation is enforced by the live DB checks in
 * streamProxyController (users.token_version + user_sessions.revoked_at).
 * @param {object} data - decoded payload { userId, sid, tv }
 * @returns {boolean}
 */
function isRevoked(data) {
  if (!data) return false;
  const sid = String(data.sid || '');
  if (sid && revoked.has('sid:' + sid)) return true;
  return false;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// HMAC key: a DEDICATED STREAM_TOKEN_SECRET is REQUIRED. FIX 6 (P1): we no
// longer fall back to JWT_SECRET — a stream-token key compromise must never
// become an auth-token (JWT) key compromise, and the two must be rotatable
// independently. server.js enforces its presence in production (REQUIRED_ENV);
// here we throw a clear error so a misconfigured process fails loudly instead
// of minting HMAC with an undefined key (which crypto.createHmac would throw
// on anyway, but with a confusing message).
const STREAM_TOKEN_SECRET =
  process.env.STREAM_TOKEN_SECRET ||
  (() => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'STREAM_TOKEN_SECRET is required in production. Generate one with: openssl rand -hex 32'
      );
    }
    // In development, allow boot but warn loudly — production is enforced.
    // eslint-disable-next-line no-console
    console.warn('[streamToken] WARNING: STREAM_TOKEN_SECRET is not set. ' +
      'This is insecure and will fail to boot in production. Use: openssl rand -hex 32');
    return process.env.JWT_SECRET;
  })();

function secret() {
  return STREAM_TOKEN_SECRET;
}

function ipHash(ip) {
  if (!ip) return '';
  return sha256(String(ip));
}

/**
 * Mint a stream authorization token.
 * @param {object} payload { userId, episodeId, streamId, ip, sid, tv }
 *   sid = session id (from access JWT), tv = token_version (from access JWT).
 * @returns {string} base64url(payload).base64url(hmac)
 */
function mint({ userId, episodeId, streamId, ip, sid, tv, scope, ttlMs }) {
  const body = {
    userId: String(userId),
    episodeId: String(episodeId),
    streamId,
    ipHash: ipHash(ip),
    sid: sid ? String(sid) : undefined,
    tv: tv !== undefined && tv !== null ? Number(tv) : undefined,
    // scope: 'hls-child' tokens may only fetch child (?url=) resources — the
    // proxy refuses them for parent manifest requests (see streamProxyController).
    scope: scope || undefined,
    exp: Date.now() + (ttlMs || TTL_MS),
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify a stream authorization token against the expected context.
 * @param {string} token
 * @param {object} expected { userId, episodeId, streamId, ip, sid, tv, checkRevoked } — all optional
 * @returns {{ok:boolean, reason?:string, payload?:object}}
 */
function verify(token, expected = {}) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'TOKEN_MISSING' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'TOKEN_MALFORMED' };
  const [payload, sig] = parts;

  const expectedSig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'TOKEN_INVALID' };

  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { return { ok: false, reason: 'TOKEN_CORRUPT' }; }

  if (!data.exp || Date.now() > data.exp) return { ok: false, reason: 'TOKEN_EXPIRED' };

  // FIX 5: in-memory revocation check first.
  if (expected.checkRevoked !== false && isRevoked(data)) {
    return { ok: false, reason: 'TOKEN_REVOKED' };
  }

  // Bind checks.
  if (expected.userId && String(data.userId) !== String(expected.userId)) return { ok: false, reason: 'USER_MISMATCH' };
  if (expected.episodeId && String(data.episodeId) !== String(expected.episodeId)) return { ok: false, reason: 'EPISODE_MISMATCH' };
  if (expected.streamId && String(data.streamId) !== String(expected.streamId)) return { ok: false, reason: 'STREAM_MISMATCH' };
  if (expected.ip !== undefined && expected.ip !== null && data.ipHash !== ipHash(expected.ip)) return { ok: false, reason: 'IP_MISMATCH' };
  // FIX 5: sid + tv binding.
  if (expected.sid !== undefined && expected.sid !== null && String(data.sid || '') !== String(expected.sid)) return { ok: false, reason: 'SID_MISMATCH' };
  if (expected.tv !== undefined && expected.tv !== null && Number(data.tv) !== Number(expected.tv)) return { ok: false, reason: 'TV_MISMATCH' };

  return { ok: true, payload: data };
}

module.exports = { mint, verify, TTL_MS, CHILD_TTL_MS, sha256, ipHash, revokeSid, revokeAllForUser, isRevoked };
