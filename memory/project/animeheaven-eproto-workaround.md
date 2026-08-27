---
name: AnimeHeaven EPROTO TLS Workaround
description: Implemented relaxed TLS verification fallback for EPROTO/SSL handshake failures on Render
type: project
---

**Fact:** AnimeHeaven (and potentially other scraping providers) fail on Render with EPROTO TLS errors (`tls_get_more_records:packet length too long`). This is a known Node.js OpenSSL strictness issue where some CDNs send malformed TLS records.

**Fix:** Added automatic retry with `rejectUnauthorized: false` in `utils/providerHttp.js` when EPROTO errors are detected. The relaxed TLS agent is created via `createRelaxedTlsAgent()` and cached for the retry attempt.

**How to apply:** This is transparent — any provider request that hits EPROTO/SSL errors will automatically retry once with relaxed TLS verification. Logs will show: `[providerHttp] TLS error detected, retrying with relaxed TLS verification`.

**Security note:** `rejectUnauthorized: false` makes connections vulnerable to MITM attacks. This is ONLY used as a fallback for scraping providers when strict TLS fails, and is acceptable for anime streaming CDN connections.
