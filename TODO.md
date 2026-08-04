# Streaming Logging Audit — Implementation TODO

## Objective

Replace generic console logging with structured diagnostic logging across the
streaming pipeline. Every provider attempt records: provider ID, anime title,
episode, start/end time, latency, result, failure reason, HTTP status, timeout
status, Cloudflare detection, search success, stream success.

## Steps

- [ ] 1. `utils/logger.js` — Add `STREAM_DEBUG` env support + `streamAttempt()` + `debugStream()` helpers
- [ ] 2. `services/streamingService.js` — Replace raw `console.*` with structured logging; thread title/episode into attempts
- [ ] 3. `services/consumetProvider.js` — Replace `console.*` with structured logging (search/stream success, Cloudflare, timeout)
- [ ] 4. `services/hostedConsumetProvider.js` — Replace `console.log` with structured logger
- [ ] 5. `services/consumet/server.js` — Replace `console.*` with structured logger
- [ ] 6. `utils/providerHttp.js` — Enhance logging (timeout status, Cloudflare detection, HTTP status)
- [ ] 7. `utils/streamingHttp.js` — Enhance logging (timeout + Cloudflare detection)
- [ ] 8. `controllers/streamController.js` — Structured start/end/latency logging + stop leaking internal errors to users
- [ ] 9. `.env.example` + `README.md` — Document `STREAM_DEBUG` env var
- [ ] 10. Syntax-check all modified files
