const cron = require('node-cron');
const pool = require('../config/db');

// ── Phase 4 (BUG-1): DISABLED-BY-DEFAULT safety gate ─────────────
// This legacy nightly job previously:
//   1. wiped ALL anime.access_tier to 'free' (destroying administrator-
//      controlled premium classification), then
//   2. re-locked every anime with >= 50 daily_views as 'premium'.
// Because daily_views was incremented on every anime-details read (BUG-2,
// also fixed in Phase 4), popular titles were silently paywalled — the root
// cause of the reported "every anime is premium" behavior.
//
// The job is now DISABLED BY DEFAULT. It executes only when an operator
// explicitly opts in with PREMIUM_AUTOMATION_ENABLED=true. Both the cron
// registration AND the destructive function body are gated, so the bulk
// classification can never run through normal startup.
//
// anime.access_tier remains the SINGLE, administrator-controlled source of
// truth for content classification (AdminDashboard → resolveAnimeAccessTier).
// No second classification source is introduced here.
const PREMIUM_AUTOMATION_ENABLED =
  String(process.env.PREMIUM_AUTOMATION_ENABLED || '').trim().toLowerCase() === 'true';

const runPremiumAutomation = async () => {
    if (!PREMIUM_AUTOMATION_ENABLED) {
        console.log('🤖 [PREMIUM_AUTOMATION] Skipped — disabled by default (set PREMIUM_AUTOMATION_ENABLED=true to opt in). anime.access_tier remains admin-controlled.');
        return;
    }
    try {
        console.log('🤖 Running Threshold Premium Automation (access_tier)...');

        // Step 1: Reset ALL anime to Free (access_tier = 'free'), keep legacy is_premium in sync
        await pool.query(`UPDATE anime SET access_tier = 'free', is_premium = 0`);

        // Step 2: Find all anime that crossed the 50 daily views threshold
        const [viralAnime] = await pool.query(`
            SELECT id FROM anime
            WHERE daily_views >= 50
        `);

        // Step 3: Lock viral anime behind the paywall (access_tier = 'premium')
        if (viralAnime.length > 0) {
            const viralIds = viralAnime.map(anime => anime.id);
            await pool.query(`
                UPDATE anime
                SET access_tier = 'premium', is_premium = 1
                WHERE id IN (?)
            `, [viralIds]);
            console.log(`✅ Locked ${viralIds.length} viral anime behind Premium.`);
        } else {
            console.log('📉 No anime hit the 50-view threshold today.');
        }

        // Step 4: Reset daily views for everyone
        await pool.query('UPDATE anime SET daily_views = 0');
        console.log('🔄 Daily views have been reset to 0.');

    } catch (error) {
        console.error('❌ Automation Failed:', error.message);
    }
};

// Cron is registered ONLY when explicitly enabled, so a normal production
// deployment with the variable absent can never execute the bulk
// classification — not at startup, not on a schedule.
if (PREMIUM_AUTOMATION_ENABLED) {
    // Schedule to run every night at Midnight (00:00) server time
    cron.schedule('0 0 * * *', () => {
        runPremiumAutomation();
    });
    console.log('🤖 [PREMIUM_AUTOMATION] Nightly viral-threshold job ENABLED via PREMIUM_AUTOMATION_ENABLED=true.');
} else {
    console.log('🤖 [PREMIUM_AUTOMATION] Disabled by default — no cron registered, no bulk access_tier classification writes.');
}

module.exports = runPremiumAutomation;