// ============================================================
//  _immutability_audit.js — READ-ONLY CACHE IMMUTABILITY AUDIT
//  Target: episode_id=33, provider=animeheaven
//
//  This script is READ-ONLY with respect to the cache's actual
//  playback data. It does NOT refresh, repair, insert, or delete
//  any cache content. It only:
//    - reads the current DB cache row
//    - if valid (unexpired), calls resolveStream() once (with
//      episodeId=33) to test a genuine persistent-cache HIT
//    - re-reads the row and deep-compares it against the baseline
//
//  A genuine HIT invokes streamCacheService.markUsed() which issues
//  `UPDATE ... SET last_used_at = ?`. Because the table has
//  `updated_at ... ON UPDATE CURRENT_TIMESTAMP`, this may change
//  `updated_at` and `last_used_at`. These are recorded separately as
//  EXPECTED HIT METADATA ACTIVITY, NOT as cache-content mutation.
//
//  If the row is EXPIRED → STOP and report NOT VERIFIED (no
//  resolveStream call, no AnimeHeaven contact, no refresh).
//
//  No production code is modified.
// ============================================================
'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const EPISODE_ID = 33;
const PROVIDER = 'animeheaven';
const ANIME_TITLE = 'Jujutsu Kaisen 0';
const EPISODE_NUMBER = 1;

const REPORT_PATH = path.join(__dirname, 'CACHE_HIT_IMMUTABILITY_VERIFICATION_REPORT.md');

// Capture console output (logs) for the audit.
const logs = [];
['log', 'warn', 'error'].forEach((fn) => {
  const orig = console[fn];
  console[fn] = (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logs.push(`[${new Date().toISOString()}] [${fn.toUpperCase()}] ${line}`);
    orig(...args);
  };
});

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function asString(v) {
  if (v === null || v === undefined) return v;
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

function normalizeDate(d) {
  // MySQL DATETIME may arrive as Date or string; normalize to ISO-ish string.
  if (!d) return d;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? String(d) : dt.toISOString();
}

(async () => {
  const report = {
    verdict: null,
    timestamp: new Date().toISOString(),
    target: { episode_id: EPISODE_ID, provider: PROVIDER, anime: ANIME_TITLE, episode: EPISODE_NUMBER },
    baseline: null,
    after: null,
    checks: {},
    hitMetadata: null,
    logs: [],
  };

  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    console.log(`DB connected: ${process.env.DB_NAME}`);

    // ── STEP 0: HARD EXPIRY GATE ──────────────────────────
    const [[nowRow]] = await conn.query('SELECT NOW() AS now');
    const dbNow = new Date(nowRow.now);
    console.log('DB NOW():', nowRow.now);

    const [rows] = await conn.query(
      'SELECT id, episode_id, provider, stream_type, stream_data, expires_at, created_at, updated_at, last_used_at, resolved_at FROM episode_stream_cache WHERE episode_id = ? AND provider = ? LIMIT 2',
      [EPISODE_ID, PROVIDER]
    );

    if (!rows || rows.length === 0) {
      report.verdict = 'NOT VERIFIED';
      report.checks.gate = 'NO ROW FOUND';
      console.log('RESULT: NOT VERIFIED — no cache row for episode 33/animeheaven');
      throw new Error('STOP_NO_ROW');
    }
    if (rows.length > 1) {
      report.verdict = 'FAIL';
      report.checks.gate = `DUPLICATE ROWS FOUND (${rows.length})`;
      console.log('RESULT: FAIL — duplicate rows found');
      throw new Error('STOP_DUP');
    }

    const row = rows[0];
    const expires = new Date(row.expires_at);
    const remainingMs = expires.getTime() - dbNow.getTime();
    report.checks.gate = {
      rowFound: true,
      rowCount: rows.length,
      expires_at: normalizeDate(row.expires_at),
      dbNow: normalizeDate(dbNow),
      remainingMs,
      expired: remainingMs <= 0,
    };

    // Validate stream_data is present and contains raw CDN source (not proxy).
    let streamData = row.stream_data;
    if (typeof streamData === 'string') {
      try { streamData = JSON.parse(streamData); } catch (_) { streamData = null; }
    }
    const streamDataStr = asString(streamData);
    const hasProxyUrl = /\/api\/stream-proxy\//.test(streamDataStr || '');
    const hasErrorUrl = /[?&]error([0-9]*)=/.test(streamDataStr || '');
    const hasSource = streamData && Array.isArray(streamData.sources) && streamData.sources.length > 0;

    report.checks.streamDataValidity = {
      hasSource,
      hasProxyUrl,
      hasErrorUrl,
    };

    if (remainingMs <= 0) {
      report.verdict = 'NOT VERIFIED';
      console.log('RESULT: NOT VERIFIED — cache row EXPIRED (remainingMs=' + remainingMs + ')');
      throw new Error('STOP_EXPIRED');
    }
    if (!hasSource) {
      report.verdict = 'NOT VERIFIED';
      console.log('RESULT: NOT VERIFIED — stream_data has no valid sources');
      throw new Error('STOP_NOSOURCES');
    }
    if (hasProxyUrl) {
      report.verdict = 'FAIL';
      report.checks.gate.proxyUrlPersisted = true;
      console.log('RESULT: FAIL — proxy URL already persisted in cache baseline');
      throw new Error('STOP_PROXYPERSISTED');
    }

    // ── STEP 1-4: CAPTURE BASELINE ─────────────────────────
    const baseline = {
      id: row.id,
      episode_id: row.episode_id,
      provider: row.provider,
      stream_type: row.stream_type,
      stream_data: deepClone(streamData),
      expires_at: normalizeDate(row.expires_at),
      created_at: normalizeDate(row.created_at),
      updated_at: normalizeDate(row.updated_at),
      last_used_at: normalizeDate(row.last_used_at),
      resolved_at: normalizeDate(row.resolved_at),
    };
    report.baseline = baseline;

    const [countBefore] = await conn.query('SELECT COUNT(*) AS n FROM episode_stream_cache');
    report.checks.rowCountBefore = countBefore[0].n;

    console.log('BASELINE captured. expires_at=' + baseline.expires_at + ' remainingMs=' + remainingMs);

    // ── STEP 5: CLEAR IN-MEMORY STREAM CACHE ───────────────
    // The persistent cache is DB-backed; the in-memory cache would NOT be hit
    // because we pass episodeId (persistent path). But per instructions, clear
    // the in-memory stream cache if necessary to ensure a clean DB-cache path.
    try {
      const cacheService = require('./utils/cacheService');
      await cacheService.delByPrefix('stream:');
      console.log('In-memory stream cache cleared (prefix stream:).');
    } catch (e) {
      console.log('In-memory cache clear skipped or failed (non-fatal): ' + e.message);
    }

    // ── STEP 6: CALL resolveStream() ONCE ──────────────────
    console.log('Calling resolveStream(' + ANIME_TITLE + ', ' + EPISODE_NUMBER + ', {episodeId:33}) ...');
    const streamingService = require('./services/streamingService');
    const result = await streamingService.resolveStream(ANIME_TITLE, EPISODE_NUMBER, {
      isPremium: true,
      episodeId: EPISODE_ID,
      skipCache: false,
    });
    console.log('resolveStream returned:', JSON.stringify({
      provider: result.provider,
      streamUrl: result.streamUrl,
      sources: (result.sources || []).map((s) => ({ quality: s.quality, url: s.url })),
      bestQuality: result.bestQuality,
      tier: result.tier,
      cached: result.cached,
    }));

    // ── STEP 8-13: LOG ANALYSIS ────────────────────────────
    const logText = logs.join('\n');
    const hit = /\[STREAM_CACHE\][^\n]*HIT/i.test(logText);
    const save = /\[STREAM_CACHE\][^\n]*SAVE/i.test(logText);
    const expired = /\[STREAM_CACHE\][^\n]*EXPIRED/i.test(logText);
    const animeheavenSearch = /\bsearch\b/i.test(logText) && /animeheaven/i.test(logText);
    const episodeResolved = /episode resolved|resolved episode|\[animeheaven\][^\n]*resolved/i.test(logText);
    const playerResolved = /player resolved|resolved player/i.test(logText);
    const streamExtracted = /stream extracted|extracted stream/i.test(logText);

    report.checks.logAnalysis = {
      persistentCacheHit: hit,
      savePresent: save,
      expiredPresent: expired,
      animeheavenSearch: animeheavenSearch,
      episodeResolved: episodeResolved,
      playerResolved: playerResolved,
      streamExtracted: streamExtracted,
    };

    // ── STEP 14: RE-READ DB ROW ────────────────────────────
    const [rowsAfter] = await conn.query(
      'SELECT id, episode_id, provider, stream_type, stream_data, expires_at, created_at, updated_at, last_used_at, resolved_at FROM episode_stream_cache WHERE episode_id = ? AND provider = ?',
      [EPISODE_ID, PROVIDER]
    );
    const afterRow = rowsAfter[0];
    let afterData = afterRow.stream_data;
    if (typeof afterData === 'string') {
      try { afterData = JSON.parse(afterData); } catch (_) { afterData = null; }
    }
    const after = {
      id: afterRow.id,
      episode_id: afterRow.episode_id,
      provider: afterRow.provider,
      stream_type: afterRow.stream_type,
      stream_data: deepClone(afterData),
      expires_at: normalizeDate(afterRow.expires_at),
      created_at: normalizeDate(afterRow.created_at),
      updated_at: normalizeDate(afterRow.updated_at),
      last_used_at: normalizeDate(afterRow.last_used_at),
      resolved_at: normalizeDate(afterRow.resolved_at),
    };
    report.after = after;

    const [countAfter] = await conn.query('SELECT COUNT(*) AS n FROM episode_stream_cache');
    report.checks.rowCountAfter = countAfter[0].n;

    // ── STEP 15: DEEP-COMPARE ──────────────────────────────
    const immutableFields = ['id', 'episode_id', 'provider', 'stream_type', 'expires_at', 'created_at'];
    const contentDiff = [];
    for (const f of immutableFields) {
      if (asString(baseline[f]) !== asString(after[f])) {
        contentDiff.push({ field: f, before: baseline[f], after: after[f] });
      }
    }
    // stream_data deep compare
    if (!deepEqual(baseline.stream_data, after.stream_data)) {
      contentDiff.push({ field: 'stream_data', before: baseline.stream_data, after: after.stream_data });
    }
    // resolved_at is content-level (set at save time); treat as immutable too.
    if (asString(baseline.resolved_at) !== asString(after.resolved_at)) {
      contentDiff.push({ field: 'resolved_at', before: baseline.resolved_at, after: after.resolved_at });
    }

    // Metadata activity (expected on HIT via markUsed)
    const metadataChange = {
      last_used_at_changed: asString(baseline.last_used_at) !== asString(after.last_used_at),
      updated_at_changed: asString(baseline.updated_at) !== asString(after.updated_at),
      before_last_used_at: baseline.last_used_at,
      after_last_used_at: after.last_used_at,
      before_updated_at: baseline.updated_at,
      after_updated_at: after.updated_at,
    };
    report.hitMetadata = metadataChange;

    // inherited field full compare (for completeness)
    const proxyPersistedAfter = /\/api\/stream-proxy\//.test(asString(after.stream_data) || '');
    const errorUrlAfter = /[?&]error([0-9]*)=/.test(asString(after.stream_data) || '');
    const urlOrderUnchanged = deepEqual(
      (baseline.stream_data && baseline.stream_data.sources) || [],
      (after.stream_data && after.stream_data.sources) || []
    );

    report.checks.afterValidity = {
      proxyUrlPersisted: proxyPersistedAfter,
      errorUrlPersisted: errorUrlAfter,
      sourceOrderUnchanged: urlOrderUnchanged,
      duplicateRows: rowsAfter.length > 1,
      rowCountUnchanged: countBefore[0].n === countAfter[0].n,
    };

    // ── CLASSIFY VERDICT ───────────────────────────────────
    const contentMutated = contentDiff.length > 0;
    const unexpectedSave = save && !expired;
    const providerReResolved = animeheavenSearch && !hit;
    const duplicate = rowsAfter.length > 1;
    const proxyPersisted = proxyPersistedAfter;
    const errorUrl = errorUrlAfter;

    if (contentMutated) {
      report.verdict = 'FAIL — CACHE CONTENT MUTATION';
      report.checks.diffs = contentDiff;
    } else if (unexpectedSave) {
      report.verdict = 'FAIL — UNEXPECTED SAVE';
    } else if (!hit) {
      report.verdict = 'FAIL — NO PERSISTENT CACHE HIT';
    } else if (providerReResolved) {
      report.verdict = 'FAIL — PROVIDER RE-RESOLUTION DURING HIT';
    } else if (duplicate) {
      report.verdict = 'FAIL — DUPLICATE CACHE ROW';
    } else if (proxyPersisted) {
      report.verdict = 'FAIL — PROXY URL PERSISTED';
    } else if (errorUrl) {
      report.verdict = 'FAIL — DEAD &error/&error2 URL PERSISTED';
    } else {
      report.verdict = 'PASS';
    }

    report.logs = logs;
    console.log('VERDICT:', report.verdict);
    if (contentDiff.length) console.log('CONTENT DIFFS:', JSON.stringify(contentDiff, null, 2));
    console.log('METADATA ACTIVITY:', JSON.stringify(metadataChange, null, 2));

    // ── WRITE REPORT ───────────────────────────────────────
    const md = buildMarkdown(report);
    fs.writeFileSync(REPORT_PATH, md);
    console.log('Report written to ' + REPORT_PATH);
  } catch (err) {
    if (err.message && err.message.startsWith('STOP_')) {
      // Expected stop (expired / no row / dup / no sources / proxy baseline)
      report.logs = logs;
      report.checks.stopReason = err.message;
      const md = buildMarkdown(report);
      fs.writeFileSync(REPORT_PATH, md);
      console.log('Report (stopped) written to ' + REPORT_PATH);
    } else {
      console.error('AUDIT ERROR:', err.message);
      report.verdict = report.verdict || 'ERROR';
      report.error = err.message;
      report.logs = logs;
      const md = buildMarkdown(report);
      fs.writeFileSync(REPORT_PATH, md);
    }
  } finally {
    if (conn) await conn.end().catch(() => {});
    process.exit(0);
  }
})();

function buildMarkdown(r) {
  const L = [];
  L.push('# CACHE HIT IMMUTABILITY VERIFICATION REPORT');
  L.push('');
  L.push('**Mode:** READ-ONLY (no source/DB/config modification)');
  L.push('**Timestamp:** ' + r.timestamp);
  L.push('**Target:** `episode_id=' + r.target.episode_id + '` · `anime="' + r.target.anime + '"` · `episode=' + r.target.episode + '` · `provider=' + r.target.provider + '`');
  L.push('');
  L.push('## Verdict');
  L.push('');
  L.push('> **' + (r.verdict || 'UNKNOWN') + '**');
  L.push('');

  if (r.checks && r.checks.gate) {
    L.push('## Expiry Gate');
    L.push('');
    L.push('| Key | Value |');
    L.push('| --- | --- |');
    L.push('| rowFound | ' + r.checks.gate.rowFound + ' |');
    L.push('| rowCount | ' + r.checks.gate.rowCount + ' |');
    L.push('| expires_at | ' + r.checks.gate.expires_at + ' |');
    L.push('| dbNow | ' + r.checks.gate.dbNow + ' |');
    L.push('| remainingMs | ' + r.checks.gate.remainingMs + ' |');
    L.push('| expired | ' + r.checks.gate.expired + ' |');
    if (r.checks.gate.proxyUrlPersisted) L.push('| proxyUrlPersisted | TRUE |');
    L.push('');
  }

  if (r.checks && r.checks.streamDataValidity) {
    L.push('## Baseline stream_data Validity');
    L.push('');
    L.push('| Key | Value |');
    L.push('| --- | --- |');
    L.push('| hasSource | ' + r.checks.streamDataValidity.hasSource + ' |');
    L.push('| hasProxyUrl | ' + r.checks.streamDataValidity.hasProxyUrl + ' |');
    L.push('| hasErrorUrl | ' + r.checks.streamDataValidity.hasErrorUrl + ' |');
    L.push('');
  }

  if (r.baseline) {
    L.push('## Baseline Row');
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(r.baseline, null, 2));
    L.push('```');
    L.push('');
  }

  if (r.after) {
    L.push('## After Row');
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(r.after, null, 2));
    L.push('```');
    L.push('');
  }

  if (r.checks && r.checks.logAnalysis) {
    L.push('## Log Analysis');
    L.push('');
    L.push('| Check | Value |');
    L.push('| --- | --- |');
    L.push('| persistentCacheHit ([STREAM_CACHE] HIT) | ' + r.checks.logAnalysis.persistentCacheHit + ' |');
    L.push('| savePresent ([STREAM_CACHE] SAVE) | ' + r.checks.logAnalysis.savePresent + ' |');
    L.push('| expiredPresent ([STREAM_CACHE] EXPIRED) | ' + r.checks.logAnalysis.expiredPresent + ' |');
    L.push('| animeheavenSearch | ' + r.checks.logAnalysis.animeheavenSearch + ' |');
    L.push('| episodeResolved | ' + r.checks.logAnalysis.episodeResolved + ' |');
    L.push('| playerResolved | ' + r.checks.logAnalysis.playerResolved + ' |');
    L.push('| streamExtracted | ' + r.checks.logAnalysis.streamExtracted + ' |');
    L.push('');
  }

  if (r.hitMetadata) {
    L.push('## Expected HIT Metadata Activity');
    L.push('');
    L.push('A genuine persistent-cache HIT calls `markUsed()` which issues `UPDATE ... SET last_used_at = ?`.');
    L.push('Because the table has `updated_at ON UPDATE CURRENT_TIMESTAMP`, `updated_at` may change. This is NOT a cache-content mutation.');
    L.push('');
    L.push('| Key | Before | After | Changed |');
    L.push('| --- | --- | --- | --- |');
    L.push('| last_used_at | ' + r.hitMetadata.before_last_used_at + ' | ' + r.hitMetadata.after_last_used_at + ' | ' + r.hitMetadata.last_used_at_changed + ' |');
    L.push('| updated_at | ' + r.hitMetadata.before_updated_at + ' | ' + r.hitMetadata.after_updated_at + ' | ' + r.hitMetadata.updated_at_changed + ' |');
    L.push('');
  }

  if (r.checks && r.checks.afterValidity) {
    L.push('## After-Validity Checks');
    L.push('');
    L.push('| Check | Value |');
    L.push('| --- | --- |');
    L.push('| proxyUrlPersisted | ' + r.checks.afterValidity.proxyUrlPersisted + ' |');
    L.push('| errorUrlPersisted | ' + r.checks.afterValidity.errorUrlPersisted + ' |');
    L.push('| sourceOrderUnchanged | ' + r.checks.afterValidity.sourceOrderUnchanged + ' |');
    L.push('| duplicateRows | ' + r.checks.afterValidity.duplicateRows + ' |');
    L.push('| rowCountUnchanged | ' + r.checks.afterValidity.rowCountUnchanged + ' |');
    L.push('| rowCountBefore | ' + (r.checks.rowCountBefore) + ' |');
    L.push('| rowCountAfter | ' + (r.checks.rowCountAfter) + ' |');
    L.push('');
  }

  if (r.checks && r.checks.diffs && r.checks.diffs.length) {
    L.push('## Content Diffs (FAIL)');
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(r.checks.diffs, null, 2));
    L.push('```');
    L.push('');
  }

  L.push('## Captured Logs');
  L.push('');
  L.push('```');
  L.push((r.logs || []).join('\n'));
  L.push('```');
  L.push('');

  return L.join('\n');
}
