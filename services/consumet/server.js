// ============================================================
//  services/consumet/server.js — Consumet Express Microservice
//
//  Provides REST endpoints for Consumet-based streaming.
//  Uses the SHARED HTTP layer from utils/providerHttp.js for
//  ALL outbound requests — eliminating duplicate networking code.
//
//  This microservice is mounted at /consumet-api in server.js
//  and is purely an alternative to the in-memory ConsumetProvider.
//
//  NETWORKING ARCHITECTURE (single implementation across project):
//    watch.js → streamController → streamingService
//      → consumetProvider / consumet microservice
//        → providerHttp.request() ← SHARED
//          → proxy rotation, retry, health tracking, logging
// ============================================================
const express = require('express');
const cors = require('cors');
const consumet = require('@consumet/extensions');
const { request: providerRequest, buildHeaders } = require('../../utils/providerHttp');
const { createStreamingInstance } = require('../../utils/streamingHttp');
const {
  PROVIDER_IDS,
  getConsumetPreferredOrder,
  toConsumetClassName,
} = require('../providerRegistry');

const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!META || !META.Anilist || !ANIME) {
  console.error('Available META providers:', Object.keys(META || {}));
  console.error('Available ANIME providers:', Object.keys(ANIME || {}));
  throw new Error('[Consumet Microservice] Failed to extract providers from @consumet/extensions.');
}

console.log('[Consumet Microservice] ✅ Loaded META.Anilist');

// ── Shared HTTP Layer via providerHttp.request() ──────────
// Instead of creating its own axios instance with independent proxy rotation,
// retry logic, and headers (which was duplicated from utils/providerHttp.js),
// this microservice now delegates ALL outbound HTTP to the shared
// providerHttp.request() function via an axios adapter.
//
// Benefits of this approach:
//   • Single networking stack across the entire project
//   • Shared residential proxy rotation (round-robin)
//   • Shared retry logic (3 attempts, exponential backoff, jitter)
//   • Shared health tracking (per-provider success/failure rates)
//   • Shared browser headers (buildHeaders) and timeouts
//   • Shared structured logging (provider, attempt, status, time, proxy)
//   • Error classification (11 categories via classifyError)
//   • All managed in one place: utils/providerHttp.js
const sharedHeaders = buildHeaders(PROVIDER_IDS.CONSUMET);

// Dedicated streaming client: 10s timeout, retries disabled, streaming
// logging. This keeps the streaming pipeline's timeout scoped to streaming
// only — never applied globally via axios.defaults.
const customAxios = createStreamingInstance({
  timeout: 10000,
  headers: sharedHeaders,
  tag: 'consumet-microservice',
});

// Replace the default adapter to route through the shared HTTP layer.
// The adapter receives axios config objects and delegates to
// providerHttp.request(), which handles proxy rotation, retries,
// health tracking, and structured logging internally.
customAxios.defaults.adapter = async (config) => {
  try {
    const response = await providerRequest(config, {
      providerName: PROVIDER_IDS.CONSUMET_HTTP,
      timeout: config.timeout || 10000,
      streaming: true, // 10s cap + retries disabled (dedicated streaming client)
    });

    // Transform to axios-compatible response shape
    return {
      data: response.data,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      config,
    };
  } catch (err) {
    // If providerHttp returned a response (non-2xx after retries exhausted),
    // return it as a proper axios response so axios creates an AxiosError
    // with the response attached — matching standard axios behavior.
    if (err.response) {
      return {
        data: err.response.data,
        status: err.response.status,
        statusText: err.response.statusText,
        headers: err.response.headers,
        config,
      };
    }
    // Network-level error (timeout, DNS failure, ECONNREFUSED) — rethrow
    throw err;
  }
};

console.log('[Consumet Microservice] ✅ Using shared providerHttp layer for all HTTP traffic');

// ── Select best available provider ─────────────────────────
const availableProviders = Object.keys(ANIME);
console.log(`[Consumet Microservice] Available ANIME providers: ${availableProviders.join(', ')}`);

const preferredOrder = getConsumetPreferredOrder();

let fallbackProvider = null;

for (const name of preferredOrder) {
  const key = availableProviders.find(k => k.toLowerCase() === name.toLowerCase());
  if (key && typeof ANIME[key] === 'function') {
    try {
      console.log(`[Consumet Microservice] ✅ Using provider: ${key}`);
      fallbackProvider = new ANIME[key](customAxios);
      break;
    } catch (e) {
      console.warn(`[Consumet Microservice] Failed to instantiate ${key}: ${e.message}`);
    }
  }
}

if (!fallbackProvider) {
  // Blind fallback must avoid providers excluded for proxy/fetch reliability.
  // The exclusion set is derived from the registry (canonical IDs → class names).
  const excludedClassNames = new Set(
    [PROVIDER_IDS.ANIME_PAHE, PROVIDER_IDS.HIANIME]
      .map(id => toConsumetClassName(id))
      .filter(Boolean)
  );
  const safeKey = availableProviders.find(key =>
    typeof ANIME[key] === 'function' &&
    !excludedClassNames.has(key)
  );
  if (safeKey) {
    console.log(`[Consumet Microservice] ⚠️  Blind fallback: ${safeKey}`);
    fallbackProvider = new ANIME[safeKey](customAxios);
  } else {
    throw new Error('[Consumet Microservice] CRITICAL: No usable anime providers found.');
  }
}

const provider = new META.Anilist(fallbackProvider);

// ── Express App ────────────────────────────────────────────
const app = express();
app.use(cors());

/**
 * GET /consumet-api/anime/gogoanime/:id
 * Fetch anime info (episode list, metadata).
 */
app.get('/anime/gogoanime/:id', async (req, res) => {
    try {
        const animeInfo = await provider.fetchAnimeInfo(req.params.id);
        res.json(animeInfo);
    } catch (err) {
        console.error(`[Consumet Microservice] fetchAnimeInfo error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /consumet-api/anime/gogoanime/watch/:episodeId
 * Fetch streaming sources for a specific episode.
 */
app.get('/anime/gogoanime/watch/:episodeId', async (req, res) => {
    try {
        const links = await provider.fetchEpisodeSources(req.params.episodeId);
        res.json(links);
    } catch (err) {
        console.error(`[Consumet Microservice] fetchEpisodeSources error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

module.exports = app;

