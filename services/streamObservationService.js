// PART 1\n
// ============================================================
//  services/streamObservationService.js — Empirical URL Lifetime
//  Determines AnimeHeaven CDN URL behavior from evidence.
// ============================================================
'use strict';

const db = require('../config/db');
const logger = require('../utils/logger');
const config = require('../config/streamCache');
const { request } = require('../utils/providerHttp');
const { fingerprint, compareUrls } = require('../utils/urlFingerprint');
const { getPlaybackContext } = require('./animeHeavenProvider');

const OBSERVATION_INTERVAL_MS = Number(process.env.STREAM_OBSERVATION_INTERVAL_MINUTES || 30) * 60 * 1000;
const LONG_LIVED_THRESHOLD_MS = Number(process.env.STREAM_LONG_LIVED_THRESHOLD_HOURS || 6) * 60 * 60 * 1000;
const OBSERVATION_TIMEOUT_MS = Number(process.env.STREAM_OBSERVATION_TIMEOUT_MS || 10000);
const OBSERVATION_CONCURRENCY = Number(process.env.STREAM_OBSERVATION_CONCURRENCY || 2);
const CLASSIFICATION = { UNKNOWN: 'UNKNOWN', LONG_LIVED: 'LONG_LIVED', TEMPORARY: 'TEMPORARY', ROTATING: 'ROTATING', DEAD: 'DEAD', PERMANENT: 'PERMANENT' };

function extractContentHash(url) { try { var u = new URL(url); var keys = [...u.searchParams.keys()]; return keys.length > 0 ? keys[0] : null; } catch (e) { return null; } }
function extractCdnToken(url) { try { var u = new URL(url); var keys = [...u.searchParams.keys()]; return keys.length >= 2 ? keys[1] : null; } catch (e) { return null; } }

async function checkDirect(url, context) { if (!context) context = {};
  var start = Date.now(); var h = {};
  if (context.referer) h.Referer = context.referer;
  if (context.origin) h.Origin = context.origin;
  var opts = { providerName: config.provider, streaming: true, skipProxy: true, dontTrackHealth: true, timeout: OBSERVATION_TIMEOUT_MS };
  try {
    var r = await request({ method: 'head', url: url, maxRedirects: 3 }, { ...opts, extraHeaders: h });
    return { status: r.status || 200, contentType: r.headers ? r.headers['content-type'] || null : null, durationMs: Date.now() - start, alive: true, failureCategory: null };
  } catch (e) {
    var s = e && e.response ? e.response.status : 0;
    if (s === 405) {
      try { var rr = await request({ method: 'get', url: url, maxRedirects: 3, headers: { ...h, Range: 'bytes=0-1023' } }, opts);
        return { status: rr.status || 200, contentType: rr.headers ? rr.headers['content-type'] || null : null, durationMs: Date.now() - start, alive: true, failureCategory: null };
      } catch (re) { return { status: re && re.response ? re.response.status : 0, contentType: null, durationMs: Date.now() - start, alive: false, failureCategory: classifyFailureStatus(re && re.response ? re.response.status : 0, re) }; }
    }
    return { status: s, contentType: null, durationMs: Date.now() - start, alive: s !== 403 && s !== 404, failureCategory: classifyFailureStatus(s, e) };
  }
}

async function checkProxy(url, context) { if (!context) context = {};
  var start = Date.now(); var h = {};
  if (context.referer) h.Referer = context.referer;
  if (context.origin) h.Origin = context.origin;
  if (context.cookies) h.Cookie = context.cookies;
  if (context.userAgent) h['User-Agent'] = context.userAgent;
  h.Range = 'bytes=0-1023';
  try {
    var r = await request({ method: 'get', url: url, maxRedirects: 3, headers: h },
      { providerName: config.provider, streaming: true, skipProxy: false, dontTrackHealth: true, timeout: OBSERVATION_TIMEOUT_MS });
    return { status: r.status || 200, contentType: r.headers ? r.headers['content-type'] || null : null, durationMs: Date.now() - start, alive: true, failureCategory: null };
  } catch (e) {
    var s = e && e.response ? e.response.status : 0;
    return { status: s, contentType: null, durationMs: Date.now() - start, alive: false, failureCategory: classifyFailureStatus(s, e) };
  }
}

function classifyFailureStatus(status, err) {
  if (status === 403) return 'CDN_403'; if (status === 404) return 'CDN_404'; if (status === 410) return 'CDN_410';
  if (status >= 500 && status < 600) return status === 502 ? 'PROXY_502' : 'CDN_5XX';
  if ((err && err.code === 'ECONNABORTED') || (err && /timeout/i.test(err.message || ''))) return 'NETWORK_TIMEOUT';
  if (err && (err.code === 'EPROTO' || /tls|ssl|wrong version/i.test(err.message || ''))) return 'TLS_ERROR';
  if (err && ['ECONNRESET','ECONNREFUSED','ENOTFOUND'].indexOf(err.code) >= 0) return 'NETWORK_TIMEOUT';
  return 'UNKNOWN_FAILURE';
}

async function recordObservation(episodeId, provider, obs) {
  if (!episodeId) return;
  try {
    var now = new Date(); var clauses = []; var vals = [];
    if (obs.checkPath) { clauses.push('last_check_path = ?'); vals.push(obs.checkPath); }
    var dur = obs.directDurationMs || obs.proxyDurationMs || null;
    if (dur) { clauses.push('last_check_duration_ms = ?'); vals.push(dur); }
    var ct = obs.directContentType || obs.proxyContentType || null;
    if (ct) { clauses.push('last_check_content_type = ?'); vals.push(ct); }
    if (obs.directStatus !== undefined) { clauses.push('last_direct_check_at = ?', 'last_direct_status = ?'); vals.push(now, obs.directStatus); }
    if (obs.proxyStatus !== undefined) { clauses.push('last_proxy_check_at = ?', 'last_proxy_status = ?'); vals.push(now, obs.proxyStatus); }
    if (obs.probeAlive !== undefined && obs.playbackAlive !== undefined) {
      if (obs.probeAlive && !obs.playbackAlive) clauses.push('probe_false_positive_count = probe_false_positive_count + 1');
      else if (!obs.probeAlive && obs.playbackAlive) clauses.push('probe_false_negative_count = probe_false_negative_count + 1');
      else if (obs.probeAlive && obs.playbackAlive) clauses.push('probe_playback_match_count = probe_playback_match_count + 1');
    }
    if (clauses.length > 0) { vals.push(episodeId, provider); await db.query('UPDATE episode_stream_cache SET ' + clauses.join(', ') + ' WHERE episode_id = ? AND provider = ?', vals); }
    var effStatus = obs.directStatus || obs.proxyStatus;
    if (effStatus !== undefined) {
      if (effStatus >= 200 && effStatus < 300) {
        await db.query('UPDATE episode_stream_cache SET url_observed_lifetime_seconds = COALESCE(TIMESTAMPDIFF(SECOND, resolved_at, ?), url_observed_lifetime_seconds) WHERE episode_id = ? AND provider = ?', [now, episodeId, provider]);
      } else {
        await db.query('UPDATE episode_stream_cache SET url_first_failure_at = COALESCE(url_first_failure_at, ?), url_last_failure_at = ?, url_failure_count = url_failure_count + 1 WHERE episode_id = ? AND provider = ?', [now, now, episodeId, provider]);
      }
    }
    logger.info('[STREAM_OBS] recorded', { episodeId: episodeId, provider: provider, directStatus: obs.directStatus, proxyStatus: obs.proxyStatus });
  } catch (err) { logger.warn('[STREAM_OBS] record failed', { episodeId: episodeId, error: err.message }); }
}

async function recordRotation(episodeId, provider, oldUrl, newUrl) {
  if (!episodeId || !oldUrl || !newUrl) return;
  var cmp = compareUrls(oldUrl, newUrl);
  if (!cmp.bothPresent || cmp.sameUrl) return;
  try {
    var newHost = fingerprint(newUrl) ? fingerprint(newUrl).host : null; var now = new Date();
    await db.query('UPDATE episode_stream_cache SET original_host = COALESCE(original_host, ?), current_host = ?, host_changed_at = CASE WHEN original_host IS NOT NULL AND original_host != ? THEN ? ELSE host_changed_at END, token_changed_at = CASE WHEN ? THEN ? ELSE token_changed_at END, rotation_count = rotation_count + 1 WHERE episode_id = ? AND provider = ?',
      [newHost, newHost, newHost, now, cmp.tokenChanged ? 1 : 0, now, episodeId, provider]);
    logger.info('[STREAM_OBS] rotation', { episodeId: episodeId, hostChanged: cmp.hostChanged, tokenChanged: cmp.tokenChanged });
  } catch (err) { logger.warn('[STREAM_OBS] rotation failed', { episodeId: episodeId, error: err.message }); }
}

function classifyUrl(row) {
  if (!row) return { classification: 'UNKNOWN', confidence: 'LOW', reason: 'No cache row.' };
  var evidence = []; var classification = 'UNKNOWN'; var confidence = 'LOW';
  if (row.url_failure_count >= 3 && row.url_last_failure_at) {
    var ls = row.observed_last_success_at ? new Date(row.observed_last_success_at).getTime() : 0;
    var lf = row.url_last_failure_at ? new Date(row.url_last_failure_at).getTime() : 0;
    if (lf > ls) { evidence.push('3+ consecutive failures, last check failed'); classification = 'DEAD'; confidence = row.url_failure_count >= 5 ? 'HIGH' : 'MEDIUM'; }
  }
  var isTemp = [];
  if (row.observed_first_success_at && row.url_first_failure_at && new Date(row.url_first_failure_at).getTime() > new Date(row.observed_first_success_at).getTime()) { isTemp.push(true); evidence.push('source worked then stopped'); }
  if (row.detected_expires_at) { isTemp.push(true); evidence.push('URL has detected expiry parameter'); }
  var isLong = [];
  if (row.url_observed_lifetime_seconds && (row.url_observed_lifetime_seconds * 1000) >= LONG_LIVED_THRESHOLD_MS) { isLong.push(true); evidence.push('observed alive for >=' + Math.round(row.url_observed_lifetime_seconds / 3600) + 'h'); }
  if ((row.probe_playback_match_count || 0) >= 5) { isLong.push(true); evidence.push(row.probe_playback_match_count + ' probe-playback matches'); }
  if ((row.rotation_count || 0) >= 2) { evidence.push(row.rotation_count + ' URL rotations'); classification = 'ROTATING'; confidence = row.rotation_count >= 5 ? 'HIGH' : 'MEDIUM'; }
  if (classification !== 'DEAD' && classification !== 'ROTATING') {
    if (isTemp.length > 0 && !isLong.length) { classification = 'TEMPORARY'; confidence = isTemp.length >= 2 ? 'HIGH' : 'MEDIUM'; }
    else if (isLong.length >= 2) { classification = 'LONG_LIVED'; confidence = isLong.length >= 3 ? 'HIGH' : 'MEDIUM'; }
    else if (isLong.length === 1) { classification = 'LONG_LIVED'; confidence = 'LOW'; }
    else { classification = 'UNKNOWN'; confidence = 'LOW'; }
  }
  if (isTemp.length > 0 && isLong.length > 0) { classification = 'TEMPORARY'; confidence = 'LOW'; evidence.push('conflicting evidence, TEMPORARY wins'); }
  return { classification: classification, confidence: confidence, reason: evidence.length > 0 ? evidence.join('; ') : 'insufficient evidence' };
}

function isObservationDue(row) {
  if (!row) return false;
  var lastCheck = row.last_direct_check_at ? new Date(row.last_direct_check_at).getTime() : 0;
  return (Date.now() - lastCheck) >= OBSERVATION_INTERVAL_MS;
}

async function observeOnCacheHit(episodeId, provider, row, playbackCtx) {
  if (!episodeId || !row || !isObservationDue(row)) return;
  var data = row.stream_data;
  if (!data || !data.sources || !data.sources[0]) return;
  var url = data.streamUrl || data.sources[0].url;
  if (!url) return;
  var referer = data.sources[0].referer || (playbackCtx && playbackCtx.referer) || null;
  var origin = data.sources[0].origin || (playbackCtx && playbackCtx.origin) || null;
  var cookies = data.sources[0].cookies || (playbackCtx && playbackCtx.cookies) || null;
  var userAgent = playbackCtx && playbackCtx.userAgent || null;
  setImmediate(async function() {
    try {
      var dr = await checkDirect(url, { referer: referer, origin: origin });
      var pr = null;
      try { pr = await checkProxy(url, { referer: referer, origin: origin, cookies: cookies, userAgent: userAgent }); } catch (_) {}
      var probeAlive = dr.status >= 200 && dr.status < 400;
      var playbackAlive = pr ? (pr.status >= 200 && pr.status < 400) : probeAlive;
      await recordObservation(episodeId, provider, { checkPath: 'BOTH', url: url, directStatus: dr.status, directDurationMs: dr.durationMs, directContentType: dr.contentType, proxyStatus: pr ? pr.status : null, proxyDurationMs: pr ? pr.durationMs : null, proxyContentType: pr ? pr.contentType : null, probeAlive: probeAlive, playbackAlive: playbackAlive });
      if ((dr.status === 403 || dr.status === 404) && (!pr || (pr.status !== 200 && pr.status !== 206))) {
        var d = require('./streamCacheService');
        await d.deleteInvalidCache(episodeId, provider);
        logger.info('[STREAM_OBS] invalidated URL dead', { episodeId: episodeId, directStatus: dr.status, proxyStatus: pr ? pr.status : null });
      }
    } catch (err) { logger.warn('[STREAM_OBS] deferred check failed', { episodeId: episodeId, error: err.message }); }
  });
}
async function syncAnime(animeId, options) {
  if (!options) options = {};
  var concurrency = options.concurrency || OBSERVATION_CONCURRENCY;
  var forceRefresh = options.forceRefresh || false;
  var report = { animeId: animeId, episodesChecked: 0, healthy: 0, refreshed: 0, dead: 0, unknown: 0, rotating: 0, longLived: 0, temporary: 0, errors: 0, details: [] };
  try {
    var [eps] = await db.query('SELECT id AS episodeId, episode_number FROM episodes WHERE anime_id = ? ORDER BY episode_number', [animeId]);
    if (!eps || eps.length === 0) { report.message = 'No episodes found.'; return report; }
    report.episodesChecked = eps.length;
    var queue = eps.slice(); var active = new Set(); var results = [];
    await new Promise(function(resolve) {
      function next() {
        while (active.size < concurrency && queue.length > 0) {
          var ep = queue.shift(); active.add(ep.episodeId);
          processEpisode(ep.episodeId, forceRefresh).then(function(r) { results.push(r); active.delete(ep.episodeId); next(); }).catch(function(e) { results.push({ episodeId: ep.episodeId, episodeNumber: ep.episode_number, status: 'error', error: e.message }); active.delete(ep.episodeId); next(); });
        }
        if (active.size === 0 && queue.length === 0) resolve();
      }
      next();
    });
    for (var i = 0; i < results.length; i++) {
      var r = results[i]; report.details.push(r);
      if (r.status === 'healthy') report.healthy++;
      else if (r.status === 'refreshed') report.refreshed++;
      else if (r.status === 'dead') report.dead++;
      else if (r.status === 'unknown') report.unknown++;
      else if (r.status === 'error') report.errors++;
      if (r.classification === 'ROTATING') report.rotating++;
      if (r.classification === 'LONG_LIVED') report.longLived++;
      if (r.classification === 'TEMPORARY') report.temporary++;
    }
  } catch (err) { report.error = err.message; logger.error('[STREAM_OBS] syncAnime failed', { animeId: animeId, error: err.message }); }
  return report;
}

async function processEpisode(episodeId, forceRefresh) {
  var provider = config.provider;
  var result = { episodeId: episodeId, status: 'unknown', classification: 'UNKNOWN', directStatus: null, proxyStatus: null, urlChanged: false, hostChanged: false, tokenChanged: false };
  try {
    var sc = require('./streamCacheService');
    var [ep] = await db.query('SELECT episode_number FROM episodes WHERE id = ?', [episodeId]);
    result.episodeNumber = ep && ep[0] ? ep[0].episode_number : null;
    var cached = await sc.findCachedStream(episodeId, provider);
    if (!cached.row || !cached.result) { result.status = 'no_cache'; return result; }
    var row = cached.row; var data = row.stream_data;
    var url = data.streamUrl || (data.sources && data.sources[0] ? data.sources[0].url : null);
    if (!url) { result.status = 'no_url'; return result; }
    var oldFp = fingerprint(url);
    var ctx = { referer: data.sources && data.sources[0] ? data.sources[0].referer : null, origin: data.sources && data.sources[0] ? data.sources[0].origin : null };
    var dr = await checkDirect(url, ctx); result.directStatus = dr.status;
    var pctx = getPlaybackContext(url, ctx.referer || null);
    var pr = await checkProxy(url, pctx); result.proxyStatus = pr.status;
    var cls = classifyUrl({ url_observed_lifetime_seconds: row.url_observed_lifetime_seconds, url_failure_count: row.url_failure_count, url_last_failure_at: row.url_last_failure_at, url_first_failure_at: row.url_first_failure_at, observed_last_success_at: row.observed_last_success_at, observed_first_success_at: row.observed_first_success_at, rotation_count: row.rotation_count, probe_playback_match_count: row.probe_playback_match_count, detected_expires_at: row.detected_expires_at });
    result.classification = cls.classification;
    await recordObservation(episodeId, provider, { checkPath: 'BOTH', url: url, directStatus: dr.status, directDurationMs: dr.durationMs, directContentType: dr.contentType, proxyStatus: pr.status, proxyDurationMs: pr.durationMs, proxyContentType: pr.contentType, probeAlive: dr.alive, playbackAlive: pr.alive });
    var urlDead = dr.status === 403 || dr.status === 404;
    var proxyFails = pr.status === 403 || pr.status === 502;
    if (forceRefresh || (urlDead && proxyFails)) {
      var ahp = require('./animeHeavenProvider');
      var [ar] = await db.query('SELECT a.animeheaven_slug, e.animeheaven_episode_key FROM episodes e JOIN anime a ON a.id = e.anime_id WHERE e.id = ?', [episodeId]);
      if (ar && ar[0] && ar[0].animeheaven_slug && ar[0].animeheaven_episode_key) {
        var fr = await ahp.provider.resolveStreamByKey({ slug: ar[0].animeheaven_slug, episodeKey: ar[0].animeheaven_episode_key });
        if (fr && fr.sources && fr.sources.length > 0) {
          var newUrl = fr.streamUrl || fr.sources[0].url;
          await recordRotation(episodeId, provider, url, newUrl);
          await sc.saveStream(episodeId, provider, fr);
          result.status = 'refreshed'; result.urlChanged = url !== newUrl;
          result.hostChanged = oldFp && oldFp.host !== (fingerprint(newUrl) ? fingerprint(newUrl).host : null);
          result.tokenChanged = extractCdnToken(url) !== extractCdnToken(newUrl);
        } else { result.status = 'resolve_failed'; }
      } else { result.status = 'no_identifiers'; }
    } else if (urlDead && !proxyFails) { result.status = 'direct_fail_proxy_ok'; }
    else if (dr.status >= 200 && dr.status < 400) { result.status = 'healthy'; }
    else { result.status = 'unknown_status'; }
  } catch (err) { result.status = 'error'; result.error = err.message; }
  return result;
}

module.exports = { CLASSIFICATION, OBSERVATION_INTERVAL_MS, LONG_LIVED_THRESHOLD_MS, OBSERVATION_CONCURRENCY, extractContentHash, extractCdnToken, checkDirect, checkProxy, classifyFailureStatus, recordObservation, recordRotation, classifyUrl, isObservationDue, observeOnCacheHit, syncAnime, processEpisode };
