'use strict';

/**
 * validation/context.js
 *
 * Shared validation context + lightweight harvest pass.
 *
 * Instead of every validator performing its own network calls to the providers,
 * a "harvest" pass runs first (run by index.js -> context.harvest()) and stores
 * results in context.providers / context.streams / context.subtitles.
 *
 * Validators then read from these arrays. This dramatically cuts duplicate
 * network traffic and keeps every validator focused on ANALYSIS, not scraping.
 */

const path = require('path');

const { provider: animeHeavenProvider } = require('../services/animeHeavenProvider');
const { provider: consumetProvider } = require('../services/consumetProvider');
const hostedConsumet = require('../services/hostedConsumetProvider');
const {
  PROVIDER_IDS,
  getDefaultProviderOrder,
  listKnownConsumetProviders,
} = require('../services/providerRegistry');
const {
  subtitleDeliveryFor,
  SUBTITLE_DELIVERY,
} = require('./providerProfile');

// Default harvest targets — keep small so nightly runs stay fast.
const DEFAULTS = {
  episodesPerAnime: 3,
  targets: [
    { title: 'One Piece', episode: 1 },
    { title: 'Naruto', episode: 1 },
    { title: 'Jujutsu Kaisen', episode: 1 },
    { title: 'Demon Slayer', episode: 1 },
    { title: 'Steins Gate', episode: 1 },
  ],
};

function nowIso() {
  return new Date().toISOString();
}

/**
 * Wrap a provider method with timing + error capture so the context can
 * accumulate latency/status without altering the provider's own health tracking.
 */
function timed(fn) {
  const start = Date.now();
  return Promise.resolve()
    .then(fn)
    .then(result => ({ result, latencyMs: Date.now() - start, error: null }))
    .catch(error => ({
      result: null,
      latencyMs: Date.now() - start,
      error: error && (error.message || String(error)),
    }));
}

/**
 * Derive the canonical subtitle mode for a resolved provider row.
 *
 * This is the SINGLE SOURCE OF TRUTH for subtitle availability across the
 * validation pipeline. It deliberately does NOT infer availability from
 * `subtitles.length > 0` alone, because providers profiled to deliver EMBEDDED
 * subtitles (burned into the video frames) intentionally expose no separate
 * external track — their absence is EXPECTED behaviour, not a failure.
 *
 * Modes:
 *   'external'  -> separate .vtt/.srt/.ass/.ssa tracks present. PASS.
 *   'embedded'  -> no external tracks, stream healthy, provider profiled to
 *                  deliver embedded subtitles. PASS (not missing).
 *   'missing'   -> stream healthy, provider EXPECTED to expose external tracks
 *                  but none were found. Genuine FAIL.
 *   'unknown'   -> cannot determine: stream never resolved / scraper crashed /
 *                  provider delivery policy not profiled. NOT auto-"missing".
 *
 * @param {object} args
 * @param {boolean} args.ok        - whether a playable stream was resolved
 * @param {Array}  args.subtitles  - external subtitle track array
 * @param {string} args.delivery   - provider delivery profile (SUBTITLE_DELIVERY.*)
 * @param {string|null} [args.runnerMode] - provider-reported subtitleMode hint
 * @returns {string} one of 'external' | 'embedded' | 'missing' | 'unknown'
 */
function deriveSubtitleMode({ ok, subtitles, delivery, runnerMode }) {
  const tracks = Array.isArray(subtitles) ? subtitles : [];
  if (tracks.length > 0) return 'external';
  // No external tracks found. Now decide why.
  if (!ok) return 'unknown'; // stream never resolved / scraper crashed / aborted
  if (delivery === SUBTITLE_DELIVERY.EMBEDDED) {
    // Provider intentionally delivers burned-in subtitles. A healthy stream +
    // embedded policy is a PASS unless the runner explicitly reported 'missing'.
    return runnerMode === 'missing' ? 'missing' : 'embedded';
  }
  if (delivery === SUBTITLE_DELIVERY.EXTERNAL) {
    // Provider is expected to expose external tracks but none were found.
    return 'missing';
  }
  // Delivery policy UNKNOWN or NONE -> cannot confidently call it missing.
  return 'unknown';
}

class ValidationContext {
  constructor(options = {}) {
    this.options = typeof options === 'object' && options ? options : {};
    this.targets = this.options.targets || DEFAULTS.targets;
    this.episodesPerAnime = this.options.episodesPerAnime ?? DEFAULTS.episodesPerAnime;

    this.runId = this.options.runId || null;
    this.startedAt = nowIso();
    this.finishedAt = null;

    // Harvest accumulators
    this.providers = [];
    this.searches = [];
    this.details = [];
    this.episodes = [];
    this.streams = [];
    this.subtitles = [];
    this.metadata = [];
    this.httpHealth = [];
    this.errors = [];

    this.log = [];
  }

  addLog(level, msg, data) {
    const entry = { at: nowIso(), level: level || 'info', msg, data: data || {} };
    this.log.push(entry);
    if (this.log.length > 5000) this.log.splice(0, this.log.length - 5000);
    return entry;
  }

  _recordError(provider, method, error) {
    this.errors.push({
      at: nowIso(),
      provider,
      method,
      error: String((error && (error.message || error)) || error || 'unknown'),
    });
  }

  /**
   * Discover provider ids to validate, using the registry as source of truth.
   * @returns {Array<string>} canonical provider ids
   */
  listProviderIds() {
    const ids = new Set();
    try {
      const order = getDefaultProviderOrder();
      if (Array.isArray(order)) {
        for (const tag of order) {
          if (!tag) continue;
          const raw = String(tag);
          // 'consumet-http' is a canonical id itself — never strip its prefix.
          if (raw === String(PROVIDER_IDS.CONSUMET_HTTP)) {
            ids.add(PROVIDER_IDS.CONSUMET_HTTP);
          } else {
            // Tags like 'consumet-kickassanime' -> 'kickassanime'.
            const id = raw.replace(/^consumet-/, '');
            if (id) ids.add(id);
          }
        }
      }
    } catch (e) {
      this._recordError('registry', 'getDefaultProviderOrder', e);
    }

    try {
      const consumetIds = listKnownConsumetProviders();
      if (Array.isArray(consumetIds)) consumetIds.forEach(x => x && ids.add(String(x)));
    } catch (e) {
      this._recordError('registry', 'listKnownConsumetProviders', e);
    }

    ids.add(String(PROVIDER_IDS.ANIME_HEAVEN || 'animeheaven'));

    // Only include the hosted consumet provider if it is actually configured
    // (avoids harvesting a permanently-failing provider).
    let hostedConfigured = false;
    try {
      hostedConfigured = typeof hostedConsumet.isConfigured === 'function' && hostedConsumet.isConfigured();
    } catch (e) {
      this._recordError('registry', 'hostedConsumet.isConfigured', e);
    }
    if (hostedConfigured) ids.add(String(PROVIDER_IDS.CONSUMET_HTTP));

    // Exclude providers that cannot be resolved by _resolveStreamForProvider:
    //   miruro (disabled pending adapter), legacy DB-only labels, meta providers.
    const excluded = new Set(['miruro', 'gogoanime', 'zoro', 'kitsu', 'consumet']);
    return [...new Set([...ids].map(x => String(x).toLowerCase()))].filter(x => !excluded.has(x));
  }

  /**
   * Resolve a stream for a single provider + target, normalized to the
   * pipeline's expected output shape.
   * @param {string} provider canonical provider id
   * @param {object} target { title, episode, identifier?, slug? }
   * @returns {Promise<object|null>} { streamUrl, sources, subtitles, ... } or null
   */
  async _resolveStreamForProvider(provider, target) {
    const { title, episode } = target;

    // AnimeHeaven: resolveStream({title, episode, identifier, slug})
    if (provider === String(PROVIDER_IDS.ANIME_HEAVEN).toLowerCase()) {
      if (animeHeavenProvider && typeof animeHeavenProvider.resolveStream === 'function') {
        return animeHeavenProvider.resolveStream({
          title,
          episode,
          identifier: target.identifier || null,
          slug: target.slug || null,
        });
      }
    }

    // Hosted Consumet: resolveStream({title, episode})
    if (provider === String(PROVIDER_IDS.CONSUMET_HTTP).toLowerCase()) {
      if (hostedConsumet && typeof hostedConsumet.resolveStream === 'function') {
        return hostedConsumet.resolveStream({ title, episode });
      }
    }

    // Consumet sub-providers: resolveStreamUrl({provider, title, episode})
    if (consumetProvider && typeof consumetProvider.resolveStreamUrl === 'function') {
      return consumetProvider.resolveStreamUrl({ provider, title, episode });
    }

    return null;
  }

  /**
   * Harvest all providers for all targets.
   * @returns {Promise<this>}
   */
  async harvest() {
    this.addLog('info', 'harvest:start', { targets: this.targets.length });
    const providerIds = this.listProviderIds();
    this.addLog('info', 'harvest:providers', { providerIds });

    for (const provider of providerIds) {
      for (const target of this.targets) {
        const outcome = await timed(() => this._resolveStreamForProvider(provider, target));

        if (outcome.error) {
          this._recordError(provider, 'resolveStream', outcome.error);
          this.providers.push({ provider, title: target.title, episode: target.episode, ok: false, error: outcome.error, latencyMs: outcome.latencyMs });
          this.streams.push({ provider, title: target.title, episode: target.episode, ok: false, error: outcome.error, latencyMs: outcome.latencyMs, stream: null, sources: [] });
          this.subtitles.push({ provider, title: target.title, episode: target.episode, ok: false, subtitles: [] });
          continue;
        }

        const result = outcome.result || {};
        const ok = Boolean(result.streamUrl || (Array.isArray(result.sources) && result.sources.length));
        const sources = Array.isArray(result.sources) ? result.sources : Array.isArray(result.allSources) ? result.allSources : [];
        const rawSubtitles = Array.isArray(result.subtitles) ? result.subtitles : [];

        // Subtitle availability is derived ONCE here via deriveSubtitleMode() —
        // the canonical single source of truth for the whole pipeline. Validators
        // (subtitles, readiness, metadata) must consume this normalized mode
        // rather than re-inferring availability from `subtitles.length > 0`.
        //
        //   external -> PASS (separate tracks present)
        //   embedded -> PASS (stream healthy + provider profiled to burn-in
        //               subtitles; absence of external tracks is EXPECTED)
        //   missing  -> FAIL (provider expected to expose external tracks but none)
        //   unknown  -> stream not resolved / policy unprofiled (not auto-missing)
        const delivery = subtitleDeliveryFor(provider);
        const runnerMode = result.subtitleMode || null;
        const subtitleMode = deriveSubtitleMode({
          ok,
          subtitles: rawSubtitles,
          delivery,
          runnerMode,
        });
        const subtitleOk = subtitleMode === 'external' || subtitleMode === 'embedded';
        const externalTracks = rawSubtitles.length > 0;

        this.providers.push({
          provider,
          title: target.title,
          episode: target.episode,
          ok,
          latencyMs: outcome.latencyMs,
          streamUrl: result.streamUrl || (sources[0] && sources[0].url) || null,
          sourceCount: sources.length,
          subtitleCount: rawSubtitles.length,
          subtitleMode,
          externalTracks,
          reason: result.reason || null,
        });

        this.streams.push({
          provider,
          title: target.title,
          episode: target.episode,
          ok,
          latencyMs: outcome.latencyMs,
          stream: result,
          sources,
          reason: result.reason || null,
        });

        this.subtitles.push({
          provider,
          title: target.title,
          episode: target.episode,
          ok: subtitleOk,
          subtitles: rawSubtitles,
          subtitleMode,
          externalTracks,
        });

        // Metadata: derive completeness from the stream result where possible.
        this.metadata.push({
          provider,
          title: target.title,
          episode: target.episode,
          ok,
          hasStream: Boolean(result.streamUrl || sources.length),
          hasSubtitles: subtitleOk,
          subtitleMode,
          sourceCount: sources.length,
          subtitleCount: rawSubtitles.length,
        });
      }
    }

    this.finishedAt = nowIso();
    this.addLog('info', 'harvest:end', { providers: this.providers.length, streams: this.streams.length });
    return this;
  }

  providerRows(provider) {
    return this.providers.filter(r => r.provider === provider);
  }

  streamRows(provider) {
    return this.streams.filter(r => r.provider === provider);
  }

  subtitleRows(provider) {
    return this.subtitles.filter(r => r.provider === provider);
  }

  allStreamUrls() {
    const urls = new Set();
    for (const row of this.streams) {
      if (Array.isArray(row.sources)) {
        for (const s of row.sources) {
          if (s && s.url) urls.add(s.url);
        }
      }
      if (row.stream && row.stream.streamUrl) urls.add(row.stream.streamUrl);
    }
    return [...urls];
  }
}

module.exports = { ValidationContext, DEFAULTS, nowIso, deriveSubtitleMode };
