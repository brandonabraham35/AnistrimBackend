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
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('./logger');
const { getReferer } = require('../services/providerRegistry');
const { streamingHttp, STREAMING_TIMEOUT } = require('./streamingHttp');

// Streaming requests default to the dedicated 10-second streaming client
// timeout. Non-streaming requests keep the historical 15s default. This is
// how the streaming pipeline is capped at 8–10s WITHOUT ever touching
// axios.defaults (no global mutation that could affect auth/payments/AniList/
// admin/uploads/image-downloads).

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
    logger.warn('Failed to create proxy agent', { proxy: proxyUrl ? '[REDACTED]' : null, error: err.message });
    return null;
  }
}

/**
 * Creates an HTTPS agent with relaxed TLS verification for EPROTO workarounds.
 * This disables strict certificate validation to work around servers that send
 * malformed TLS records (e.g., animeheaven.me on Render/Node.js).
 *
 * WARNING: This makes the connection vulnerable to MITM attacks — use only
 * as a fallback for scraping providers when strict TLS fails.
 *
 * @param {string|null} proxyUrl - Optional proxy URL
 * @returns {HttpsProxyAgent|https.Agent} Configured agent
 */
function createRelaxedTlsAgent(proxyUrl) {
  const agentOptions = {
    rejectUnauthorized: false, // Relaxes TLS verification for EPROTO workarounds
  };

  if (proxyUrl) {
    try {
      return new HttpsProxyAgent(proxyUrl, agentOptions);
    } catch (err) {
      logger.warn('Failed to create relaxed TLS proxy agent', { proxy: '[REDACTED]', error: err.message });
    }
  }

  return new https.Agent(agentOptions);
}

// ───────────────────────────────────────────────────────────────
//  PROVIDER HEALTH TRACKING
// ───────────────────────────────────────────────────────────────

const healthStore = new Map(); // providerName -> { successCount, failureCount, timeoutCount, consecutiveFailures, responseTimes, lastSuccessAt, lastFailureAt, firstSeenAt, degradedUntil }

const HEALTH_CONFIG = {
  CONSECUTIVE_FAILURE_LIMIT: 3,   // Mark degraded after N consecutive failures
  DEGRADE_COOLDOWN_MS: 60_000,    // Retry degraded provider after 60s
  SAMPLE_SIZE: 20,                 // Rolling window for avg response time
};

/**
 * Ensure a provider record exists in the store, initialising all counters
 * and timestamps. All health-mutation helpers call this first so the record
 * shape is always consistent.
 *
 * @private
 * @param {string} providerName - Canonical provider name / health key
 * @returns {object} The mutable in-memory record
 */
function ensureProviderRecord(providerName) {
  if (!healthStore.has(providerName)) {
    const now = Date.now();
    healthStore.set(providerName, {
      successCount: 0,
      failureCount: 0,
      timeoutCount: 0,
      consecutiveFailures: 0,
      responseTimes: [],
      lastSuccessAt: null,
      lastFailureAt: null,
      firstSeenAt: now,
      degradedUntil: 0,
    });
  }
  return healthStore.get(providerName);
}

/**
 * Determine whether an error is a genuine TIMEOUT.
 *
 * Only ECONNABORTED / ETIMEDOUT codes, axios timeout errors, and messages
 * containing "timeout" are classified as timeouts. Everything else (403, 404,
 * 429, 5xx, Cloudflare pages, DNS failures, connection resets, etc.) is NOT a
 * timeout and must go through the normal failure path.
 *
 * @param {Error} err - The error to inspect
 * @returns {boolean} True if the error is genuinely a timeout
 */
function isTimeoutError(err) {
  if (!err) return false;
  const code = err.code || '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
  return /timeout/i.test(err.message || '');
}

/**
 * Record a successful response for a provider.
 *
 * @param {string} providerName - Canonical provider name / health key
 * @param {number} responseTimeMs - Response time in milliseconds
 */
function markSuccess(providerName, responseTimeMs) {
  if (!providerName) return;
  const h = ensureProviderRecord(providerName);
  h.successCount++;
  h.consecutiveFailures = 0;
  h.responseTimes.push(responseTimeMs);
  if (h.responseTimes.length > HEALTH_CONFIG.SAMPLE_SIZE) h.responseTimes.shift();
  h.lastSuccessAt = Date.now();
  // Clear degraded status on success
  h.degradedUntil = 0;
}

/**
 * Record a failure for a provider (non-timeout).
 *
 * @param {string} providerName - Canonical provider name / health key
 * @param {number} responseTimeMs - Response time in milliseconds
 */
function markFailure(providerName, responseTimeMs) {
  if (!providerName) return;
  const h = ensureProviderRecord(providerName);
  h.failureCount++;
  h.consecutiveFailures++;
  h.responseTimes.push(responseTimeMs);
  if (h.responseTimes.length > HEALTH_CONFIG.SAMPLE_SIZE) h.responseTimes.shift();
  h.lastFailureAt = Date.now();

  // Mark degraded if consecutive failures exceed limit
  if (h.consecutiveFailures >= HEALTH_CONFIG.CONSECUTIVE_FAILURE_LIMIT) {
    h.degradedUntil = Date.now() + HEALTH_CONFIG.DEGRADE_COOLDOWN_MS;
    logger.warn(`Provider marked degraded`, {
      provider: providerName,
      consecutiveFailures: h.consecutiveFailures,
      cooldownSec: HEALTH_CONFIG.DEGRADE_COOLDOWN_MS / 1000,
    });
  }
}

/**
 * Record a timeout for a provider. A timeout is ALSO a failure (it increments
 * failureCount and consecutiveFailures) so that repeated timeouts degrade the
 * provider, but it is additionally tracked separately in timeoutCount.
 *
 * @param {string} providerName - Canonical provider name / health key
 * @param {number} responseTimeMs - Response time in milliseconds
 */
function markTimeout(providerName, responseTimeMs) {
  if (!providerName) return;
  const h = ensureProviderRecord(providerName);
  h.timeoutCount++;
  h.failureCount++;
  h.consecutiveFailures++;
  h.responseTimes.push(responseTimeMs);
  if (h.responseTimes.length > HEALTH_CONFIG.SAMPLE_SIZE) h.responseTimes.shift();
  h.lastFailureAt = Date.now();

  // Mark degraded if consecutive failures exceed limit
  if (h.consecutiveFailures >= HEALTH_CONFIG.CONSECUTIVE_FAILURE_LIMIT) {
    h.degradedUntil = Date.now() + HEALTH_CONFIG.DEGRADE_COOLDOWN_MS;
    logger.warn(`Provider marked degraded (timeout)`, {
      provider: providerName,
      consecutiveFailures: h.consecutiveFailures,
      cooldownSec: HEALTH_CONFIG.DEGRADE_COOLDOWN_MS / 1000,
    });
  }
}

/**
 * Check if a provider is healthy enough to use.
 * Returns true if provider is not degraded or if cooldown has expired.
 *
 * @param {string} providerName - Canonical provider name / health key
 * @returns {boolean} True if the provider may be used
 */
function isHealthy(providerName) {
  if (!providerName || !healthStore.has(providerName)) return true;
  const h = healthStore.get(providerName);
  if (h.degradedUntil > Date.now()) {
    const remaining = Math.ceil((h.degradedUntil - Date.now()) / 1000);
    logger.debug(`Provider still degraded`, { provider: providerName, degradedRemainingSec: remaining });
    return false;
  }
  return true;
}

/**
 * Compute the uptime percentage for a provider record.
 *   uptimePercentage = successCount / (successCount + failureCount)
 * Returns 100% when there have been zero requests.
 *
 * @private
 * @param {object} h - Provider health record
 * @returns {number} Uptime percentage (0–100), or 100 when no requests
 */
function computeUptimePercentage(h) {
  const total = h.successCount + h.failureCount;
  if (total === 0) return 100;
  return Math.round((h.successCount / total) * 1000) / 10;
}

/**
 * Get the full health statistics for a single provider.
 * Returns null if the provider has never been tracked.
 *
 * @param {string} providerName - Canonical provider name / health key
 * @returns {object|null} Full health stats, or null if untracked
 */
function getHealthStats(providerName) {
  if (!providerName || !healthStore.has(providerName)) return null;
  const h = healthStore.get(providerName);
  const total = h.successCount + h.failureCount;
  return {
    successCount: h.successCount,
    failureCount: h.failureCount,
    timeoutCount: h.timeoutCount,
    totalRequests: total,
    consecutiveFailures: h.consecutiveFailures,
    successRate: total > 0 ? ((h.successCount / total) * 100).toFixed(1) + '%' : 'N/A',
    uptimePercentage: computeUptimePercentage(h),
    avgResponseTime: h.responseTimes.length > 0
      ? (h.responseTimes.reduce((a, b) => a + b, 0) / h.responseTimes.length).toFixed(0) + 'ms'
      : 'N/A',
    lastSuccessfulRequest: h.lastSuccessAt ? new Date(h.lastSuccessAt).toISOString() : null,
    lastFailure: h.lastFailureAt ? new Date(h.lastFailureAt).toISOString() : null,
    firstSeenAt: h.firstSeenAt ? new Date(h.firstSeenAt).toISOString() : null,
    degraded: h.degradedUntil > Date.now(),
    degradedRemainingSec: h.degradedUntil > Date.now()
      ? Math.ceil((h.degradedUntil - Date.now()) / 1000)
      : 0,
  };
}

/**
 * Get health status for all tracked providers.
 */
function getProviderHealth() {
  const result = {};
  for (const [name, h] of healthStore) {
    const total = h.successCount + h.failureCount;
    result[name] = {
      successRate: total > 0 ? ((h.successCount / total) * 100).toFixed(1) + '%' : 'N/A',
      totalRequests: total,
      consecutiveFailures: h.consecutiveFailures,
      avgResponseTime: h.responseTimes.length > 0
        ? (h.responseTimes.reduce((a, b) => a + b, 0) / h.responseTimes.length).toFixed(0) + 'ms'
        : 'N/A',
      degraded: h.degradedUntil > Date.now(),
      degradedRemainingSec: h.degradedUntil > Date.now()
        ? Math.ceil((h.degradedUntil - Date.now()) / 1000)
        : 0,
      // Enriched runtime stats (observability only)
      successCount: h.successCount,
      failureCount: h.failureCount,
      timeoutCount: h.timeoutCount,
      uptimePercentage: computeUptimePercentage(h),
      lastSuccessfulRequest: h.lastSuccessAt ? new Date(h.lastSuccessAt).toISOString() : null,
      lastFailure: h.lastFailureAt ? new Date(h.lastFailureAt).toISOString() : null,
      firstSeenAt: h.firstSeenAt ? new Date(h.firstSeenAt).toISOString() : null,
    };
  }
  return result;
}

// ── Backward-compatible wrappers (delegate to the canonical API) ──
// The old API is preserved intact so existing modules keep working.
// New callers should prefer markSuccess / markFailure / markTimeout /
// isHealthy / getHealthStats.

/**
 * Record a successful response for a provider (legacy alias of markSuccess).
 */
function recordSuccess(providerName, responseTimeMs) {
  markSuccess(providerName, responseTimeMs);
}

/**
 * Record a failure for a provider (legacy alias of markFailure).
 */
function recordFailure(providerName, responseTimeMs) {
  markFailure(providerName, responseTimeMs);
}

/**
 * Check if a provider is healthy enough to use (legacy alias of isHealthy).
 */
function isProviderHealthy(providerName) {
  return isHealthy(providerName);
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

  // Add provider-specific Referer/Origin from the centralized registry.
  // Provider referer metadata lives ONLY in services/providerRegistry.js.
  if (providerName) {
    const ref = getReferer(providerName);
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
  TLS_ERROR: 'TLS_ERROR',       // EPROTO/SSL handshake failures
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
  // TLS/SSL handshake failures — EPROTO, SSL routines errors, packet length issues
  if (code === 'EPROTO' || /ssl routines|tls_get_more_records|packet length|ssl_error/i.test(err.message || '')) {
    return { category: ERROR_CATEGORIES.TLS_ERROR, status: 0, retryable: true, description: 'TLS/SSL handshake failure — server certificate or protocol issue' };
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
 * @param {object}  options.params — URL query params to merge into config (for get/post convenience functions)
 * @param {boolean} options.streaming — Use the dedicated 10s streaming client (retry disabled).
 * @returns {Promise<object>} Axios response object
 */
async function request(config, options = {}) {
  const {
    providerName = 'unknown',
    maxRetries = MAX_RETRIES,
    skipProxy = false,
    extraHeaders = {},
    dontTrackHealth = false,
    params = null,
    // `streaming: true` marks this as a streaming-provider request. These are
    // capped at the dedicated 10-second streaming timeout (STREAMING_TIMEOUT).
    // Non-streaming requests keep the historical 15s default. Explicit
    // `options.timeout` still overrides either default per request.
    streaming = false,
  } = options;

  // Resolve effective timeout: explicit option wins, then streaming vs default.
  const timeout = options.timeout ?? (streaming ? STREAMING_TIMEOUT : 15000);

  // Build merged headers
  const mergedHeaders = buildHeaders(providerName, extraHeaders);

  // Add cache-busting for GET requests to avoid stale responses
  if (config.method === undefined || config.method === 'get') {
    mergedHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    mergedHeaders['Pragma'] = 'no-cache';
  }

  // Start with the configured timeout
  const effectiveTimeout = config.timeout || timeout;
  // Streaming retries are DISABLED at the HTTP layer; the streaming pipeline
  // (streamingService.executeWithRetry) already coordinates per-provider retries.
  // EXCEPTION: TLS errors get one retry with relaxed verification even in streaming mode.
  let effectiveMaxRetries = streaming ? 0 : maxRetries;
  const startTime = Date.now();

  let lastError;
  let proxiedUrl = null;
  let tlsRelaxed = false; // Track if we've tried with relaxed TLS
  let relaxedHttpsAgent = null; // Cached relaxed TLS agent for retries

  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    // Check provider health before attempting
    if (attempt === 0 && !isProviderHealthy(providerName)) {
      logger.debug('Skipping unhealthy provider', { provider: providerName });
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

    // Merge params from options into config (params may be passed via convenience get/post functions)
    const mergedParams = { ...(config.params || {}), ...(params || {}) };

    const requestConfig = {
      ...config,
      timeout: effectiveTimeout,
      headers: {
        ...mergedHeaders,
        ...config.headers,
      },
      httpsAgent: relaxedHttpsAgent || proxyAgent || config.httpsAgent || undefined,
      ...(Object.keys(mergedParams).length > 0 ? { params: mergedParams } : {}),
    };

// Log the attempt
    const attemptLabel = effectiveMaxRetries > 0 ? `attempt ${attempt + 1}/${effectiveMaxRetries + 1}` : 'attempt 1/1';
    logger.stream({
      provider: providerName,
      attempt: attempt + 1,
      status: 'pending',
      message: `${config.method || 'GET'} ${config.url?.substring(0, 120)}`,
      proxy: proxyAgent ? true : false,
    });

    const attemptStart = Date.now();

    try {
      // Streaming-provider requests route through the DEDICATED streaming axios
      // client (utils/streamingHttp.js) which enforces the 10s timeout,
      // retry-disabled behaviour, and descriptive timeout/error logging.
      const response = streaming
        ? await streamingHttp.request(requestConfig)
        : await axios(requestConfig);
      const responseTime = Date.now() - attemptStart;

      // Track health
      if (!dontTrackHealth) {
        recordSuccess(providerName, responseTime);
      }

      logger.stream({
        provider: providerName,
        attempt: attempt + 1,
        duration: responseTime,
        status: response.status,
        result: 'success',
        timedOut: false,
        cloudflareDetected: response.status === 403,
      });

      return response;
    } catch (err) {
      const responseTime = Date.now() - attemptStart;
      lastError = err;

      const status = err.response?.status;
      const statusText = status ? `HTTP ${status}` : 'NETWORK_ERROR';
      const isTimeout = isTimeoutError(err);
      const cloudflareDetected = status === 403 || /cloudflare/i.test(err.message || '');
      const isTlsError = err.code === 'EPROTO' || /ssl routines|tls_get_more_records|packet length|ssl_error/i.test(err.message || '');

      logger.stream({
        provider: providerName,
        attempt: attempt + 1,
        duration: responseTime,
        status: status || 0,
        error: err.message?.substring(0, 200),
        result: 'failure',
        timedOut: isTimeout,
        cloudflareDetected,
        timeoutStatus: isTimeout,
      });

      // TLS error fallback: retry once with relaxed TLS verification
      // This applies even in streaming mode where normal retries are disabled
      if (isTlsError && !tlsRelaxed) {
        tlsRelaxed = true;
        // Allow one extra attempt for TLS errors (even in streaming mode)
        effectiveMaxRetries = Math.max(effectiveMaxRetries, 1);
        
        logger.warn('[providerHttp] TLS error detected, retrying with relaxed TLS verification', {
          provider: providerName,
          url: config.url?.substring(0, 120),
          error: err.message?.substring(0, 200),
        });

        // Create and cache relaxed TLS agent for subsequent attempts
        relaxedHttpsAgent = createRelaxedTlsAgent(proxiedUrl);

        const delay = BASE_DELAY_MS + Math.random() * 300;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

// Track health on final failure only (to not count retries as separate failures).
      // Genuine timeouts are recorded via markTimeout (a failure + separate timeout
      // counter); everything else uses markFailure. 403/404/429/5xx/DNS/connection
      // resets are NOT timeouts and go through the normal failure path.
      if (attempt === effectiveMaxRetries && !dontTrackHealth) {
        if (isTimeoutError(err)) {
          markTimeout(providerName, responseTime);
        } else {
          markFailure(providerName, responseTime);
        }
      }

      // Determine if we should retry
      const retryable = isRetryableStatus(status) || isRetryableError(err);

      if (!retryable || attempt === effectiveMaxRetries) {
        // Non-retryable or out of attempts
        break;
      }

      // Calculate backoff delay: exponential with jitter
      const delay = Math.min(
        BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500,
        10000 // cap at 10s
      );

      logger.stream({
        provider: providerName,
        attempt: attempt + 1,
        duration: responseTime,
        retryDelay: Math.round(delay),
        retriesLeft: effectiveMaxRetries - attempt,
        result: 'retry',
        status: status || 0,
      });

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
    retries: effectiveMaxRetries,
    timeMs: Date.now() - startTime,
    proxied: !!proxiedUrl,
  };

  logger.error(`Provider failed after ${effectiveMaxRetries + 1} attempts`, {
    provider: providerName,
    status,
    attempts: effectiveMaxRetries + 1,
    duration: Date.now() - startTime,
    error: lastError.message,
    stack: lastError.stack,
    code: lastError.code,
  });

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
  // Canonical API (preferred)
  markSuccess,
  markFailure,
  markTimeout,
  isHealthy,
  getHealthStats,
  isTimeoutError,
  // Legacy API (backward-compatible wrappers)
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

