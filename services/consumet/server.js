const express = require('express');
const cors = require('cors');

// Robust import pattern for @consumet/extensions — handles CommonJS vs ESM mismatches
const consumet = require('@consumet/extensions');

// Safely resolve the ANIME object regardless of the package version / export structure.
// Latest versions may export under: consumet.ANIME, consumet.default.ANIME, or consumet.PROVIDERS.ANIME.
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!ANIME || !ANIME.Gogoanime) {
  console.error('Consumet Export Object:', Object.keys(consumet));
  throw new Error(
    'Failed to extract ANIME.Gogoanime from @consumet/extensions. See logs above for available exports.'
  );
}

const app = express();
app.use(cors());

// Initialize the Gogoanime provider
const gogoanime = new ANIME.Gogoanime("https://anitaku.pe");

// Route 1: Get Anime Info and Episode List
app.get('/anime/gogoanime/:id', async (req, res) => {
    try {
        const animeInfo = await gogoanime.fetchAnimeInfo(req.params.id);
        res.json(animeInfo);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route 2: Get Streaming Links for a Specific Episode
app.get('/anime/gogoanime/watch/:episodeId', async (req, res) => {
    try {
        const links = await gogoanime.fetchEpisodeSources(req.params.episodeId);
        res.json(links);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = app;

