# Production Security Remediation — Notes

This document records the production-security remediation pass with attention to
the reviewed findings. It also documents a product/infrastructure decision that
cannot be fully resolved in code (premium media URL exposure).

---

## 1. TLS verification — insecure downgrade removed

- `utils/providerHttp.js` previously retried failed HTTPS requests with a
  `rejectUnauthorized: false` agent (`createRelaxedTlsAgent`) whenever a TLS
  error (e.g. `EPROTO`) was seen. A certificate-validation failure must not
  silently downgrade to insecure verification (MITM risk).
- **Change:** removed the relaxed-TLS agent, the TLS-error retry path, and all
  related state. TLS verification is now always strict. TLS/proxy-auth failures
  fail normally; they are never retried with relaxed verification.

## 2. SSRF / redirects — every hop validated

- `utils/ssrfGuard.js` already validated the original target (loopback / private /
  link-local / metadata / DNS-rebinding-aware).
- **Change:** redirects are now followed **manually with per-hop validation** via
  `utils/redirectSafeHttp.js` (`followWithGuard`). Axios auto-redirect is
  disabled (`maxRedirects: 0`, `validateStatus: status < 400`) and every
  `Location` is re-validated with `assertSafeTargetHost` before re-issuing.
  Redirects to internal destinations are blocked. The shared fetch in
  `utils/providerHttp.js` (used by both stream proxies and all providers) now
  routes through this guarded fetch, so no provider/proxy fetch can be redirected
  to an internal address.

## 3. Upload validation

- **Images** (`utils/bunnyUpload.js`): the client MIME type is no longer trusted.
  Magic bytes are sniffed (`utils/uploadContent.js`) and non-image payloads are
  rejected with 400. The avatar path already re-encoded via Sharp.
- **Videos** (`routes/uploadRoutes.js` + `controllers/bunnyStreamController.js`):
  container magic bytes (MP4/QuickTime `ftyp`, WebM/MKV `EBML`) are validated
  server-side before upload; MIME type is a first filter only.
- **Limits:** `files: 1` per image field and per video request, per-file size
  caps (15 MB images, 1 GB video).
- **Temp files:** multer errors now return proper client errors; every video
  temp file is unlinked after upload; an abandoned-temp-file sweeper removes
  files older than 1 hour on startup and every 15 minutes.

## 4. Production error leakage

- Controllers that returned `res.status(500).json({ message: error.message })`
  now return a safe generic message and log the real error server-side:
  `adminController.js`, `adminImportController.js`, `bunnyStreamController.js`,
  `utils/bunnyUpload.js`.
- All unexpected errors continue to be routed through
  `middleware/errorHandler.js` → `buildErrorBody`, which never leaks SQL errors,
  filesystem paths, provider internals, stack traces, or secrets to clients in
  production.

## 5. CORS rejected-origin behavior

- `config/cors.js` no longer throws from the origin callback (throwing surfaced
  as a 500). It returns `allow=false`; the wrapper at the end of `server.js`
  responds with an explicit **403 `CORS_BLOCKED`** client error. Intended origin
  restrictions are unchanged.

## 6. Payment verification (Pesapal IPN)

- The IPN handler now requires that a **COMPLETED** payment includes a **present,
  finite, positive amount** that matches the subscription (within rounding
  tolerance), a **present, matching currency**, and a **matching
  merchant_reference**. An incomplete or non-finite financial response is never
  granted premium (fails closed). Non-completed statuses never grant premium.

## 7. Premium media URLs — documented risk (needs product decision)

**Risk:** premium-paywalled episodes store a Cloudinary/Bunny `secure_url` in
`episodes.video_url`, and privileged/payment flows return that URL (e.g.
`controllers/catalogueController.getStream`). This URL is a stable, unexpiring
HTTPS resource. It is gated at request time by `canWatch()` (server-authoritative
entitlement), the admin dashboard is `adminOnly`, and `maskEpisodes` strips
`video_url` from listings for non-entitled callers. **However**, once a
legitimately entitled client receives the `secure_url`, it can re-share it; the
URL itself is not per-user, not expiring, and not signed.

**What can/should be done (requires product/infra decision — NOT changed here):**
- Use Cloudinary **signed delivery / private CDN delivery type** (`type: private`
  + signed URLs) so media URLs are expiring and user-scoped, or
- Route premium media exclusively through the signed stream proxy so the raw
  `secure_url` is never handed to clients, or
- Accept that premium is a "server-gated convenience" and gate playback strictly
  server-side (current behavior) with the known caveat that a shared URL works
  until access is revoked.

No code change was made to the media platform; the current architecture already
enforces entitlement at every playback gate.

---

## Infrastructure / product decisions required (not resolved in code)
- Premium media URL exposure (above): signed/private Cloudinary delivery vs.
  proxy-only playback vs. accepted limitation.
- In-memory rate limiting: for horizontal (multi-instance) deployment, move
  express-rate-limit to a shared `rate-limit-redis` store so per-IP caps are
  global, not per-instance.
- `sharp` must be installed for image re-encoding paths (avatars/thumbnails).
