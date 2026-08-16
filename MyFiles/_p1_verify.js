// =============================================================
//  _p1_verify.js — Verification for P1 Security Hardening
//  Tests the SSRF guard (P1-2) + cache tier isolation helpers (P1-1).
// =============================================================
'use strict';

const guard = require('./utils/ssrfGuard');
const { isForbiddenIp, assertSafeTargetHost } = guard;

// ── 1. SSRF literal IP rejection tests ─────────────────────
const mustReject = [
  'http://127.0.0.1/',
  'http://localhost/',
  'http://[::1]/',
  'http://0.0.0.0/',
  'http://10.0.0.1/',
  'http://172.16.0.1/',
  'http://192.168.1.1/',
  'http://169.254.169.254/',
  'http://192.168.1.1:8080/x',
  'http://2130706433/',            // 127.0.0.1 as decimal
  'http://0x7f000001/',            // 127.0.0.1 as hex
  'http://0177.0.0.1/',            // 127.0.0.1 with octal
  'http://[::ffff:127.0.0.1]/',    // IPv4-mapped loopback
  'http://[fc00::1]/',             // unique-local IPv6
  'http://[fe80::1]/',             // link-local IPv6
  'http://user:pass@127.0.0.1/',   // embedded credentials
  'http://localhost:3000/admin',
];

// ── 2. Private-IP guard unit tests (isForbiddenIp) ─────────
const privateIps = [
  '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255',
  '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '::',
  '::ffff:10.0.0.1', 'fe80::1', 'fc00::1', '100.64.0.1',
  '224.0.0.1', '240.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1',
];
const publicIps = [
  '8.8.8.8', '1.1.1.1', '104.16.132.229', '93.184.216.34',
  '172.217.14.206', '::ffff:8.8.8.8',
];

(async () => {
  let pass = 0;
  let fail = 0;
  const report = (name, ok, detail) => {
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name} ${detail ? '— ' + detail : ''}`); }
  };

  console.log('\n=== SSRF literal-IP rejection (assertSafeTargetHost) ===');
  for (const url of mustReject) {
    const err = await assertSafeTargetHost(url);
    report(`reject ${url}`, !!err, err || '(allowed!)');
  }

  console.log('\n=== isForbiddenIp unit tests ===');
  for (const ip of privateIps) {
    report(`private ${ip}`, isForbiddenIp(ip) === true, `got ${isForbiddenIp(ip)}`);
  }
  for (const ip of publicIps) {
    report(`public ${ip}`, isForbiddenIp(ip) === false, `got ${isForbiddenIp(ip)}`);
  }

  console.log('\n=== Legitimate AnimeHeaven host (public DNS) ===');
  const legit = await assertSafeTargetHost('https://animeheaven.me/');
  report('animeheaven.me allowed (public)', legit === null, legit || '(rejected!)');

  console.log('\n=== Embedded credentials / scheme guards ===');
  report('reject ftp scheme', !!(await assertSafeTargetHost('ftp://8.8.8.8/')), 'allowed');
  report('reject creds', !!(await assertSafeTargetHost('http://a:b@8.8.8.8/')), 'allowed');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
