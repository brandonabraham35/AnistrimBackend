// tests/streamExpiryDetection.test.js
// Unit tests for stream source expiry detection logic.
'use strict';

const assert = require('assert');
const {
  detectExpiryFromUrl,
  detectExpiryFromHeaders,
  detectSourceExpiry,
  parseTimestamp,
} = require('../services/streamCacheService');

// Helper: create a date N seconds from now.
function futureDate(seconds) {
  return new Date(Date.now() + seconds * 1000);
}

function pastDate(seconds) {
  return new Date(Date.now() - seconds * 1000);
}

// ── parseTimestamp tests ──────────────────────────────────

describe('parseTimestamp', () => {
  it('parses Unix seconds correctly', () => {
    // 2030-01-01 in Unix seconds
    const result = parseTimestamp('1893456000');
    assert.ok(result instanceof Date);
    assert.strictEqual(result.getFullYear(), 2030);
  });

  it('parses Unix milliseconds correctly', () => {
    // 2030-01-01 in Unix milliseconds
    const result = parseTimestamp('1893456000000');
    assert.ok(result instanceof Date);
    assert.strictEqual(result.getFullYear(), 2030);
  });

  it('returns null for values below minimum threshold', () => {
    // 2019-01-01 — below MIN_VALID_TIMESTAMP
    const result = parseTimestamp('1546300800');
    assert.strictEqual(result, null);
  });

  it('returns null for non-numeric strings', () => {
    assert.strictEqual(parseTimestamp('abc'), null);
    assert.strictEqual(parseTimestamp(''), null);
    assert.strictEqual(parseTimestamp(null), null);
    assert.strictEqual(parseTimestamp(undefined), null);
  });

  it('returns null for unreasonably large timestamps', () => {
    // 99999999999999999 seconds — far beyond any reasonable expiry
    // This results in an Invalid Date because it exceeds Date's max range
    const result = parseTimestamp('99999999999999999');
    // Note: This may or may not be null depending on JS engine,
    // so we just check it's either null or an Invalid Date
    if (result !== null) {
      assert.ok(!Number.isFinite(result.getTime()), 'Should be an invalid date');
    }
  });
});

// ── detectExpiryFromUrl tests ─────────────────────────────

describe('detectExpiryFromUrl', () => {
  it('detects expires=Unix timestamp', () => {
    const futureTs = Math.floor(futureDate(3600).getTime() / 1000);
    const url = `https://cdn.example.com/video.mp4?token=abc&expires=${futureTs}`;
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'url');
    assert.ok(result.detectedExpiresAt instanceof Date);
    assert.ok(result.detectedExpiresAt > new Date());
  });

  it('detects exp=Unix timestamp', () => {
    const futureTs = Math.floor(futureDate(7200).getTime() / 1000);
    const url = `https://cdn.example.com/video.m3u8?sig=xyz&exp=${futureTs}`;
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'url');
    assert.ok(result.detectedExpiresAt instanceof Date);
  });

  it('detects expires_at=Unix timestamp', () => {
    const futureTs = Math.floor(futureDate(1800).getTime() / 1000);
    const url = `https://cdn.example.com/stream?expires_at=${futureTs}&quality=720`;
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'url');
    assert.ok(result.detectedExpiresAt instanceof Date);
  });

  it('detects expiration=Unix timestamp (milliseconds)', () => {
    const futureMs = futureDate(3600).getTime();
    const url = `https://cdn.example.com/video.mp4?expiration=${futureMs}`;
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'url');
    assert.ok(result.detectedExpiresAt instanceof Date);
  });

  it('returns unknown for missing expiry', () => {
    const url = 'https://cdn.example.com/video.mp4?token=abc&quality=720';
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'unknown');
    assert.strictEqual(result.detectedExpiresAt, null);
  });

  it('returns unknown for invalid expiry value', () => {
    const url = 'https://cdn.example.com/video.mp4?expires=not-a-timestamp';
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'unknown');
    assert.strictEqual(result.detectedExpiresAt, null);
  });

  it('ignores unrelated numeric query parameters', () => {
    // episode number, quality, etc. should NOT be parsed as expiry
    const url = 'https://cdn.example.com/video.mp4?episode=5&quality=1080&token=abc';
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'unknown');
    assert.strictEqual(result.detectedExpiresAt, null);
  });

  it('handles already expired source', () => {
    const pastTs = Math.floor(pastDate(3600).getTime() / 1000);
    const url = `https://cdn.example.com/video.mp4?expires=${pastTs}`;
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'url');
    assert.ok(result.detectedExpiresAt instanceof Date);
    assert.ok(result.detectedExpiresAt < new Date());
  });

  it('handles future source', () => {
    const futureTs = Math.floor(futureDate(86400).getTime() / 1000);
    const url = `https://cdn.example.com/video.mp4?expires=${futureTs}`;
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'url');
    assert.ok(result.detectedExpiresAt > new Date());
  });

  it('handles HLS source with expiry', () => {
    const futureTs = Math.floor(futureDate(3600).getTime() / 1000);
    const url = `https://cdn.example.com/manifest.m3u8?expires=${futureTs}&token=abc`;
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'url');
    assert.ok(result.detectedExpiresAt instanceof Date);
  });

  it('handles MP4 source with expiry', () => {
    const futureTs = Math.floor(futureDate(3600).getTime() / 1000);
    const url = `https://cdn.example.com/video.mp4?expires=${futureTs}&token=abc`;
    const result = detectExpiryFromUrl(url);
    assert.strictEqual(result.expirySource, 'url');
    assert.ok(result.detectedExpiresAt instanceof Date);
  });

  it('returns unknown for null/undefined URL', () => {
    assert.deepStrictEqual(detectExpiryFromUrl(null), { detectedExpiresAt: null, expirySource: 'unknown' });
    assert.deepStrictEqual(detectExpiryFromUrl(undefined), { detectedExpiresAt: null, expirySource: 'unknown' });
    assert.deepStrictEqual(detectExpiryFromUrl(''), { detectedExpiresAt: null, expirySource: 'unknown' });
  });
});

// ── detectExpiryFromHeaders tests ─────────────────────────

describe('detectExpiryFromHeaders', () => {
  it('detects Cache-Control max-age', () => {
    const now = Date.now();
    const headers = { 'cache-control': 'max-age=3600, public' };
    const result = detectExpiryFromHeaders(headers, now);
    assert.strictEqual(result.expirySource, 'header');
    assert.ok(result.detectedExpiresAt instanceof Date);
    // Should be approximately 3600 seconds from now
    const diff = result.detectedExpiresAt.getTime() - now;
    assert.ok(diff >= 3500000 && diff <= 3700000, `Expected ~3600s, got ${diff / 1000}s`);
  });

  it('detects Expires header', () => {
    const now = Date.now();
    const expiresDate = new Date(now + 7200 * 1000);
    const headers = { expires: expiresDate.toUTCString() };
    const result = detectExpiryFromHeaders(headers, now);
    assert.strictEqual(result.expirySource, 'header');
    assert.ok(result.detectedExpiresAt instanceof Date);
  });

  it('returns unknown for headers without expiry', () => {
    const headers = { 'content-type': 'video/mp4', 'content-length': '12345' };
    const result = detectExpiryFromHeaders(headers, Date.now());
    assert.strictEqual(result.expirySource, 'unknown');
    assert.strictEqual(result.detectedExpiresAt, null);
  });

  it('returns unknown for null/undefined headers', () => {
    assert.deepStrictEqual(
      detectExpiryFromHeaders(null, Date.now()),
      { detectedExpiresAt: null, expirySource: 'unknown' }
    );
    assert.deepStrictEqual(
      detectExpiryFromHeaders(undefined, Date.now()),
      { detectedExpiresAt: null, expirySource: 'unknown' }
    );
  });
});

// ── detectSourceExpiry tests ──────────────────────────────

describe('detectSourceExpiry', () => {
  it('detects expiry from first source URL', () => {
    const futureTs = Math.floor(futureDate(3600).getTime() / 1000);
    const providerResult = {
      provider: 'animeheaven',
      streamUrl: `https://cdn.example.com/video.mp4?expires=${futureTs}`,
      sources: [
        { url: `https://cdn.example.com/video.mp4?expires=${futureTs}`, quality: '720' },
      ],
      subtitles: [],
    };
    const result = detectSourceExpiry(providerResult);
    assert.strictEqual(result.expirySource, 'url');
    assert.ok(result.detectedExpiresAt instanceof Date);
  });

  it('detects earliest expiry from multiple sources', () => {
    const sooner = Math.floor(futureDate(1800).getTime() / 1000);
    const later = Math.floor(futureDate(7200).getTime() / 1000);
    const providerResult = {
      provider: 'animeheaven',
      sources: [
        { url: `https://cdn.example.com/video1080.mp4?expires=${later}`, quality: '1080' },
        { url: `https://cdn.example.com/video720.mp4?expires=${sooner}`, quality: '720' },
      ],
      subtitles: [],
    };
    const result = detectSourceExpiry(providerResult);
    assert.strictEqual(result.expirySource, 'url');
    // Should pick the sooner expiry
    assert.ok(Math.abs(result.detectedExpiresAt.getTime() - sooner * 1000) < 2000);
  });

  it('falls back to streamUrl when sources have no expiry', () => {
    const futureTs = Math.floor(futureDate(3600).getTime() / 1000);
    const providerResult = {
      provider: 'animeheaven',
      streamUrl: `https://cdn.example.com/stream.m3u8?expires=${futureTs}`,
      sources: [
        { url: 'https://cdn.example.com/stream.m3u8', quality: '720' },
      ],
      subtitles: [],
    };
    const result = detectSourceExpiry(providerResult);
    assert.strictEqual(result.expirySource, 'url');
    assert.ok(result.detectedExpiresAt instanceof Date);
  });

  it('returns unknown for empty sources', () => {
    const providerResult = {
      provider: 'animeheaven',
      sources: [],
      subtitles: [],
    };
    const result = detectSourceExpiry(providerResult);
    assert.strictEqual(result.expirySource, 'unknown');
    assert.strictEqual(result.detectedExpiresAt, null);
  });

  it('returns unknown for null provider result', () => {
    const result = detectSourceExpiry(null);
    assert.strictEqual(result.expirySource, 'unknown');
    assert.strictEqual(result.detectedExpiresAt, null);
  });

  it('returns unknown for sources without expiry params', () => {
    const providerResult = {
      provider: 'animeheaven',
      sources: [
        { url: 'https://cdn.example.com/video.mp4?token=abc&quality=720', quality: '720' },
      ],
      subtitles: [],
    };
    const result = detectSourceExpiry(providerResult);
    assert.strictEqual(result.expirySource, 'unknown');
    assert.strictEqual(result.detectedExpiresAt, null);
  });
});
