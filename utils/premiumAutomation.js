const cron = require('node-cron');
const pool = require('../config/db');

// This function runs the algorithm
const runPremiumAutomation = async () => {
    try {
        console.log('🤖 Running Auto-Premium Automation...');

        // Step 1: Reset ALL anime to Free (is_premium = 0)
        await pool.query('UPDATE anime SET is_premium = 0');

        // Step 2: Define "Demand". The top 10 most viewed anime 
        // in your database become Premium.
        const [topAnime] = await pool.query(`
            SELECT id, title FROM anime 
            ORDER BY view_count DESC 
            LIMIT 10
        `);

        if (topAnime.length === 0) return;

        // Step 3: Extract their IDs and make them Premium (is_premium = 1)
        const topIds = topAnime.map(anime => anime.id);
        
        await pool.query(`
            UPDATE anime 
            SET is_premium = 1 
            WHERE id IN (?)
        `, [topIds]);

        console.log(`✅ Successfully locked ${topIds.length} high-demand anime behind Premium.`);
        
    } catch (error) {
        console.error('❌ Auto-Premium Automation Failed:', error.message);
    }
};

// Schedule the algorithm to run every night at Midnight (00:00)
cron.schedule('0 0 * * *', () => {
    runPremiumAutomation();
});

module.exports = runPremiumAutomation;

