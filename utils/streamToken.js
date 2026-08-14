// utils/streamToken.js — Phase 10 (item 21) short-lived stream authorization.
//
// POST /api/stream/authorize { episodeId } → canWatch() → mints an HMAC-signed
// token bound to userId + episodeId + ip_hash, valid 120 s. /api/stream-proxy/:
// streamId accepts ONLY this token (via ?token= or Authorization: Bearer).
// Upstream URLs / cookies / referers are never exposed to the client.
const crypto = require('crypto');

const TTL_MS = 120 * 1000; // 120 s

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function ipHash(ip) {
  if (!ip) return '';
  return sha256(String(ip));
}

/**
 * Mint a stream authorization token.
 * @param {object} payload { userId, episodeId, streamId, ip }
 * @returns {string} base64url(payload).base64url(hmac)
 */
function mint({ userId, episodeId, streamId, ip }) {
  const body = { userId: String(userId), episodeId: String(episodeId), streamId, ipHash: ipHash(ip), exp: Date.now() + TTL_MS };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.STREAM_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify a stream authorization token against the expected context.
 * @param {string} token
 * @param {object} expected { userId, episodeId, streamId, ip } — all optional
 * @returns {{ok:boolean, reason?:string, payload?:object}}
 */
function verify(token, expected = {}) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'TOKEN_MISSING' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'TOKEN_MALFORMED' };
  const [payload, sig] = parts;

  const expectedSig = crypto.createHmac('sha256', process.env.STREAM_TOKEN_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'TOKEN_INVALID' };

  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { return { ok: false, reason: 'TOKEN_CORRUPT' }; }

  if (!data.exp || Date.now() > data.exp) return { ok: false, reason: 'TOKEN_EXPIRED' };

  // Bind checks.
  if (expected.userId && String(data.userId) !== String(expected.userId)) return { ok: false, reason: 'USER_MISMATCH' };
  if (expected.episodeId && String(data.episodeId) !== String(expected.episodeId)) return { ok: false, reason: 'EPISODE_MISMATCH' };
  if (expected.streamId && String(data.streamId) !== String(expected.streamId)) return { ok: false, reason: 'STREAM_MISMATCH' };
  if (expected.ip !== undefined && expected.ip !== null && data.ipHash !== ipHash(expected.ip)) return { ok: false, reason: 'IP_MISMATCH' };

  return { ok: true, payload: data };
}

module.exports = { mint, verify, TTL_MS, sha256, ipHash };