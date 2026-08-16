// test/episodeAccess.test.js — Phase 7.2 access matrix.
//
// Encodes the required access matrix for canWatch:
//   Free user     |  Free anime      ✅
//   Free user     |  Premium anime   ❌
//   Free user     |  Free ep of premium anime  ✅
//   Free user     |  Premium ep (window open)  ❌
//   Free user     |  Premium ep (window expired)  ✅
//   Premium user  |  all of the above  ✅
const assert = require('assert');
const Module = require('module');

// Stub pool to drive loadTiers deterministically.
const now = Date.now();
const TIER_ROWS = {
  1: { id: 1, e_tier: 'inherit', e_until: null, a_tier: 'free' },                    // free anime
  2: { id: 2, e_tier: 'inherit', e_until: null, a_tier: 'premium' },                 // premium anime
  3: { id: 3, e_tier: 'free', e_until: null, a_tier: 'premium' },                    // free ep of premium anime
  4: { id: 4, e_tier: 'premium', e_until: new Date(now + 7 * 86400000).toISOString(), a_tier: 'free' }, // premium ep, window open
  5: { id: 5, e_tier: 'premium', e_until: new Date(now - 86400000).toISOString(), a_tier: 'free' }, // premium ep, window expired
};

const mockPool = {
  query: async (sql, params) => {
    if (sql.includes('FROM episodes e')) {
      // params[0] is the id AS an array (loadTiers passes [ids]).
      const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
      const rows = ids.map(id => TIER_ROWS[id]).filter(Boolean);
      return [rows];
    }
    return [[], {}];
  },
};

// Patch require so episodeAccess uses our mock pool.
const originalRequire = Module.prototype.require;
Module.prototype.require = function (request) {
  if (request === '../config/db' || request === './config/db') return mockPool;
  return originalRequire.apply(this, arguments);
};
delete require.cache[require.resolve('../utils/episodeAccess')];

const { canWatchWithEntitlement: canWatch } = require('../utils/episodeAccess');
Module.prototype.require = originalRequire;

const FREE = { isPremium: false, tier: null, state: null, source: null };
const PREMIUM = { isPremium: true, tier: 'premium', state: 'active', source: 'payment' };

async function run() {
  console.log('Running episodeAccess access-matrix tests...');

  // 1. Free anime (ep 1) → Free user ✅, Premium ✅
  let r = await canWatch(FREE, 1);
  assert.strictEqual(r.allow, true, 'Free user should watch free anime');
  r = await canWatch(PREMIUM, 1);
  assert.strictEqual(r.allow, true, 'Premium user should watch free anime');
  console.log('  ✓ Free anime: Free ✅ / Premium ✅');

  // 2. Premium anime (ep 2) → Free ❌, Premium ✅
  r = await canWatch(FREE, 2);
  assert.strictEqual(r.allow, false, 'Free user should NOT watch premium anime');
  assert.strictEqual(r.reason, 'PREMIUM_REQUIRED', 'Denial reason is PREMIUM_REQUIRED');
  r = await canWatch(PREMIUM, 2);
  assert.strictEqual(r.allow, true, 'Premium user should watch premium anime');
  console.log('  ✓ Premium anime: Free ❌ / Premium ✅');

  // 3. Free episode of premium anime (ep 3) → Free ✅, Premium ✅
  r = await canWatch(FREE, 3);
  assert.strictEqual(r.allow, true, 'Free episode of premium anime should be free');
  r = await canWatch(PREMIUM, 3);
  assert.strictEqual(r.allow, true, 'Premium user should watch');
  console.log('  ✓ Free ep of premium anime: Free ✅ / Premium ✅');

  // 4. Premium episode, window open (ep 4) → Free ❌, Premium ✅
  r = await canWatch(FREE, 4);
  assert.strictEqual(r.allow, false, 'Free user should NOT watch premium ep (window open)');
  assert.ok(r.availableAt, 'availableAt set for future window (Free on date)');
  r = await canWatch(PREMIUM, 4);
  assert.strictEqual(r.allow, true, 'Premium user should watch premium ep (window open)');
  console.log('  ✓ Premium ep (window open): Free ❌ / Premium ✅');

  // 5. Premium episode, window expired (ep 5) → Free ✅, Premium ✅
  r = await canWatch(FREE, 5);
  assert.strictEqual(r.allow, true, 'Expired premium window → free for all');
  r = await canWatch(PREMIUM, 5);
  assert.strictEqual(r.allow, true, 'Premium user should watch');
  console.log('  ✓ Premium ep (window expired): Free ✅ / Premium ✅');

  console.log('\nAll episodeAccess access-matrix tests passed.');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});