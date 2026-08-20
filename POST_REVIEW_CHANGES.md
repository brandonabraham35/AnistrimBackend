# POST-REVIEW CHANGELOG — AniStrim multi-client fix (applied from the audit)

Applied in response to the post-audit review of `MyFiles/`. No API contract, DB
schema, or `/api/*` route paths were changed. `Frontend/` API-base logic was
preserved (only an additive `window.__ANISTRIM_API` override was added).

## CRITICAL / HIGH

### B1 + B4 + B9 — CORS (the reason mobile was dead in production)

- `config/cors.js`: native WebView origins (`capacitor://localhost`,
  `https://localhost`, `http://localhost`, `ionic://localhost`) are ALWAYS
  allowed regardless of `NODE_ENV`; `PATCH` added to methods; `X-Client` +
  `X-Requested-With` added to `allowedHeaders`; blocked origins are logged
  (`[cors] blocked origin: <origin>`) before `callback(null, false)`.
- `server.js`: added a loud-CORS middleware that turns blocked-origin requests
  into an explicit `403 { success:false, error:{code:'CORS_BLOCKED',...} }`
  (instead of a silent 200 with no `Access-Control-Allow-Origin`). Scoped to
  only fire when no ACAO header was set, so allowed origins / `/uploads`
  (`ACAO:*`) / same-origin navigations are unaffected.
- `.env.example`: `API_ALLOWED_ORIGINS` filled with the production value
  (`https://anistrim.com,https://www.anistrim.com,https://admin.anistrim.com,
https://anistrimbackend.onrender.com`). `DESKTOP_ORIGINS` already populated.
- **Tests:** `test/cors.test.js` covers capacitor-allowed-in-production,
  unknown-origin-blocked, no-origin-allowed, env-origin-allowed, PATCH,
  X-Client. All green.

### B2 — Mobile WebView transport

- `capacitor.config.json`: `CapacitorHttp.enabled = false` (so the native
  fetch patch no longer breaks AbortController timeouts / FormData /
  `res.text()` semantics). `androidScheme` kept `https`.
- `Frontend/js/api.js`: added startup health-check self-test
  (`GET /api/health` on load) with a visible human-readable banner if the API
  is unreachable — a B1-class failure now surfaces as a banner, not a silent
  "can't do that right now".

### B3 — Backend serves three static roots

- `server.js` mount order: CORS → `/api/* routers` → `/admin` (+ SPA fallback)
  → `${WEB_MOUNT_PATH}` (+ SPA fallback → `Web/index.html`) → optional
  `/desktop-preview` → `/shared/client-contract` → mobile `/ static + final
`app.get(/._/) → Frontend/index.html`. `maxAge`on hashed assets,`no-cache`on`_.html`, `index:false` everywhere so fallbacks work.
- Explicit JSON 404 for unmatched `/api/*` (no more HTML shell for JSON).
- `app.get('/api/health')` now uses `sendSuccess` (envelope `{success,data}`).
- `errorHandler` moved to the very bottom (after SPA fallback + CORS wrapper)
  so it catches errors from later-mounted handlers.
- Tests: `test/routeServing.test.js` asserts `/`, `/web/`, `/web/anime/123`,
  `/admin/settings`, `/api/does-not-exist` → mobile HTML / web HTML / web HTML
  / admin HTML / JSON 404. All green.

### B7 — Per-client settings (no open-redirect)

- `config/clientAgnostic.js`: `getPasswordResetPath` / `getGoogleReturnTarget`
  resolve per client from `RESET_PATHS_JSON` / `GOOGLE_RETURN_TARGETS_JSON`
  with strict allow-lists (`RESET_PATH_ALLOW_LIST`, `GOOGLE_RETURN_ALLOW_LIST`).
  Allow-list fixed to include the desktop default `/reset-password` and the
  hash-routed web path `/web/#/reset-password`. Any unlisted value is rejected.

### B8 — Token-storage collision (browser client)

- `Web/index.html` loads `shared/client-contract/{endpoints,envelope,session,http}.js`.
- `Web/js/api.js` refactored so token reads/writes go through
  `AniStrimSession.create('web')` → scoped keys `anistrim.web.*`, with a
  one-time migration of legacy `web_token` / `web_refresh_token` and a
  localStorage fallback if the shared contract isn't served.

### X-Client on every client (review item #2)

- `Frontend/js/api.js`: `X-Client: mobile`
- `Web/js/api.js`: `X-Client: web`
- `AdminDashboard/js/api.js`: `X-Client: admin`
- `shared/client-contract/http.js` already sets `X-Client` on every request
  (including the refresh call), so the Desktop renderer is covered automatically.

### API base env-awareness (review item #3)

- `Web/js/config.js` and `Frontend/config.js` `getApiBaseUrl()` resolve in order:
  `window.__ANISTRIM_API` override (`''` ⇒ same-origin relative → zero CORS) →
  `<meta name="anistrim-api">` → built-in production URL. Capacitor/native
  behavior is preserved (still returns the absolute production URL, since the
  WebView origin is not the API origin).

## MEDIUM

### B6 — Desktop packaging / local assets

- `Desktop/index.html`: strict CSP (`script-src 'self' 'wasm-unsafe-eval'`),
  all scripts loaded from `vendor/` (no `../` escapes out of the app root).
- `Desktop/package.json`: added `vendor/**/*` to `files`; `prebuild:desktop`
  script runs `node ../scripts/desktop-vendor.js`; `desktop:dev`/`*build:*`
  run the prebuild first.
- `scripts/desktop-vendor.js`: idempotent staging of `shared/client-contract`
  → `Desktop/vendor/shared` and local `hls.min.js` → `Desktop/vendor`.
- Local `hls.js` (618 KB) downloaded to `Web/js/vendor/hls.min.js` and
  `Desktop/vendor/hls.min.js` — satisfies CSP `script-src 'self'` and removes
  the jsDelivr CDN dependency for both Web and Desktop.

## Verification (all green)

- `node --check server.js && node --check config/clientAgnostic.js && node --check config/cors.js && node --check scripts/desktop-vendor.js && node --check shared/client-contract/{session,http,envelope,endpoints,app}.js` → OK
- `node --test test/cors.test.js test/routeServing.test.js` → **24/24 pass**

## Remaining / manual (could not be completed in-agent)

- **B5 Web UI 100% parity / B6 Desktop 100%:** the API layer (`Web/js/api.js`)
  already wraps every endpoint in the contract, but the Web _views_
  (`ui.js`/`router.js`/`player.js`/`auth.js`/`app.js`) and the Desktop
  `renderer.js` remain skeletons — a full UI build + the manual device matrix
  (APK / iOS / Chrome/Safari/Firefox / packaged Electron) is out of scope here.
- **Web SEO:** `robots.txt` / `sitemap.xml` / JSON-LD not generated.
- **`controllers/adsController.js`** 6 direct `res.json()` calls: not converted
  to `sendSuccess`/`sendPaginated` (needs per-endpoint shape review to avoid
  breaking the ads contract).
- **Secret rotation:** `.env`, `client_secret_*.json`, `Gmail Key.txt`, `MyKey`
  were added to `.gitignore` but are still tracked in git. Run
  `git rm --cached` + history cleanup (BFS!) + rotate every secret before
  touching production — they must never ship to any repo.
- **Docs:** `shared/client-contract/endpoints.js` should be regenerated from
  `docs/client-integration-spec.md`; `docs/client-integration-spec.md` should
  be extended to the authoritative three-client contract.
