// utils/redirectSafeHttp.js — HTTP client with SSRF-safe redirect following.
//
// Axios follows redirects automatically (maxRedirects) but only validates the
// ORIGINAL target. A hostile/sampled redirect can therefore point a fetch at an
// internal address. This helper disables auto-redirects and follows each hop
// manually, validating EVERY redirect destination with utils/ssrfGuard before
// re-issuing the request. Redirects to loopback/private/link-local/metadata
// targets are blocked.
'use strict';

const { assertSafeTargetHost } = require('./ssrfGuard');

const MAX_REDIRECTS = 5;

/**
 * Follow redirects with per-hop SSRF validation.
 *
 * @param {object} client - axios-like instance exposing `request(config)`
 *   (plain axios, or the streamingHttp instance).
 * @param {object} requestConfig - axios request config.
 * @returns {Promise<object>} the final (non-redirect) response.
 */
async function followWithGuard(client, requestConfig) {
  // Disable automatic redirects and treat 3xx as a normal (non-error) response
  // so we can inspect the Location and validate it. 4xx/5xx still reject.
  const guarded = {
    ...requestConfig,
    maxRedirects: 0,
    validateStatus: (status) => status < 400,
  };

  let url = requestConfig.url;
  let redirects = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await client.request({ ...guarded, url });

    if (response.status >= 300 && response.status < 400 && response.headers && response.headers.location) {
      if (redirects >= MAX_REDIRECTS) {
        const err = new Error('Too many redirects.');
        err.code = 'TOO_MANY_REDIRECTS';
        throw err;
      }
      let nextUrl;
      try {
        nextUrl = new URL(String(response.headers.location), url).toString();
      } catch (e) {
        const err = new Error('Invalid redirect location.');
        err.code = 'INVALID_REDIRECT';
        throw err;
      }
      const ssrfError = await assertSafeTargetHost(nextUrl);
      if (ssrfError) {
        const err = new Error(`Redirect target blocked (SSRF): ${ssrfError}`);
        err.code = 'SSRF_REDIRECT_BLOCKED';
        throw err;
      }
      url = nextUrl;
      redirects += 1;
      continue;
    }

    return response;
  }
}

module.exports = { followWithGuard, MAX_REDIRECTS };
