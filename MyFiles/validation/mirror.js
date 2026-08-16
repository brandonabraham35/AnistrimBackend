'use strict';

/**
 * validation/mirror.js
 *
 * Mirror Validator
 *
 * Analyzes mirror-host stream URLs (vidstream, filemoon, mp4upload, dood,
 * streamwish, mixdrop, yourupload, filelions, etc.) harvested by the context.
 * Mirrors are the fallback hosts that AnimeHeaven uses when the primary player
 * fails, so their health directly affects production stream reliability.
 *
 * Emits:
 *   reports/<run>/mirror-validation.json
 */

const { writeJson, readPreviousJson } = require('./reporters');

const MIRROR_HINTS = [
  'vidstream',
  'filemoon',
  'mp4upload',
  'dood',
  'streamwish',
  'mixdrop',
  'yourupload',
  'filelions',
];

function isMirrorUrl(url) {
  const host = String(url || '').toLowerCase();
  return MIRROR_HINTS.some(h => host.includes(h));
}

function mirrorHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Run mirror validation over harvested stream rows.
 * @param {object} context - shared ValidationContext
 * @param {object} options
 * @returns {Promise<object>} report payload
 */
async function runMirrorValidation(context, options = {}) {
  const maxProbes = options.maxProbes ?? 30;

  // Collect all mirror URLs from harvested streams.
  const mirrorUrls = new Map(); // url -> { count, provider, title, episode }
  const allRows = context.streams || [];

  for (const row of allRows) {
    const sources = Array.isArray(row.sources) ? row.sources : [];
    for (const src of sources) {
      if (src && src.url && isMirrorUrl(src.url)) {
        if (!mirrorUrls.has(src.url)) {
          mirrorUrls.set(src.url, { count: 0, provider: row.provider, title: row.title, episode: row.episode });
        }
        mirrorUrls.get(src.url).count += 1;
      }
    }
  }

  const uniqueUrls = [...mirrorUrls.keys()].slice(0, maxProbes);

  // Group by host.
  const byHost = {};
  for (const url of uniqueUrls) {
    const host = mirrorHost(url) || 'unknown';
    byHost[host] = byHost[host] || { total: 0, urls: [] };
    byHost[host].total += 1;
    byHost[host].urls.push(url);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalMirrorOccurrences: [...mirrorUrls.values()].reduce((a, b) => a + b.count, 0),
      uniqueMirrorUrls: mirrorUrls.size,
      probedMirrorUrls: uniqueUrls.length,
      mirrorHosts: Object.keys(byHost).length,
      hosts: Object.keys(byHost),
    },
    byHost,
    uniqueUrls: uniqueUrls.map(u => ({ url: u, occurrences: mirrorUrls.get(u).count, provider: mirrorUrls.get(u).provider })),
  };

  const prev = readPreviousJson('mirror-validation', context && context.runId);
  if (prev && prev.summary) {
    report.trend = {
      previousUniqueMirrors: prev.summary.uniqueMirrorUrls ?? null,
      deltaUniqueMirrors: mirrorUrls.size - (prev.summary.uniqueMirrorUrls || 0),
      previousHosts: prev.summary.mirrorHosts ?? null,
      deltaHosts: Object.keys(byHost).length - (prev.summary.mirrorHosts || 0),
    };
  }

  writeJson('mirror-validation', report, context && context.runId);
  return report;
}

module.exports = { runMirrorValidation, isMirrorUrl, mirrorHost, MIRROR_HINTS };
