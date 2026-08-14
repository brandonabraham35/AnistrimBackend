// test/googleIdentityService.test.js
// Item 16: Google is authentication, not registration.
//
// Asserts that BOTH the web GIS flow (resolveGoogleIdentity(idToken, 'login'))
// and the native Capacitor flow (resolveGoogleIdentity(profile, 'login'))
// return GOOGLE_NO_ACCOUNT for an unknown email — the identical intent rule.
const assert = require('assert');
const Module = require('module');

// Mock the googleUpsert module so we don't need a real Google token or DB.
const mockGoogleUpsert = {
  verifyGoogleIdToken: async (idToken) => {
    // Simulate a verified Google ID token payload.
    return {
      sub: 'google-sub-123',
      email: 'unknown@example.com',
      email_verified: true,
      name: 'Unknown User',
      picture: 'https://example.com/avatar.png',
    };
  },
  findGoogleUser: async () => null,          // no google_id match
  findUserByEmail: async () => null,         // no email match → unknown account
  createGoogleUser: async (profile) => ({ id: 999, ...profile }),
  authenticateExistingGoogleUser: async (user) => user,
};

// Clear any cached copies so the patched require is used.
delete require.cache[require.resolve('../services/googleIdentityService')];
delete require.cache[require.resolve('../services/googleUpsert')];

// Patch require BEFORE loading googleIdentityService so it picks up the mocks.
const originalRequire = Module.prototype.require;
Module.prototype.require = function (request) {
  if (request === './googleUpsert') return mockGoogleUpsert;
  return originalRequire.apply(this, arguments);
};

// Load the module fresh with the patched require.
const { resolveGoogleIdentity } = require('../services/googleIdentityService');

// Restore the original require.
Module.prototype.require = originalRequire;

async function run() {
  console.log('Running googleIdentityService tests...');

  // ── Test 1: Web GIS flow (idToken string) → GOOGLE_NO_ACCOUNT ──
  try {
    await resolveGoogleIdentity('fake-google-id-token', 'login');
    assert.fail('Expected GOOGLE_NO_ACCOUNT error for web GIS flow');
  } catch (err) {
    assert.strictEqual(err.code, 'GOOGLE_NO_ACCOUNT', 'Web GIS flow should return GOOGLE_NO_ACCOUNT');
    assert.strictEqual(err.status, 404, 'Web GIS flow should return 404');
    console.log('  ✓ Web GIS flow returns GOOGLE_NO_ACCOUNT for unknown email');
  }

  // ── Test 2: Native Capacitor flow (profile object) → GOOGLE_NO_ACCOUNT ──
  try {
    await resolveGoogleIdentity({
      sub: 'google-sub-123',
      email: 'unknown@example.com',
      email_verified: true,
      name: 'Unknown User',
      picture: 'https://example.com/avatar.png',
    }, 'login');
    assert.fail('Expected GOOGLE_NO_ACCOUNT error for native Capacitor flow');
  } catch (err) {
    assert.strictEqual(err.code, 'GOOGLE_NO_ACCOUNT', 'Native Capacitor flow should return GOOGLE_NO_ACCOUNT');
    assert.strictEqual(err.status, 404, 'Native Capacitor flow should return 404');
    console.log('  ✓ Native Capacitor flow returns GOOGLE_NO_ACCOUNT for unknown email');
  }

  // ── Test 3: Signup intent for unknown email → creates account ──
  const result = await resolveGoogleIdentity('fake-google-id-token', 'signup');
  assert.ok(result.user, 'Signup should create a user');
  assert.strictEqual(result.user.id, 999, 'Signup should return the created user');
  console.log('  ✓ Signup intent creates a new account for unknown email');

  console.log('\nAll googleIdentityService tests passed.');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});