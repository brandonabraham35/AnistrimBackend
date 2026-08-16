'use strict';

/**
 * validation/streams.js
 *
 * Stream Validator
 *
 * Reads harvested stream results from the shared context and probes each
 * stream URL with a HEAD (or Range) request to determine whether the URL is
 * actually playable. Classifies each source as healthy / broken / unreachable
 * and aggregates per-provider stream health.
 *
 * Emits:
 *   reports/<run>/stream-validation.json
 */

const { request } = require('../utils/providerHttp');
const { writeJson, readPreviousJson } = require('./reporters');

const PROBE_TIMEOUT_MS = 8000;

function classifyUrl(url) {
  const raw = String(url || '').toLowerCase();
  if (!/^https?:\/\//i.test(raw)) return 'invalid';
  if (/\.(m3u8|m3u|mpd)(\?|$)/i.test(raw)) return 'hls';
  if (/\.(mp4|webm|mkv|mov|avi)(\?|$)/i.test(raw)) return 'direct';
  if (/\.(mp3|aac|ogg|wav|flac)(\?|$)/i.test(raw)) return 'audio';
  if (/\.(vtt|srt|ass|ssa)(\?|$)/i.test(raw)) return 'subtitle';
  if (/\.(png|jpe?g|gif|webp|svg|ico)(\?|$)/i.test(raw)) return 'image';
  return 'unknown';
}

/**
 * Probe a single stream URL with a Range/HEAD request.
 * @param {string} url
 * @returns {Promise<{url, ok, status, format, latencyMs, error}>}
 */
async function probeUrl(url, referer) {
  const start = Date.now();
  const extraHeaders = { Range: 'bytes=0-1023' };
  if (referer) extraHeaders.Referer = referer;

  try {
    const res = await request(
      { method: 'get', url, headers: extraHeaders },
      {
        providerName: 'animeheaven',
        streaming: true,
        timeout: PROBE_TIMEOUT_MS,
        extraHeaders,
        dontTrackHealth: true,
      }
    );

    const status = Number(res.status || 0);
    const ok = status >= 200 && status < 400;
    const contentType = String(res.headers?.['content-type'] || '');

    return {
      url,
      ok,
      status,
      format: classifyUrl(url),
      contentType,
      latencyMs: Date.now() - start,
      error: ok ? null : `HTTP ${status}`,
    };
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    return {
      url,
      ok: false,
      status,
      format: classifyUrl(url),
      contentType: '',
      latencyMs: Date.now() - start,
      error: error && (error.message || String(error)),
      timeout: /timeout|etimedout|econnaborted/i.test(String(error && (error.message || error.code || ''))),
    };
  }
}

/**
 * Analyze stream URLs from the harvested context.
 * @param {object} context - shared ValidationContext
 * @param {object} options
 * @returns {Promise<object>} report payload + per-row data
 */
async function runStreamValidation(context, options = {}) {
  const maxProbes = options.maxProbes ?? 40;
  const urls = context.allStreamUrls().slice(0, maxProbes);

  const probes = [];
  // Probe first N unique URLs (dedupe).
  const seen = new Set();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    probes.push(await probeUrl(url));
  }

  const byFormat = {};
  for (const p of probes) {
    byFormat[p.format] = byFormat[p.format] || { total: 0, healthy: 0, broken: 0 };
    byFormat[p.format].total += 1;
    if (p.ok) byFormat[p.format].healthy += 1;
    else byFormat[p.format].broken += 1;
  }

  const healthy = probes.filter(p => p.ok);
  const broken = probes.filter(p => !p.ok);
  const total = probes.length;
  const healthyRate = total ? Number(((healthy.length / total) * 100).toFixed(2)) : 0;

  // Per-provider stream health from harvested context.
  const perProvider = {};
  for (const row of context.streams) {
    const key = row.provider || 'unknown';
    perProvider[key] = perProvider[key] || { total: 0, ok: 0, failed: 0, latencyMs: 0 };
    perProvider[key].total += 1;
    if (row.ok) perProvider[key].ok += 1;
    else perProvider[key].failed += 1;
    perProvider[key].latencyMs += Number(row.latencyMs || 0);
  }
  for (const key of Object.keys(perProvider)) {
    perProvider[key].avgLatencyMs = perProvider[key].total
      ? Number((perProvider[key].latencyMs / perProvider[key].total).toFixed(2))
      : 0;
    perProvider[key].successRate = perProvider[key].total
      ? Number(((perProvider[key].ok / perProvider[key].total) * 100).toFixed(2))
      : 0;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalUrls: total,
      probedUrls: probes.length,
      healthy: healthy.length,
      broken: broken.length,
      healthyRate,
    },
    byFormat,
    perProvider,
    newestBroken: broken.slice(0, 10).map(p => ({ url: p.url, status: p.status, error: p.error })),
    probes: probes.map(p => ({ url: p.url, ok: p.ok, status: p.status, format: p.format, latencyMs: p.latencyMs, error: p.error })),
  };

  // Trend comparison vs previous run.
  const prev = readPreviousJson('stream-validation', context.runId);
  if (prev && prev.summary) {
    report.trend = {
      previousHealthyRate: prev.summary.healthyRate ?? null,
      deltaHealthyRate: Number((healthyRate - (prev.summary.healthyRate || 0)).toFixed(2)),
      previousBrokenCount: prev.summary.broken ?? null,
      deltaBroken: broken.length - (prev.summary.broken || 0),
    };
  }

  writeJson('stream-validation', report, context.runId);
  return report;
}

module.exports = { runStreamValidation, probeUrl, classifyUrl };
