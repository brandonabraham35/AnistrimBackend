// =============================================================
//  test/ssrfGuard.test.js
//
//  Regression tests for utils/ssrfGuard.js — in particular the
//  leading-zero/octal IPv4 SSRF bypass fix.
//
//  Uses Node's built-in test runner (node:test) — no external deps.
//  Run:  node --test test/ssrfGuard.test.js
//
//  Coverage:
//    • isForbiddenIp — loopback, private, link-local, CGNAT, unspecified,
//      IPv6, IPv4-mapped IPv6 (dotted + hex hextet), and critically the
//      obfuscated IPv4 forms (leading-zero/octal, hex, decimal).
//    • assertSafeTargetHost — end-to-end URL-level rejection/allowance for
//      literal IPs (no DNS needed), scheme/credential checks.
// =============================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isForbiddenIp,
  isForbiddenIpv4Int,
  normalizeObfuscatedIpv4,
  assertSafeTargetHost,
} = require('../utils/ssrfGuard');

// ═══════════════════════════════════════════════════════════
//  normalizeObfuscatedIpv4
// ═══════════════════════════════════════════════════════════
test('normalizeObfuscatedIpv4 canonicalizes octal/hex/decimal forms', () => {
  assert.equal(normalizeObfuscatedIpv4('0177.0.0.1'), '127.0.0.1');
  assert.equal(normalizeObfuscatedIpv4('0177.1'), '127.0.0.1');
  assert.equal(normalizeObfuscatedIpv4('017700000001'), '127.0.0.1');
  assert.equal(normalizeObfuscatedIpv4('0x7f000001'), '127.0.0.1');
  assert.equal(normalizeObfuscatedIpv4('2130706433'), '127.0.0.1');
  assert.equal(normalizeObfuscatedIpv4('127.1'), '127.0.0.1');
  assert.equal(normalizeObfuscatedIpv4('012.0.0.1'), '10.0.0.1');
// octal: 0251=169, 0376=254, 0251=169, 0252=170 → 169.254.169.170 (link-local)
  assert.equal(normalizeObfuscatedIpv4('0251.0376.0251.0252'), '169.254.169.170');
});

test('normalizeObfuscatedIpv4 rejects malformed inputs', () => {
  assert.equal(normalizeObfuscatedIpv4('999.999.999.999'), null);
  assert.equal(normalizeObfuscatedIpv4('127.0.0.999'), null);
  assert.equal(normalizeObfuscatedIpv4('127..0.1'), null);
  assert.equal(normalizeObfuscatedIpv4('1.2.3.4.5'), null);
  assert.equal(normalizeObfuscatedIpv4('not-an-ip'), null);
  assert.equal(normalizeObfuscatedIpv4(''), null);
});

// Old-style class-A/B/C forms have fewer parts but are still valid IPv4
// literals — they must normalize to a real dotted-quad and be classified by
// isForbiddenIp (e.g. "127.0.0" → 127.0.0.0, still loopback → rejected).
test('isForbiddenIp rejects shortened class-A/B/C loopback forms', () => {
  assert.equal(normalizeObfuscatedIpv4('127.0.0'), '127.0.0.0');
  assert.equal(isForbiddenIp('127.0.0'), true);
  assert.equal(isForbiddenIp('127.0'), true);
  assert.equal(isForbiddenIp('127'), true);
});

// ═══════════════════════════════════════════════════════════
//  isForbiddenIpv4Int
// ═══════════════════════════════════════════════════════════
test('isForbiddenIpv4Int classifies ranges correctly', () => {
  assert.equal(isForbiddenIpv4Int(0x7F000001), true);  // 127.0.0.1
  assert.equal(isForbiddenIpv4Int(0x0A000001), true);  // 10.0.0.1
  assert.equal(isForbiddenIpv4Int(0xAC100001), true);  // 172.16.0.1
  assert.equal(isForbiddenIpv4Int(0xC0A80101), true);  // 192.168.1.1
  assert.equal(isForbiddenIpv4Int(0xA9FEA9FE), true);  // 169.254.169.254
  assert.equal(isForbiddenIpv4Int(0x64400001), true);  // 100.64.0.1
  assert.equal(isForbiddenIpv4Int(0x08080808), false); // 8.8.8.8
});

// ═══════════════════════════════════════════════════════════
//  isForbiddenIp — LOOPBACK (incl. obfuscated forms)
// ═══════════════════════════════════════════════════════════
test('isForbiddenIp rejects loopback in all supported forms', () => {
  const loopbacks = [
    '127.0.0.1',
    '0177.0.0.1',   // octal 127
    '0177.1',       // octal class-A form
    '017700000001', // octal 32-bit
    '0x7f000001',   // hex 32-bit
    '2130706433',   // decimal 32-bit
    '127.1',        // class-A form
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ];
  for (const ip of loopbacks) {
    assert.equal(isForbiddenIp(ip), true, `expected ${ip} to be forbidden`);
  }
});

// ═══════════════════════════════════════════════════════════
//  isForbiddenIp — PRIVATE / LINK-LOCAL / CGNAT
// ═══════════════════════════════════════════════════════════
test('isForbiddenIp rejects private/link-local/CGNAT incl. obfuscated', () => {
  const forbidden = [
    '10.0.0.1',
    '012.0.0.1',       // octal 10
    '0x0a000001',      // hex 10.0.0.1
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0251.0376.0251.0252', // octal 169.254.169.254
    '100.64.0.1',
  ];
  for (const ip of forbidden) {
    assert.equal(isForbiddenIp(ip), true, `expected ${ip} to be forbidden`);
  }
});

// ═══════════════════════════════════════════════════════════
//  isForbiddenIp — PUBLIC ALLOWANCE
// ═══════════════════════════════════════════════════════════
test('isForbiddenIp allows public addresses', () => {
  const publicIps = ['8.8.8.8', '1.1.1.1', '93.184.216.34'];
  for (const ip of publicIps) {
    assert.equal(isForbiddenIp(ip), false, `expected ${ip} to be allowed`);
  }
});

// ═══════════════════════════════════════════════════════════
//  isForbiddenIp — malformed/invalid inputs
// ═══════════════════════════════════════════════════════════
test('isForbiddenIp safely rejects malformed addresses', () => {
  const malformed = [
    '999.999.999.999',
    '127.0.0.999',
    '127.0.0',
    '127..0.1',
    '1.2.3.4.5',
    'not-an-ip',
  ];
  for (const ip of malformed) {
    assert.equal(isForbiddenIp(ip), true, `expected ${ip} to be rejected`);
  }
});

// ═══════════════════════════════════════════════════════════
//  assertSafeTargetHost — end-to-end URL level (literal IPs,
//  no DNS required)
// ═══════════════════════════════════════════════════════════
test('assertSafeTargetHost rejects loopback obfuscations in URLs', async () => {
  const reject = [
    'http://127.0.0.1/',
    'http://0177.0.0.1/',
    'http://0177.1/',
    'http://017700000001/',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
  ];
  for (const url of reject) {
    const err = await assertSafeTargetHost(url);
    assert.notEqual(err, null, `expected ${url} to be rejected`);
  }
});

test('assertSafeTargetHost rejects private/link-local obfuscations in URLs', async () => {
  const reject = [
    'http://10.0.0.1/',
    'http://012.0.0.1/',
    'http://0x0a000001/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/',
    'http://0251.0376.0251.0252/',
  ];
  for (const url of reject) {
    const err = await assertSafeTargetHost(url);
    assert.notEqual(err, null, `expected ${url} to be rejected`);
  }
});

test('assertSafeTargetHost allows public literal IPs', async () => {
  const allow = ['http://8.8.8.8/', 'http://1.1.1.1/', 'http://93.184.216.34/'];
  for (const url of allow) {
    const err = await assertSafeTargetHost(url);
    assert.equal(err, null, `expected ${url} to be allowed (got: ${err})`);
  }
});

test('assertSafeTargetHost rejects file/ftp schemes and credentials', async () => {
  assert.notEqual(await assertSafeTargetHost('file:///etc/passwd'), null);
  assert.notEqual(await assertSafeTargetHost('ftp://127.0.0.1/'), null);
  assert.notEqual(await assertSafeTargetHost('http://user:pass@1.1.1.1/'), null);
  assert.notEqual(await assertSafeTargetHost('http://user:pass@example.com/'), null);
});
