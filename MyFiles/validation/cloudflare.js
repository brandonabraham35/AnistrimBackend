'use strict';

/**
 * validation/cloudflare.js
 *
 * Cloudflare Validator
 *
 * Detects Cloudflare / anti-bot challenges in provider responses. It probes
 * the AnimeHeaven provider (and its mirrors) plus the Consumet sub-providers
 * for common Cloudflare challenge signatures.
 *
 * Emits:
 *   reports/<run>/cloudflare-validation.json
 */

const { provider: animeHeavenProvider } = require('../services/animeHeavenProvider');
const { getHealthStats } = require('../utils/providerHttp');
const { writeJson, readPreviousJson } = require('./reporters');

const CF_PATTERNS = [
  /cloudflare/i,
  /cf-challenge/i,
  /just a moment/i,
  /attention required/i,
  /browser verification/i,
  /access denied/i,
  /captcha/i,
  /cf-ray/i,
  /turnstile/i,
];

function detectCloudflare(input) {
  const text = String(input || '').toLowerCase();
  return CF_PATTERNS.some(rx => rx.test(text));
}

/**
 * Probe a single URL for Cloudflare signatures using a lightweight fetch.
 * @param {string} url
 * @returns {Promise<{url, cloudflare, status, error}>}
 */
async function probeCloudflare(url) {
  try {
    const { get } = require('../utils/providerHttp');
    const res = await get(url, {
      providerName: 'animeheaven',
      streaming: true,
      timeout: 8000,
      dontTrackHealth: true,
    });
    const html = String(res.data || '');
    return {
      url,
      cloudflare: detectCloudflare(html),
      status: Number(res.status || 0),
      error: null,
    };
  } catch (e) {
    const status = Number(e?.response?.status || 0);
    return {
      url,
      cloudflare: status === 403 || detectCloudflare(e?.response?.data),
      status,
      error: e && (e.message || String(e)),
    };
  }
}

/**
 * Run Cloudflare validation.
 * @param {object} context - shared ValidationContext
 * @param {object} options
 * @returns {Promise<object>} report payload
 */
async function runCloudflareValidation(context, options = {}) {
  const probeUrls = [];

  // Build a list of URLs to probe: harvested stream URLs + base domains.
  const allUrls = context.allStreamUrls();
  probeUrls.push(...allUrls.slice(0, options.maxUrls ?? 20));

  // Add known provider base domains for a direct probe.
  const baseUrls = [
    'https://animeheaven.ru/',
    'https://animeheaven.me/',
    'https://kickassanime.am/',
    'https://animepahe.ru/',
    'https://hianime.to/',
  ];
  probeUrls.push(...baseUrls);

  // Dedupe.
  const seen = new Set();
  const uniqueUrls = probeUrls.filter((u) => {
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  const results = [];
  for (const url of uniqueUrls.slice(0, options.maxProbes ?? 30)) {
    results.push(await probeCloudflare(url));
  }

  const cloudflareDetected = results.filter(r => r.cloudflare);
  const clean = results.filter(r => !r.cloudflare);
  const total = results.length;

  // Also include provider health stats to detect 403 spikes.
  const healthStats = getHealthStats('animeheaven');
  const cloudflareHits = cloudflareDetected.length;

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      total: total,
      clean: clean.length,
      cloudflareDetected: cloudflareHits,
      cloudflareRate: total ? Number(((cloudflareHits / total) * 100).toFixed(2)) : 0,
      animeheavenHealth: healthStats ? {
        consecutiveFailures: healthStats.consecutiveFailures,
        degraded: healthStats.degraded,
        successRate: healthStats.successRate,
      } : null,
    },
    detected: cloudflareDetected.slice(0, 20).map(r => ({ url: r.url, status: r.status })),
    results: results.map(r => ({ url: r.url, cloudflare: r.cloudflare, status: r.status, error: r.error })),
  };

  const prev = readPreviousJson('cloudflare-validation', context && context.runId);
  if (prev && prev.summary) {
    report.trend = {
      previousCloudflareRate: prev.summary.cloudflareRate ?? null,
      deltaCloudflareRate: Number(((report.summary.cloudflareRate || 0) - (prev.summary.cloudflareRate || 0)).toFixed(2)),
      previousDetectedCount: prev.summary.cloudflareDetected ?? null,
      deltaDetected: cloudflareHits - (prev.summary.cloudflareDetected || 0),
    };
  }

  writeJson('cloudflare-validation', report, context && context.runId);
  return report;
}

module.exports = { runCloudflareValidation, detectCloudflare, probeCloudflare };
