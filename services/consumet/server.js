const express = require('express');
const cors = require('cors');

const consumet = require('@consumet/extensions');
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!ANIME) {
  throw new Error('Failed to extract ANIME object from @consumet/extensions.');
}

// Dynamically find the provider key regardless of exact casing or renaming
const providerKey = Object.keys(ANIME).find(key =>
  key.toLowerCase().includes('gogo') ||
  key.toLowerCase().includes('anitaku')
);

if (!providerKey) {
  console.error('Available ANIME providers in package:', Object.keys(ANIME));
  throw new Error('Could not find Gogoanime or Anitaku in ANIME exports. Check the Render logs for the available providers.');
}

console.log(`✅ Successfully mapped provider to: ANIME.${providerKey}`);

const app = express();
app.use(cors());

// Initialize the dynamically found class (passing the custom URL to be safe)
const gogoanime = new ANIME[providerKey]("https://anitaku.pe");

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

