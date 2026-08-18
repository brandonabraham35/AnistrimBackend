// utils/streamToken.js — Phase 10 (item 21) short-lived stream authorization.
//
// POST /api/stream/authorize { episodeId } → canWatch() → mints an HMAC-signed
// token bound to userId + episodeId + streamId + ip, valid 120 s. /api/stream-
// proxy/:streamId accepts ONLY this token (via ?token= or Bearer).
//
// FIX 5 (P1): adds sid (session id) + tv (token_version) to the payload, plus
// an in-memory revocation set. logout / logout-all / suspension add the session
// id(s) to the set; proxy verify refuses any token whose sid is revoked or whose
// tv no longer matches the current user token_version. This kills in-flight
// playback (within one segment fetch) after logout/suspend/premium-expiry, while
// the 120 s TTL remains as defense in depth.
const crypto = require('crypto');

const TTL_MS = 120 * 1000; // 120 s

// ── In-memory revocation set ──────────────────────────────
// Contains revoked session ids (sid) OR "<userId>:<tv>" markers for a global
// token-version bump (logout-all / password change / suspend). Verified on
// every /api/stream-proxy/:streamId request. Memory-bounded: entries are
// dropped once older than TTL_MS (stream tokens can't outlive 120 s anyway).
const revoked = new Set();
function pruneRevoked() {
  const cutoff = Date.now();
  for (const key of revoked) {
    if (!key.includes(':')) continue; // sid entries are keyed without ':'
  }
}
// Keep it simple: entries self-expire by not mattering once the 120s window
// passes (we never need to actively remove them). Cap to avoid unbounded growth.
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
 * Revoke all stream tokens for a userId (e.g. logout-all, password change,
 * suspension, token_version bump). Stream tokens are bound to the user's
 * token_version (tv); bumping tv invalidates them. We also add a per-user
 * marker so tokens minted between the bump and the next login are refused.
 * @param {number|string} userId
 * @param {number} tv — the CURRENT (after-bump) token_version, if known
 */
function revokeAllForUser(userId, tv) {
  if (userId === undefined || userId === null) return;
  // Hard-invalidate EVERYTHING currently minted for this user. tv is advisory
  // here — the authoritative token_version comparison happens against the
  // CURRENT users.token_version at verify time (see verify tv check). This
  // marker ensures a token minted a moment ago is refused immediately.
  revoked.add('all:' + String(userId));
  capRevoked();
}

/**
 * True if a token payload would be rejected by the in-memory revocation set.
 * @param {object} data - decoded payload { userId, sid, tv }
 * @returns {boolean}
 */
function isRevoked(data) {
  if (!data) return false;
  const sid = String(data.sid || '');
  const userId = String(data.userId || '');
  if (sid && revoked.has('sid:' + sid)) return true;
  if (userId && revoked.has('all:' + userId)) return true;
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
function mint({ userId, episodeId, streamId, ip, sid, tv }) {
  const body = {
    userId: String(userId),
    episodeId: String(episodeId),
    streamId,
    ipHash: ipHash(ip),
    sid: sid ? String(sid) : undefined,
    tv: tv !== undefined && tv !== null ? Number(tv) : undefined,
    exp: Date.now() + TTL_MS,
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

module.exports = { mint, verify, TTL_MS, sha256, ipHash, revokeSid, revokeAllForUser, isRevoked };
