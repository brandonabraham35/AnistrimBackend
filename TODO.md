# Task: Dedicated Streaming Axios Client (No Global Timeout)

## Goal

Audit every axios instance in the backend. Do NOT set `axios.defaults.timeout` globally.
Create a dedicated axios instance used ONLY for streaming providers with:

- timeout: 8–10s → **10s**
- retry disabled
- proper timeout error handling
- descriptive logging
- preserve existing interceptors where appropriate

Replace ONLY streaming-related requests with the dedicated client.

## Approved Approach

- Keep `providerHttp` in the request path for streaming resolvers (it provides
  proxy rotation, header/referer injection, health tracking, retry coordination,
  error classification — infrastructure must NOT be bypassed).
- Make `providerHttp` configurable so streaming requests use the 10s timeout
  (via a `streaming: true` option / `STREAMING_TIMEOUT` constant).
- Reuse a single shared streaming client (`utils/streamingHttp.js`) across the
  streaming stack; provider-specific interceptors wrap/extend it.
- Preserve proxy rotation, adapter routing, health tracking, failover logic.
- Do NOT modify payments, auth, uploads, downloads, Kitsu, MALSync, AniSkip,
  admin imports, metadata providers.

## Steps

- [x] 1. Audit all axios usage in the backend (no global `axios.defaults.timeout` exists).
- [ ] 2. Create `utils/streamingHttp.js` — dedicated streaming client (10s, retry disabled, logging, timeout handling).
- [ ] 3. Add `STREAMING_TIMEOUT` + `streaming` option to `utils/providerHttp.js`.
- [ ] 4. `services/consumetProvider.js` — use `createStreamingInstance` (preserve proxy/403-retry interceptors).
- [ ] 5. `services/consumet/server.js` — use `createStreamingInstance` (preserve adapter routing).
- [ ] 6. `services/streamingService.js` — use `streaming: true` (10s) for consumet-http & miruro resolvers.
- [ ] 7. Verify: syntax checks, no global axios.defaults, confirm other services untouched.
- [ ] 8. Run regression suite (weather permitting) and document results.
