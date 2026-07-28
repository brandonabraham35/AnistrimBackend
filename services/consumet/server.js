// ============================================================
//  services/consumet/server.js — Consumet Express Microservice
//
//  Provides REST endpoints for Consumet-based streaming.
//  Uses the SHARED proxy configuration from utils/providerHttp.js
//  and the shared HTTP client for all outbound requests.
//
//  This microservice is mounted at /consumet-api in server.js
//  and is purely an alternative to the in-memory ConsumetProvider.
// ============================================================
const express = require('express');
const cors = require('cors');
const consumet = require('@consumet/extensions');
const { buildHeaders, getProxyList, createProxyAgent } = require('../../utils/providerHttp');

const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!META || !META.Anilist || !ANIME) {
  console.error('Available META providers:', Object.keys(META || {}));
  console.error('Available ANIME providers:', Object.keys(ANIME || {}));
  throw new Error('[Consumet Microservice] Failed to extract providers from @consumet/extensions.');
}

console.log('[Consumet Microservice] ✅ Loaded META.Anilist');

// ── Build shared axios instance ───────────────────────────
const axios = require('axios');

// Use unified headers from providerHttp
const sharedHeaders = buildHeaders('consumet');

const customAxios = axios.create({
  timeout: 15000,
  headers: sharedHeaders,
});

// Attach shared proxy rotation
const PROXY_LIST = getProxyList();
if (PROXY_LIST.length > 0) {
  console.log(`[Consumet Microservice] Using shared proxy rotation (${PROXY_LIST.length} proxies)`);

  let proxyIdx = 0;

  customAxios.interceptors.request.use(config => {
    const proxyUrl = PROXY_LIST[proxyIdx];
    proxyIdx = (proxyIdx + 1) % PROXY_LIST.length;
    if (proxyUrl) {
      config.httpsAgent = createProxyAgent(proxyUrl);
      config.headers['Referer'] = 'https://consumet.org/';
      config.headers['Origin'] = 'https://consumet.org';
    }
    return config;
  });

  // Retry 403 with next proxy
  customAxios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config;
      if (error.response?.status === 403 && !config._retry) {
        config._retry = true;
        console.warn('[Consumet Microservice] 403 — retrying with next proxy...');
        const nextProxy = PROXY_LIST[proxyIdx];
        proxyIdx = (proxyIdx + 1) % PROXY_LIST.length;
        if (nextProxy) {
          config.httpsAgent = createProxyAgent(nextProxy);
          return customAxios.request(config);
        }
      }
      return Promise.reject(error);
    }
  );
} else {
  console.log('[Consumet Microservice] No proxies configured. Using direct connections.');
}

// ── Select best available provider ─────────────────────────
const availableProviders = Object.keys(ANIME);
console.log(`[Consumet Microservice] Available ANIME providers: ${availableProviders.join(', ')}`);

const preferredOrder = [
  'KickAssAnime',
  'AnimePahe',
  'AnimeKai',
  'AnimeSaturn',
  'Hianime',
  'AnimeSama',
];

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
  const safeKey = availableProviders.find(key =>
    typeof ANIME[key] === 'function' &&
    !key.toLowerCase().includes('pahe') &&
    !key.toLowerCase().includes('hianime')
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

