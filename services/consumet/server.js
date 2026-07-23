const express = require('express');
const cors = require('cors');

const consumet = require('@consumet/extensions');
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!ANIME || !ANIME.Hianime) {
  console.error('Available ANIME providers in package:', Object.keys(ANIME));
  throw new Error('Failed to extract ANIME.Hianime from @consumet/extensions.');
}

console.log('✅ Successfully mapped provider to: ANIME.Hianime');

const app = express();
app.use(cors());

// Initialize the Hianime provider
const provider = new ANIME.Hianime();

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

