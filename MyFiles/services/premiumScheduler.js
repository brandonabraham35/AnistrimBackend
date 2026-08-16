// services/premiumScheduler.js — Phase 7.3 (Item 8) premium release scheduler.
//
// Runs on node-cron every 10 minutes:
//   1. Expire premium timed-release episodes → free.
//   2. Subscription state sweep (active → grace → expired) + refresh the
//      users.is_premium derived cache column (never used for authorization).
//   3. Log transitions to admin_logs / payment_events.
//
// The read path (utils/episodeAccess via canWatch) is correct even if cron
// misses a run — an expired premium_until is treated as free there. This job is
// a convenience that keeps the derived cache + state machine tidy.
const db = require('../config/db');
const cron = require('node-cron');

const GRACE_DAYS = 3;
const DEFAULT_PREMIUM_DAYS = 7;

async function expireTimedEpisodes() {
  const [result] = await db.query(
    `UPDATE episodes
     SET access_tier = 'free', premium_until = NULL
     WHERE access_tier = 'premium' AND premium_until IS NOT NULL AND premium_until <= NOW()`
  );
  if (result.affectedRows > 0) {
    console.log(`[PremiumScheduler] Expired ${result.affectedRows} timed-release episodes to free.`);
    // Log as system action.
    try {
      await db.query(
        `INSERT INTO admin_logs (admin_id, action, entity_type, entity_id, detail)
         VALUES (NULL, 'premium.expire_episodes', 'episode', NULL, ?)`,
        [`${result.affectedRows} episodes moved to free by scheduler`]
      );
    } catch (e) { /* non-fatal */ }
  }
}

// Sweep subscription states: active → grace at ends_at; grace → expired after
// GRACE_DAYS past ends_at. Refresh users.is_premium derived cache.
async function sweepSubscriptions() {
  // active → grace when past ends_at.
  const [toGrace] = await db.query(
    `UPDATE subscriptions
     SET state = 'grace'
     WHERE state = 'active' AND ends_at IS NOT NULL AND ends_at <= NOW()`
  );

  // grace → expired after GRACE_DAYS.
  const [toExpired] = await db.query(
    `UPDATE subscriptions
     SET state = 'expired'
     WHERE state = 'grace' AND ends_at IS NOT NULL AND ends_at <= DATE_SUB(NOW(), INTERVAL ${GRACE_DAYS} DAY)`
  );

  if (toGrace.affectedRows || toExpired.affectedRows) {
    console.log(`[PremiumScheduler] Subscription sweep: ${toGrace.affectedRows} → grace, ${toExpired.affectedRows} → expired`);
  }

  // Refresh users.is_premium derived cache (NEVER read for authorization).
  await db.query(
    `UPDATE users u
     SET u.is_premium = IF(
         EXISTS (SELECT 1 FROM subscriptions s
                 WHERE s.user_id = u.id AND s.state IN ('trialing','active','grace')
                   AND (s.ends_at IS NULL OR s.ends_at > NOW())),
         1, 0)`
  );
  // Also expire the legacy is_premium flag when no active subscription remains.
  await db.query(
    `UPDATE users u
     SET u.is_premium = 0, u.premium_expires_at = NULL
     WHERE u.is_premium = 1 AND NOT EXISTS (
       SELECT 1 FROM subscriptions s
       WHERE s.user_id = u.id AND s.state IN ('trialing','active','grace')
         AND (s.ends_at IS NULL OR s.ends_at > NOW())
     ) AND u.is_admin = 0`
  );
}

async function runSweep() {
  try {
    await expireTimedEpisodes();
    await sweepSubscriptions();
  } catch (e) {
    console.error('[PremiumScheduler] Sweep failed (non-fatal):', e.message);
  }
}

let started = false;
function startScheduler() {
  if (started) return;
  started = true;
  // Every 10 minutes.
  cron.schedule('*/10 * * * *', () => {
    runSweep();
  });
  console.log('[PremiumScheduler] Timed-release + subscription sweep started (every 10 min)');
}

module.exports = { runSweep, startScheduler, DEFAULT_PREMIUM_DAYS };