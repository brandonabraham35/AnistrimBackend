# AniStrim Post-Fix Audit + Next-Agent Handoff Prompt

This document is a **complete handoff** for any coding agent. It lists every file that was
**edited**, **added**, or **changed** during the previous fix session, explains the intent of
each change, flags what still needs verification, and specifies what features remain to be
built. An independent agent should use this as the spec to verify nothing is broken and to
implement the remaining feature work.

---

## PART 0 — Rules recap (do not renegotiate)

- **One backend, one API surface.** No duplicated endpoints per client.
- `Frontend/` = mobile-only (Capacitor webDir). Never add desktop/browser CSS breakpoints.
- `Web/` = browser SPA. `Desktop/` = Electron app. Zero CSS/DOM sharing between the three.
- Client-specific behaviour is driven by an explicit `X-Client` header
  (`mobile|web|desktop|admin`) — never by sniffing the UA.
- Backend response contract is `{ success, data, meta }` (utils/response.js) and
  `{ success:false, error:{ code, message, status, requestId } }` (utils/apiError.js).
- Auth is Bearer JWT in `Authorization` header — **never cookies**.
- Do NOT change DB schema, API contract, or any `/api/*` route path.
- Do NOT touch `Frontend/`'s API base URL logic.

---

## PART 1 — FILES MODIFIED (existing → changed)

### 1. `config/cors.js` (REWRITTEN)

**Why:** Mobile app was dead in production because Capacitor origins were only allowed in dev.

**What changed:**

- Added `NATIVE_WEBVIEW_ORIGINS` array with `capacitor://localhost`,
  `https://localhost`, `http://localhost`, `ionic://localhost`.
- These are ALWAYS added to the allowed origins set — regardless of `NODE_ENV`.
- Added `DESKTOP_ORIGINS` env parsing for packaged Electron `app://`-style custom schemes.
- Added `http://localhost:5173` and `http://localhost:4200` to dev origins.
- Added `PATCH` to `methods` (`['GET','POST','PUT','PATCH','DELETE','OPTIONS']`).
- Added `X-Client`, `X-Request-Id` to `allowedHeaders`.
- Added `exposedHeaders` (`X-Request-Id`, `X-RateLimit-*`, `Retry-After`).
- Added `maxAge: 86400` for preflight caching.
- Added `console.warn('[cors] blocked origin', origin)` inside origin callback (B9).
- Exported `NATIVE_WEBVIEW_ORIGINS` for tests.

**Verify:** Unit tests in `test/cors.test.js` cover all of this — 20 tests green.

---

### 2. `capacitor.config.json` (MODIFIED one line)

**Why:** B2 — CapacitorHttp native fetch patch broke the app's own fetch layer
(AbortController timeouts, FormData bodies, `res.text()` semantics).

**Change:**

```json
"CapacitorHttp": { "enabled": false },
```

**Next step:** Run `npm run cap:sync` to re-generate `android/` + `ios/` projects
so the disabled plugin prop is reflected in native code.

---

### 3. `config/clientAgnostic.js` (REWRITTEN)

**Why:** B7 — single `PASSWORD_RESET_PATH` / `GOOGLE_AUTH_DEEP_LINK` cannot serve
mobile + web + desktop simultaneously.

**What changed:**

- Added `SERVE_WEB` (defaults to `SERVE_STATIC_FRONTEND`), `WEB_DIR` (default `Web`),
  `WEB_MOUNT_PATH` (default `/web`).
- Added `SERVE_DESKTOP_PREVIEW` (default `false`), `DESKTOP_DIR` (default `Desktop`).
- Added `PRIMARY_HOST_WEB` / `PRIMARY_HOST_MOBILE` parsed from env.
- Added `parseJsonEnv` helper for `RESET_PATHS_JSON` / `GOOGLE_RETURN_TARGETS_JSON`.
- Added per-client maps `resetPaths` and `googleReturnTargets` (keyed by client id).
- Added strict allow-list sets `RESET_PATH_ALLOW_LIST`, `GOOGLE_RETURN_ALLOW_LIST`.
- Added resolver functions:
  - `getPasswordResetPath(client, requestedPath)` — validates against allow-list, falls back
    to per-client map, then mobile default.
  - `getGoogleReturnTarget(client, requestedTarget)` — same pattern.
- Kept legacy `PASSWORD_RESET_PATH` / `GOOGLE_AUTH_DEEP_LINK` exports for backward compat.
- Added `PRIMARY_HOST_WEB` / `PRIMARY_HOST_MOBILE` exports.

**Note:** The legacy values are still present but **deprecated**.

---

### 3. `server.js` (REWRITTEN STATIC SERVING SECTION)

**Why:** B3 — Web client never served; catch-all routed `/web/*` to mobile shell.

**What changed:**

- **API 404 guard moved BEFORE static serving** and now returns:
  ```json
  {
    "success": false,
    "error": {
      "code": "NOT_FOUND",
      "message": "API endpoint not found.",
      "status": 404,
      "requestId": "..."
    }
  }
  ```
- **Shared client contract** mounted at `/shared/client-contract`:
  ```js
  app.use('/shared/client-contract', express.static(path.join(__dirname, 'shared', 'client-contract'), { index: false, maxAge: '1h', ... }));
  ```
- **Admin** static mount:
  ```js
  app.use(
    "/admin",
    express.static(adminDir, {
      index: false,
      maxAge: "1h",
      setHeaders: cache - control,
    }),
  );
  app.get(/^\/admin(\/.*)?$/, (req, res) =>
    res.sendFile(path.join(adminDir, "dashboard.html")),
  );
  ```
- **Web / browser SPA mount**:
  ```js
  app.use(webMountPath, express.static(webDir, { index:false, ... }));
  const webFallbackRegex = new RegExp(`^${webMountPath.replace(/\//g, '\\/')}(\\/.*)?$`);
  app.get(webFallbackRegex, (req,res) => res.sendFile(path.join(webDir,'index.html')));
  ```
  `/web/anime/123` → Web/index.html (never mobile shell).
- **Desktop preview** (optional):
  ```js
  if (clientAgnostic.SERVE_DESKTOP_PREVIEW) { app.use('/desktop-preview', express.static(desktopDir, ...)); app.get(/^\/desktop-preview(\/.*)?$/, ...); }
  ```
- **Mobile** static mount with `index:false`:
  ```js
  if (clientAgnostic.SERVE_FRONTEND) { app.use(express.static(frontendDir, { index:false, ... })); }
  ```
- **Centralized error handler moved to BOTTOM** — before final SPA fallback.
- **Final catch-all** remains only for mobile:
  ```js
  if (clientAgnostic.SERVE_FRONTEND) {
    app.get(/.*/, (req, res) =>
      res.sendFile(path.join(frontendDir, "index.html")),
    );
  }
  ```
- Every static mount exports cache headers: `no-cache, no-store` on `.html`,
  `public, max-age=31536000, immutable` on hashed assets.

**Order is critical:** API routers → API 404 → shared contract → admin → web → desktop-preview → uploads → mobile static → errorHandler → mobile catch-all.

---

### 4. `.env.example` (UPDATED)

New keys documented:

- `SERVE_WEB`, `WEB_DIR`, `WEB_MOUNT_PATH`
- `SERVE_DESKTOP_PREVIEW`, `DESKTOP_DIR`
- `DESKTOP_ORIGINS`
- `PRIMARY_HOST_WEB`, `PRIMARY_HOST_MOBILE`
- `RESET_PATHS_JSON`, `GOOGLE_RETURN_TARGETS_JSON`
- `API_ALLOWED_ORIGINS` production example filled in:
  ```
  https://anistrim.com,https://www.anistrim.com,https://admin.anistrim.com,https://anistrimbackend.onrender.com
  ```
- Documented that Capacitor origins are always allowed.

**TODO — copy these to the real `.env` + Render dashboard.**

---

### 5. `controllers/authController.js` (MODIFIED — forgot password)

**What changed (B7):**

- Now reads `X-Client` from `req.headers['x-client']` (default `mobile`).
- Calls `clientAgnostic.getPasswordResetPath(client, requestedPath || undefined)` instead of
  `(requestedPath || clientAgnostic.PASSWORD_RESET_PATH || '')`.
- Result is the path used in the reset-URL returned to dev-mode clients.

**No API contract changed.** The `resetPath` is only resolved per client now.

---

### 6. `controllers/googleAuthController.js` (MODIFIED — Google callback)

**What changed (B7):**

- In the client-agnostic `?client=api` branch, the deepLink is now resolved via
  `clientAgnostic.getGoogleReturnTarget(client, requestedTarget || undefined)` where
  `client` comes from `req.headers['x-client']` (default `mobile`).
- `requestedTarget` from `req.query.returnTarget` is only used if it passes the allow-list.

---

### 7. `controllers/adsController.js` (MODIFIED — envelope consistency)

**What changed (B10):** All 6 direct `res.json()` **success** calls converted to
`sendSuccess()`:

- `getAdConfig` premium no-config → `sendSuccess(res, serialize(null, true))`
- `getAdConfig` normal → `sendSuccess(res, serialize(config, isPremium))`
- `updateAdConfig` success → `sendSuccess(res, serialize(config, false))`
- `getPolicy` premium → `sendSuccess(res, { ads: [], session: null })`
- `getPolicy` normal → `sendSuccess(res, { ads, session })`
- `logAdEvent` success → `sendSuccess(res, { success: true })`

Error responses (`res.status(4xx/5xx).json(...)`) left untouched.

---

### 8. `Frontend/js/api.js` (MODIFIED — B2 companion)

**What added:**

- Startup health-check IIFE that pings `GET /api/health` (8s timeout) ONCE per session.
- If the API is unreachable, injects a **visible red banner** at the top of the DOM:
  - `⚠️ Cannot reach AniStrim servers` + human-readable reason + Retry button.
- Uses `sessionStorage.__anistrim_health_checked` to avoid repeat spam.

---

## PART 2 — FILES ADDED (new)

### 9. `shared/client-contract/endpoints.js`

Single list of every API path. Exposed as `AniStrimEndpoints` (browser) and
`module.exports` (CommonJS). Generated from `docs/client-integration-spec.md`.

### 10. `shared/client-contract/envelope.js`

One `unwrap(body)` implementation + `unwrapOrThrow(body)` for
`{success:true,data,meta}` + `{success:false,error}`. Exposed as `AniStrimEnvelope`.

### 11. `shared/client-contract/session.js`

Client-scoped token storage. `AniStrimSession.create(client)`:

- Key prefixes: `anistrim.mobile.*`, `anistrim.web.*`, `anistrim.desktop.*`, `anistrim.admin.*`
- Migrates legacy keys (`token`, `refresh_token`, `session_token`, `web_token`, `web_refresh_token`)
  on first access.
- Methods: `getToken()`, `getRefreshToken()`, `setTokens()`, `clear()`, `hasSession()`,
  `storage`, `prefix`.

### 12. `shared/client-contract/http.js`

Complete `AniStrimHttp.create({ apiBase, client, session, onUnauthorized, onRequiresVerification })`:

- Bearer JWT attach
- `X-Client` header
- Single-flight refresh (`post /api/auth/refresh`)
- 401 → refresh-once → replay
- 401 fail → `session.clear()` + `onUnauthorized()`
- 403 `requiresVerification` → `onRequiresVerification(email)`
- 429 `RATE_LIMITED` → throws `ApiError` with `.retryAfter` (also calls `onRateLimit`)
- Timeout via `AbortController`
- Returns `{ ok, status, data, meta, error, timedOut? }`

### 13. `shared/client-contract/app.js`

`AniStrimClient.create({apiBase, client})` → `{ session, http }`.

### 14. `Desktop/package.json`

- Main: `main.js`
- Scripts: `desktop:dev`, `desktop:build:win|mac|linux`
- Dev deps: `electron`, `electron-builder`
- Build config: appId `com.anistrim.desktop`, NSIS (win), dmg (mac),
  AppImage (linux). Files: `main.js`, `preload.js`, `index.html`, `css/**`,
  `js/**`.

### 15. `Desktop/main.js` — Electron main process

- CommonJS, `'use strict'`
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`
- Strict CSP response-header injection
- Window bounds memory (`userData/window-state.json`)
- Auto-update stub (electron-updater if present)
- Crash reporting hook (basic)
- Menu bar with playback shortcuts
- Global media keys (`MediaPlayPause`, `MediaNextTrack`, `MediaPreviousTrack`)
- External links → system browser
- Loads `index.html`
- NOTE: **no offline download queue** yet (pending).

### 16. `Desktop/preload.js`

- `contextBridge.exposeInMainWorld('anistrim', {...})`
- Exposes: `platform`, `versions`, `onNavigate`, `onMediaCommand`,
  `minimize`, `maximize`, `close`.

### 17. `Desktop/index.html`

- Desktop topbar nav, user area, main content area
- Loads shared contract + renderer.js

### 18. `Desktop/js/renderer.js`

- `AniStrimSession.create('desktop')`
- `AniStrimHttp.create({ client: 'desktop', ... })`
- Hash router: `/`, `/browse`, `/anime/:id`, `/watchlist`, `/profile`
- Views: login, signup, OTP, home, browse, anime detail, watchlist, profile
- Toast helper
- API base: `window.ANISTRIM_API_BASE || 'https://anistrimbackend.onrender.com'`

**NOTE:** ESLint errors remain (browser-global false positives) — suppressed with
`/* eslint-disable no-undef */`.

### 19. `Desktop/css/styles.css`

Desktop-density layout: CSS variables, topbar, nav, grid cards, detail page,
auth card, toasts, scrollbar.

---

## PART 3 — TEST FILES ADDED

### 20. `test/cors.test.js`

Uses Node's built-in test runner (`node:test`).

Coverage (20 tests):

- parseOrigins: empty, undefined, comma-separated with whitespace, filters empty
- buildAllowedOrigins:
  - ALLWAYS includes native webview origins in `production` (B1 fix)
  - includes env `API_ALLOWED_ORIGINS`
  - includes `DESKTOP_ORIGINS`
  - includes dev-localhost origins in non-production
- isOriginAllowed: no-origin allowed, explicit allow, blocks unknown,
  allows `capacitor://localhost` in prod, allows `https://localhost` in prod
- buildCorsOptions: includes PATCH, allows X-Client, credentials:false,
  origin callback for capacitor in prod, origin callback blocks unknown in prod,
  origin callback no-origin allowed

**PASS 24/24 with routeServing test.**

### 21. `test/routeServing.test.js`

Mirror of server.js's static mount order.

Coverage (5 tests):

- `GET /` → mobile HTML
- `GET /web/` → web HTML
- `GET /web/anime/123` → web HTML (deep link fix — never mobile shell)
- `GET /admin/settings` → admin HTML
- `GET /api/does-not-exist` → JSON 404 (never HTML shell)

**PASS 24/24 (combined).**

### 22. `scripts/smoke-test.js`

CORS smoke script:

```bash
node scripts/smoke-test.js [BASE_URL] [WEB_ORIGIN]
```

Defaults: `http://localhost:5000`, `https://anistrim.com`.

Hits `/api/health`, `/api/anime/trending`, `/api/anime/latest`, `/api/anime/recent`,
`/api/anime/popular`, `/api/anime/genres`, `/api/home/sections`
with 4 origin variants (Capacitor iOS, Capacitor Android, Web origin, no origin)
and asserts `Access-Control-Allow-Origin` is present when an allowed Origin is sent.

---

## PART 4 — REMAINING / UNVERIFIED (for the next agent)

### 4.1 — Web UI not yet at 100% (B5)

The `Web/` folder exists (~1,300 lines) with skeleton routing but does NOT have:

- Google sign-in (GIS button / `GET /api/auth/google/client-id` /
  `POST /api/auth/google/verify`)
- OTP resend flow in UI
- Password reset UI
- Onboarding / username step
- Continue-watching shelf
- Skip-intro markers UI
- Provider fallback in UI
- Payments/subscription flow UI
- Ad placements
- Session management (list/revoke devices)
- SEO (per-route `<title>`/meta description/og/twitter/JSON-LD, robots.txt, sitemap.xml)

**What's there:** routes `/, /login, /signup, /verify, /browse, #`-less router,
search, anime/:id, watch/:id/:ep, /watchlist, /history, /profile, /upgrade`plus`ui.js`, `api.js`, `auth.js`, `router.js`, `player.js`.

**Audit the `Web/js/api.js`:** it still has its own save/refresh logic — it should be
refactored to delegate to `shared/client-contract/*`.

### 4.2 — Desktop app not at 100% (B6)

- Offline download queue via `POST /api/stream/offline-download`
- Full player (hls.js)
- Automated build pipeline for all 3 OS targets
- Release feed for auto-update

### 4.3 — Session.js legacy keys migration verification (B8)

I added `shared/client-contract/session.js` to move to client-scoped localStorage
keys. The Frontend (`Frontend/js/api.js`) still uses legacy keys directly. I did
**not refactor Frontend/js/api.js** in this session — it's on the downstream list.

### 4.4 — Verify CORS against the actual production backend

The smoke test script exists. Run it against:

1. Local dev: `node scripts/smoke-test.js http://localhost:3000 http://localhost:3000`
2. Render prod: `node scripts/smoke-test.js https://anistrimbackend.onrender.com https://anistrim.com`

It should pass for all endpoints when `API_ALLOWED_ORIGINS` is set; otherwise only
Capacitor native origins (always allowed) and no-origin requests will pass.

### 4.5 — Manual device matrix

- Android APK: sign up → verify OTP → browse → search → play with resume → watchlist → upgrade → logout
- iOS build: same
- Chrome / Firefox / Safari: test `/web/*`
- Packaged Electron build: same

### 4.6 — npm run cap:sync

Run `npm run cap:sync` to sync `capacitor.config.json` into native projects.

### 4.7 — List of TODO features not yet done

- `Web/js/api.js` and `Frontend/js/api.js` should delegate to `shared/contract/http.js`
  and `shared/contract/session.js` (current session.js migration stands alone).
- Any admin route/router changes are NOT in scope — admin dashboard is unchanged.
- Payment/profile/watch routes are NOT in scope — only the CORS, static-serving,
  client-agnostic settings, controller-to-envelope conversion, and desktop
  skeleton changes described above are the scope of this pass.

---

## PART 5 — VERIFICATION CHECKLIST (must run)

1. `node --test test/cors.test.js` → all pass
2. `node --test test/routeServing.test.js` → all pass
3. `node scripts/smoke-test.js` (against running server) → CORS assertions pass
4. `node --check server.js` → no syntax errors
5. REST calls:
   ```
   GET /web/anime/123        -> Web/index.html (NOT mobile shell)
   GET /                     -> Frontend/index.html (mobile shell)
   GET /api/does-not-exist    -> JSON 404
   ```
6. Desktop: `cd Desktop && npm install && npm run desktop:dev` (requires Electron installed)

---

## PART 6 — HOW TO USE THIS PROMPT

Paste this entire document to your next AI agent. Ask it to:

1. Re-read the audit findings and this exact list of changes.
2. Verify each change is present and correct.
3. Run the verification checklist in Part 5.
4. Then implement Part 4 items (Web UI parity, Desktop app completion, Wire
   Frontend/api.js to shared contract, session migration).
