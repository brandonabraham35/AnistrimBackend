// =============================================================
//  services/providerRegistry.js — Centralized Provider Registry
//
//  SINGLE SOURCE OF TRUTH for all streaming provider identifiers.
//
//  Every provider name in the project MUST be referenced through these
//  exported constants and helper functions. No hardcoded provider strings
//  should appear anywhere else in the codebase.
//
//  Canonical provider IDs are lowercase, hyphen-free identifiers
//  (e.g. 'kickassanime', 'animekai'). Incoming names may arrive in many
//  shapes (PascalCase, kebab-case, lowercase, with/without 'consumet-'
//  prefix) and are normalized via normalizeProviderName().
//
//  Provider "tags" are the runtime identifiers used by the streaming
//  pipeline (e.g. 'consumet-kickassanime', 'miruro', 'consumet-http').
// =============================================================
'use strict';

const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
//  CANONICAL PROVIDER IDS
//  These are the single source of truth. Everything else derives
//  from these constants.
// ─────────────────────────────────────────────────────────────
const PROVIDER_IDS = Object.freeze({
  // Consumet-backed anime sub-providers.
  // NOTE: These MUST match the classes actually exported by the installed
  // @consumet/extensions version (verified against v1.8.8). Only providers
  // listed here AND present in the ANIME namespace are instantiable.
  KICK_ASS_ANIME: 'kickassanime',
  ANIME_KAI: 'animekai',
  ANIME_PAHE: 'animepahe',
  HIANIME: 'hianime',
  ANIME_SATURN: 'animesaturn',
  ANIME_SAMA: 'animesama',
  ANIME_UNITY: 'animeunity',
  ANIME_HEAVEN: 'animeheaven',

  // Legacy / metadata-only identifiers (NOT instantiable via Consumet).
  // GOGOANIME is used as a DB label in anime_mappings (catalogueService) and
  // does NOT correspond to any @consumet/extensions class in v1.8.8.
  // ZORO is retained as a legacy aniwatch alias but the 'Zoro' class does NOT
  // exist in v1.8.8 either.
  GOGOANIME: 'gogoanime',
  ZORO: 'zoro',

  // External API / meta providers
  MIRURO: 'miruro',
  KITSU: 'kitsu',

  // Consumet HTTP microservice + generic consumet tag
  CONSUMET_HTTP: 'consumet-http',
  CONSUMET: 'consumet',
});

// ─────────────────────────────────────────────────────────────
//  CONSUMET SUB-PROVIDER IDS
//  The subset of providers that are Consumet-backed and can be
//  instantiated from @consumet/extensions. Used to build the
//  in-memory registry and the default provider order.
// ─────────────────────────────────────────────────────────────
const CONSUMET_SUB_PROVIDER_IDS = Object.freeze([
  PROVIDER_IDS.KICK_ASS_ANIME,
  PROVIDER_IDS.ANIME_KAI,
  PROVIDER_IDS.ANIME_PAHE,
  PROVIDER_IDS.HIANIME,
  PROVIDER_IDS.ANIME_SATURN,
  PROVIDER_IDS.ANIME_SAMA,
  PROVIDER_IDS.ANIME_UNITY,
]);

// ─────────────────────────────────────────────────────────────
//  CONSUMET CLASS NAME MAP
//  Maps a canonical provider ID to the @consumet/extensions class
//  name (PascalCase). This replaces the manual pascal-case
//  conversion that previously lived in streamingService.js.
// ─────────────────────────────────────────────────────────────
// Only classes that are ACTUALLY exported by @consumet/extensions v1.8.8 are
// listed here. 'Gogoanime' and 'Zoro' were previously mapped but those classes
// do NOT exist in v1.8.8 — mapping them caused silent instantiation failures.
// GOGOANIME remains only as a DB metadata label and ZORO as a legacy alias.
const CONSUMET_PROVIDER_CLASS_NAMES = Object.freeze({
  [PROVIDER_IDS.KICK_ASS_ANIME]: 'KickAssAnime',
  [PROVIDER_IDS.ANIME_KAI]: 'AnimeKai',
  [PROVIDER_IDS.ANIME_PAHE]: 'AnimePahe',
  [PROVIDER_IDS.HIANIME]: 'Hianime',
  [PROVIDER_IDS.ANIME_SATURN]: 'AnimeSaturn',
  [PROVIDER_IDS.ANIME_SAMA]: 'AnimeSama',
  [PROVIDER_IDS.ANIME_UNITY]: 'AnimeUnity',
});

// ─────────────────────────────────────────────────────────────
//  REFERER MAP
//  Maps a canonical provider ID to its Referer/Origin header base.
//  Moved out of utils/providerHttp.js so all provider metadata lives
//  in one place.
// ─────────────────────────────────────────────────────────────
const PROVIDER_REFERERS = Object.freeze({
  [PROVIDER_IDS.CONSUMET]: 'https://consumet.org/',
  [PROVIDER_IDS.KICK_ASS_ANIME]: 'https://kickassanime.am/',
  [PROVIDER_IDS.ANIME_PAHE]: 'https://animepahe.ru/',
  [PROVIDER_IDS.ANIME_KAI]: 'https://animekai.to/',
  [PROVIDER_IDS.HIANIME]: 'https://hianime.to/',
  [PROVIDER_IDS.ANIME_SATURN]: 'https://animesaturn.mx/',
  [PROVIDER_IDS.ANIME_UNITY]: 'https://animeunity.it/',
  [PROVIDER_IDS.ANIME_HEAVEN]: 'https://animeheaven.ru/',
  [PROVIDER_IDS.MIRURO]: 'https://www.miruro.tv/',
  // 'consumet-http' referer is dynamic (based on CONSUMET_API_URL) and is
  // resolved inside getReferer() below.
  [PROVIDER_IDS.CONSUMET_HTTP]: null,
});

// ─────────────────────────────────────────────────────────────
//  NORMALIZATION INDEX
//  Builds a lookup map from a normalized key (lowercase, all
//  non-alphanumeric removed) to the canonical provider ID. This
//  robustly handles:
//    'KickAssAnime'     → 'kickassanime'
//    'kickassanime'     → 'kickassanime'
//    'kick-ass-anime'   → 'kickassanime'
//    'KICKASSANIME'     → 'kickassanime'
//    'consumet-animekai' → 'animekai'
// ─────────────────────────────────────────────────────────────
function normalizeKey(input) {
  if (typeof input !== 'string') return '';
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const NORMALIZED_TO_ID = new Map();
for (const id of Object.values(PROVIDER_IDS)) {
  NORMALIZED_TO_ID.set(normalizeKey(id), id);
}
// Add explicit aliases for any names that don't normalize to the
// canonical id (e.g. 'aniwatch' historically maps to zoro).
NORMALIZED_TO_ID.set('aniwatch', PROVIDER_IDS.ZORO);

// ─────────────────────────────────────────────────────────────
//  NORMALIZATION HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Normalize any incoming provider name to its canonical provider ID.
 * Handles PascalCase, kebab-case, lowercase, underscores, and the
 * 'consumet-' tag prefix.
 *
 * Examples:
 *   'KickAssAnime'       → 'kickassanime'
 *   'kickassanime'       → 'kickassanime'
 *   'consumet-animekai'  → 'animekai'
 *   'consumet-http'      → 'consumet-http'
 *   'Consumet-Http'      → 'consumet-http'
 *   'CONSUMET_HTTP'      → 'consumet-http'
 *
 * @param {string} input - Raw provider name (e.g. 'KickAssAnime',
 *   'kickassanime', 'consumet-kickassanime', 'kick-ass-anime',
 *   'consumet-http', 'CONSUMET_HTTP')
 * @returns {string|null} - Canonical provider ID, or null if unknown.
 */
function normalizeProviderName(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (!value) return null;

  const trimmed = value.toLowerCase();

  // If the ENTIRE value (including any 'consumet-' prefix) normalizes to a
  // known provider ID, use that first. This handles 'consumet-http' and
  // 'CONSUMET_HTTP' correctly — previously these returned null because the
  // prefix was stripped leaving 'http', which is not a registered ID.
  const fullKey = normalizeKey(value);
  const fullMatch = NORMALIZED_TO_ID.get(fullKey);
  if (fullMatch) return fullMatch;

  // Otherwise strip the 'consumet-' tag prefix (e.g. 'consumet-kickassanime')
  if (trimmed.startsWith('consumet-')) {
    value = value.slice('consumet-'.length);
  }

  const key = normalizeKey(value);
  const id = NORMALIZED_TO_ID.get(key);

  if (!id) {
    logger.warn('[ProviderRegistry] Unknown provider requested', { provider: input });
    return null;
  }
  return id;
}

/**
 * Check whether a raw provider name maps to a known provider.
 */
function isKnownProvider(input) {
  return normalizeProviderName(input) !== null;
}

/**
 * Convert a canonical provider ID to its @consumet/extensions class name.
 * Returns null if the ID is not a Consumet-backed provider.
 *
 * @param {string} id - Canonical provider ID (e.g. 'kickassanime')
 * @returns {string|null} - e.g. 'KickAssAnime'
 */
function toConsumetClassName(id) {
  const canonical = normalizeProviderName(id);
  if (!canonical) return null;
  return CONSUMET_PROVIDER_CLASS_NAMES[canonical] || null;
}

/**
 * Convert a canonical provider ID to its health tracking key.
 *   miruro        → 'miruro'
 *   consumet-http → 'consumet-http'
 *   others        → 'consumet-<id>'
 *
 * @param {string} id - Canonical provider ID
 * @returns {string} - Health key
 */
function toHealthKey(id) {
  const canonical = normalizeProviderName(id);
  if (!canonical) return null;
  // Non-Consumet-backed / external providers use their bare ID as the health key.
  if (
    canonical === PROVIDER_IDS.MIRURO ||
    canonical === PROVIDER_IDS.CONSUMET_HTTP ||
    canonical === PROVIDER_IDS.CONSUMET ||
    canonical === PROVIDER_IDS.KITSU
  ) {
    return canonical;
  }
  return `consumet-${canonical}`;
}

/**
 * Build a provider tag from a canonical provider ID.
 *   miruro        → 'miruro'
 *   consumet-http → 'consumet-http'
 *   kickassanime  → 'consumet-kickassanime'
 *
 * @param {string} id - Canonical provider ID
 * @returns {string} - Provider tag used by the streaming pipeline
 */
function toProviderTag(id) {
  const canonical = normalizeProviderName(id);
  if (!canonical) return null;
  // Non-Consumet-backed / external providers use their bare ID as the tag
  // (miruro, consumet-http, consumet generic, kitsu). Only Consumet-backed
  // sub-providers (those with a class-name mapping) get the 'consumet-' prefix.
  if (
    canonical === PROVIDER_IDS.MIRURO ||
    canonical === PROVIDER_IDS.CONSUMET_HTTP ||
    canonical === PROVIDER_IDS.CONSUMET ||
    canonical === PROVIDER_IDS.KITSU
  ) {
    return canonical;
  }
  // Consumet-backed providers (have a class name) use the 'consumet-' prefix.
  return CONSUMET_PROVIDER_CLASS_NAMES[canonical] ? `consumet-${canonical}` : canonical;
}

/**
 * Get the referer URL for a canonical provider ID.
 * Returns null if no referer is configured.
 *
 * @param {string} id - Canonical provider ID
 * @returns {string|null}
 */
function getReferer(id) {
  const canonical = normalizeProviderName(id);
  if (!canonical) return null;

  // 'consumet-http' referer is dynamic — it depends on the configured
  // CONSUMET_API_URL (mirrors the former hardcoded logic in providerHttp.js).
  if (canonical === PROVIDER_IDS.CONSUMET_HTTP) {
    return process.env.CONSUMET_API_URL || 'https://api.consumet.org/';
  }

  return PROVIDER_REFERERS[canonical] || null;
}

/**
 * List the canonical IDs of all known Consumet sub-providers.
 * @returns {string[]}
 */
function listKnownConsumetProviders() {
  return [...CONSUMET_SUB_PROVIDER_IDS];
}

/**
 * Get the default provider order (as tags) for the streaming pipeline.
 *
 * AnimeHeaven is now the SINGLE streaming provider. All multi-provider logic
 * (Consumet sub-providers, hosted Consumet, provider race/rotation/retries/
 * queues) has been removed from the streaming ENGINE. This function returns
 * only the AnimeHeaven tag so any consumer that derives the streaming provider
 * order from the registry sees a single entry.
 *
 * NOTE: The other provider IDs (kickassanime, animekai, etc.) and their
 * associated constants/helpers remain in this registry because NON-streaming
 * subsystems (catalogue, admin import, consumet microservice, providerHttp
 * referer map) still reference them. They are legacy and are NOT used by the
 * streaming engine anymore.
 *
 * @returns {string[]}
 */
function getDefaultProviderOrder() {
  return [PROVIDER_IDS.ANIME_HEAVEN].map(toProviderTag);
}

/**
 * Get the preferred Consumet class-name ordering (in @consumet class
 * names) for services/consumet/server.js fallback selection.
 * Mirrors the historical preferredOrder array exactly.
 * @returns {string[]}
 */
function getConsumetPreferredOrder() {
  return [
    PROVIDER_IDS.KICK_ASS_ANIME,
    PROVIDER_IDS.ANIME_PAHE,
    PROVIDER_IDS.ANIME_KAI,
    PROVIDER_IDS.ANIME_SATURN,
    PROVIDER_IDS.HIANIME,
    PROVIDER_IDS.ANIME_SAMA,
    PROVIDER_IDS.ANIME_UNITY,
  ].map(toConsumetClassName).filter(Boolean);
}

module.exports = {
  PROVIDER_IDS,
  CONSUMET_SUB_PROVIDER_IDS,
  CONSUMET_PROVIDER_CLASS_NAMES,
  PROVIDER_REFERERS,

  normalizeProviderName,
  isKnownProvider,
  toConsumetClassName,
  toHealthKey,
  toProviderTag,
  getReferer,
  listKnownConsumetProviders,
  getDefaultProviderOrder,
  getConsumetPreferredOrder,
};
