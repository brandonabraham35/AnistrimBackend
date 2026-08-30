// test/streamObservation.test.js — Tests for URL fingerprinting and observation
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { fingerprint, compareUrls, parseStreamUrl } = require('../utils/urlFingerprint');

const URL_A = 'https://co.animeheaven.me/video.mp4?d4dfb40b72870f4f7377c89479af784b&0c91e69bf67ceac46c469d7b9fed7230';
const URL_B = 'https://cz.animeheaven.me/video.mp4?d4dfb40b72870f4f7377c89479af784b&0c91e69bf67ceac46c469d7b9fed7230';
const URL_C = 'https://co.animeheaven.me/video.mp4?d4dfb40b72870f4f7377c89479af784b&85b0a226f1ecfb2265aaf12e6ba5976f';
const URL_D = 'https://co.animeheaven.me/video.mp4?a47bda87647a93b2dc71db281e1b5a2d&0c91e69bf67ceac46c469d7b9fed7230';
const URL_E = 'https://ck.animeheaven.me/video.mp4?d4dfb40b72870f4f7377c89479af784b&5b1ebe26bbf017c46cf2ba1540d49a7f&error2';

test('parseStreamUrl extracts host, contentHash, cdnToken', () => {
  const r = parseStreamUrl(URL_A);
  assert.ok(r);
  assert.strictEqual(r.hostname, 'co.animeheaven.me');
  assert.strictEqual(r.path, '/video.mp4');
  assert.strictEqual(r.contentHash, 'd4dfb40b72870f4f7377c89479af784b');
  assert.strictEqual(r.cdnToken, '0c91e69bf67ceac46c469d7b9fed7230');
  assert.strictEqual(r.params.length, 2);
  assert.ok(r.fullHash.length >= 12);
});

test('parseStreamUrl returns null for invalid URL', () => {
  assert.strictEqual(parseStreamUrl(null), null);
  assert.strictEqual(parseStreamUrl(''), null);
  assert.strictEqual(parseStreamUrl('not-a-url'), null);
});

test('fingerprint returns safe fields', () => {
  const fp = fingerprint(URL_A);
  assert.ok(fp);
  assert.strictEqual(fp.host, 'co.animeheaven.me');
  assert.strictEqual(fp.path, '/video.mp4');
  assert.strictEqual(fp.hash.length, 12);
  assert.ok(fp.hash.includes('b0d'), 'Should be deterministic');
});
test('compareUrls same URL returns sameUrl=true', () => {
  const r = compareUrls(URL_A, URL_A);
  assert.ok(r.bothPresent);
  assert.ok(r.sameUrl);
  assert.strictEqual(r.hostChanged, false);
  assert.strictEqual(r.contentHashChanged, false);
  assert.strictEqual(r.tokenChanged, false);
});

test('compareUrls different host', () => {
  const r = compareUrls(URL_A, URL_B);
  assert.ok(r.bothPresent);
  assert.strictEqual(r.sameUrl, false);
  assert.strictEqual(r.hostChanged, true);
  assert.strictEqual(r.contentHashChanged, false);
  assert.strictEqual(r.tokenChanged, false);
});

test('compareUrls different token', () => {
  const r = compareUrls(URL_A, URL_C);
  assert.ok(r.bothPresent);
  assert.strictEqual(r.hostChanged, false);
  assert.strictEqual(r.contentHashChanged, false);
  assert.strictEqual(r.tokenChanged, true);
});

test('compareUrls different content hash', () => {
  const r = compareUrls(URL_A, URL_D);
  assert.ok(r.bothPresent);
  assert.strictEqual(r.hostChanged, false);
  assert.strictEqual(r.contentHashChanged, true);
  assert.strictEqual(r.tokenChanged, false);
});

test('compareUrls null handling', () => {
  const r = compareUrls(null, URL_A);
  assert.strictEqual(r.bothPresent, false);
  const r2 = compareUrls(URL_A, null);
  assert.strictEqual(r2.bothPresent, false);
});

// ── Classification Tests ──────────────────────────────────

test('classifyUrl UNKNOWN for null', () => {
  const obs = require('../services/streamObservationService');
  const r = obs.classifyUrl(null);
  assert.strictEqual(r.classification, 'UNKNOWN');
});

test('classifyUrl DEAD for 3+ failures', () => {
  const obs = require('../services/streamObservationService');
  const r = obs.classifyUrl({
    url_failure_count: 3,
    url_last_failure_at: new Date().toISOString(),
    observed_last_success_at: new Date(Date.now() - 86400000).toISOString(),
  });
  assert.strictEqual(r.classification, 'DEAD');
});

test('classifyUrl LONG_LIVED for long lifetime', () => {
  const obs = require('../services/streamObservationService');
  const r = obs.classifyUrl({
    url_observed_lifetime_seconds: 7 * 3600,
    probe_playback_match_count: 10,
  });
  assert.strictEqual(r.classification, 'LONG_LIVED');
});

test('classifyUrl ROTATING for 2+ rotations', () => {
  const obs = require('../services/streamObservationService');
  const r = obs.classifyUrl({ rotation_count: 3 });
  assert.strictEqual(r.classification, 'ROTATING');
});

test('classifyUrl TEMPORARY for worked then stopped', () => {
  const obs = require('../services/streamObservationService');
  const r = obs.classifyUrl({
    observed_first_success_at: new Date(Date.now() - 86400000).toISOString(),
    url_first_failure_at: new Date().toISOString(),
  });
  assert.strictEqual(r.classification, 'TEMPORARY');
});

// ── Failure Classification ─────────────────────────────────

test('classifyFailureStatus', () => {
  const obs = require('../services/streamObservationService');
  assert.strictEqual(obs.classifyFailureStatus(403, {}), 'CDN_403');
  assert.strictEqual(obs.classifyFailureStatus(404, {}), 'CDN_404');
  assert.strictEqual(obs.classifyFailureStatus(502, {}), 'PROXY_502');
  assert.strictEqual(obs.classifyFailureStatus(500, {}), 'CDN_5XX');
  assert.strictEqual(obs.classifyFailureStatus(0, { code: 'ECONNABORTED' }), 'NETWORK_TIMEOUT');
  assert.strictEqual(obs.classifyFailureStatus(0, { code: 'EPROTO' }), 'TLS_ERROR');
  assert.strictEqual(obs.classifyFailureStatus(0, {}), 'UNKNOWN_FAILURE');
});

// ── Extract functions ──────────────────────────────────────

test('extractContentHash', () => {
  const obs = require('../services/streamObservationService');
  assert.strictEqual(obs.extractContentHash(URL_A), 'd4dfb40b72870f4f7377c89479af784b');
  assert.strictEqual(obs.extractContentHash(null), null);
});

test('extractCdnToken', () => {
  const obs = require('../services/streamObservationService');
  assert.strictEqual(obs.extractCdnToken(URL_A), '0c91e69bf67ceac46c469d7b9fed7230');
  assert.strictEqual(obs.extractCdnToken('https://x.com/v.mp4?h'), null);
});