// Direct test of AnimeHeaven extractStreams + streamingService.resolveStream
process.env.STREAM_PROVIDERS = 'animeheaven';
const { provider } = require('./services/animeHeavenProvider');
const streamingService = require('./services/streamingService');

(async () => {
  console.log('=== Test 1: provider.extractStreams("One Piece", 1) ===');
  try {
    const r = await provider.extractStreams({ title: 'One Piece', episode: 1 });
    console.log('reason:', r.reason || 'none');
    console.log('streamUrl:', r.streamUrl);
    console.log('sources:', JSON.stringify((r.sources || []).map(s => ({ url: s.url, quality: s.quality, sourceType: s.sourceType, referer: s.referer, cookie: s.cookie, origin: s.origin })), null, 2));
    console.log('subtitleMode:', r.subtitleMode);
  } catch (e) {
    console.error('extractStreams ERROR:', e.message);
  }

  console.log('\n=== Test 2: streamingService.resolveStream("One Piece", 1) ===');
  try {
    const r = await streamingService.resolveStream('One Piece', 1, { isPremium: true });
    console.log('provider:', r.provider);
    console.log('streamUrl:', r.streamUrl);
    console.log('bestQuality:', r.bestQuality);
    console.log('sources:', JSON.stringify((r.sources || []).map(s => ({ url: s.url, quality: s.quality, referer: s.referer, cookie: s.cookie, origin: s.origin })), null, 2));
  } catch (e) {
    console.error('resolveStream ERROR:', e.message);
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
