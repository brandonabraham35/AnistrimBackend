// ============================================================
//  test/streamDiagnostics.test.js
//
//  Regression tests for the streamDiagnostics module API.
//  Verifies that all 7 specialized logging methods that the
//  streaming pipeline depends on exist and are callable without
//  throwing. The bug that caused `logFreshResolution is not a
//  function` in production was caused by these methods being
//  absent from the module's exports.
//
//  Run: node --test test/streamDiagnostics.test.js
// ============================================================
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const streamDiag = require('../utils/streamDiagnostics');

const sampleUrl = 'https://rt.animeheaven.me/video.mp4?token=abc123&expires=9999999999';
const sampleCtx = { targetUrl: sampleUrl, referer: 'https://animeheaven.me/', streamId: 'abc12345' };
const sampleResult = {
  provider: 'animeheaven',
  sources: [{ url: 'https://rt.animeheaven.me/video.mp4?token=abc', quality: '720' }],
  bestQuality: '720',
};

describe('streamDiagnostics module exports', () => {
  test('exports DIAG_ENABLED (boolean)', () => {
    assert.strictEqual(typeof streamDiag.DIAG_ENABLED, 'boolean');
  });
  test('exports TAG (string)', () => {
    assert.strictEqual(typeof streamDiag.TAG, 'string');
  });
  test('exports fingerprintUrl (function)', () => {
    assert.strictEqual(typeof streamDiag.fingerprintUrl, 'function');
  });
  test('exports diagLog (function)', () => {
    assert.strictEqual(typeof streamDiag.diagLog, 'function');
  });
});

describe('streamDiagnostics API completeness', () => {
  test('logFreshResolution exists and is a function', () => {
    assert.strictEqual(typeof streamDiag.logFreshResolution, 'function');
  });
  test('logCacheProbe exists and is a function', () => {
    assert.strictEqual(typeof streamDiag.logCacheProbe, 'function');
  });
  test('logCacheHit exists and is a function', () => {
    assert.strictEqual(typeof streamDiag.logCacheHit, 'function');
  });
  test('logCacheCreation exists and is a function', () => {
    assert.strictEqual(typeof streamDiag.logCacheCreation, 'function');
  });
  test('logCacheInvalidation exists and is a function', () => {
    assert.strictEqual(typeof streamDiag.logCacheInvalidation, 'function');
  });
  test('logPlaybackFailure exists and is a function', () => {
    assert.strictEqual(typeof streamDiag.logPlaybackFailure, 'function');
  });
  test('logProxyPlayback exists and is a function', () => {
    assert.strictEqual(typeof streamDiag.logProxyPlayback, 'function');
  });
});

describe('streamDiagnostics methods do not throw', () => {
  test('logFreshResolution does not throw', () => {
    assert.doesNotThrow(() => {
      streamDiag.logFreshResolution(7302, 'animeheaven', sampleResult, 3787, true);
    });
  });
  test('logCacheProbe does not throw', () => {
    assert.doesNotThrow(() => {
      streamDiag.logCacheProbe(sampleUrl, { method: 'head', hadReferer: true }, { status: 200, alive: true });
    });
  });
  test('logCacheHit does not throw', () => {
    assert.doesNotThrow(() => {
      streamDiag.logCacheHit(7302, 'animeheaven', {}, sampleResult, 60000, 300000, { host: 'rt.animeheaven.me' });
    });
  });
  test('logCacheCreation does not throw', () => {
    assert.doesNotThrow(() => {
      streamDiag.logCacheCreation(7302, 'animeheaven', sampleResult, 3600000, new Date());
    });
  });
  test('logCacheInvalidation does not throw', () => {
    assert.doesNotThrow(() => {
      streamDiag.logCacheInvalidation(7302, 'animeheaven', 'probe_dead', { affectedRows: 1 }, null);
    });
  });
  test('logPlaybackFailure does not throw', () => {
    assert.doesNotThrow(() => {
      streamDiag.logPlaybackFailure(sampleCtx, { status: 502, error: 'timeout' }, { type: 'upstream_timeout' });
    });
  });
  test('logProxyPlayback does not throw', () => {
    assert.doesNotThrow(() => {
      streamDiag.logProxyPlayback('abc12345', sampleCtx, { status: 200, contentType: 'video/mp4' });
    });
  });
});

describe('streamDiagnostics with null/undefined arguments', () => {
  test('logFreshResolution with null episodeId does not throw', () => {
    assert.doesNotThrow(() => { streamDiag.logFreshResolution(null, null, null, null, null); });
  });
  test('logPlaybackFailure with null ctx does not throw', () => {
    assert.doesNotThrow(() => {
      streamDiag.logPlaybackFailure(null, { status: 404, error: 'ctx missing' }, { type: 'context_expired' });
    });
  });
  test('logCacheProbe with null url does not throw', () => {
    assert.doesNotThrow(() => { streamDiag.logCacheProbe(null, { method: 'head' }, { alive: false }); });
  });
});

describe('regression: production call-site signatures', () => {
  test('streamingService.js:1072 — logFreshResolution signature', () => {
    assert.doesNotThrow(() => {
      streamDiag.logFreshResolution(7302, 'animeheaven', sampleResult, 3787, true);
    });
  });
  test('streamProxyController.js:204 — logPlaybackFailure with null ctx', () => {
    assert.doesNotThrow(() => {
      streamDiag.logPlaybackFailure(null, { status: 404, contentType: null, error: 'Stream context not found or expired' }, { type: 'context_expired', detail: 'ctx not found in streamProxyStore' });
    });
  });
  test('streamProxyController.js:370 — logPlaybackFailure with ctx', () => {
    assert.doesNotThrow(() => {
      streamDiag.logPlaybackFailure(sampleCtx, { status: 502, contentType: null, error: 'Upstream timeout' }, { type: 'upstream_timeout', detail: 'ECONNRESET' });
    });
  });
  test('streamProxyController.js:388 — logProxyPlayback signature', () => {
    assert.doesNotThrow(() => {
      streamDiag.logProxyPlayback('abc12345', sampleCtx, { status: 200, contentType: 'video/mp4' });
    });
  });
  test('streamProxyController.js:511 — logPlaybackFailure with error', () => {
    assert.doesNotThrow(() => {
      streamDiag.logPlaybackFailure(sampleCtx, { status: 0, contentType: null, error: 'connect ECONNREFUSED' }, { type: 'connection_error', detail: 'connect ECONNREFUSED' });
    });
  });
  test('streamCacheService.js:412,419,425 — logCacheProbe signature', () => {
    assert.doesNotThrow(() => {
      streamDiag.logCacheProbe('https://cdn.animeheaven.me/seg-1.ts?token=abc', { method: 'head', skipProxy: true, hadCookies: false, hadReferer: true, hadOrigin: false }, { status: 200, contentType: 'video/MP2T', alive: true, durationMs: 85 });
    });
  });
  test('streamCacheService.js:597 — logCacheHit signature', () => {
    assert.doesNotThrow(() => {
      streamDiag.logCacheHit(7302, 'animeheaven', { provider: 'animeheaven' }, sampleResult, 60000, 300000, { host: 'rt.animeheaven.me' });
    });
  });
  test('streamCacheService.js:814 — logCacheCreation signature', () => {
    assert.doesNotThrow(() => {
      streamDiag.logCacheCreation(7302, 'animeheaven', sampleResult, 3600000, new Date());
    });
  });
  test('streamCacheService.js:826 — logCacheInvalidation signature', () => {
    assert.doesNotThrow(() => {
      streamDiag.logCacheInvalidation(7302, 'animeheaven', 'probe_dead', null, null);
    });
  });
});
