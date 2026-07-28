# Stream Resolution Pipeline Audit - Implementation Plan

## Phase 1: Foundation - Shared Infrastructure

- [x] 1. Rewrite `utils/providerHttp.js` — Central HTTP client with:
  - Unified proxy configuration (single proxy manager)
  - Exponential backoff retry (3 attempts, 1s→2s→4s)
  - Provider health tracking (response time, success/failure rates)
  - Structured logging
  - Unified headers (User-Agent, Referer, Origin, Accept-Language)
  - Request timeout management

- [x] 2. Update `services/consumetProvider.js`:
  - Use shared HTTP client from providerHttp.js
  - Fix missing Referer/Origin headers
  - Enhance 403 retry with proxy rotation
  - Add cloudflare bypass headers
  - Re-enable AnimePahe/Hianime in preferredOrder with proper proxy

- [x] 3. Update `services/consumet/server.js`:
  - Integrate shared proxy configuration
  - Use providerHttp for all outbound requests
  - Remove standalone axios instance

## Phase 2: Episode Mapping Fix

- [x] 4. Update `controllers/streamController.js`:
  - Fix episode number detection
  - Add better logging when anime not found in DB
  - Separate episodeId (DB) from episodeNumber (streaming)
  - Pass both original and resolved episode number to resolver

- [x] 5. Update `Frontend/watch.js`:
  - Fix `resolveAndPlayStream` to pass episode NUMBER not DB ID
  - Add `ep` query param for episode number, keep `epId` for DB lookups
  - Update `loadWatch()` to use correct params

## Phase 3: Orchestration & Caching

- [x] 6. Rewrite `services/streamingService.js`:
  - Clean orchestration layer
  - Pre-query cache before calling providers
  - Centralized retry orchestration (delegated to providerHttp)
  - Provider health check integration
  - Structured logging throughout
  - Proper fallback chain

## Phase 4: All Tasks Complete ✓
