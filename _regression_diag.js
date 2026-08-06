// Regression diagnostic for proxy integration audit
const { provider: consumetProvider } = require('./services/consumetProvider');
const streamProxy = require('./utils/streamProxy');

console.log('=== CONSUMET PROVIDER REGISTRY ===');
console.log('Providers registered:', consumetProvider.listProviders());
console.log('Provider count:', consumetProvider.providerCount);

const providers = [
  'KickAssAnime', 'AnimeKai', 'AnimePahe', 'Hianime',
  'AnimeSaturn', 'AnimeUnity', 'AnimeSama'
];
for (const name of providers) {
  console.log(`hasProvider(${name}):`, consumetProvider.hasProvider(name));
}

console.log('\n=== STREAM PROXY: isAnimeHeavenSource ===');
// Anonymous source (Consumet-style) - no referer/origin/cookies
const anonymousSource = { url: 'https://cdn.example.com/video.m3u8', quality: '1080p' };
console.log('Anonymous source proxied?', streamProxy.isAnimeHeavenSource(anonymousSource));

// AnimeHeaven source with context
const ahSource = {
  url: 'https://ck.animeheaven.me/video.mp4?token',
  quality: 'auto',
  referer: 'https://animeheaven.me/gate.php',
  origin: 'https://animeheaven.me',
  cookies: 'key=abc'
};
console.log('AnimeHeaven source proxied?', streamProxy.isAnimeHeavenSource(ahSource));

console.log('\n=== STREAM PROXY: rewriteResultToProxy (anonymous Consumet result) ===');
const consumetResult = {
  provider: 'KickAssAnime',
  streamUrl: 'https://cdn.example.com/video.m3u8',
  sources: [
    { url: 'https://cdn.example.com/video.m3u8', quality: '1080p' },
    { url: 'https://cdn.example.com/video2.mp4', quality: '720p' }
  ],
  subtitles: [
    { url: 'https://cdn.example.com/sub.vtt', lang: 'English' }
  ]
};
const rewritten = streamProxy.rewriteResultToProxy(consumetResult);
console.log('Result preserved?', !!rewritten);
console.log('Provider:', rewritten.provider);
console.log('streamUrl:', rewritten.streamUrl);
console.log('sources:', JSON.stringify(rewritten.sources, null, 2));
console.log('subtitles preserved:', rewritten.subtitles.length);
console.log('Any proxy URL leaked?', JSON.stringify(rewritten).includes('/api/stream-proxy'));

console.log('\nDONE');
