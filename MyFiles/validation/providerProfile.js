'use strict';

/**
 * validation/providerProfile.js
 *
 * Provider Policy / Capability Profile
 *
 * Central place to declare KNOWN behaviour of each streaming provider so the
 * validation layer can interpret results correctly WITHOUT hardcoding provider
 * knowledge inside the providers themselves.
 *
 * Today this focuses on subtitle delivery, but the structure is designed to
 * scale to other capabilities (expectedStreams, supportsMirrors,
 * supportsQualitySelection, supportsMultipleAudio, expectedLatencyMs, ...).
 *
 * Subtitle delivery values are EXPLICIT to avoid ambiguity:
 *   - 'external_tracks' : provider exposes separate .vtt/.srt/.ass/.ssa tracks
 *   - 'embedded'        : subtitles are burned/embedded into the video; the
 *                         provider intentionally does NOT expose separate
 *                         subtitle resources (e.g. AnimeHeaven direct MP4).
 *   - 'none'            : provider delivers no subtitles at all.
 *   - 'unknown'         : provider behaviour not yet profiled.
 *
 * IMPORTANT: An 'embedded' policy only counts as PASS when a playable stream
 * was actually resolved for the episode. A broken scraper must NOT be rewarded
 * for configured capability alone (see validation/context.js derivation).
 */

const PROVIDER_SUBTITLE_DELIVERY = Object.freeze({
  // AnimeHeaven delivers direct MP4 video; subtitles, when present, are
  // pre-rendered/burned into the frames. Verified by _subtitle_runtime_investigation.js
  // (subtitle-delivery-report.json). No separate subtitle resource is exposed,
  // so its absence is expected behaviour, NOT a validation failure.
  animeheaven: 'embedded',

  // Consumet-backed providers / hosted consumet expose external subtitle tracks.
  'consumet-http': 'external_tracks',
  kickassanime: 'external_tracks',
  animekai: 'external_tracks',
  animepahe: 'external_tracks',
  hianime: 'external_tracks',
  animesaturn: 'external_tracks',
  animesama: 'external_tracks',
  animeunity: 'external_tracks',

  // Providers not listed above default to 'unknown' via getProfile().
});

const SUBTITLE_DELIVERY = Object.freeze({
  EXTERNAL: 'external_tracks',
  EMBEDDED: 'embedded',
  NONE: 'none',
  UNKNOWN: 'unknown',
});

/**
 * Get the full profile for a provider id (normalised to lowercase).
 * Returns a frozen object; unknown providers get a default policy profile.
 * @param {string} provider - provider id (e.g. 'animeheaven', 'consumet-http')
 * @returns {object} profile
 */
function getProfile(provider) {
  const key = String(provider || '').toLowerCase();
  return Object.freeze({
    subtitleDelivery: PROVIDER_SUBTITLE_DELIVERY[key] || SUBTITLE_DELIVERY.UNKNOWN,
  });
}

/**
 * Get the subtitle delivery mode for a provider id.
 * @param {string} provider - provider id
 * @returns {string} one of SUBTITLE_DELIVERY values
 */
function subtitleDeliveryFor(provider) {
  return getProfile(provider).subtitleDelivery;
}

module.exports = {
  PROVIDER_SUBTITLE_DELIVERY,
  SUBTITLE_DELIVERY,
  getProfile,
  subtitleDeliveryFor,
};
