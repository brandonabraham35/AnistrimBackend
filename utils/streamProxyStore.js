// =============================================================
//  utils/streamProxyStore.js — In-Memory Stream Context Store
//
//  PURPOSE:
//    Stores the playback context (target URL, referer, origin,
//    cookies, headers) needed to authorize an AnimeHeaven stream,
//    keyed by a SHORT-LIVED streamId. The streamId is the ONLY
//    thing ever exposed to the browser — cookies, referers,
//    origins, and tokens NEVER leave the server.
//
//  DESIGN:
//    • TTL-based expiry (default 8 minutes) so stale contexts are
//      automatically reclaimed.
//    • Last-access tracking so inactive contexts are removed.
//    • Maps streamId → { targetUrl, host, referer, origin, cookies,
//      headers, createdAt, lastAccessAt, hits }.
//    • Pure in-memory (no disk). Single-process assumption is fine
//      for this backend (Render single instance).
// =============================================================
'use strict';

const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_TTL_MS = Number(process.env.STREAM_PROXY_TTL_MS || 8 * 60 * 1000); // 8 min
const MAX_CONTEXTS = Number(process.env.STREAM_PROXY_MAX_CONTEXTS || 5000);
const SWEEP_INTERVAL_MS = 60 * 1000; // sweep expired once per minute

const contexts = new Map(); // streamId -> context

/**
 * Generate a short, unguessable stream id.
 * @returns {string} A 24-char url-safe token
 */
function generateStreamId() {
  return crypto.randomBytes(18).toString('hex'); // 36 hex chars
}

/**
 * Internal sweep: remove expired contexts and enforce the max-size cap.
 * Called periodically and opportunistically on writes.
 */
function sweep() {
  const now = Date.now();
  for (const [id, ctx] of contexts) {
    if (!ctx || now - ctx.lastAccessAt > TTL_MS || now - ctx.createdAt > TTL_MS) {
      contexts.delete(id);
    }
  }
  // Enforce cap (drop oldest by lastAccessAt if over cap)
  if (contexts.size > MAX_CONTEXTS) {
    const sorted = [...contexts.entries()].sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
    const toRemove = sorted.slice(0, contexts.size - MAX_CONTEXTS);
    for (const [id] of toRemove) contexts.delete(id);
  }
}

// Start periodic sweeper.
const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
if (sweeper.unref) sweeper.unref();
sweeper._anistrim = true;

/**
 * Register a stream context and return its short streamId.
 * @param {object} entry - { targetUrl, host, referer, origin, cookies, headers }
 * @returns {string} streamId
 */
function store(entry = {}) {
  const targetUrl = String(entry.targetUrl || '');
  if (!targetUrl) return null;

  let host = entry.host || null;
  if (!host) {
    try {
      host = new URL(targetUrl).host;
    } catch {
      host = null;
    }
  }

const streamId = generateStreamId();
  const now = Date.now();
  contexts.set(streamId, {
    targetUrl,
    host,
    referer: entry.referer || null,
    origin: entry.origin || null,
    cookies: entry.cookies || null,
    userAgent: entry.userAgent || null,
    headers: entry.headers || null,
    createdAt: now,
    lastAccessAt: now,
    hits: 0,
  });

  sweep(); // opportunistic cleanup
  return streamId;
}

/**
 * Retrieve a context by streamId, refreshing its lastAccessAt.
 * Returns null if unknown or expired.
 * @param {string} streamId
 * @returns {object|null}
 */
function get(streamId) {
  if (!streamId) return null;
  const ctx = contexts.get(streamId);
  if (!ctx) return null;
  const now = Date.now();
  if (now - ctx.lastAccessAt > TTL_MS || now - ctx.createdAt > TTL_MS) {
    contexts.delete(streamId);
    return null;
  }
  ctx.lastAccessAt = now;
  ctx.hits += 1;
  return ctx;
}

/**
 * Remove a context by streamId (e.g. after a terminal error or explicit release).
 * @param {string} streamId
 */
function remove(streamId) {
  if (!streamId) return;
  contexts.delete(streamId);
}

/**
 * Validate that a requested target URL host matches the stored host.
 * Prevents open-proxy abuse: a caller holding a valid streamId may only
 * fetch resources on the SAME host as the original context target.
 * @param {object} ctx - context from get()
 * @param {string} candidateUrl - URL the caller wants to fetch
 * @returns {boolean}
 */
function isHostAllowed(ctx, candidateUrl) {
  if (!ctx || !ctx.host) return false;
  try {
    return new URL(candidateUrl).host === ctx.host;
  } catch {
    return false;
  }
}

/**
 * Get the number of currently stored contexts (observability).
 * @returns {number}
 */
function size() {
  return contexts.size;
}

/**
 * Clear all contexts (testing / admin).
 */
function clear() {
  contexts.clear();
}

// Stop the sweeper interval on process exit to allow clean shutdown.
process.on('exit', () => {
  if (sweeper && sweeper._anistrim && typeof sweeper.unref === 'function') clearInterval(sweeper);
});

module.exports = {
  store,
  get,
  remove,
  isHostAllowed,
  size,
  clear,
  DEFAULT_TTL_MS,
};
