// =============================================================
//  utils/streamingHttp.js — Dedicated Axios Client for STREAMING
//
//  PURPOSE:
//    A single, shared axios instance used ONLY by the streaming
//    provider pipeline. This client exists so streaming timeouts
//    are NEVER configured globally (no axios.defaults.timeout),
//    which would otherwise leak onto authentication, payments,
//    AniList, admin APIs, uploads, and image downloads.
//
//  BEHAVIOUR:
//    • timeout: 10s  (within the required 8–10s window)
//    • retry:   disabled — NO automatic retries on this client
//    • logging: descriptive request/response logging via utils/logger
//    • errors:  timeout errors (ECONNABORTED / 'timeout') handled
//               explicitly and separated from HTTP/network failures
//
//  IMPORTANT:
//    This client never touches axios.defaults and never mutates the
//    global axios module. Provider-specific concerns (proxy rotation,
//    403-retry via proxy switch, adapter routing, health tracking)
//    are layered on top by the streaming modules that consume this
//    client, OR handled by the shared providerHttp infrastructure.
// =============================================================

const axios = require('axios');
const logger = require('./logger');

// Streaming provider timeout — the required 8–10s window, upper bound.
const STREAMING_TIMEOUT = 10000;

// Browser-like User-Agent so provider CDNs accept streaming requests.
const STREAMING_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Create a dedicated streaming axios instance.
 *
 * Provider-specific modules may call this factory to get an instance with
 * the same 10s timeout / no-retry / logging behaviour, then attach their
 * own interceptors on top (e.g. proxy rotation, 403-retry via proxy switch).
 *
 * @param {object}  [options={}]          — Axios/create options overrides
 * @param {number}  [options.timeout]     — Override timeout (default 10s)
 * @param {object}  [options.headers]     — Extra request headers (merged)
 * @param {string}  [options.tag]         — Logging tag (default 'streamingHttp')
 * @returns {object} Configured axios instance
 */
function createStreamingInstance(options = {}) {
  const tag = options.tag || 'streamingHttp';
  const timeout = options.timeout || STREAMING_TIMEOUT;

  const instance = axios.create({
    timeout,
    // Explicit marker: automatic retries are DISABLED for streaming.
    // (Axios performs no automatic retries without axios-retry; this keeps
    //  the intent documented and guards against accidental retry plugins.)
    retry: 0,
    ...options,
    headers: {
      'User-Agent': STREAMING_USER_AGENT,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(options.headers || {}),
    },
  });

  // ── Request interceptor: descriptive logging ─────────────
  instance.interceptors.request.use(
    (config) => {
      config._streamStartTime = Date.now();
      logger.info(`[${tag}] → ${(config.method || 'get').toUpperCase()} ${String(config.url).substring(0, 160)}`);
      return config;
    },
    (error) => {
      logger.error(`[${tag}] request setup failed`, { error: error.message });
      return Promise.reject(error);
    }
  );

  // ── Response interceptor: success logging + timeout handling ──
  instance.interceptors.response.use(
    (response) => {
      const duration = Date.now() - (response.config?._streamStartTime || Date.now());
      logger.info(`[${tag}] ← ${response.status} ${String(response.config?.url || '').substring(0, 160)} (${duration}ms)`);
      return response;
    },
    (error) => {
      const url = String(error.config?.url || '').substring(0, 160);
      const method = (error.config?.method || 'GET').toUpperCase();
      const effectiveTimeout = error.config?.timeout || timeout;

      // Timeout-specific error handling.
      if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
        logger.error(`[${tag}] TIMEOUT after ${effectiveTimeout}ms → ${method} ${url}`, {
          code: error.code,
          timeout: effectiveTimeout,
          method,
          url: error.config?.url,
        });
      } else if (error.response) {
        logger.error(`[${tag}] HTTP ${error.response.status} → ${method} ${url}`, {
          status: error.response.status,
          method,
          url: error.config?.url,
        });
      } else {
        logger.error(`[${tag}] NETWORK error → ${method} ${url}`, {
          code: error.code || null,
          message: error.message,
        });
      }

      return Promise.reject(error);
    }
  );

  return instance;
}

// Shared default streaming client — the entire streaming stack reuses this
// instance unless a provider needs different interceptors (those wrap this one).
const streamingHttp = createStreamingInstance();

module.exports = {
  streamingHttp,
  createStreamingInstance,
  STREAMING_TIMEOUT,
};

