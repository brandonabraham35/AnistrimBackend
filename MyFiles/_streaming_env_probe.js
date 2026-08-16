'use strict';
/**
 * _streaming_env_probe.js — READ-ONLY STREAMING ENVIRONMENT & DB INVENTORY PROBE
 *
 * This is a temporary diagnostic script. It performs ONLY read-only checks:
 *   - environment / module-load verification (no secrets printed)
 *   - MySQL connectivity (SELECT 1)
 *   - catalogue / stream-cache inventory (SELECT only)
 *   - AnimeHeaven DNS + HTTPS reachability (SSRF-safe, no bypass)
 *
 * It NEVER modifies, truncates, seeds, or repairs data. It never kills other
 * processes/connections. It is deleted after the verification completes.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
require('dotenv').config();

const dns = require('dns');

const REDACT = '[REDACTED]';
const out = { sections: {} };

function section(name) { out.sections[name] = {}; return out.sections[name]; }

// ── 1. ENVIRONMENT ─────────────────────────────────────────
(async () => {
  const env = section('environment');

  // Module presence via require (this also proves the module can load).
  const modules = [
    'mysql2/promise',
    'express',
    'cheerio',
    'axios',
    'dotenv',
'./utils/providerHttp',
    './utils/streamingHttp',
    './utils/ssrfGuard',
    './services/providerRegistry',
    './services/animeHeavenProvider',
    './services/streamingService',
    './services/streamCacheService',
    './config/streamCache',
  ];
  env.moduleLoads = {};
  for (let i = 0; i < modules.length; i++) {
    const mod = modules[i];
    try {
      require(mod);
      env.moduleLoads[mod] = 'OK';
    } catch (err) {
      env.moduleLoads[mod] = `FAIL: ${err && err.message ? err.message : String(err)}`;
    }
  }

  // Required env variables — presence ONLY, never values.
  const required = [
    'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
    'JWT_SECRET', 'ANIMEHEAVEN_BASE_URL',
  ];
  env.envVars = {};
  for (const key of required) {
    const v = process.env[key];
    if (v === undefined || v === null || v === '') {
      env.envVars[key] = 'MISSING';
    } else {
      env.envVars[key] = key.includes('PASSWORD') || key.includes('SECRET') ? 'PRESENT' : 'PRESENT';
    }
  }

  // MySQL config existence (shape only, no credentials).
  env.mysqlConfig = (() => {
    try {
      const db = require('./config/db');
      return db ? 'config/db.js loaded (pool created)' : 'loaded but no export';
    } catch (err) {
      return `FAIL: ${err && err.message ? err.message : String(err)}`;
    }
  })();

  // Streaming module smoke test — the single provider registry.
  try {
    const reg = require('./services/providerRegistry');
    env.providerOrder = reg.getDefaultProviderOrder();
    env.isKnownAnimeHeaven = reg.isKnownProvider('animeheaven');
  } catch (err) {
    env.providerOrder = `FAIL: ${err.message}`;
  }

  // ── 2+3+4 probe dispatch ─────────────────────────────────
  await probeDatabase(out);
  await probeAnimeHeaven(out);
  return out;
})()
  .then(() => {
    console.log('=== STREAMING ENV PROBE RESULT ===');
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('PROBE FATAL:', err);
    process.exit(1);
  });

// ── 2. DATABASE CONNECTIVITY + 3. INVENTORY ────────────────
async function probeDatabase(root) {
  const dbSec = section('database');
  let pool;
  try {
    pool = require('./config/db');
  } catch (err) {
    dbSec.connectivity = { success: false, error: `config load failed: ${err.message}` };
    return;
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query('SELECT 1 AS ok');
    dbSec.connectivity = {
      success: true,
      select1: Array.isArray(rows) && rows[0] && rows[0].ok === 1 ? '1' : 'unexpected',
      dbName: process.env.DB_NAME || '(default)',
      host: process.env.DB_HOST || 'localhost',
    };
  } catch (err) {
    dbSec.connectivity = {
      success: false,
      error: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : null,
      errno: err && err.errno !== undefined ? err.errno : null,
    };
    root.sections.database = dbSec;
    return;
  } finally {
    if (conn) { try { conn.release(); } catch (_) {} }
  }

  // ── 3. INVENTORY (read-only) ─────────────────────────────
  const inv = section('inventory');
  const q = async (sql, params) => {
    try {
      const [r] = await conn.query(sql, params || []);
      return r;
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  };

  // Discover episode columns dynamically (provider metadata may be a column).
  const cols = await q(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'episodes'`);
  const epCols = Array.isArray(cols) ? cols.map(c => c.COLUMN_NAME) : [];
  const hasProviderCol = epCols.includes('provider');

  inv.episodes = (await q('SELECT COUNT(*) AS c FROM episodes'));
  inv.anime = (await q('SELECT COUNT(*) AS c FROM anime'));
  inv.premiumEpisodes = (await q('SELECT COUNT(*) AS c FROM episodes WHERE is_premium = 1'));
  inv.episodesWithVideoUrl = (await q('SELECT COUNT(*) AS c FROM episodes WHERE video_url IS NOT NULL AND video_url <> ""'));
  inv.episodeStreamCacheRows = (await q('SELECT COUNT(*) AS c FROM episode_stream_cache'));

  // Provider metadata (column 'provider' if present, else none).
  if (hasProviderCol) {
    inv.episodesWithProvider = await q('SELECT COUNT(*) AS c FROM episodes WHERE provider IS NOT NULL AND provider <> ""');
    inv.distinctProviders = await q('SELECT provider, COUNT(*) AS c FROM episodes WHERE provider IS NOT NULL AND provider <> "" GROUP BY provider');
  } else {
    inv.episodesWithProvider = { note: 'no provider column on episodes table' };
    inv.distinctProviders = { note: 'no provider column on episodes table' };
  }

  // Available providers from the registry (static).
  try {
    const reg = require('./services/providerRegistry');
    inv.availableProviders = reg.getDefaultProviderOrder();
  } catch (err) {
    inv.availableProviders = `FAIL: ${err.message}`;
  }

  // Usable FREE episode candidates: non-premium, with a video_url (direct playable).
  const freeWithUrl = await q(
    'SELECT e.id, e.anime_id, e.episode_number, e.title, a.title AS anime_title ' +
    'FROM episodes e JOIN anime a ON a.id = e.anime_id ' +
    'WHERE e.is_premium = 0 AND e.video_url IS NOT NULL AND e.video_url <> "" ' +
    'ORDER BY e.id ASC LIMIT 10'
  );
  inv.freeCandidatesWithVideoUrl = freeWithUrl;

  // Usable PREMIUM episode candidates: premium episodes with a video_url.
  const premWithUrl = await q(
    'SELECT e.id, e.anime_id, e.episode_number, e.title, a.title AS anime_title ' +
    'FROM episodes e JOIN anime a ON a.id = e.anime_id ' +
    'WHERE e.is_premium = 1 AND e.video_url IS NOT NULL AND e.video_url <> "" ' +
    'ORDER BY e.id ASC LIMIT 10'
  );
  inv.premiumCandidatesWithVideoUrl = premWithUrl;

  // Stream-cache contents (provider rows only, no raw URLs/cookies).
  inv.cacheProviders = await q('SELECT provider, COUNT(*) AS c FROM episode_stream_cache GROUP BY provider');

  // Select the single best free episode candidate for runtime testing.
  if (Array.isArray(freeWithUrl) && freeWithUrl.length > 0) {
    inv.recommendedFreeEpisode = freeWithUrl[0];
  } else {
    inv.recommendedFreeEpisode = { note: 'NO free episode with video_url found — runtime test NOT VERIFIED (no fixture created)' };
  }

  if (conn) { try { conn.release(); } catch (_) {} }
}

// ── 4. ANIMEHEAVEN REACHABILITY (SSRF-safe) ────────────────
async function probeAnimeHeaven(root) {
  const ah = section('animeHeaven');
  let assertSafeTargetHost;
  try {
    ({ assertSafeTargetHost } = require('./utils/ssrfGuard'));
  } catch (err) {
    ah.error = `ssrfGuard load failed: ${err.message}`;
    return;
  }

  const candidates = [
    process.env.ANIMEHEAVEN_BASE_URL,
    'https://animeheaven.me',
    'https://animeheaven.ru',
    'https://www.animeheaven.me',
  ].filter(Boolean).map(v => String(v).trim().replace(/\/+$/, ''));

  const results = [];
  for (const url of Array.from(new Set(candidates))) {
    let host;
    try { host = new URL(url).hostname; } catch (_) { host = null; }
    const row = { url, host };

    // DNS resolution
    try {
      const addrs = await new Promise((resolve, reject) => {
        dns.lookup(host, { all: true, verbatim: true }, (err, a) => {
          if (err) return reject(err);
          resolve(a);
        });
      });
      row.dns = addrs.map(x => x.address);
    } catch (err) {
      row.dns = `FAIL: ${err && err.message ? err.message : String(err)}`;
      results.push(row);
      continue;
    }

    // SSRF safety (must pass before any fetch)
    try {
      const block = await assertSafeTargetHost(url);
      row.ssrf = block ? `BLOCKED: ${block}` : 'SAFE';
      if (block) {
        row.https = 'SKIPPED (SSRF would block)';
        results.push(row);
        continue;
      }
    } catch (err) {
      row.ssrf = `ERROR: ${err.message}`;
      row.https = 'SKIPPED';
      results.push(row);
      continue;
    }

    // HTTPS connectivity via the streaming client (HEAD, then GET fallback)
    try {
      const { streamingHttp } = require('./utils/streamingHttp');
      try {
        const res = await streamingHttp.request({ method: 'head', url, timeout: 8000, maxRedirects: 3 });
        row.https = `HTTP ${res.status}`;
      } catch (headErr) {
        const status = headErr && headErr.response && headErr.response.status;
        if (status) {
          row.https = `HTTP ${status} (HEAD)`;
        } else {
          // GET fallback
          try {
            const res = await streamingHttp.request({ method: 'get', url, timeout: 8000, maxRedirects: 3 });
            row.https = `HTTP ${res.status} (GET)`;
          } catch (getErr) {
            const gs = getErr && getErr.response && getErr.response.status;
            row.https = gs ? `HTTP ${gs} (GET)` : `UNREACHABLE: ${getErr.code || getErr.message}`;
          }
        }
      }
    } catch (err) {
      row.https = `ERROR: ${err.message}`;
    }
    results.push(row);
  }

  ah.results = results;
  const reachable = results.find(r => typeof r.https === 'string' && /^HTTP 2/.test(r.https));
  ah.reachable = !!reachable;
  ah.verdict = ah.reachable
    ? 'AnimeHeaven reachable (SSRF-safe)'
    : 'AnimeHeaven unreachable / not verified (environmental limitation)';
}
