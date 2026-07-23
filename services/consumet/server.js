const express = require('express');
const cors = require('cors');

const consumet = require('@consumet/extensions');
// Fallback safely in case of export changes
const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;

if (!META || !META.Anilist) {
  console.error('Available META providers in package:', Object.keys(META || {}));
  throw new Error('Failed to extract META.Anilist from @consumet/extensions.');
}

console.log('✅ Successfully mapped provider to: META.Anilist');

const app = express();
app.use(cors());

// Initialize the Anilist aggregator — uses Anilist's GraphQL API which is
// much more resilient for cloud environments (no Cloudflare blocking).
const provider = new META.Anilist();

// Route 1: Get Anime Info and Episode List
app.get('/anime/gogoanime/:id', async (req, res) => {
    try {
        const animeInfo = await provider.fetchAnimeInfo(req.params.id);
        res.json(animeInfo);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route 2: Get Streaming Links for a Specific Episode
app.get('/anime/gogoanime/watch/:episodeId', async (req, res) => {
    try {
        const links = await provider.fetchEpisodeSources(req.params.episodeId);
        res.json(links);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = app;

