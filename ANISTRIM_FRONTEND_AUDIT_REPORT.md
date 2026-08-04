# 🎬 AniStrim2 — Full-Stack Anime Streaming Platform

## Frontend Architecture Audit Report

**Scope:** Comprehensive audit of the AniStrim frontend (no code modified). Both the legacy `Frontend/` user-facing app and the `AdminDashboard/` CMS were analyzed, cross-referenced against the backend (`routes/`, `controllers/`, `server.js`).

---

## 1. Current Frontend Architecture

### 1.1 Technology Stack

- **Pure static HTML/CSS/vanilla JS** — no framework (no React/Vue/Svelte). Multi-page application (MPA), not SPA.
- **Backend:** Express REST API at `https://anistrimbackend.onrender.com` (Render). MySQL DB.
- **Environment config:** `config.js` detects Capacitor native vs browser, always returns the production URL.
- **Capacitor / Ionic** for native Android/iOS (`android/`, `ios/` folders). Duplicate frontend JS exists in `ios/App/App/public/`.
- **HLS.js** loaded from CDN for stream playback. **Google Identity Services (GIS)** for OAuth.
- **Chart.js** (admin) and **Font Awesome** (admin) from CDN.

### 1.2 Directory Layout

```
Frontend/                 → User-facing web app (also served by Express static)
  index.html, browse.html, details.html, watch.html, watchlist.html,
  profile.html, upgrade.html, login.html, signup.html, forgot-password.html,
  reset-password.html, payment-callback.html, google-callback.html, admin.html
  config.js, scrpt.js, browse.js, details.js, watch.js, watchlist.js,
  profile.js, upgrade.js, login.js, signup.js, google-auth-handler.js
  style.css, mobile-native.css, css/watch.css
AdminDashboard/           → Admin CMS (served at /admin)
  index.html (login), dashboard.html (SPA), google-callback.html
  js/{api,auth,shared,dashboard,anime,users,episodes,genres,payments,ads,logs,settings,uploader}.js
  css/{style,shared}.css
uchiha-admin-dashboard/   → An unused TanStack-router-based React admin (dead code)
```

---

## 2. HTML Pages and Their Purposes

| Page             | Path                    | Purpose                                                              | Auth           |
| ---------------- | ----------------------- | -------------------------------------------------------------------- | -------------- |
| Home             | `index.html`            | Hero slider, trending/popular/new/classics rows, continue-watching   | Semi-public    |
| Browse           | `browse.html`           | Search + genre + status filters + grid                               | Public         |
| Details          | `details.html`          | Anime metadata + episode list (client-side)                          | Public         |
| Watch            | `watch.html`            | Custom video player, HLS, provider switch, skip intro, ads, download | Semi-public    |
| Watchlist        | `watchlist.html`        | User's saved anime collection with status tabs                       | Protected      |
| Profile          | `profile.html`          | Avatar, stats, watchlist shortcut, admin link                        | Protected      |
| Upgrade          | `upgrade.html`          | Pesapal premium plans (monthly/yearly)                               | Protected      |
| Login            | `login.html`            | Email/password + Google OAuth                                        | Public         |
| Signup           | `signup.html`           | Register + Google OAuth                                              | Public         |
| Forgot Password  | `forgot-password.html`  | Send reset link                                                      | Public         |
| Reset Password   | `reset-password.html`   | New password via token                                               | Public         |
| Payment Callback | `payment-callback.html` | Polls payment status, updates premium                                | Public         |
| Google Callback  | `google-callback.html`  | Deep-link OAuth code exchange (mobile)                               | Public         |
| Admin redirect   | `admin.html`            | Redirects to `../AdminDashboard/`                                    | Requires admin |

---

## 3. JavaScript Files and Page Usage

| JS File                                                                                                   | Used On                                                           | Role                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `config.js`                                                                                               | ALL pages                                                         | API base URL detection                                                                                               |
| `scrpt.js`                                                                                                | index, browse, details, watch, watchlist, profile, upgrade, admin | **Shared core**: `State`, `apiFetch`, auth gate, `_escapeHTML`, toast, premium UI, hero slider, home rows, ad system |
| `google-auth-handler.js`                                                                                  | login, signup, admin/index                                        | Shared GIS module + Capacitor deep-link handler                                                                      |
| `browse.js`                                                                                               | browse                                                            | Search/filter/grid rendering                                                                                         |
| `details.js`                                                                                              | details                                                           | Anime details + episode list                                                                                         |
| `watch.js`                                                                                                | watch                                                             | Player logic, providers, HLS, progress, skip, offline download                                                       |
| `watchlist.js`                                                                                            | watchlist                                                         | Collection rendering + tabs                                                                                          |
| `profile.js`                                                                                              | profile                                                           | Avatar upload, stats, user info                                                                                      |
| `upgrade.js`                                                                                              | upgrade                                                           | Plan selection + checkout                                                                                            |
| `login.js`                                                                                                | login                                                             | Email + Google login                                                                                                 |
| `signup.js`                                                                                               | signup                                                            | Email + Google signup                                                                                                |
| `AdminDashboard/js/api.js`                                                                                | admin                                                             | Admin API fetch (separate duplicate of `apiFetch`)                                                                   |
| `AdminDashboard/js/auth.js`                                                                               | admin/index                                                       | Admin Google/email login                                                                                             |
| `AdminDashboard/js/{shared,dashboard,anime,users,episodes,genres,payments,ads,logs,settings,uploader}.js` | admin/dashboard                                                   | Admin SPA sections                                                                                                   |

---

## 4. CSS Architecture

- **`style.css`** — single global stylesheet (≈2000 lines). Defaults, navbar, hero, cards, browse, details, watchlist, profile, auth, upgrade, popup, mobile bottom nav, episode rows.
- **`mobile-native.css`** — additive override for native feel: safe-area insets, larger tap targets, user-select none, shimmer skeletons, mobile grid.
- **`css/watch.css`** — player-specific overrides (fullscreen, controls, skip/nav buttons).
- **`AdminDashboard/css/style.css` + `shared.css`** — separate admin stylesheet.
- **Inline `<style>` blocks** are pervasive in `watch.html`, `admin.html`, `payment-callback.html`, `upgrade.html` (~40% of player+admin styling is inline).

**⚠️ No CSS preprocessor, no CSS variables beyond the `:root` block, no componentization, heavy inline styles, and duplicated `.mobile-bottom-nav` / `.side-nav` markup across every HTML page.**

---

## 5. Routing and Navigation Flow

- **No client-side router** in the user app — it's an MPA using raw `<a href>` and `location.href`.
- Server has a catch-all SPA fallback (`server.js`) that serves `index.html` for any unmatched route, and `/admin/*` → `dashboard.html`.
- **Side menu** (hamburger) duplicated in every page: `index`, `browse`, `details`, `watch`, `watchlist`, `profile`, `upgrade`.
- **Mobile bottom nav** duplicated in every page: Home / Browse / My List / Profile.
- **Auth gate** in `scrpt.js` redirects unauthenticated users to `login.html` for protected pages (`watchlist`, `profile`, `upgrade`, `index`).

**Navigation map:**

```
index.html ──► browse.html ──► details.html?id= ──► watch.html?id=&ep=
  ▲              │              │  └──► upgrade.html (locked eps)
  │              └──► details.html?id=
  └──► watchlist.html ──► details.html?id=
  └──► profile.html ──► {watchlist, upgrade, admin.html}
  └──► upgrade.html ──► payment-callback.html ──► index.html
login.html ──► index.html / admin.html
```

---

## 6. Authentication Flow

1. **Email/password:** `POST /api/auth/login` (or `/signup`) → JWT stored in `localStorage` as `token` (7-day expiry) + `user` JSON.
2. **Google OAuth:** GIS client → ID token → `POST /api/auth/google/verify` → backend verifies → returns JWT. Shared module `google-auth-handler.js` handles library load, client-ID fetch, double-prompt fallback.
3. **Mobile deep link:** `anistrim://auth?code=` → `GET /api/auth/google/token?code=` → JWT.
4. **State management:** `State` object in `scrpt.js` reads `localStorage`; `apiFetch` injects `Bearer` token; on 401 clears session → redirects to login.
5. **Admin:** separate `admin_token`/`admin_user` in `localStorage`; `AdminDashboard/js/auth.js` checks `isAdmin` client-side.

**⚠️ Issues:** Token in `localStorage` (XSS risk); no token refresh; admin role check is client-side only (server re-checks via `adminOnly` middleware, which is correct); no refresh/rotation of the 7-day JWT.

---

## 7. Search Implementation

- **Client-side only** in `browse.js`: fetches the ENTIRE `/api/anime/trending` catalog once, then filters in memory by genre, status, and title/description substring (`toLowerCase().includes`).
- **No debouncing** on the search input — filters on every keystroke.
- **Performance risk:** loads the full catalog (no pagination) into memory on every page load.

**⚠️** The backend has proper `/api/anime/search` (LIKE) and `/api/anime/search/advanced` endpoints, but the frontend does **not** use them — it downloads everything and filters client-side.

---

## 8. Anime Browsing Pages

- **Home (`index.html`)**: hero slider (featured/top-rated), horizontal-scroll rows for trending (airing), popular (rating), new (year≥2020), classics (year<2015), continue-watching.
- **Browse (`browse.html`)**: 2-column grid, 8 hardcoded genre pills (Action, Adventure, Drama, Comedy, Mystery, Sci-Fi, Supernatural), status filter, results count, client-side filtering.
- **⚠️ No pagination, no infinite scroll** — browse loads all titles at once.

---

## 9. Anime Details Page

- Loads `GET /api/anime/:id` (includes episodes), with a hard 8s timeout → falls back to scanning `/api/anime/trending`.
- Fetches episodes separately from `GET /api/anime/:id/episodes`.
- Renders metadata, genres, status badge, episode list with premium locks.
- "Start Watching" jumps to first unlocked episode; "Add to List" posts to watchlist.

---

## 10. Watch Page & Player Integration

- **Custom player** (not a library like video.js/plyr): custom controls, progress bar, volume, fullscreen, skip back/forward 10s.
- **HLS.js** for `.m3u8`; native `<video>` for `.mp4`.
- **Multi-provider:** `GET /api/stream/providers/:title/:ep` → dropdown; `GET /api/stream/:title/:ep` → resolve stream ("Switch Server").
- **Premium features:** skip intro (`/api/watch/skip-times/`), autoplay next episode, offline download (IndexedDB sandbox).
- **Free-tier ads:** 15s interstitial every 10 min (mid-roll overlay) + home-page ad overlay.
- **Progress:** saves/resumes via `/api/watchlist/progress` (see mismatch below).

---

## 11. User Profile Pages

- Profile shows avatar (upload via `/api/auth/avatar`), name/email, watching/completed/planned stats, watchlist link, admin link.
- **⚠️ `profile.js` calls `/api/auth/me` and `/api/watchlist/stats` — these endpoints DO NOT EXIST in the backend** (see Section 15).

---

## 12. Admin Dashboard

- **TWO admin interfaces exist:**
  1. **`AdminDashboard/`** (current, served at `/admin`): feature-rich SPA — Dashboard w/ Chart.js analytics + health checks, Anime list (search/filter/sort/bulk/pagination/import), Users, Episodes, Payments, Genres, Ads config, Logs, Settings, image uploader.
  2. **`Frontend/admin.html`** (legacy in-app admin): tabbed dashboard with Anime CMS, Episodes, Users, Revenue. It self-redirects to `../AdminDashboard/`.
  3. **`uchiha-admin-dashboard/`** — an unused TanStack React admin (dead code, different stack).
- Admin auth: `admin_token` in localStorage; login via email or Google (Google route checks `isAdmin`).

**⚠️ Duplicate/legacy admin surfaces present — consolidation needed.**

---

## 13. API Endpoints Consumed by Each Page

**Verified working endpoints:**
| Page | Endpoints |
|------|-----------|
| Home | `GET /api/anime/trending`, `GET /api/watchlist/continue` ⚠️(mismatch) |
| Browse | `GET /api/anime/trending` |
| Details | `GET /api/anime/:id`, `GET /api/anime/:id/episodes`, `POST /api/watchlist/add` ⚠️ |
| Watch | `GET /api/anime/:id`, `GET /api/anime/:id/episodes`, `GET /api/stream/:title/:ep`, `GET /api/stream/providers/:title/:ep`, `POST /api/stream/offline-download`, `POST /api/watchlist/progress` ⚠️, `GET /api/watchlist/progress/:epId` ⚠️, `GET /api/watch/skip-times/:malId/:epNum`, `GET /api/download/:epId` |
| Watchlist | `GET /api/watchlist` |
| Profile | `GET /api/auth/me` ⚠️, `POST /api/auth/avatar`, `GET /api/watchlist/stats` ⚠️ |
| Upgrade | `POST /api/payments/checkout` |
| Payment callback | `GET /api/payments/verify-subscription?reference=`, `GET /api/payments/verify?tx_ref=` |
| Login/Signup | `POST /api/auth/login`, `POST /api/auth/signup`, `POST /api/auth/google/verify`, `GET /api/auth/google/client-id` |
| Forgot/Reset | `POST /api/auth/forgot-password` ⚠️, `POST /api/auth/reset-password` ⚠️ |
| Admin | `GET /api/admin/dashboard/overview`, `/api/admin/anime`, `/api/admin/users`, `/api/admin/episodes`, `/api/admin/genres`, `/api/admin/ads`, `/api/admin/logs`, `/api/admin/settings`, `/api/admin/upload/*`, `/api/payments/revenue`, `/api/payments/subscription-revenue` |

---

## 14. Shared Components

**Shared:** `config.js`, `scrpt.js` (State, apiFetch, escapeHTML, toast, premium UI, ad system), `google-auth-handler.js`, the duplicated `.side-nav` + `.mobile-bottom-nav` + `.navbar` HTML blocks.

**Duplicate code (high debt):**

- `apiFetch` implemented **three times**: `scrpt.js`, `AdminDashboard/js/api.js`, plus raw `fetch` in login/signup/upgrade/payment-callback.
- `makeFallbackImg`/`imgError`/`cardImgError` duplicated in `scrpt.js`, `details.js`, `watch.js`.
- `showError`/`showToast`/`setText` redefined in multiple files.
- Navigation markup (side menu + bottom nav + navbar ~40 lines) repeated in **every** HTML page.
- `google-auth-handler.js` copy exists in `AdminDashboard/js/`.

---

## 15. CRITICAL API Contract Mismatches (Backend vs Frontend)

These are the highest-risk findings — frontend calls endpoints that **do not exist** in the backend:

| Frontend Call                       | Backend Route Exists?                                         | Correct Route                                     |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| `POST /api/watchlist/add`           | ❌ No — only `POST /api/watchlist`                            | `POST /api/watchlist`                             |
| `GET /api/watchlist/continue`       | ❌ No                                                         | `GET /api/watch/continue-watching`                |
| `GET /api/watchlist/progress/:epId` | ❌ No (expects `/api/watch/progress/:animeId/:episodeNumber`) | `GET /api/watch/progress/:animeId/:episodeNumber` |
| `POST /api/watchlist/progress`      | ❌ No (expects `/api/watch/progress`)                         | `POST /api/watch/progress`                        |
| `GET /api/watchlist/stats`          | ❌ No route at all                                            | Missing                                           |
| `GET /api/auth/me`                  | ❌ No route                                                   | Missing                                           |
| `POST /api/auth/forgot-password`    | ❌ No route in `authRoutes.js`                                | Missing                                           |
| `POST /api/auth/reset-password`     | ❌ No route in `authRoutes.js`                                | Missing                                           |

**Impact:** Continue Watching, resume progress, profile stats, profile user info, and password reset are **broken** in production. The `forgot-password.html`/`reset-password.html` pages exist but cannot function. This is the most important area to fix.

---

## 16. Missing Pages Needed for a Production Streaming Website

- **Search results page** (currently only in-browse filter, no dedicated search UX).
- **Genre / category landing pages** (e.g., `/genre/action`).
- **Anime details with recommendations / related titles** (backend has `/api/anime/recommendations/:id` but no frontend uses it).
- **Continue Watching dedicated page**.
- **404 Not Found page** (server fallback serves index.html for everything).
- **Terms of Service / Privacy Policy / About / Contact pages**.
- **Help / Support / FAQ page**.
- **Homepage redesign** (no landing/promo, no "What's new" hero carousel beyond a slider).
- **Search by studio / voice actor / year filters**.
- **Movie/OVA/film-specific filtering** (DB has `media_type` migration but no UI).
- **Account settings page** (change password, email, delete account) — only avatar upload exists.
- **Subscription management page** (cancel/upgrade/downgrade).
- **Watch history page**.
- **Report-a-broken-stream UI** (backend `/api/reports/stream` exists, no frontend form).
- **Admin sub-pages** (some exist in AdminDashboard; legacy `admin.html` duplicates).

---

## 17. Pages That Need Redesign vs. Already Suitable

**Already suitable (minor polish):** `login.html`, `signup.html`, `upgrade.html`, `profile.html`, `watchlist.html` — clean, focused layouts.

**Needs redesign:**

- **`index.html`** — hero uses full cover as background with a generic gradient; no branding richness; rows feel sparse; no visible "latest" row wired to `/api/anime/latest` (backend route unused).
- **`browse.html`** — hardcoded genre list, no pagination, basic grid.
- **`details.html`** — no banner image, no trailer, no recommendations, no related section.
- **`watch.html`** — heavily inline-styled, cluttered controls, no subtitles support, no quality selector.
- **`admin.html`** — legacy, should be removed in favor of `AdminDashboard/`.

---

## 18. Mobile Responsiveness Status

- **Good:** mobile bottom nav, safe-area insets, larger tap targets, 2-col grids on mobile, responsive hero, `mobile-native.css` handles native feel.
- **Gaps:** no desktop-specific layout enhancements (grid stays 2-col on large screens for browse — should be 4-6 cols); no tablet breakpoints; admin tables rely on horizontal scroll on mobile; no responsive images (`srcset`/`sizes`).

---

## 19. Performance Issues

- **Full catalog downloaded on every browse/home load** — no pagination, no server-side search, no caching.
- **No bundle/minification** — raw JS files, inline styles, no build step.
- **HLS.js and Google GIS loaded via CDN** with no caching/versioning (HLS uses `@latest`).
- **No asset optimization** — images unoptimized, no lazy-loading config beyond `loading="lazy"`.
- **Multiple `setInterval` timers** (hero slider 5s, ad overlays, autoplay countdown) not always cleaned up.
- **Google Fonts** loaded via `@import` (blocking) in `style.css`.
- **No service worker / offline caching** for the web app (only IndexedDB offline download for premium).

---

## 20. Accessibility Issues

- **No ARIA roles/labels** on nav, sliders, modals, or custom player controls.
- **Custom player controls** are `<button>`s with SVG but no `aria-label` for play/pause/volume/fullscreen/skip.
- **Color contrast** concerns: muted text (`--text-muted: #6b7280`) on dark bg.
- **No `alt` text** fallback consistently (some images rely on `onerror`).
- **Focus states** not styled for keyboard navigation.
- **Toast/error messages** are not announced to screen readers.
- **No `lang`/skip-link** navigation; no reduced-motion support.
- **Modals** in admin don't trap focus / restore focus.

---

## 21. SEO Readiness

- **Very poor:** no `<meta name="description">`, no Open Graph, no Twitter cards, no JSON-LD structured data, no `robots.txt` in `Frontend/` (only `uchiha-admin-dashboard/public/robots.txt`).
- **No sitemap.xml.**
- **No canonical URLs.**
- **Client-side routing** means crawlable content is limited; the server SPA fallback serves `index.html` for all paths.
- **No SSR/prerendering**; titles are set via JS (`document.title`) after load.
- **Images lack `srcset`** and structured alt text.

---

## 22. Technical Debt Summary

1. **No framework/build tooling** — hard to maintain, no HMR, no type safety, no tests.
2. **Triplicated API layer** and duplicated utility functions.
3. **Duplicated navigation markup** across all pages.
4. **Critical API contract mismatches** (Section 15) — broken features.
5. **Two/three admin dashboards** (legacy `admin.html`, `AdminDashboard/`, dead `uchiha-admin-dashboard/`).
6. **Inline styles** scattered across watch/payment/admin pages.
7. **Unused backend endpoints** (search, recommendations, latest, reports, media-type) with no frontend consumer.
8. **Duplicate frontend copies** in `ios/App/App/public/` (drift risk).
9. **`avatarRoutes.js` is empty** (unused); uploads handled via `authRoutes.js` and `uploadRoutes.js`.
10. **No .env-based frontend config** — production URL hardcoded in `config.js` and `AdminDashboard/js/api.js`.

---

## 23. Recommendations (Prioritized)

**P0 – Critical (fix immediately):**

1. Align frontend API calls with backend routes: `/api/watchlist/add`→`POST /api/watchlist`, `/api/watchlist/continue`→`GET /api/watch/continue-watching`, progress→`/api/watch/progress`, add `/api/auth/me` and `/api/watchlist/stats` to backend, add `/api/auth/forgot-password` + `/api/auth/reset-password` routes. This restores continue-watching, resume, profile, and password reset.

**P1 – High:** 2. Standardize on a single `apiFetch` helper and remove the other two copies. 3. Consolidate the admin surfaces into `AdminDashboard/` and delete `admin.html` + `uchiha-admin-dashboard/`. 4. Extract shared navigation (navbar/side-menu/bottom-nav) into a single template or JS renderer. 5. Move inline styles to proper CSS files; migrate player/ad styles out of `watch.html`.

**P2 – Medium:** 6. Add server-side search + pagination to browse; stop downloading the full catalog client-side. 7. Add missing pages: search results, genre pages, 404, TOS/privacy, account settings, subscription management, watch history, report-broken-stream. 8. Add SEO meta tags, Open Graph, sitemap, robots.txt, JSON-LD, prerendering/SSR or at least per-page meta. 9. Add accessibility: ARIA labels, focus management, keyboard nav for player, alt text, reduced-motion.

**P3 – Low:** 10. Introduce a build system (Vite/webpack) for bundling/minification; add a service worker. 11. Add responsive image optimization (`srcset`); improve desktop grid breakpoints. 12. Implement token refresh and move tokens to more secure storage (HttpOnly cookie) or at least refresh rotation. 13. Reconcile the duplicated `ios/App/App/public/` files with `Frontend/`.

---

**Bottom line:** The frontend is a functional streaming MPA with a solid feature set (auth, browse, watchlist, premium, multi-provider streaming, admin CMS), but it carries significant technical debt: no build tooling, heavy code duplication, missing production pages, poor SEO/accessibility, and **several critical API contract mismatches that currently break continue-watching, resume, profile stats, and password reset**. The expansion to a production-ready platform should start by fixing the API mismatches and consolidating the duplicated infrastructure.
