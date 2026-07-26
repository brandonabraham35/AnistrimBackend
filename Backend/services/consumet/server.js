const express = require('express');
const cors = require('cors');

const consumet = require('@consumet/extensions');
// Fallback safely in case of export changes
const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!META || !META.Anilist || !ANIME || !ANIME.AnimePahe) {
  console.error('Available META providers:', Object.keys(META || {}));
  console.error('Available ANIME providers:', Object.keys(ANIME || {}));
  throw new Error('Failed to extract required providers (META.Anilist + ANIME.AnimePahe) from @consumet/extensions.');
}

console.log('✅ Successfully loaded META.Anilist with ANIME.AnimePahe fallback');

const app = express();
app.use(cors());

// Inject AnimePahe as the dedicated episode scraper for Anilist
// This prevents Consumet from defaulting to Hianime (which is blocked on Render)
const fallbackProvider = new ANIME.AnimePahe();
const provider = new META.Anilist(fallbackProvider);

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

