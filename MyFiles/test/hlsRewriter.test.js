// =============================================================
//  test/hlsRewriter.test.js
//
//  Regression tests for utils/hlsRewriter.js — the production-grade
//  HLS manifest rewriter shared by both playback proxies.
//
//  Uses Node's built-in test runner (node:test) — no external deps.
//  Run:  node --test test/hlsRewriter.test.js
//
//  Coverage:
//    • resolveUri — relative, root-relative, query-only, fragment-only,
//      absolute, nested ../ paths, signed/tokenized URLs.
//    • isHlsUri / isHlsContentType — detection incl. extension-less
//      playlists served with an HLS Content-Type.
//    • shouldRewriteUrl — http(s) + relative rewritten; data:/blob:/
//      javascript:/mailto: pass through untouched.
//    • rewriteHlsManifest — variant/media/subtitle/audio playlists, key
//      URIs, init segments (MAP), LL-HLS (PART/PRELOAD-HINT/
//      RENDITION-REPORT), I-frame playlists, byte-range segments,
//      unquoted URI=, query/tokenized URLs.
//    • Integration — a realistic master + media playlist fixture where:
//        - every rewritten URL points at the proxy,
//        - no direct CDN URL remains,
//        - all HLS directives are preserved verbatim,
//        - the output is idempotent (re-rewriting is a no-op).
// =============================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  rewriteHlsManifest,
  resolveUri,
  isHlsUri,
  isHlsContentType,
  shouldRewriteUrl,
} = require('../utils/hlsRewriter');

// ── Proxy URL builder used across tests. Mirrors the streamId-scoped shape
//    emitted by streamProxyController.js.
const proxy = (absUrl) =>
  `/api/stream-proxy/stream123?url=${encodeURIComponent(absUrl)}`;

const BASE = 'https://cdn.example.com/hls/master.m3u8';

// ═══════════════════════════════════════════════════════════
//  resolveUri
// ═══════════════════════════════════════════════════════════
test('resolveUri resolves relative URIs', () => {
  assert.equal(
    resolveUri(BASE, 'seg1.ts'),
    'https://cdn.example.com/hls/seg1.ts'
  );
});

test('resolveUri resolves nested relative paths (../)', () => {
  assert.equal(
    resolveUri(BASE, '../other/seg1.ts'),
    'https://cdn.example.com/other/seg1.ts'
  );
});

test('resolveUri resolves root-relative URIs (/)', () => {
  assert.equal(
    resolveUri(BASE, '/segments/seg1.ts'),
    'https://cdn.example.com/segments/seg1.ts'
  );
});

test('resolveUri preserves absolute URIs', () => {
  const abs = 'https://other.example.com/seg1.ts';
  assert.equal(resolveUri(BASE, abs), abs);
});

test('resolveUri preserves query strings', () => {
  assert.equal(
    resolveUri(BASE, 'seg1.ts?token=abc&expiry=123'),
    'https://cdn.example.com/hls/seg1.ts?token=abc&expiry=123'
  );
});

test('resolveUri preserves a query-only URI', () => {
  assert.equal(
    resolveUri(BASE, '?token=abc'),
    'https://cdn.example.com/hls/master.m3u8?token=abc'
  );
});

test('resolveUri preserves fragments', () => {
  assert.equal(
    resolveUri(BASE, 'seg1.ts#t=5'),
    'https://cdn.example.com/hls/seg1.ts#t=5'
  );
});

test('resolveUri handles signed/tokenized URLs', () => {
  assert.equal(
    resolveUri(BASE, '/key?Policy=abc&Signature=xyz&Key-Pair-Id=K123'),
    'https://cdn.example.com/key?Policy=abc&Signature=xyz&Key-Pair-Id=K123'
  );
});

test('resolveUri falls back to raw string on unparseable input', () => {
  assert.equal(resolveUri('not-a-url', 'seg1.ts'), 'seg1.ts');
});

// ═══════════════════════════════════════════════════════════
//  isHlsUri / isHlsContentType
// ═══════════════════════════════════════════════════════════
test('isHlsUri detects .m3u8 with query string', () => {
  assert.equal(isHlsUri('https://x.com/a.m3u8?token=abc'), true);
  assert.equal(isHlsUri('https://x.com/a.m3u8'), true);
  assert.equal(isHlsUri('https://x.com/a.mp4'), false);
  assert.equal(isHlsUri(null), false);
});

test('isHlsContentType accepts all HLS MIME types', () => {
  assert.equal(isHlsContentType('application/vnd.apple.mpegurl'), true);
  assert.equal(isHlsContentType('application/x-mpegURL'), true);
  assert.equal(isHlsContentType('application/x-mpegurl'), true);
  assert.equal(isHlsContentType('audio/mpegurl'), true);
  assert.equal(isHlsContentType('application/vnd.apple.mpegurl; charset=utf-8'), true);
  assert.equal(isHlsContentType('video/mp4'), false);
  assert.equal(isHlsContentType(null), false);
});

// ═══════════════════════════════════════════════════════════
//  shouldRewriteUrl
// ═══════════════════════════════════════════════════════════
test('shouldRewriteUrl rewrites http(s) and relative', () => {
  assert.equal(shouldRewriteUrl('https://cdn.example.com/seg.ts'), true);
  assert.equal(shouldRewriteUrl('seg.ts'), true);
  assert.equal(shouldRewriteUrl('../seg.ts'), true);
  assert.equal(shouldRewriteUrl('/seg.ts'), true);
});

test('shouldRewriteUrl does NOT rewrite data/blob/javascript/mailto', () => {
  assert.equal(shouldRewriteUrl('data:text/vnd.trolltech.qt;base64,AAAA'), false);
  assert.equal(shouldRewriteUrl('blob:https://x.com/uuid'), false);
  assert.equal(shouldRewriteUrl('javascript:void(0)'), false);
  assert.equal(shouldRewriteUrl('mailto:x@y.com'), false);
  assert.equal(shouldRewriteUrl(''), false);
  assert.equal(shouldRewriteUrl(null), false);
});

// ═══════════════════════════════════════════════════════════
//  rewriteHlsManifest — media playlist (segments, keys, MAP)
// ═══════════════════════════════════════════════════════════
test('rewrites media playlist segments, key URI, and init segment', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/key?token=abc"',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
    '#EXTINF:6.006,',
    '../seg1.ts?token=xyz',
    '#EXTINF:6.006,',
    'seg2.ts',
  ].join('\n');

const { body, rewritten } = rewriteHlsManifest(manifest, BASE, proxy);

  assert.ok(body.includes('URI="/api/stream-proxy/stream123?url='));
  // No RAW absolute CDN URL remains (only percent-encoded inside the proxy URL).
  assert.ok(!body.includes('URI="https://keys.example.com/key?token=abc"'));
  assert.ok(!body.includes('URI="https://cdn.example.com/hls/init.mp4"'));
  // Directives preserved verbatim.
  assert.ok(body.includes('#EXTM3U'));
  assert.ok(body.includes('#EXT-X-VERSION:3'));
  assert.ok(body.includes('#EXT-X-TARGETDURATION:6'));
  assert.ok(body.includes('#EXT-X-MEDIA-SEQUENCE:0'));
  assert.ok(body.includes('#EXT-X-MAP:URI='));
  assert.ok(body.includes('#EXTINF:6.006,'));
  // 4 rewrites: key, MAP, seg1, seg2.
  assert.equal(rewritten, 4);
});

test('rewrites unquoted URI= attribute forms', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI=https://keys.example.com/key',
    '#EXTINF:6,',
    'seg.ts',
  ].join('\n');
  const { body } = rewriteHlsManifest(manifest, BASE, proxy);
  assert.ok(body.includes('/api/stream-proxy/stream123?url='));
  assert.ok(!body.includes('https://keys.example.com/key'));
});

// ═══════════════════════════════════════════════════════════
//  rewriteHlsManifest — master playlist (variant playlists)
// ═══════════════════════════════════════════════════════════
test('rewrites variant playlist URIs in master playlist', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480',
    '720p/video.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720',
    '720p/video.m3u8?token=abc',
  ].join('\n');
  const { body, rewritten } = rewriteHlsManifest(manifest, BASE, proxy);
  assert.equal(rewritten, 2);
  assert.ok(!body.includes('720p/video.m3u8'));
  assert.ok(body.includes('/api/stream-proxy/stream123?url='));
});

// ═══════════════════════════════════════════════════════════
//  rewriteHlsManifest — audio/subtitle playlists (EXT-X-MEDIA)
// ═══════════════════════════════════════════════════════════
test('rewrites audio and subtitle playlist URIs in EXT-X-MEDIA', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="https://subs.example.com/en.vtt"',
  ].join('\n');
  const { body, rewritten } = rewriteHlsManifest(manifest, BASE, proxy);
  assert.equal(rewritten, 2);
  assert.ok(!body.includes('audio/en.m3u8'));
  assert.ok(!body.includes('https://subs.example.com/en.vtt'));
  assert.ok(body.includes('TYPE=AUDIO'));
  assert.ok(body.includes('TYPE=SUBTITLES'));
});

// ═══════════════════════════════════════════════════════════
//  rewriteHlsManifest — LL-HLS (PART / PRELOAD-HINT / RENDITION-REPORT)
// ═══════════════════════════════════════════════════════════
test('rewrites LL-HLS PART, PRELOAD-HINT, and RENDITION-REPORT URIs', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-PART:DURATION=0.333,URI="part0001.m4s"',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part0002.m4s"',
    '#EXT-X-RENDITION-REPORT:URI="rendition.m3u8"',
  ].join('\n');
const { body, rewritten } = rewriteHlsManifest(manifest, BASE, proxy);
  assert.equal(rewritten, 3);
  // The raw URI="..." attribute forms must be gone (only encoded inside proxy).
  assert.ok(!body.includes('URI="part0001.m4s"'));
  assert.ok(!body.includes('URI="part0002.m4s"'));
  assert.ok(!body.includes('URI="rendition.m3u8"'));
  assert.ok(body.includes('/api/stream-proxy/stream123?url='));
});

// ═══════════════════════════════════════════════════════════
//  rewriteHlsManifest — I-frame playlists
// ═══════════════════════════════════════════════════════════
test('rewrites I-FRAME-STREAM-INF URI attributes', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,RESOLUTION=640x360,URI="iframe.m3u8"',
  ].join('\n');
const { body, rewritten } = rewriteHlsManifest(manifest, BASE, proxy);
  assert.equal(rewritten, 1);
  assert.ok(body.includes('BANDWIDTH=86000'));
  // The raw URI="iframe.m3u8" attribute is replaced by a proxy URL.
  assert.ok(!body.includes('URI="iframe.m3u8"'));
  assert.ok(body.includes('/api/stream-proxy/stream123?url='));
});

// ═══════════════════════════════════════════════════════════
//  rewriteHlsManifest — data:/blob: pass-through
// ═══════════════════════════════════════════════════════════
test('leaves data:/blob:/javascript:/mailto: URIs untouched', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
    '#EXTINF:6,',
    'seg.ts',
  ].join('\n');
  const { body, rewritten } = rewriteHlsManifest(
    manifest,
    BASE,
    proxy
  );
  // Only the relative segment is rewritten, not the data: key.
  assert.equal(rewritten, 1);
  assert.ok(body.includes('data:text/plain;base64,AAAA'));
  assert.ok(!body.includes('URkkekek'));
});

// ═══════════════════════════════════════════════════════════
//  rewriteHlsManifest — does not break HLS syntax (line-for-line)
// ═══════════════════════════════════════════════════════════
test('preserves all directives and comments verbatim (line-for-line)', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/key"',
    '#EXTINF:6.006,',
    '../seg1.ts?token=xyz',
    '#EXTINF:6.006,',
    'seg2.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  const { body } = rewriteHlsManifest(manifest, BASE, proxy);
  const lines = body.split('\n');

// Directive lines must be unchanged.
  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[1], '#EXT-X-VERSION:3');
  assert.equal(lines[2], '#EXT-X-TARGETDURATION:6');
  assert.equal(lines[3], '#EXT-X-MEDIA-SEQUENCE:0');
  assert.equal(lines[5], '#EXTINF:6.006,');
  assert.equal(lines[7], '#EXTINF:6.006,');
  assert.equal(lines[9], '#EXT-X-ENDLIST');

  // The two segment URI lines are rewritten to proxy URLs.
  assert.ok(lines[6].startsWith('/api/stream-proxy/stream123?url='));
  assert.ok(lines[8].startsWith('/api/stream-proxy/stream123?url='));
  // The key line keeps its directive but has its URI rewritten.
  assert.ok(lines[4].startsWith('#EXT-X-KEY:METHOD=AES-128,URI='));
  assert.ok(!lines[4].includes('https://keys.example.com/key'));
});

// ═══════════════════════════════════════════════════════════
//  Integration + idempotency
// ═══════════════════════════════════════════════════════════
test('integration: full master playlist rewritten and idempotent', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:4',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480',
    '720p/video.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720',
    '1080p/video.m3u8?token=abc',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subs/en.vtt"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="iframe.m3u8"',
  ].join('\n');

const first = rewriteHlsManifest(master, BASE, proxy);
  const second = rewriteHlsManifest(first.body, BASE, proxy);

  // 1) Every rewritten URL points at the proxy.
  assert.ok(first.body.includes('/api/stream-proxy/stream123?url='));
  // 2) No RAW relative references remain (every URI is now a proxy URL).
  assert.ok(!first.body.includes('\n720p/video.m3u8'));
  assert.ok(!first.body.includes('\n1080p/video.m3u8'));
  assert.ok(!first.body.includes('URI="subs/en.vtt"'));
  assert.ok(!first.body.includes('URI="iframe.m3u8"'));
  // 3) All HLS directives remain unchanged.
  assert.ok(first.body.includes('#EXTM3U'));
  assert.ok(first.body.includes('#EXT-X-VERSION:4'));
  assert.ok(first.body.includes('#EXT-X-INDEPENDENT-SEGMENTS'));
  assert.ok(first.body.includes('BANDWIDTH=1280000'));
  assert.ok(first.body.includes('BANDWIDTH=2560000'));
  assert.ok(first.body.includes('TYPE=SUBTITLES'));
  // 4) Idempotency: re-rewriting yields the same output (rewritten count 0).
  assert.equal(second.body, first.body);
  assert.equal(second.rewritten, 0);
});

test('throws when proxyUrlBuilder is not a function', () => {
  assert.throws(() => rewriteHlsManifest('#EXTM3U', BASE, null), TypeError);
});

test('handles empty manifest gracefully', () => {
  const { body, rewritten } = rewriteHlsManifest('', BASE, proxy);
  assert.equal(body, '');
  assert.equal(rewritten, 0);
});
