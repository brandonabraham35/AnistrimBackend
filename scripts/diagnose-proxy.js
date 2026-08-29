// scripts/diagnose-proxy.js
// ============================================================================
// SAFE, READ-ONLY residential-proxy diagnostic for the AniStrim provider layer.
//
// PURPOSE
//   Distinguish the possible root causes of the production failure
//   "EPROTO ... tls_get_more_records:packet length too long" when fetching
//   AnimeHeaven through the Thordata proxy:
//     A) proxy endpoint unreachable
//     B) proxy authentication rejected (proxy returns 407)
//     C) proxy protocol misconfigured (client speaks TLS to a plaintext proxy)
//     D) HTTPS CONNECT through the proxy succeeds / fails
//     E) the destination (AnimeHeaven) rejects the proxied connection
//
//   It reuses the EXACT same proxy configuration the provider layer uses
//   (utils/providerHttp.getProxyList() + createProxyAgent()).  It does NOT
//   start the app, does NOT touch the DB, does NOT modify any configuration,
//   and NEVER prints the proxy username/password or full proxy URL.
//
// USAGE (run from repo root, with .env present):
//   node scripts/diagnose-proxy.js [--target https://ipinfo.io/json]
//
// SECURITY
//   - Only the proxy HOST (non-secret) is printed; the password is redacted.
//   - Proxy-Authorization is computed in memory and never logged.
//   - No TLS verification is disabled.  No production config is changed.
// ============================================================================
'use strict';

require('dotenv').config();
const net = require('net');
const axios = require('axios');
const providerHttp = require('../utils/providerHttp');

const TARGET = (process.argv.find(a => a.startsWith('--target=')) || '--target=https://ipinfo.io/json').split('=')[1];
const CONNECT_TIMEOUT_MS = 12000;
const REQUEST_TIMEOUT_MS = 15000;

const proxyList = providerHttp.getProxyList();
function getProxyInfo() {
  if (!proxyList.length) return null;
  const u = new URL(proxyList[0]);
  return {
    host: u.hostname,            // non-secret host
    port: u.port ? Number(u.port) : 80,
    hasAuth: !!(u.username || u.password),
    proxyUrl: proxyList[0],      // in-memory only; never printed
  };
}
const proxy = getProxyInfo();

function sanitize(err) {
  if (!err) return { code: '', message: '' };
  return {
    code: err.code || (err.response && err.response.status ? 'HTTP_' + err.response.status : ''),
    message: String(err.message || '').split('\n')[0].slice(0, 200),
  };
}

// Raw HTTP CONNECT probe (separates A / B / C / D).
function rawConnectProbe() {
  return new Promise((resolve) => {
    if (!proxy) return resolve({ skipped: 'no proxy configured' });
    const targetUrl = new URL(TARGET);
    const s = net.createConnection({ host: proxy.host, port: proxy.port });
    const started = Date.now();
    let timedOut = false;
    let done = false;
    const t = setTimeout(() => { if (done) return; done = true; timedOut = true; s.destroy(); resolve({ ok: false, phase: 'connect', error: 'TIMEOUT', ms: Date.now() - started }); }, CONNECT_TIMEOUT_MS);
    let buf = '';
    s.once('connect', () => {
      const authHeader = proxy.hasAuth
        ? 'Proxy-Authorization: Basic ' + Buffer.from(new URL(proxy.proxyUrl).username + ':' + decodeURIComponent(new URL(proxy.proxyUrl).password || '')).toString('base64') + '\r\n'
        : '';
      s.write('CONNECT ' + targetUrl.host + ':443 HTTP/1.1\r\nHost: ' + targetUrl.host + ':443\r\n' + authHeader + '\r\n');
    });
    s.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.includes('\r\n\r\n') && !done) {
        done = true; clearTimeout(t);
        const statusLine = buf.split('\r\n\r\n')[0].split('\r\n')[0] || '';
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
        const code = m ? Number(m[1]) : 0;
        s.destroy();
        resolve({ ok: code === 200, phase: 'connect', httpStatus: code, authRejected: code === 407, ms: Date.now() - started });
      }
    });
    s.on('error', (e) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve({ ok: false, phase: 'connect', error: e.code || e.message, ms: Date.now() - started }); });
    s.on('close', () => { clearTimeout(t); if (!done) { done = true; resolve({ ok: false, phase: 'connect', error: 'CLOSED_EARLY', ms: Date.now() - started }); } });
  });
}

// Full HTTPS request through the proxy (D/E).
async function proxiedRequest() {
  if (!proxy) return { skipped: 'no proxy configured' };
  const started = Date.now();
  const agent = providerHttp.createProxyAgent(proxy.proxyUrl);
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; AniStrim-ProxyDiag/1.0)' };
  try {
    const res = await axios.get(TARGET, { timeout: REQUEST_TIMEOUT_MS, httpsAgent: agent, proxy: false, maxRedirects: 0, validateStatus: () => true, headers });
    let ip = null, country = null;
    try { const j = typeof res.data === 'string' ? JSON.parse(res.data) : res.data; ip = j.ip || null; country = j.country || j.region || null; } catch { /* non-JSON */ }
    return { ok: res.status >= 200 && res.status < 400, phase: 'request', httpStatus: res.status, len: String(res.data || '').length, ip, country, ms: Date.now() - started, tls: true };
  } catch (err) { return { ok: false, phase: 'request', ...sanitize(err), ms: Date.now() - started }; }
}

// Direct request (no proxy) — control environment sanity.
async function directRequest() {
  const started = Date.now();
  try {
    const res = await axios.get(TARGET, { timeout: REQUEST_TIMEOUT_MS, proxy: false, validateStatus: () => true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AniStrim-ProxyDiag/1.0)' } });
    let ip = null, country = null;
    try { const j = typeof res.data === 'string' ? JSON.parse(res.data) : res.data; ip = j.ip || null; country = j.country || j.region || null; } catch { /* non-JSON */ }
    return { ok: res.status >= 200 && res.status < 400, phase: 'direct', httpStatus: res.status, ip, country, ms: Date.now() - started, tls: true };
  } catch (err) { return { ok: false, phase: 'direct', ...sanitize(err), ms: Date.now() - started }; }
}

// Full HTTPS request to an arbitrary target through the proxy (used for AnimeHeaven).
async function proxiedTarget(url) {
  const started = Date.now();
  const targetUrl = new URL(url);
  const agent = providerHttp.createProxyAgent(proxy.proxyUrl);
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' };
  headers.Origin = targetUrl.origin; headers.Referer = targetUrl.origin;
  try {
    const res = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS, httpsAgent: agent, proxy: false, maxRedirects: 0, validateStatus: () => true, headers });
    return { ok: res.status >= 200 && res.status < 400, phase: 'request', httpStatus: res.status, len: String(res.data || '').length, ms: Date.now() - started, tls: true };
  } catch (err) { return { ok: false, phase: 'request', ...sanitize(err), ms: Date.now() - started }; }
}


// Plain HTTP relay probe (removes TLS entirely).
// Opens a raw CONNECT tunnel to an HTTP (port 80) destination, then sends an
// HTTP request through it. This definitively separates "TLS/plaintext issue"
// from "proxy authentication/relay issue": if the proxy answers the plaintext
// request with 407, the failure is at the proxy auth/relay layer, not TLS.
function plainHttpRelay() {
  return new Promise((resolve) => {
    if (!proxy) return resolve({ skipped: 'no proxy configured' });
    const host = 'httpbin.org', port = 80;
    const s = net.createConnection({ host: proxy.host, port: proxy.port });
    const started = Date.now();
    let done = false;
    const to = setTimeout(() => { if (done) return; done = true; s.destroy(); resolve({ ok: false, phase: 'relay', error: 'TIMEOUT', ms: Date.now() - started }); }, CONNECT_TIMEOUT_MS);
    let connBuf = '';
    let relayBuf = Buffer.alloc(0);
    let tunnelOpen = false;
    s.once('connect', () => {
      const authHeader = proxy.hasAuth
        ? 'Proxy-Authorization: Basic ' + Buffer.from(new URL(proxy.proxyUrl).username + ':' + decodeURIComponent(new URL(proxy.proxyUrl).password || '')).toString('base64') + '\r\n'
        : '';
      s.write('CONNECT ' + host + ':80 HTTP/1.1\r\nHost: ' + host + ':80\r\n' + authHeader + '\r\n');
    });
    s.on('data', (chunk) => {
      if (!tunnelOpen) {
        connBuf += chunk.toString('latin1');
        if (connBuf.includes('\r\n\r\n')) {
          const m = /^HTTP\/1\.[01] (\d{3})/.exec(connBuf);
          if (m && m[1] === '200') {
            tunnelOpen = true;
            const idx = connBuf.indexOf('\r\n\r\n') + 4;
            relayBuf = Buffer.from(connBuf.slice(idx), 'latin1');
            s.write('GET /ip HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n');
          } else {
            done = true; clearTimeout(to); s.destroy();
            resolve({ ok: false, phase: 'relay', connectStatus: m ? Number(m[1]) : 0, error: 'CONNECT not 200', ms: Date.now() - started });
          }
        }
      } else {
        relayBuf = Buffer.concat([relayBuf, chunk]);
      }
    });
    s.on('close', () => {
      clearTimeout(to);
      if (done) return; done = true;
      const head = relayBuf.toString('latin1');
      const statusLine = head.split('\r\n')[0] || '(none)';
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
      const code = m ? Number(m[1]) : 0;
      resolve({
        ok: code >= 200 && code < 300 && !/Proxy Authentication Required/i.test(head),
        phase: 'relay',
        httpStatus: code,
        authRejected: code === 407 || /Proxy Authentication Required/i.test(head),
        bytes: relayBuf.length,
        statusLine,
        ms: Date.now() - started,
        tlsNotUsed: true,
      });
    });
    s.on('error', (e) => { if (done) return; done = true; clearTimeout(to); s.destroy(); resolve({ ok: false, phase: 'relay', error: e.code || e.message, ms: Date.now() - started }); });
  });
}

async function main() {
  console.log('PROXY_DIAG_START', new Date().toISOString());
  console.log('TARGET', new URL(TARGET).host, new URL(TARGET).pathname);
  console.log('PROXY_ENABLED', proxy ? 'YES' : 'NO');
  console.log('PROXY_HOST', proxy ? proxy.host : '(none)', proxy ? 'PORT=' + proxy.port : '', proxy ? 'AUTH=' + (proxy.hasAuth ? 'CONFIGURED(redacted)' : 'NONE') : '');

  // Report which env-var source provides the proxy configuration.
  const proxySource = process.env.PROXY_HOST && process.env.PROXY_HOST.trim().length > 0
    ? 'PROXY_HOST_CONFIG'
    : (process.env.PROXY_LIST && process.env.PROXY_LIST.trim().length > 0
        ? 'PROXY_LIST'
        : 'UNSET');
  console.log('PROXY_SOURCE', proxySource);

  // Check for conflicting/hijacking env proxy vars.
  const envHijack = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].filter(k => process.env[k]);
  if (envHijack.length > 0) {
    console.log('WARN_ENV_PROXY_VARS', envHijack.join(','), '(these CAN hijack Axios if proxy:false is missing!)');
  } else {
    console.log('ENV_PROXY_VARS', 'none');
  }

  const d = await directRequest();
  console.log('TEST1_DIRECT', JSON.stringify(d));

  if (!proxy) { console.log('SKIP_PROXY_TESTS', 'no proxy configured in providerHttp'); process.exit(0); }

  const c = await rawConnectProbe();
  // Classify CONNECT result
  const connectLabel = c.ok ? 'PASS' : (c.authRejected ? 'PROXY_AUTH_FAILED' : 'FAIL');
  console.log('TEST2_RAW_CONNECT', JSON.stringify({ ...c, classification: connectLabel }));

  // Test 4 — plain HTTP relay (removes TLS; isolates proxy auth/relay layer).
  const rel = await plainHttpRelay();
  const relayLabel = rel.ok ? 'PASS' : (rel.authRejected ? 'PROXY_AUTH_FAILED' : 'FAIL');
  console.log('TEST4_PLAIN_HTTP_RELAY', JSON.stringify({ ...rel, classification: relayLabel }));

  const p = await proxiedRequest();
  const httpsLabel = p.ok ? 'PASS' : (p.code === 'EPROTO' || (p.code||'').includes('AUTH') ? 'PROXY_AUTH_FAILED' : 'FAIL');
  console.log('TEST2_PROXIED_HTTPS', JSON.stringify({ ...p, classification: httpsLabel }));

  const a = await proxiedTarget('https://animeheaven.me/');
  const ahLabel = a.ok ? 'PASS' : (a.code === 'EPROTO' || (a.code||'').includes('AUTH') ? 'PROXY_AUTH_FAILED' : 'FAIL');
  console.log('TEST3_ANIMEHEAVEN_PROXIED', JSON.stringify({ ...a, classification: ahLabel }));
  console.log('PROXY_DIAG_END', new Date().toISOString());
  process.exit(0);
}

main().catch(e => { console.log('FATAL', sanitize(e)); process.exit(1); });

