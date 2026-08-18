// Diagnostics: Trace the exact frontend playback URL construction
// and verify the proxy accepts it. Mimics watch.js flow:
//   1. GET /api/stream/:title/:ep?preferredProvider=animeheaven
//   2. POST /api/stream/authorize { episodeId }
//   3. Build the source URL the same way watch.js does
//   4. Request the proxy URL with Range and report the status
require('dotenv').config();
const http = require('http');

const BASE = process.env.API_BASE || 'http://127.0.0.1:5000';
const TITLE = 'Sorcery Fight 2nd Season';
const EP = '1';

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 60000,
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString(), json });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  console.log('BASE:', BASE);

  // 1. Resolve the stream
  const streamRes = await req('GET', `/api/stream/${encodeURIComponent(TITLE)}/${EP}?preferredProvider=animeheaven`, null, process.env.TOKEN);
  console.log('\n=== GET /api/stream ===');
  console.log('status:', streamRes.status);
  if (!streamRes.json) { console.log('raw:', streamRes.text.slice(0, 400)); return; }
  console.log('provider:', streamRes.json.provider);
  console.log('streamUrl:', streamRes.json.streamUrl);
  console.log('sources:', JSON.stringify(streamRes.json.sources, null, 2));
  console.log('episodeNumber:', streamRes.json.episodeNumber);

  if (!streamRes.json.sources || !streamRes.json.sources.length) {
    console.log('NO SOURCES — abort');
    return;
  }

  // 2. Determine episodeId from sources? The frontend uses currentEpId from the episodes list.
  // We need the DB id. The /api/stream response doesn't include it directly. Use /api/anime/:id/episodes or infer.
  // For this diagnostic, assume the response has an episodeId or fetch the anime episodes.
  const sourceUrl = streamRes.json.sources[0].url; // relative /api/stream-proxy/...
  console.log('\nsourceUrl from /api/stream:', sourceUrl);

  // 3. Authorize. We need the DB episodeId. Look it up from the anime.
  // The anime id is not in the stream response, so fetch the episodes via the title.
  // We'll use a fallback: parse it from the source's streamId? No. Let's fetch episodes.
  // Use /api/anime?search= or the known DB: for "Sorcery Fight 2nd Season" it's id=61, ep1 id=1484.
  const EPISODE_ID = process.env.EPISODE_ID || '1484';
  console.log('\nUsing episodeId:', EPISODE_ID);

  const authRes = await req('POST', '/api/stream/authorize', JSON.stringify({ episodeId: EPISODE_ID }), process.env.TOKEN);
  console.log('\n=== POST /api/stream/authorize ===');
  console.log('status:', authRes.status);
  console.log('body:', authRes.text);
  if (!authRes.json || !authRes.json.streams) { console.log('AUTH FAILED — abort'); return; }
  console.log('streams:', JSON.stringify(authRes.json.streams, null, 2));

  // 4. Build the source URL like watch.js does.
  const API_BASE_URL = 'http://127.0.0.1:5000'; // same origin
  const absSource = sourceUrl.startsWith('http') ? sourceUrl : API_BASE_URL + sourceUrl;
  // preferAuthorizedProxyUrl: match streamId
  const m = absSource.match(/\/api\/stream-proxy\/([^/?]+)/);
  const streamId = m && m[1];
  const match = authRes.json.streams.find(s => String(s.streamId) === String(streamId));
  const playableUrl = match && match.url ? match.url : absSource;
  console.log('\nFinal playable URL (as watch.js would attach):');
  console.log(playableUrl);

  // 5. Request the proxy URL with Range
  const proxyPath = playableUrl.startsWith('http') ? new URL(playableUrl).pathname + new URL(playableUrl).search : playableUrl;
  console.log('\nRequesting proxy:', proxyPath);
  const proxyRes = await req('GET', proxyPath, null, null, { range: 'bytes=0-1023' });
  console.log('proxy status:', proxyRes.status);
  console.log('proxy content-type:', proxyRes.headers['content-type']);
  console.log('proxy content-range:', proxyRes.headers['content-range']);
  console.log('proxy accept-ranges:', proxyRes.headers['accept-ranges']);
  console.log('proxy bytes:', proxyRes.body.length);
  console.log('proxy body head:', proxyRes.text.slice(0, 200));
})().catch(e => { console.error('FATAL', e); process.exit(1); });