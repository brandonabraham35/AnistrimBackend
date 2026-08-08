// =============================================================
//  _p1_ssrf_verify.js — P1-2 SSRF guard verification
//  Tests the actual utils/ssrfGuard.js implementation against
//  representative reject AND allow targets.
// =============================================================
'use strict';

const { assertSafeTargetHost, isForbiddenIp } = require('./utils/ssrfGuard');

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
};

async function main() {
  console.log('=== MUST REJECT (private/loopback/link-local/internal) ===');
  const mustReject = [
    'http://127.0.0.1/',
    'http://127.0.0.1:8080/admin',
    'http://localhost/',
    'http://localhost:3000/',
    'http://[::1]/',
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/',
    'http://169.254.0.1/latest/meta-data/',
    // IPv4-mapped IPv6
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://[::ffff:7f00:1]/',
    // Obfuscated IPv4
    'http://2130706433/',          // 127.0.0.1
    'http://0x7f000001/',          // 127.0.0.1 hex
    'http://0177.0.0.1/',          // octal 127
    'http://127.1/',               // class-A form 127.0.0.1
    'http://0177.0.0.01/',         // leading-zero decimal
    // 100.64.0.0/10 CGNAT
    'http://100.64.0.1/',
    'http://100.127.255.254/',
    // Reserved / documentation / multicast
    'http://192.0.2.1/',
    'http://198.51.100.1/',
    'http://203.0.113.1/',
    'http://224.0.0.1/',
    // Credentials in URL
    'http://user:pass@127.0.0.1/',
    'http://user:pass@example.com/',
    // Non-http scheme
    'file:///etc/passwd',
    'ftp://127.0.0.1/',
    // IPv6 link-local / unique-local
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456:789a::1]/',
    'http://[::]/',
    'http://[2001:db8::1]/',
  ];

  for (const url of mustReject) {
    let err = null;
    try {
      err = await assertSafeTargetHost(url);
    } catch (e) {
      err = 'threw: ' + e.message;
    }
    ok(`REJECT ${url} (err: ${err})`, err !== null);
  }

  console.log('\n=== MUST ALLOW (legitimate public AnimeHeaven targets) ===');
  // These are the real hosts the AnimeHeaven provider uses. Even resolving
  // hostnames to public IPs should be allowed. NOTE: DNS resolution must
  // succeed for the allow path; if the environment is offline these will
  // report as "could not be resolved" (a fail), but the guard logic itself
  // only rejects non-public addresses.
  const mustAllow = [
    'https://animeheaven.me/',
    'https://animeheaven.ru/',
'https://www.animeheaven.me/',
    // Known mirror/CDN domains referenced by the provider
    'https://vidstream.pro/',
    'https://filemoon.sx/',
    'https://mp4upload.com/',
    'https://dood.co/',
    'https://streamwish.to/',
    'https://mixdrop.co/',
  ];

  for (const url of mustAllow) {
    let err = null;
    try {
      err = await assertSafeTargetHost(url);
    } catch (e) {
      err = 'threw: ' + e.message;
    }
    ok(`ALLOW ${url} (err: ${err})`, err === null);
  }

  console.log('\n=== isForbiddenIp direct checks ===');
  ok('isForbiddenIp(127.0.0.1)', isForbiddenIp('127.0.0.1') === true);
  ok('isForbiddenIp(::1)', isForbiddenIp('::1') === true);
  ok('isForbiddenIp(169.254.169.254)', isForbiddenIp('169.254.169.254') === true);
  ok('isForbiddenIp(8.8.8.8)', isForbiddenIp('8.8.8.8') === false);
  ok('isForbiddenIp(192.168.0.1)', isForbiddenIp('192.168.0.1') === true);
  ok('isForbiddenIp(10.0.0.1)', isForbiddenIp('10.0.0.1') === true);
  ok('isForbiddenIp(172.16.0.1)', isForbiddenIp('172.16.0.1') === true);
  ok('isForbiddenIp(172.32.0.1)', isForbiddenIp('172.32.0.1') === false);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

