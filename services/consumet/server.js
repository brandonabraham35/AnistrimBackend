const express = require('express');
const cors = require('cors');

// Robust import pattern for @consumet/extensions — handles variations across versions
const consumet = require('@consumet/extensions');
const Gogoanime = consumet.ANIME?.Gogoanime;

if (!Gogoanime) {
  throw new Error(
    'Failed to initialize @consumet/extensions: ANIME.Gogoanime is not available. ' +
    'Run `npm install @consumet/extensions@latest` and try again.'
  );
}

const app = express();
app.use(cors());

// Initialize the Gogoanime provider
const gogoanime = new Gogoanime("https://anitaku.pe");

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

