# AniStrim — Admin Dashboard Reload-Loop Diagnostic Report

**Date:** 2026-08-13
**Author:** Agent diagnostic run (for handoff to another AI for a second opinion)

---

## 1. Executive summary

The **admin dashboard** (`/admin`) works inside the Capacitor (Android) WebView but fails in the **web browser**: it shows the loading spinner and enters an **infinite reload / redirect loop** (`/admin → login.html → index.html → login.html → index.html …`). A fix attempt eliminated the loop in a headless browser reproduction, but the underlying session/role flow is fragile and the user reports the real browser still "loads, fails, reloads". This report gives another AI everything needed to propose a robust solution.

---

## 2. Project architecture (important — it is NOT React/Vue/Supabase)

- **Backend:** Node.js + Express 5, **MySQL** (`mysql2`), JWT auth. Hosted on Render at `https://anistrimbackend.onrender.com`.
- **Frontend:** **vanilla JavaScript multi-page app** (no bundler, no framework). Real `.html` pages: `index.html`, `login.html`, `admin.html`, `browse.html`, `details.html`, `watchlist.html`, etc. Files live in `Frontend/`.
- **Session storage:** JWT in `localStorage` under `token` (and `session_token`); user object under `user`. Centralized in `Frontend/config.js` (`Auth` object) and `Frontend/scrpt.js` (`State` object delegating to `Auth`).
- **Capacitor:** `webDir: "Frontend"`, `androidScheme: "https"`. `npx cap copy android` copies `Frontend/` → `android/app/src/main/assets/public/`.
- **There is a separate, legacy `AdminDashboard/` folder at repo root** (its own auth stack, stored an `admin_token`). It was previously mounted at `/admin` in Express, but has been removed from the routes.

---

## 3. The problem / symptom

After admin login, the web browser admin dashboard:

1. Shows a loading spinner ("Checking access…").
2. **Does not complete** — it "keeps loading, failing and then reloading".

The Android WebView admin loads and works (though it had a CSS issue that was fixed). The failure is browser-specific.

### Reproduced navigation sequence (headless Chrome, 15s)

```
/admin
→ login.html
→ index.html
→ login.html
→ index.html
→ login.html
→ index.html
… (repeats indefinitely)
```

Console showed: `[AdminGate] authorized [object Object]` followed by multiple `Failed to load resource: 401` errors.

---

## 4. Root cause of the reload loop (confirmed by reproduction)

**Mechanism:**

1. `admin.html` reveals the dashboard (`document.body.classList.add('admin-authorized')`) based on the presence of a token + cached user (my "fail-open" gate).
2. Revealing the dashboard immediately calls `loadDashboard()` → `apiFetch('/api/admin/dashboard/overview')` and `loadEpisodeAnimeDropdown()` → `apiFetch('/api/admin/anime')`.
3. If the JWT is **invalid/expired/stale**, those admin endpoints return **401**.
4. `apiFetch` (defined in `Frontend/config.js`) has a global handler: **on 401 → `State.clear()` + `window.location.href = 'login.html'`**.
5. Clearing the session and navigating to login triggers `login.html`/`index.html` `scrpt.js` auth gates that bounce the browser between login and index → **infinite loop**.

So a stale/invalid token (or any 401 on the dashboard's first data fetch) turns the admin page into a redirect storm. The loader effect the user sees is this rapid reloading.

**Fix applied (works in headless repro):** all admin data loads now call `apiFetch(path, { skipAuthRedirect: true })` and on 401 show a graceful in-page banner instead of letting `apiFetch` redirect. After this fix the headless browser stays on `/admin`, removes the gate, and does not navigate away.

---

## 5. Why the user's browser may STILL not be fixed / what is unresolved

The fix breaks the _loop mechanism_ locally, but the user says the real browser still doesn't render. Possible reasons we need a second opinion on:

1. **Deploy lag / caching.** The fix may not be deployed to the hosted site, or the browser cached the old `admin.html`. A hard refresh / fresh deploy is needed.
2. **The real session is genuinely invalid in the browser.** If the browser's `token` is stale/expired (e.g., issued before a `JWT_SECRET` rotation, or left over from the old AdminDashboard app which used a different `admin_token` key), the dashboard's first API call 401s. With `skipAuthRedirect` it now shows "session expired" instead of looping — but the user still doesn't see data.
3. **`admin.html` depends on `/config.js` and `/scrpt.js` being served at the site root.** If the deployed server is old (still serving `/admin` → the legacy `AdminDashboard/`), the page is entirely different.
4. **Even a valid token only guarantees the gate reveals; the server-side `adminOnly` middleware** (`middleware/auth.js`) requires the JWT payload to carry `isAdmin: true`. If the login response's `user.isAdmin` is wrong/stale, the gate may redirect away.

---

## 6. Current state of the relevant code (as of this report)

### `Frontend/admin.html` — single self-contained admin page

- Loads `/style.css`, `/mobile-native.css` (root-absolute so sub-paths work).
- Loads `/config.js`, `/scrpt.js` (root-absolute).
- Has a `#admin-gate` loading overlay.
- On `DOMContentLoaded`, an async gate:
  - If no token → `location.replace('login.html')`.
  - If cached `user.isAdmin === true` → reveal dashboard immediately; fire `Auth.refresh()` in background (bounded 5s).
  - Else → bounded `Auth.refresh()` (5s timeout via `withTimeout`), fail-open to cached user; if still not admin → `location.replace('index.html')`.
- All 5 data-loading functions (`loadDashboard`, `loadEpisodeAnimeDropdown`, `loadAnimeList`, `loadUsers`, `loadRevenue`) now call `apiFetch(..., { skipAuthRedirect: true })` and show a `showSessionExpired()` banner on 401.

### `Frontend/config.js`

- Defines `Auth` (token/user in localStorage) and the shared `apiFetch`.
- `apiFetch` 401 handler: clears session and redirects to `login.html` **unless** `options.skipAuthRedirect === true`.

### `Frontend/scrpt.js`

- Defines `State`, and an auth gate IIFE: unauthenticated users on non-public pages → `login.html`; authenticated users on `login.html`/`signup.html` → `index.html`.

### `server.js`

- `/admin` and `/admin/*` now serve `Frontend/admin.html` (the legacy `AdminDashboard/` mount was removed).
- General SPA fallback serves `Frontend/index.html`.

### `/api/auth/login` (backend `controllers/authController.js`)

- Returns `{ token, user: { ..., isAdmin: !!user.is_admin, ... } }`.
- JWT signed by `utils/token.js` with claims: `{ userId, email, name, isVerified, authProvider, id, isAdmin, isPremium }`, `expiresIn: '7d'`.

### Admin authorization (backend)

- `middleware/auth.js` `protect` decodes the JWT; `adminOnly` checks `req.user.isAdmin`.
- All `/api/admin/*` routes go through `protect, adminOnly`.

---

## 7. What has been changed in this session (could be reverted/tuned)

| File                                                                          | Change                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Frontend/admin.html`                                                         | Turned the redirect-stub into a full self-contained admin dashboard; added stylesheets; root-absolute asset paths; non-blocking gate; `skipAuthRedirect` on all data loads + graceful session banner. |
| `server.js`                                                                   | `/admin` now serves `Frontend/admin.html`; removed `/admin → AdminDashboard/` static mount.                                                                                                           |
| `Frontend/index.html`                                                         | Added a head forwarder: if `pathname` starts with `/admin`, replace with `admin.html` (for WebView deep links).                                                                                       |
| `Frontend/js/api.js`                                                          | `redirectAfterAuthentication` now commits token+user atomically via `Auth.save(token, user)`.                                                                                                         |
| `Frontend/login.js`, `signup.js`, `google-auth-handler.js`, `verify-otp.html` | Pass `data.token` to `redirectAfterAuthentication`.                                                                                                                                                   |
| `package.json`                                                                | Added `cap:sync` script.                                                                                                                                                                              |
| `scripts/capacitor-preflight.js`                                              | New preflight gate for `cap copy`/`sync`.                                                                                                                                                             |

**NOT changed:** `capacitor.config.json`, the MySQL schema, `middleware/auth.js`, `middleware/authMiddleware.js`, `routes/adminRoutes.js`, `controllers/authController.js` (role model), the legacy `AdminDashboard/` folder (left in place, unmounted).

---

## 8. Open questions for a second-opinion AI

1. **What is the minimal, most robust way to render the admin dashboard in the browser WITHOUT any possibility of a redirect/reload loop** — while keeping it working in the Capacitor WebView (no separate admin app, single session)?
2. Is the correct approach to **stop gateing the UI on the client-side role entirely** and simply render the dashboard whenever a token exists, letting the server's `adminOnly` middleware (403) be the only enforcement? What are the downsides (a non-admin seeing an empty dashboard)?
3. Should `scrpt.js`'s global auth gate even apply to `admin.html`? It currently redirects unauthenticated users to login; combined with `apiFetch`'s 401 redirect this is where loops originate.
4. How should a **stale/expired token in the browser** be handled at `/admin` so the user sees a clear "sign in" screen rather than a loop or a blank dashboard — while a **valid** admin lands on the dashboard immediately, with no network round-trip blocking the page?
5. Is there a risk that the deployed site still serves the **legacy `AdminDashboard/`** at `/admin`, or that `admin.html`'s `/config.js` / `/scrpt.js` absolute paths 404 on the host (e.g., if the app is served under a sub-path or a CDN with a base path)?

---

## 9. Reproduce / verify

- Server: `node server.js` (listens on `:5000`; DB unreachable in this environment logs `ETIMEDOUT` — fine, static + admin route still serve).
- Browser: `http://localhost:5000/admin`.
- Headless reproduction used: `puppeteer-core` with system Chrome; seed `localStorage` with a token + `user {isAdmin:true}`, then capture `framenavigated`/`console`/`pageerror`.
- After the fix, the reproduction shows a single navigation to `/admin`, `admin-gate` removed, `body.admin-authorized` set — no loop. `loadDashboard` still 401s (synthetic token), but now shows the banner instead of redirecting.

---

## 10. Files most relevant for review

- `Frontend/admin.html` (the whole dashboard + gate)
- `Frontend/config.js` (`Auth`, `apiFetch`, `getApiBaseUrl`)
- `Frontend/scrpt.js` (`State`, global auth gate)
- `Frontend/js/api.js` (`redirectAfterAuthentication`)
- `server.js` (routing)
- `middleware/auth.js` (protect/adminOnly)
- `controllers/authController.js` (login → user + token)
- `utils/token.js` (JWT claims)
