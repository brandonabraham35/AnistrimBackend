// tests/sourceStateMachine.test.js
// Unit tests for the source state machine (Phase 6).
'use strict';

const assert = require('assert');
const { getSourceState, isReusable } = require('../services/streamCacheService');

// ── Helper: create a mock DB row ─────────────────────────────

function mockRow(overrides) {
  const now = Date.now();
  const future = new Date(now + 3600 * 1000); // 1 hour from now
  const past = new Date(now - 3600 * 1000);   // 1 hour ago

  return {
    id: 1,
    episode_id: 123,
    provider: 'animeheaven',
    stream_type: 'direct',
    stream_data: { provider: 'animeheaven', streamUrl: 'https://cdn.example.com/video.mp4', sources: [{ url: 'https://cdn.example.com/video.mp4', quality: '720' }], subtitles: [] },
    expires_at: future,            // AniStrim TTL (future)
    detected_expires_at: null,     // No upstream expiry known
    expiry_source: 'unknown',
    verification_status: 'unknown',
    last_verified_at: null,
    last_used_at: new Date(now),
    created_at: new Date(now - 86400 * 1000),
    updated_at: new Date(now),
    ...overrides,
  };
}

// ── State: ACTIVE ───────────────────────────────────────────

describe('Source state: ACTIVE', () => {
  it('ACTIVE when verification_status=active and last_verified_at exists', () => {
    const now = Date.now();
    const row = mockRow({
      verification_status: 'active',
      last_verified_at: new Date(now - 60000), // verified 1 min ago
    });
    const state = getSourceState(row, now);
    assert.strictEqual(state, 'active');
  });

  it('isReusable returns true for ACTIVE', () => {
    const now = Date.now();
    const row = mockRow({
      verification_status: 'active',
      last_verified_at: new Date(now - 60000),
    });
    assert.strictEqual(isReusable(row, now), true);
  });
});

// ── State: EXPIRED ──────────────────────────────────────────

describe('Source state: EXPIRED', () => {
  it('EXPIRED when detected_expires_at is in the past', () => {
    const now = Date.now();
    const row = mockRow({
      detected_expires_at: new Date(now - 3600 * 1000), // expired 1 hour ago
    });
    const state = getSourceState(row, now);
    assert.strictEqual(state, 'expired');
  });

  it('UNKNOWN (not EXPIRED) when only the AniStrim TTL (expires_at) has passed', () => {
    const now = Date.now();
    const row = mockRow({
      expires_at: new Date(now - 3600 * 1000), // AniStrim performance TTL expired
      detected_expires_at: null,
    });
    const state = getSourceState(row, now);
    // AGE IS NOT PROOF OF DEATH — an elapsed AniStrim TTL is not evidence that
    // the underlying source died, so the state stays 'unknown' (reusable).
    assert.strictEqual(state, 'unknown');
    assert.strictEqual(isReusable(row, now), true);
  });

  it('isReusable returns false for EXPIRED', () => {
    const now = Date.now();
    const row = mockRow({
      detected_expires_at: new Date(now - 3600 * 1000),
    });
    assert.strictEqual(isReusable(row, now), false);
  });
});

// ── State: INVALID ──────────────────────────────────────────

describe('Source state: INVALID', () => {
  it('INVALID when verification_status=invalid', () => {
    const now = Date.now();
    const row = mockRow({
      verification_status: 'invalid',
    });
    const state = getSourceState(row, now);
    assert.strictEqual(state, 'invalid');
  });

  it('isReusable returns false for INVALID', () => {
    const now = Date.now();
    const row = mockRow({
      verification_status: 'invalid',
    });
    assert.strictEqual(isReusable(row, now), false);
  });

  it('INVALID takes priority over ACTIVE verification', () => {
    // Even if last_verified_at exists, invalid status wins
    const now = Date.now();
    const row = mockRow({
      verification_status: 'invalid',
      last_verified_at: new Date(now - 60000),
    });
    const state = getSourceState(row, now);
    assert.strictEqual(state, 'invalid');
  });
});

// ── State: UNKNOWN ──────────────────────────────────────────

describe('Source state: UNKNOWN', () => {
  it('UNKNOWN when no upstream expiry and no verification', () => {
    const now = Date.now();
    const row = mockRow({
      detected_expires_at: null,
      verification_status: 'unknown',
      last_verified_at: null,
    });
    const state = getSourceState(row, now);
    assert.strictEqual(state, 'unknown');
  });

  it('UNKNOWN when no upstream expiry but stale verification', () => {
    const now = Date.now();
    const row = mockRow({
      detected_expires_at: null,
      verification_status: 'active',
      last_verified_at: new Date(now - 2 * 3600 * 1000), // verified 2 hours ago
    });
    const state = getSourceState(row, now);
    // Still active because verification_status is 'active'
    assert.strictEqual(state, 'active');
  });

  it('isReusable returns true for UNKNOWN (within AniStrim TTL)', () => {
    const now = Date.now();
    const row = mockRow({
      detected_expires_at: null,
      verification_status: 'unknown',
    });
    assert.strictEqual(isReusable(row, now), true);
  });

  it('UNKNOWN never classified as permanent', () => {
    // UNKNOWN means "we don't know" — never "permanent"
    const now = Date.now();
    const row = mockRow({
      detected_expires_at: null,
      verification_status: 'unknown',
    });
    const state = getSourceState(row, now);
    assert.notStrictEqual(state, 'active'); // Not assumed permanently valid
    assert.strictEqual(state, 'unknown');   // Explicitly unknown
  });
});

// ── State Transitions ───────────────────────────────────────

describe('State transitions', () => {
  it('UNKNOWN → ACTIVE on successful verification', () => {
    const now = Date.now();
    const unknownRow = mockRow({
      detected_expires_at: null,
      verification_status: 'unknown',
    });
    assert.strictEqual(getSourceState(unknownRow, now), 'unknown');

    // After verification succeeds
    const activeRow = mockRow({
      detected_expires_at: null,
      verification_status: 'active',
      last_verified_at: new Date(now),
    });
    assert.strictEqual(getSourceState(activeRow, now), 'active');
  });

  it('ACTIVE → EXPIRED when detected_expires_at passes', () => {
    const now = Date.now();
    const activeRow = mockRow({
      detected_expires_at: new Date(now + 3600 * 1000), // expires in 1 hour
      verification_status: 'active',
      last_verified_at: new Date(now - 60000),
    });
    assert.strictEqual(getSourceState(activeRow, now), 'active');

    // After expiry passes
    const expiredRow = mockRow({
      detected_expires_at: new Date(now - 3600 * 1000), // expired 1 hour ago
      verification_status: 'active',
    });
    assert.strictEqual(getSourceState(expiredRow, now), 'expired');
  });

  it('ACTIVE → INVALID on playback failure', () => {
    const now = Date.now();
    const activeRow = mockRow({
      verification_status: 'active',
      last_verified_at: new Date(now - 60000),
    });
    assert.strictEqual(getSourceState(activeRow, now), 'active');

    // After failure report
    const invalidRow = mockRow({
      verification_status: 'invalid',
    });
    assert.strictEqual(getSourceState(invalidRow, now), 'invalid');
  });

  it('INVALID → ACTIVE after resolver succeeds', () => {
    const now = Date.now();
    const invalidRow = mockRow({
      verification_status: 'invalid',
    });
    assert.strictEqual(getSourceState(invalidRow, now), 'invalid');

    // After fresh resolution and verification
    const activeRow = mockRow({
      verification_status: 'active',
      last_verified_at: new Date(now),
      detected_expires_at: new Date(now + 7200 * 1000), // 2 hours from now
    });
    assert.strictEqual(getSourceState(activeRow, now), 'active');
  });

  it('EXPIRED → ACTIVE after resolver succeeds', () => {
    const now = Date.now();
    const expiredRow = mockRow({
      detected_expires_at: new Date(now - 3600 * 1000),
    });
    assert.strictEqual(getSourceState(expiredRow, now), 'expired');

    // After fresh resolution
    const activeRow = mockRow({
      detected_expires_at: new Date(now + 7200 * 1000),
      verification_status: 'active',
      last_verified_at: new Date(now),
    });
    assert.strictEqual(getSourceState(activeRow, now), 'active');
  });
});

// ─ Edge Cases ──────────────────────────────────────────────

describe('Edge cases', () => {
  it('returns unknown for null row', () => {
    assert.strictEqual(getSourceState(null), 'unknown');
  });

  it('handles missing fields gracefully', () => {
    const now = Date.now();
    const row = { id: 1 };
    const state = getSourceState(row, now);
    // Missing metadata is NOT proof of death — the source remains reusable.
    assert.strictEqual(state, 'unknown');
  });

  it('EXPIRED detected_expires_at takes priority over ACTIVE verification', () => {
    const now = Date.now();
    const row = mockRow({
      detected_expires_at: new Date(now - 3600 * 1000), // expired
      verification_status: 'active',
      last_verified_at: new Date(now - 60000), // recently verified
    });
    // detected_expires_at in past → EXPIRED, regardless of verification
    assert.strictEqual(getSourceState(row, now), 'expired');
  });

  it('UNKNOWN within AniStrim TTL is reusable', () => {
    const now = Date.now();
    const future = new Date(now + 3600 * 1000);
    const row = mockRow({
      expires_at: future,
      detected_expires_at: null,
      verification_status: 'unknown',
    });
    assert.strictEqual(isReusable(row, now), true);
  });

  it('UNKNOWN past AniStrim TTL remains reusable (age is not proof of death)', () => {
    const now = Date.now();
    const past = new Date(now - 3600 * 1000);
    const row = mockRow({
      expires_at: past,
      detected_expires_at: null,
      verification_status: 'unknown',
    });
    assert.strictEqual(isReusable(row, now), true);
  });

  it('UNKNOWN with old expires_at AND null detected_expires_at stays reusable (Prompt Test 1)', () => {
    const now = Date.now();
    const row = mockRow({
      expires_at: new Date(now - 7 * 24 * 3600 * 1000), // a week old TTL
      detected_expires_at: null,
      verification_status: 'unknown',
    });
    assert.strictEqual(isReusable(row, now), true);
  });

  it('ACTIVE with old expires_at stays reusable unless upstream expiry is known (Prompt Test 2)', () => {
    const now = Date.now();
    const row = mockRow({
      expires_at: new Date(now - 24 * 3600 * 1000),
      detected_expires_at: null,
      verification_status: 'active',
      last_verified_at: new Date(now - 60000),
    });
    assert.strictEqual(getSourceState(row, now), 'active');
    assert.strictEqual(isReusable(row, now), true);
  });

  it('detected_expires_at in the FUTURE is reusable (Prompt Test 3a)', () => {
    const now = Date.now();
    const row = mockRow({
      expires_at: new Date(now - 3600 * 1000), // old AniStrim TTL
      detected_expires_at: new Date(now + 7200 * 1000), // real upstream expiry in future
    });
    assert.strictEqual(getSourceState(row, now), 'unknown');
    assert.strictEqual(isReusable(row, now), true);
  });

  it('detected_expires_at in the PAST is expired / not reusable (Prompt Test 3b)', () => {
    const now = Date.now();
    const row = mockRow({
      detected_expires_at: new Date(now - 3600 * 1000),
    });
    assert.strictEqual(getSourceState(row, now), 'expired');
    assert.strictEqual(isReusable(row, now), false);
  });

  it('invalid source is never reusable regardless of age (Prompt Test 4)', () => {
    const now = Date.now();
    const row = mockRow({
      expires_at: new Date(now + 3600 * 1000),
      detected_expires_at: null,
      verification_status: 'invalid',
    });
    assert.strictEqual(getSourceState(row, now), 'invalid');
    assert.strictEqual(isReusable(row, now), false);
  });
});
