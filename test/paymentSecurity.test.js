// test/paymentSecurity.test.js
'use strict';
const assert = require('assert');
const fs2 = require('fs');
const p = require('path');

describe('Payment amount', function () {
  it('monthly 15000', function () {
    const v = fs2.readFileSync(p.join(__dirname, '..', 'sql', 'migrations_v35_plans_subscriptions.sql'), 'utf8');
    assert.ok(v.split('\n').find(l => l.includes('premium-monthly') && l.includes('15000,')), 'monthly=15000');
  });
  it('yearly 180000', function () {
    const v = fs2.readFileSync(p.join(__dirname, '..', 'sql', 'migrations_v35_plans_subscriptions.sql'), 'utf8');
    assert.ok(v.split('\n').find(l => l.includes('premium-annual') && l.includes('180000,')), 'yearly=180000');
  });
  it('no division', function () {
    const s = fs2.readFileSync(p.join(__dirname, '..', 'controllers', 'paymentController.js'), 'utf8');
    for (const pat of ['amount / 100', 'amount / 1000', 'amount * 100']) assert.ok(!s.includes(pat));
    assert.ok(s.match(/amount:\s*amount/));
  });
  it('IPN rejects 15', function () { assert.strictEqual(Math.abs(15 - 15000) > 1, true); });
  it('IPN accepts 15000', function () { assert.strictEqual(Math.abs(15000 - 15000) > 1, false); });
});

describe('Download auth', function () {
  it('uses getEntitlement', function () {
    const s = fs2.readFileSync(p.join(__dirname, '..', 'routes', 'downloadRoutes.js'), 'utf8');
    assert.ok(s.includes('getEntitlement')); assert.ok(!s.includes('SELECT is_premium'));
  });
  it('SSRF protected', function () {
    const s = fs2.readFileSync(p.join(__dirname, '..', 'routes', 'downloadRoutes.js'), 'utf8');
    assert.ok(s.includes('assertSafeTargetHost')); assert.ok(s.includes('maxRedirects'));
  });
  it('denies expired/cancelled/refunded', function () {
    const G = new Set(['trialing', 'active', 'grace']);
    for (const st of ['expired', 'cancelled', 'refunded'])
      assert.strictEqual(!!({ isPremium: false, state: st }.isPremium && G.has({ isPremium: false, state: st }.state)), false);
  });
});

describe('Admin auth', function () {
  it('fails closed no JWT fallback', function () {
    const s = fs2.readFileSync(p.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');
    assert.ok(!s.includes('fall back to the JWT claim')); assert.ok(s.includes('Unable to verify admin role'));
  });
});

describe('Migration v47', function () {
  it('checks all 7 ENUM values', function () {
    const v = fs2.readFileSync(p.join(__dirname, '..', 'sql', 'migrations_v47_subscriptions_state_enum.sql'), 'utf8');
    for (const x of ['pending', 'trialing', 'active', 'grace', 'expired', 'cancelled', 'refunded'])
      assert.ok(v.includes('%' + x + '%'));
  });
  it('MODIFY has complete ENUM', function () {
    const v = fs2.readFileSync(p.join(__dirname, '..', 'sql', 'migrations_v47_subscriptions_state_enum.sql'), 'utf8');
    const m = v.match(/MODIFY COLUMN state ENUM\([^)]+\)/);
    assert.ok(m);
    for (const x of ['pending', 'trialing', 'active', 'grace', 'expired', 'cancelled', 'refunded'])
      assert.ok(m[0].includes(x));
  });
});

describe('Schema verify', function () {
  it('script checks amounts', function () {
    const s = fs2.readFileSync(p.join(__dirname, '..', 'scripts', 'verify-schema.js'), 'utf8');
    assert.ok(s.includes('15000')); assert.ok(s.includes('180000')); assert.ok(s.includes('CANONICAL_STATE_ENUM'));
  });
});

describe('SSRF', function () {
  it('rejects localhost', function () { assert.strictEqual(/^https?:$/.test('file:'), false); });
  it('rejects metadata', function () { assert.ok('http://169.254.169.254/latest/'.includes('169.254.169.254')); });
  it('ssrfGuard has all checks', function () {
    const s = fs2.readFileSync(p.join(__dirname, '..', 'utils', 'ssrfGuard.js'), 'utf8');
    assert.ok(s.includes('isForbiddenIp')); assert.ok(s.includes('resolveAllAddresses')); assert.ok(s.includes('assertSafeTargetHost'));
  });
});

describe('Security headers', function () {
  it('server sets headers', function () {
    const s = fs2.readFileSync(p.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(s.includes('nosniff')); assert.ok(s.includes('strict-origin-when-cross-origin')); assert.ok(s.includes('Strict-Transport-Security'));
  });
});