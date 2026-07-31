// =============================================================
//  utils/providerHttp.js — Central HTTP Client for All Providers
//
//  Single networking layer with:
//    • Unified proxy configuration (shared across all providers)
//    • Exponential backoff retry
//    • Provider health tracking (response time, success/failure)
//    • Structured logging
//    • Unified headers (User-Agent, Referer, Origin, Accept-Language)
//    • Proxy rotation on 403/blocked responses
//    • Request timeout management
// =============================================================

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ───────────────────────────────────────────────────────────────
//  SHARED PROXY MANAGER
// ───────────────────────────────────────────────────────────────

/**
 * Build proxy URL from environment variables.
 * Supports two formats:
 *   1. PROXY_LIST — comma-separated list of fully qualified proxy URLs
 *      e.g. http://user:pass@host:port,http://user2:pass2@host2:port2
 *   2. PROXY_HOST/PORT/USER/PASS — single proxy (legacy)
 *
 * If PROXY_LIST is empty, falls back to legacy PROXY_HOST/PORT/USER/PASS.
 */
function buildProxyUrl(host, port, user, pass) {
  if (!host || !port) return null;
  const auth = user && pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  return `http://${auth}${host}:${port}`;
}

function buildProxyList() {
  // 1. Check PROXY_LIST first
  const list = (process.env.PROXY_LIST || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  if (list.length > 0) return list;

  // 2. Fallback to legacy single proxy
  const single = buildProxyUrl(
    process.env.PROXY_HOST,
    process.env.PROXY_PORT,
    process.env.PROXY_USER,
    process.env.PROXY_PASS
  );
  return single ? [single] : [];
}

const PROXY_LIST = buildProxyList();
let proxyIndex = 0;

function getNextProxyUrl() {
  if (PROXY_LIST.length === 0) return null;
  const url = PROXY_LIST[proxyIndex];
  proxyIndex = (proxyIndex + 1) % PROXY_LIST.length;
  return url;
}

/**
 * Creates an HTTPS proxy agent from a proxy URL string.
 */
function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    return new HttpsProxyAgent(proxyUrl);
  } catch (err) {
    console.warn(`[ProviderHttp] Failed to create proxy agent for ${proxyUrl}: ${err.message}`);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────
//  PROVIDER HEALTH TRACKING
// ───────────────────────────────────────────────────────────────

const healthStore = new Map(); // providerName -> { successes, failures, consecutiveFailures, avgResponseTime, lastChecked, degradedUntil }

const HEALTH_CONFIG = {
  CONSECUTIVE_FAILURE_LIMIT: 3,   // Mark degraded after N consecutive failures
  DEGRADE_COOLDOWN_MS: 60_000,    // Retry degraded provider after 60s
  SAMPLE_SIZE: 20,                 // Rolling window for avg response time
};

/**
 * Record a successful response for a provider.
 */
function recordSuccess(providerName, responseTimeMs) {
  if (!providerName) return;
  if (!healthStore.has(providerName)) {
    healthStore.set(providerName, { successes: 0, failures: 0, consecutiveFailures: 0, responseTimes: [], degradedUntil: 0 });
  }
  const h = healthStore.get(providerName);
  h.successes++;
  h.consecutiveFailures = 0;
  h.responseTimes.push(responseTimeMs);
  if (h.responseTimes.length > HEALTH_CONFIG.SAMPLE_SIZE) h.responseTimes.shift();
  h.lastChecked = Date.now();
  // Clear degraded status on success
  h.degradedUntil = 0;
}

/**
 * Record a failure for a provider.
 */
function recordFailure(providerName, responseTimeMs) {
  if (!providerName) return;
  if (!healthStore.has(providerName)) {
    healthStore.set(providerName, { successes: 0, failures: 0, consecutiveFailures: 0, responseTimes: [], degradedUntil: 0 });
  }
  const h = healthStore.get(providerName);
  h.failures++;
  h.consecutiveFailures++;
  h.responseTimes.push(responseTimeMs);
  if (h.responseTimes.length > HEALTH_CONFIG.SAMPLE_SIZE) h.responseTimes.shift();
  h.lastChecked = Date.now();

  // Mark degraded if consecutive failures exceed limit
  if (h.consecutiveFailures >= HEALTH_CONFIG.CONSECUTIVE_FAILURE_LIMIT) {
    h.degradedUntil = Date.now() + HEALTH_CONFIG.DEGRADE_COOLDOWN_MS;
    console.warn(`[ProviderHttp] ⚠️  ${providerName} marked DEGRADED for ${HEALTH_CONFIG.DEGRADE_COOLDOWN_MS / 1000}s (${h.consecutiveFailures} consecutive failures)`);
  }
}

/**
 * Check if a provider is healthy enough to use.
 * Returns true if provider is not degraded or if cooldown has expired.
 */
function isProviderHealthy(providerName) {
  if (!providerName || !healthStore.has(providerName)) return true;
  const h = healthStore.get(providerName);
  if (h.degradedUntil > Date.now()) {
    const remaining = Math.ceil((h.degradedUntil - Date.now()) / 1000);
    console.log(`[ProviderHttp] ⏳ ${providerName} still degraded (${remaining}s remaining)`);
    return false;
  }
  return true;
}

/**
 * Get health status for all tracked providers.
 */
function getProviderHealth() {
  const result = {};
  for (const [name, h] of healthStore) {
    const total = h.successes + h.failures;
    result[name] = {
      successRate: total > 0 ? ((h.successes / total) * 100).toFixed(1) + '%' : 'N/A',
      totalRequests: total,
      consecutiveFailures: h.consecutiveFailures,
      avgResponseTime: h.responseTimes.length > 0
        ? (h.responseTimes.reduce((a, b) => a + b, 0) / h.responseTimes.length).toFixed(0) + 'ms'
        : 'N/A',
      degraded: h.degradedUntil > Date.now(),
      degradedRemainingSec: h.degradedUntil > Date.now()
        ? Math.ceil((h.degradedUntil - Date.now()) / 1000)
        : 0,
    };
  }
  return result;
}

// ───────────────────────────────────────────────────────────────
//  UNIFIED HEADERS
// ───────────────────────────────────────────────────────────────

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Connection': 'keep-alive',
  'Cache-Control': 'max-age=0',
};

/**
 * Build request headers with optional overrides.
 * Adds Referer and Origin if provider name is known.
 */
function buildHeaders(providerName, extraHeaders = {}) {
  const headers = { ...DEFAULT_HEADERS };

  // Add provider-specific Referer/Origin
  if (providerName) {
    const referers = {
      consumet: 'https://consumet.org/',
      'consumet-http': process.env.CONSUMET_API_URL || 'https://api.consumet.org/',
      kickassanime: 'https://kickassanime.am/',
      animepahe: 'https://animepahe.ru/',
      animekai: 'https://animekai.to/',
      hianime: 'https://hianime.to/',
      animesaturn: 'https://animesaturn.mx/',
      zoro: 'https://aniwatch.to/',
      miruro: 'https://www.miruro.tv/',
    };

    const ref = referers[providerName.toLowerCase()];
    if (ref) {
      headers['Referer'] = ref;
      headers['Origin'] = new URL(ref).origin;
    }
  }

  // Merge extra headers (allow override)
  Object.assign(headers, extraHeaders);
  return headers;
}

// ───────────────────────────────────────────────────────────────
//  CENTRAL REQUEST FUNCTION
// ───────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ───────────────────────────────────────────────────────────────
//  ERROR CLASSIFICATION
// ───────────────────────────────────────────────────────────────

const ERROR_CATEGORIES = {
  FORBIDDEN: 'FORBIDDEN',       // 403 — Cloudflare / access denied
  NOT_FOUND: 'NOT_FOUND',       // 404 — resource not found
  RATE_LIMITED: 'RATE_LIMITED', // 429 — too many requests
  SERVER_ERROR: 'SERVER_ERROR', // 500+ — server-side failure
  TIMEOUT: 'TIMEOUT',           // network timeout
  DNS_FAILURE: 'DNS_FAILURE',   // DNS resolution failed
  CONNECTION_REFUSED: 'CONNECTION_REFUSED',
  CONNECTION_RESET: 'CONNECTION_RESET',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PROVIDER_DEGRADED: 'PROVIDER_DEGRADED',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Classify an error into a category for better logging and decision-making.
 * @param {Error} err — The error object from axios
 * @returns {{ category: string, status: number, retryable: boolean, description: string }}
 */
function classifyError(err) {
  if (!err) return { category: ERROR_CATEGORIES.UNKNOWN, status: 0, retryable: false, description: 'No error object' };

  const status = err.response?.status || 0;
  const code = err.code || '';
  const message = (err.message || '').toLowerCase();

  // Provider was health-skipped
  if (err.code === 'PROVIDER_DEGRADED') {
    return { category: ERROR_CATEGORIES.PROVIDER_DEGRADED, status: 0, retryable: false, description: 'Provider marked degraded — skipped' };
  }

  // HTTP status-based classification
  if (status === 403) {
    return { category: ERROR_CATEGORIES.FORBIDDEN, status: 403, retryable: true, description: '403 Forbidden — likely Cloudflare/anti-bot block' };
  }
  if (status === 404) {
    return { category: ERROR_CATEGORIES.NOT_FOUND, status: 404, retryable: false, description: '404 Not Found — resource does not exist' };
  }
  if (status === 429) {
    return { category: ERROR_CATEGORIES.RATE_LIMITED, status: 429, retryable: true, description: '429 Rate Limited — back off and retry' };
  }
  if (status >= 500) {
    return { category: ERROR_CATEGORIES.SERVER_ERROR, status, retryable: true, description: `${status} Server Error — may be transient` };
  }

  // Network-level classification
  if (code === 'ECONNABORTED' || message.includes('timeout')) {
    return { category: ERROR_CATEGORIES.TIMEOUT, status: 0, retryable: true, description: 'Timeout — request took too long' };
  }
  if (code === 'ENOTFOUND' || message.includes('enotfound')) {
    return { category: ERROR_CATEGORIES.DNS_FAILURE, status: 0, retryable: true, description: 'DNS resolution failed' };
  }
  if (code === 'ECONNREFUSED' || message.includes('econnrefused')) {
    return { category: ERROR_CATEGORIES.CONNECTION_REFUSED, status: 0, retryable: true, description: 'Connection refused — server may be down' };
  }
  if (code === 'ECONNRESET' || message.includes('socket hang up') || message.includes('econnreset')) {
    return { category: ERROR_CATEGORIES.CONNECTION_RESET, status: 0, retryable: true, description: 'Connection reset — socket hang up' };
  }
  if (code === 'ERR_NETWORK' || message.includes('network')) {
    return { category: ERROR_CATEGORIES.NETWORK_ERROR, status: 0, retryable: true, description: 'Network error' };
  }

  return { category: ERROR_CATEGORIES.UNKNOWN, status, retryable: false, description: message.substring(0, 120) || 'Unknown error' };
}

/**
 * Determine if an HTTP status code is retryable.
 */
function isRetryableStatus(status) {
  // 403: blocked — retry with different proxy or headers
  // 429: rate-limited — retry with backoff
  // 500+: server error — may be transient
  // 0 / undefined: network error
  return (
    status === 403 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    !status ||
    status >= 500
  );
}

/**
 * Determine if an error is retryable (network-level).
 */
function isRetryableError(err) {
  if (!err) return false;
  const { retryable } = classifyError(err);
  return retryable;
}

/**
 * Central HTTP request function used by all providers.
 *
 * @param {object} config — Axios request config
 * @param {object} options
 * @param {string}  options.providerName — Provider name for health tracking & headers
 * @param {number}  options.maxRetries — Override max retries (default: 3)
 * @param {number}  options.timeout — Request timeout in ms (default: 15000)
 * @param {boolean} options.skipProxy — Skip proxy for this request
 * @param {object}  options.extraHeaders — Additional headers
 * @param {boolean} options.dontTrackHealth — Skip health tracking
 * @returns {Promise<object>} Axios response object
 */
async function request(config, options = {}) {
  const {
    providerName = 'unknown',
    maxRetries = MAX_RETRIES,
    timeout = 15000,
    skipProxy = false,
    extraHeaders = {},
    dontTrackHealth = false,
  } = options;

  // Build merged headers
  const mergedHeaders = buildHeaders(providerName, extraHeaders);

  // Add cache-busting for GET requests to avoid stale responses
  if (config.method === undefined || config.method === 'get') {
    mergedHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    mergedHeaders['Pragma'] = 'no-cache';
  }

  // Start with the configured timeout
  const effectiveTimeout = config.timeout || timeout;
  const startTime = Date.now();

  let lastError;
  let proxiedUrl = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check provider health before attempting
    if (attempt === 0 && !isProviderHealthy(providerName)) {
      console.log(`[ProviderHttp] ⏭ Skipping unhealthy provider: ${providerName}`);
      const err = new Error(`Provider ${providerName} is degraded — skipping`);
      err.code = 'PROVIDER_DEGRADED';
      throw err;
    }

    // Select proxy (round-robin, skip if previous attempt got 403)
    let proxyAgent = null;
    if (!skipProxy && PROXY_LIST.length > 0) {
      // On 403 retry, try a different proxy
      if (attempt > 0 && proxiedUrl) {
        // Move past the failed proxy
        proxyIndex = (proxyIndex + 1) % PROXY_LIST.length;
      }
      proxiedUrl = getNextProxyUrl();
      proxyAgent = createProxyAgent(proxiedUrl);
    }

    const requestConfig = {
      ...config,
      timeout: effectiveTimeout,
      headers: {
        ...mergedHeaders,
        ...config.headers,
      },
      httpsAgent: proxyAgent || config.httpsAgent || undefined,
    };

    // Log the attempt
    const attemptLabel = maxRetries > 0 ? `attempt ${attempt + 1}/${maxRetries + 1}` : 'attempt 1/1';
    console.log(
      `[ProviderHttp] ➡️  ${providerName} | ${attemptLabel} | ${config.method || 'GET'} ${config.url?.substring(0, 120)} | ${proxyAgent ? `proxy: ${proxiedUrl?.substring(0, 40)}...` : 'direct'}`
    );

    const attemptStart = Date.now();

    try {
      const response = await axios(requestConfig);
      const responseTime = Date.now() - attemptStart;

      // Track health
      if (!dontTrackHealth) {
        recordSuccess(providerName, responseTime);
      }

      console.log(
        `[ProviderHttp] ✅ ${providerName} | ${attemptLabel} | ${response.status} | ${responseTime}ms`
      );

      return response;
    } catch (err) {
      const responseTime = Date.now() - attemptStart;
      lastError = err;

      const status = err.response?.status;
      const statusText = status ? `HTTP ${status}` : 'NETWORK_ERROR';

      console.warn(
        `[ProviderHttp] ❌ ${providerName} | ${attemptLabel} | ${statusText} | ${responseTime}ms | ${err.message?.substring(0, 100)}`
      );

      // Track health on final failure only (to not count retries as separate failures)
      if (attempt === maxRetries && !dontTrackHealth) {
        recordFailure(providerName, responseTime);
      }

      // Determine if we should retry
      const retryable = isRetryableStatus(status) || isRetryableError(err);

      if (!retryable || attempt === maxRetries) {
        // Non-retryable or out of attempts
        break;
      }

      // Calculate backoff delay: exponential with jitter
      const delay = Math.min(
        BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500,
        10000 // cap at 10s
      );

      console.log(
        `[ProviderHttp] 🔄 ${providerName} | retrying in ${Math.round(delay)}ms (${maxRetries - attempt} retries left)`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted
  const status = lastError.response?.status || 0;
  const statusText = status ? `HTTP ${status}` : 'NETWORK_ERROR';

  // Augment error with provider context
  lastError.providerContext = {
    provider: providerName,
    url: config.url,
    status,
    retries: maxRetries,
    timeMs: Date.now() - startTime,
    proxied: !!proxiedUrl,
  };

  console.error(
    `[ProviderHttp] 🛑 ${providerName} | FAILED after ${maxRetries + 1} attempts | ${statusText} | ${Date.now() - startTime}ms`
  );

  throw lastError;
}

/**
 * Convenience: GET request with all providerHttp features.
 */
async function get(url, options = {}) {
  return request({ method: 'get', url }, options);
}

/**
 * Convenience: POST request with all providerHttp features.
 */
async function post(url, data = {}, options = {}) {
  return request({ method: 'post', url, data }, options);
}

/**
 * Convenience: GET that returns parsed JSON data directly.
 * Throws if response has no data.
 */
async function getJson(url, options = {}) {
  const response = await request({
    method: 'get',
    url,
    responseType: 'json',
  }, options);
  return response.data;
}

// ───────────────────────────────────────────────────────────────
//  EXPORTS
// ───────────────────────────────────────────────────────────────

module.exports = {
  // Core request function
  request,
  get,
  post,
  getJson,

  // Proxy management
  getProxyList: () => [...PROXY_LIST],
  getProxyIndex: () => proxyIndex,
  resetProxyIndex: () => { proxyIndex = 0; },
  buildProxyUrl,
  createProxyAgent,

  // Health tracking
  recordSuccess,
  recordFailure,
  isProviderHealthy,
  getProviderHealth,

  // Header builder
  buildHeaders,
  DEFAULT_HEADERS,

  // Error classification
  classifyError,
  ERROR_CATEGORIES,
};

