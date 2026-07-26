require('dotenv').config();
const { KitsuProvider } = require('../services/kitsuProvider');
const catalogueService = require('../services/catalogueService');
const db = require('../config/db');

const kitsu = new KitsuProvider();

async function seedCatalogue() {
  console.log('🌱 Starting catalogue seeding process...');

  try {
    // Fetch a list of popular anime from Kitsu to seed our database
    const animeToSeed = await kitsu.searchAnime('popular', 20); // Fetch top 20 popular

    if (!animeToSeed || animeToSeed.length === 0) {
      console.error('❌ Could not fetch any anime from Kitsu to seed. Aborting.');
      return;
    }

    let importedCount = 0;
    let skippedCount = 0;

    for (const anime of animeToSeed) {
      // Check if this anime (by Kitsu ID) already exists in our database
      const [existing] = await db.query('SELECT id FROM anime WHERE source_provider = ? AND source_id = ?', ['kitsu', anime.kitsu_id]);

      if (existing.length > 0) {
        console.log(`-  Skipping '${anime.title}' (already exists).`);
        skippedCount++;
        continue;
      }

      console.log(`+  Importing '${anime.title}'...`);
      await catalogueService.importFromKitsu(anime.kitsu_id);
      importedCount++;
    }

    console.log('\n✅ Seeding complete!');
    console.log(`   ${importedCount} new anime imported.`);
    console.log(`   ${skippedCount} anime skipped (already in database).`);

  } catch (error) {
    console.error('❌ An error occurred during the seeding process:', error);
  } finally {
    await db.end(); // Close the database connection pool
  }
}

seedCatalogue();