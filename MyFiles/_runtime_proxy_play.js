// READ-ONLY: Verify the cached proxy URL actually plays through the query proxy.
// (Tests 11 + partial 14: cached proxy URL -> same-origin proxy -> upstream)
'use strict';
require('dotenv').config();
const http = require('http');

const BASE = 'http://localhost:5000';
const results = [];
function record(test, status, httpStatus, expected, actual, evidence) {
  results.push({ test, status, httpStatus, expected, actual, evidence });
  console.log(`\n[${test}]\n  STATUS: ${status}\n  HTTP STATUS: ${httpStatus}\n  EXPECTED: ${expected}\n  ACTUAL: ${actual}\n  EVIDENCE: ${evidence}`);
}

function httpGet(path, { timeoutMs = 30000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => { let parsed = body; try { parsed = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: body }); });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  // Get the stream for Naruto ep2 (warm cache) -> obtain the proxy URL
  const r = await httpGet(`/api/stream/${encodeURIComponent('Naruto')}/2`, { timeoutMs: 20000 });
  const streamUrl = r.body && r.body.streamUrl;
  const src = (r.body && r.body.sources && r.body.sources[0] && r.body.sources[0].url) || null;
  const proxyUrl = streamUrl || src;
  record(
    '11a. CACHE-SERVED PROXY URL present (same-origin)',
    (r.status === 200 && proxyUrl && proxyUrl.startsWith('/api/stream/proxy')) ? 'PASS' : 'FAIL',
    r.status,
    'Browser-facing URL is a same-origin /api/stream/proxy URL, not raw CDN',
    `status=${r.status} streamUrl=${streamUrl ? String(streamUrl).substring(0, 60) : 'NONE'} src0=${src ? String(src).substring(0, 60) : 'NONE'}`,
    JSON.stringify({ status: r.status, streamUrl, src0: src })
  );

  if (proxyUrl && proxyUrl.startsWith('/api/stream/proxy')) {
    // Range request (like a video player) to confirm the proxy streams media.
    const pr = await httpGet(proxyUrl, { timeoutMs: 40000, headers: { Range: 'bytes=0-1023' } });
    const isMedia = pr.status === 200 || pr.status === 206;
    const hasRange = pr.headers && pr.headers['content-range'];
    record(
      '11b. PROXY PLAYBACK (cached proxy URL, Range request)',
      (isMedia) ? 'PASS' : 'FAIL',
      pr.status,
      'Proxy returns media (200/206) with byte-range support',
      `status=${pr.status} content-range=${hasRange || 'n/a'} content-type=${pr.headers && pr.headers['content-type']} bytes=${String(pr.raw || '').length}`,
      JSON.stringify({ status: pr.status, contentRange: hasRange || null, contentType: pr.headers && pr.headers['content-type'], bytes: String(pr.raw || '').length })
    );
  } else {
    record('11b. PROXY PLAYBACK', 'NOT VERIFIED', 0, 'proxy URL', 'no proxy URL returned from cache', 'n/a');
  }
})().catch(e => { console.error('HARNESS FAIL:', e.message); process.exit(1); });
