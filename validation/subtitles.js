'use strict';

/**
 * validation/subtitles.js
 *
 * Subtitle Validator
 *
 * Reads harvested subtitle data from the shared context and analyzes:
 *   - coverage: how many resolved episodes had subtitles
 *   - delivery distribution: external vs embedded vs missing vs unknown
 *   - external-only coverage (strict, for providers expected to expose
 *     external tracks)
 *   - language diversity (English/Japanese/other)
 *   - formats (vtt/srt/ass/ssa)
 *   - URL validity (https, no obvious malformed URLs)
 *
 * IMPORTANT: Subtitle availability is derived ONCE upstream (validation/context.js
 * -> deriveSubtitleMode()) and stored as context.subtitles[].subtitleMode. This
 * validator consumes that normalized field and does NOT re-infer availability
 * from `subtitles.length > 0`. Providers profiled to deliver EMBEDDED subtitles
 * (e.g. AnimeHeaven) are counted as satisfied when the stream is healthy, even
 * though they expose no external track — their absence is EXPECTED, not a failure.
 *
 * Emits:
 *   reports/<run>/subtitle-validation.json
 */

const { writeJson, readPreviousJson } = require('./reporters');

function normLang(lang) {
  const raw = String(lang || 'Unknown').trim();
  if (!raw) return 'Unknown';
  const lower = raw.toLowerCase();
  if (lower.includes('english') || lower === 'en' || lower === 'eng') return 'English';
  if (lower.includes('japanese') || lower === 'ja' || lower === 'jp' || lower === 'jpn') return 'Japanese';
  if (lower.includes('spanish') || lower === 'es' || lower === 'spa') return 'Spanish';
  if (lower.includes('french') || lower === 'fr' || lower === 'fra') return 'French';
  if (lower.includes('german') || lower === 'de' || lower === 'deu') return 'German';
  if (lower.includes('portuguese') || lower === 'pt' || lower === 'por') return 'Portuguese';
  if (lower.includes('italian') || lower === 'it' || lower === 'ita') return 'Italian';
  if (lower.includes('arabic') || lower === 'ar' || lower === 'ara') return 'Arabic';
  if (lower.includes('korean') || lower === 'ko' || lower === 'kor') return 'Korean';
  if (lower.includes('chinese') || lower === 'zh' || lower === 'zho') return 'Chinese';
  if (lower.includes('indonesian') || lower === 'id' || lower === 'ind') return 'Indonesian';
  return raw;
}

function formatOf(url) {
  const raw = String(url || '').toLowerCase();
  if (/\.vtt(\?|$)/.test(raw)) return 'vtt';
  if (/\.srt(\?|$)/.test(raw)) return 'srt';
  if (/\.ass(\?|$)/.test(raw)) return 'ass';
  if (/\.ssa(\?|$)/.test(raw)) return 'ssa';
  return 'other';
}

/**
 * Run subtitle validation over harvested rows.
 * @param {object} context - shared ValidationContext
 * @returns {Promise<object>} report payload
 */
async function runSubtitleValidation(context) {
  const rows = context.subtitles || [];

  // Normalize each row's subtitle mode. Prefer the canonical field computed by
  // context.js; fall back to a safe derivation for callers that pass raw rows.
  const normalized = rows.map((r) => {
    const mode = r.subtitleMode
      || (r.externalTracks ? 'external' : (r.ok && r.subtitles && !r.subtitles.length ? 'embedded' : (r.ok ? 'missing' : 'unknown')));
    return Object.assign({}, r, { subtitleMode: mode });
  });

  // Delivery distribution.
  const externalSatisfied = normalized.filter(r => r.subtitleMode === 'external');
  const embeddedSatisfied = normalized.filter(r => r.subtitleMode === 'embedded');
  const missing = normalized.filter(r => r.subtitleMode === 'missing');
  const unknown = normalized.filter(r => r.subtitleMode === 'unknown');

  // Overall coverage = satisfied (external OR embedded) / total. Embedded is
  // satisfied because a healthy stream from an embedded-delivery provider IS
  // subtitle-capable (burned-in) — absence of external tracks is expected.
  const satisfied = [...externalSatisfied, ...embeddedSatisfied];
  const coverageRate = rows.length ? Number(((satisfied.length / rows.length) * 100).toFixed(2)) : 0;

  // External-only coverage (strict): how many episodes actually expose external
  // tracks. This keeps validation strict for providers expected to deliver
  // external subtitles, without penalizing embedded-delivery providers.
  const externalCoverageRate = rows.length
    ? Number(((externalSatisfied.length / rows.length) * 100).toFixed(2))
    : 0;

  const byLang = {};
  const byFormat = {};
  const malformed = [];
  const seenUrls = new Set();
  let totalSubtitleTracks = 0;
  let totalResolvedEpisodes = rows.length;

  for (const row of rows) {
    if (!Array.isArray(row.subtitles)) continue;
    for (const sub of row.subtitles) {
      if (!sub || !sub.url) continue;
      totalSubtitleTracks += 1;
      const lang = normLang(sub.lang);
      byLang[lang] = byLang[lang] || { count: 0 };
      byLang[lang].count += 1;

      const format = formatOf(sub.url);
      byFormat[format] = byFormat[format] || { count: 0 };
      byFormat[format].count += 1;

      if (seenUrls.has(sub.url)) {
        malformed.push({ type: 'duplicate', url: sub.url, row: row.title });
      }
      seenUrls.add(sub.url);

      if (!/^https?:\/\//i.test(sub.url)) {
        malformed.push({ type: 'invalid_url', url: sub.url, row: row.title });
      }
      if (typeof sub.url !== 'string' || sub.url.length < 12) {
        malformed.push({ type: 'too_short', url: sub.url, row: row.title });
      }
    }
  }

  const resolvedEpisodesWithStream = context.streams.filter(s => s.ok).length;
  const subtitleCoverageOfResolved = resolvedEpisodesWithStream
    ? Number(((satisfied.length / resolvedEpisodesWithStream) * 100).toFixed(2))
    : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalResolvedEpisodes,
      resolvedEpisodesWithStreams: resolvedEpisodesWithStream,
      episodesWithSubtitles: satisfied.length,
      episodesWithoutSubtitles: missing.length,
      unknown: unknown.length,
      coverageRate,
      externalCoverageRate,
      subtitleCoverageOfResolved,
      totalSubtitleTracks,
      uniqueSubtitleUrls: seenUrls.size,
      malformedCount: malformed.length,
    },
    deliveryDistribution: {
      external: externalSatisfied.length,
      embedded: embeddedSatisfied.length,
      missing: missing.length,
      unknown: unknown.length,
    },
    byLanguage: byLang,
    byFormat: byFormat,
    missing: missing.slice(0, 20).map(r => ({
      provider: r.provider,
      title: r.title,
      episode: r.episode,
    })),
    malformed: malformed.slice(0, 20),
    // All rows (trimmed to recent 50) for the report
    rows: rows.slice(-50).map(r => ({
      provider: r.provider,
      title: r.title,
      episode: r.episode,
      ok: r.ok,
      subtitleMode: r.subtitleMode || 'unknown',
      subtitleCount: Array.isArray(r.subtitles) ? r.subtitles.length : 0,
    })),
  };

  // Trend comparison
  const prev = readPreviousJson('subtitle-validation', context.runId);
  if (prev && prev.summary) {
    report.trend = {
      previousCoverageRate: prev.summary.coverageRate ?? null,
      deltaCoverage: Number((coverageRate - (prev.summary.coverageRate || 0)).toFixed(2)),
      previousExternalCoverageRate: prev.summary.externalCoverageRate ?? null,
      deltaExternalCoverage: Number((externalCoverageRate - (prev.summary.externalCoverageRate || 0)).toFixed(2)),
      previousTrackCount: prev.summary.totalSubtitleTracks ?? null,
      deltaTracks: totalSubtitleTracks - (prev.summary.totalSubtitleTracks || 0),
    };
  }

  writeJson('subtitle-validation', report, context.runId);
  return report;
}

module.exports = { runSubtitleValidation, normLang, formatOf };
