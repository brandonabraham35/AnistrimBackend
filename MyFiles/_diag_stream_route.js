// Diagnostic: verify the /api/stream/:title/:ep route captures params correctly.
process.env.PORT = process.env.PORT || '5099';
process.env.STREAM_PROVIDERS = 'animeheaven';

const http = require('http');

function request(method, reqPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL('http://127.0.0.1:' + process.env.PORT + reqPath);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { 'User-Agent': 'Mozilla/5.0', ...opts.headers },
      timeout: opts.timeout || 15000,
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function waitForServer(attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request('GET', '/api/health', { timeout: 2000 });
      if (res.status === 200) return true;
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  require('./server');
  const up = await waitForServer();
  console.log('SERVER UP:', up);

  const tests = [
    '/api/stream/One%20Piece/1',
    '/api/stream/One%20Piece/1?preferredProvider=animeheaven',
    '/api/stream/Naruto/1',
    '/api/stream/Attack%20on%20Titan/1',
  ];
  for (const t of tests) {
    try {
      const r = await request('GET', t, { timeout: 20000 });
      console.log(`\n[${r.status}] ${t}`);
      console.log('  body:', r.text.slice(0, 300));
    } catch (e) {
      console.log(`\n[ERROR] ${t}: ${e.message}`);
    }
  }
  process.exit(0);
})();
