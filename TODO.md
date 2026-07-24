# TODO: Fix Consumet Provider Casing Crash

## Steps

- [x] 1. Explore repo and read relevant files (`services/consumetProvider.js`, `services/consumet/server.js`)
- [x] 2. Create plan and get user approval
- [x] 3. Edit `services/consumetProvider.js`:
  - [x] Replace the hardcoded `new ANIME.Gogoanime()` with dynamic key finder
  - [x] Add safe fallback to `new ANIME.Zoro()`
  - [x] Update validation check to be provider-agnostic
  - [x] Update startup log messages
- [x] 4. Add Global Error Boundaries (`server.js`)
- [x] 5. Add Smart Caching Layer for stream resolver (`controllers/animeController.js`)
