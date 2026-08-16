// Direct test of AnimeHeaven provider extraction
process.env.STREAM_PROVIDERS = 'animeheaven';
const { provider } = require('./services/animeHeavenProvider');

(async () => {
  console.log('=== searchAnime: One Piece ===');
  const results = await provider.searchAnime('One Piece', 5);
  console.log('search results:', JSON.stringify(results, null, 2));
  if (results.length === 0) {
    console.log('NO SEARCH RESULTS');
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
