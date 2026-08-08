// READ-ONLY: Independently verify SSRF guard + query proxy (not dependent on streaming pipeline).
'use strict';
require('dotenv').config();
const http = require('http');

const BASE = 'http://localhost:5000';
const results = [];
function record(test, status, httpStatus, expected, actual, evidence) {
  results.push({ test, status, httpStatus, expected, actual, evidence });
  console.log(`\n[${test}]\n  STATUS: ${status}\n  HTTP STATUS: ${httpStatus}\n  EXPECTED: ${expected}\n  ACTUAL: ${actual}\n  EVIDENCE: ${evidence}`);
}

function httpGet(path, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const SSRF_TARGETS = [
  ['localhost', 'http://localhost:5000/api/health'],
  ['127.0.0.1', 'http://127.0.0.1:5000/api/health'],
  ['::1', 'http://[::1]:5000/api/health'],
  ['0.0.0.0', 'http://0.0.0.0:5000/api/health'],
  ['10.x', 'http://10.1.2.3/'],
  ['172.16.x', 'http://172.16.0.1/'],
  ['192.168.x', 'http://192.168.1.1/'],
  ['169.254.x', 'http://169.254.169.254/latest/meta-data/'],
  ['private ipv6', 'http://[fc00::1]/'],
  ['ipv4-mapped private ipv6', 'http://[::ffff:127.0.0.1]/'],
  ['obfuscated ipv4 (hex)', 'http://0x7f000001/'],
  ['embedded credentials', 'http://user:pass@127.0.0.1/'],
  ['non-http scheme', 'file:///etc/passwd'],
  ['ftp scheme', 'ftp://127.0.0.1/'],
];

(async () => {
  for (const [label, url] of SSRF_TARGETS) {
    const target = encodeURIComponent(url);
    const path = `/api/stream/proxy?provider=animeheaven&url=${target}`;
    const r = await httpGet(path, 20000);
    const rejected = r.status === 400;
    record(
      `12. SSRF reject: ${label}`,
      rejected ? 'PASS' : 'FAIL',
      r.status,
      `HTTP 400 (reject ${label})`,
      `status=${r.status} body=${String(r.body).substring(0, 80)}`,
      JSON.stringify({ url, status: r.status, rejected })
    );
  }

  // Legitimate public host (AnimeHeaven CDN) should either proxy or at least not be SSRF-rejected.
  // Use a real AnimeHeaven CDN host that resolves to public IP.
  const legit = encodeURIComponent('https://animeheaven.me/');
  const legitPath = `/api/stream/proxy?provider=animeheaven&url=${legit}`;
  try {
    const r = await httpGet(legitPath, 30000);
    const notSsrfRejected = r.status !== 400;
    record(
      '13. LEGITIMATE PROXY (public animeheaven host)',
      notSsrfRejected ? 'PASS' : 'FAIL',
      r.status,
      'Not SSRF-rejected; proxy attempts upstream',
      `status=${r.status} bodyPrefix=${String(r.body).substring(0, 60)}`,
      JSON.stringify({ url: 'https://animeheaven.me/', status: r.status })
    );
  } catch (e) {
    record('13. LEGITIMATE PROXY', 'FAIL', 0, 'Not SSRF-rejected', `error=${e.message}`, e.message);
  }
})();
