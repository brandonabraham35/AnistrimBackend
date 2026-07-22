const cron = require('node-cron');
const pool = require('../config/db');

const runPremiumAutomation = async () => {
    try {
        console.log('🤖 Running Threshold Premium Automation...');

        // Step 1: Reset ALL anime to Free (is_premium = 0)
        await pool.query('UPDATE anime SET is_premium = 0');

        // Step 2: Find all anime that crossed the 50 daily views threshold
        const [viralAnime] = await pool.query(`
            SELECT id FROM anime 
            WHERE daily_views >= 50
        `);

        // Step 3: Lock viral anime behind the paywall
        if (viralAnime.length > 0) {
            const viralIds = viralAnime.map(anime => anime.id);
            await pool.query(`
                UPDATE anime 
                SET is_premium = 1 
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

// Schedule to run every night at Midnight (00:00) server time
cron.schedule('0 0 * * *', () => {
    runPremiumAutomation();
});

module.exports = runPremiumAutomation;

