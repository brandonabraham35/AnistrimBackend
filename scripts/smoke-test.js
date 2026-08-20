// scripts/smoke-test.js
// CORS smoke test — hits key API endpoints with multiple Origin headers
// and asserts Access-Control-Allow-Origin is present for allowed origins.
// Usage: node scripts/smoke-test.js [BASE_URL] [WEB_ORIGIN]

'use strict';

const BASE_URL = process.argv[2] || 'http://localhost:5000';
const WEB_ORIGIN = process.argv[3] || 'https://anistrim.com';

const ENDPOINTS = [
  '/api/health',
  '/api/anime/trending',
  '/api/anime/latest',
  '/api/anime/recent',
  '/api/anime/popular',
  '/api/anime/genres',
  '/api/home/sections',
];

const ORIGINS = [
  { name: 'Capacitor iOS', origin: 'capacitor://localhost' },
  { name: 'Capacitor Android', origin: 'https://localhost' },
  { name: 'Web origin', origin: WEB_ORIGIN },
  { name: 'no origin', origin: null },
];

let failures = 0;

function check(desc, ok) {
  console.log(`  ${ok ? '✅' : '❌'} ${desc}`);
  if (!ok) failures++;
}

async function main() {
  console.log(`\n🌐 CORS smoke test against ${BASE_URL}`);
  console.log(`   Web origin: ${WEB_ORIGIN}\n`);

  for (const ep of ENDPOINTS) {
    for (const t of ORIGINS) {
      const headers = {};
      if (t.origin) headers.Origin = t.origin;
      try {
        const res = await fetch(BASE_URL + ep, { headers });
        const acao = res.headers.get('access-control-allow-origin');
        if (!t.origin) {
          check(`${ep} [no origin] → status ${res.status}`, res.status < 500);
        } else {
          check(`${ep} [${t.name}] → ACAO="${acao || 'MISSING'}"`, acao === t.origin || acao === '*');
        }
      } catch (e) {
        check(`${ep} [${t.name}] → request failed: ${e.message}`, false);
      }
    }
  }

  console.log(failures === 0 ? '\n✅ ALL SMOKE TESTS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});