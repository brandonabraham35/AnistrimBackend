# API Boundary Baseline — AniStrimBackend2

**Date:** 2026-08-20  
**Audit Type:** Read-only baseline  
**Status:** PARTIALLY READY for independent clients  
**Scope:** API boundary stabilization for Web, Mobile, Desktop, and Admin clients

---

## A. Current API Route Inventory

All routes are mounted under `/api/*` in `server.js`.

### Route Groups

| Group         | Mount               | Route File                          | Controller(s)                                     |
| ------------- | ------------------- | ----------------------------------- | ------------------------------------------------- |
| Auth          | `/api/auth`         | `authRoutes.js`                     | `authController`                                  |
| Auth (avatar) | `/api/auth`         | `avatarRoutes.js`                   | `avatarService`                                   |
| Profile       | `/api/profile`      | `profileRoutes.js`                  | `profileController`                               |
| Anime         | `/api/anime`        | `animeRoutes.js`                    | `animeController`, `catalogueController`          |
| Watchlist     | `/api/watchlist`    | `watchlistRoutes.js`                | `watchlistController`                             |
| Payments      | `/api/payments`     | `paymentRoutes.js`                  | `paymentController`                               |
| Admin         | `/api/admin`        | `adminRoutes.js`, `uploadRoutes.js` | `adminController`, `adminImportController`        |
| Download      | `/api/download`     | `downloadRoutes.js`                 | inline                                            |
| Watch         | `/api/watch`        | `watchRoutes.js`                    | `watchController`                                 |
| Stream        | `/api/stream`       | `streamRoutes.js`                   | `streamController`                                |
| Stream Proxy  | `/api/stream-proxy` | `streamProxyRoutes.js`              | `streamProxyController`                           |
| Ads           | `/api/ads`          | `adsRoutes.js`                      | `adsController`                                   |
| Reports       | `/api/reports`      | `reportRoutes.js`                   | `reportController`                                |
| Home          | `/api/home`         | `homeShelfRoutes.js`                | `homeShelfController`, `recommendationController` |
| Upload        | `/api/admin/upload` | `uploadRoutes.js`                   | `bunnyUpload`, `bunnyStreamController`            |

### Full Route Table

#### AUTH (`/api/auth`)

| Method | Route                   | Controller                                 | Auth | Admin | Client(s)                   |
| ------ | ----------------------- | ------------------------------------------ | ---- | ----- | --------------------------- |
| POST   | `/login`                | `authController.login`                     | ❌   | ❌    | Web, Mobile, Admin          |
| POST   | `/signup`               | `authController.signup`                    | ❌   | ❌    | Web, Mobile                 |
| POST   | `/verify-email`         | `authController.verifyEmailToken`          | ❌   | ❌    | Web, Mobile                 |
| POST   | `/verify-otp`           | `authController.verifyEmailToken`          | ❌   | ❌    | Web, Mobile                 |
| POST   | `/resend-otp`           | `authController.resendVerification`        | ❌   | ❌    | Web, Mobile                 |
| GET    | `/me`                   | `authController.getMe`                     | ✅   | ❌    | Web, Mobile, Desktop, Admin |
| POST   | `/forgot-password`      | `authController.forgotPassword`            | ❌   | ❌    | Web, Mobile, Desktop        |
| POST   | `/set-password`         | `authController.setPassword`               | ✅   | ❌    | Web, Mobile, Desktop        |
| POST   | `/reset-password`       | `authController.resetPassword`             | ❌   | ❌    | Web, Mobile, Desktop        |
| POST   | `/refresh`              | `authController.refresh`                   | ❌\* | ❌    | Web, Mobile, Desktop, Admin |
| POST   | `/logout`               | `authController.logout`                    | ✅   | ❌    | Web, Mobile, Desktop, Admin |
| POST   | `/logout-all`           | `authController.logoutAll`                 | ✅   | ❌    | Web, Mobile, Desktop        |
| GET    | `/sessions`             | `authController.listSessions`              | ✅   | ❌    | Web, Mobile, Desktop        |
| DELETE | `/sessions/:id`         | `authController.revokeSession`             | ✅   | ❌    | Web, Mobile, Desktop        |
| POST   | `/change-password`      | `authController.changePassword`            | ✅   | ❌    | Web, Mobile, Desktop        |
| POST   | `/change-email`         | `authController.changeEmail`               | ✅   | ❌    | Web, Mobile, Desktop        |
| POST   | `/change-email/confirm` | `authController.confirmChangeEmail`        | ✅   | ❌    | Web, Mobile, Desktop        |
| POST   | `/account/deactivate`   | `authController.deactivateAccount`         | ✅   | ❌    | Web, Mobile, Desktop        |
| POST   | `/account/delete`       | `authController.deleteAccount`             | ✅   | ❌    | Web, Mobile, Desktop        |
| POST   | `/google/verify`        | `googleVerifyController.verifyGoogleToken` | ❌   | ❌    | Web, Mobile                 |
| POST   | `/google/signup`        | `googleVerifyController.googleSignup`      | ❌   | ❌    | Web, Mobile                 |
| GET    | `/google/client-id`     | inline                                     | ❌   | ❌    | Web                         |
| GET    | `/google/start`         | `googleAuthController.googleRedirect`      | ❌   | ❌    | Mobile                      |
| GET    | `/google/callback`      | `googleAuthController.googleCallback`      | ❌   | ❌    | Mobile                      |
| GET    | `/google/token`         | `googleAuthController.exchangeLoginCode`   | ❌   | ❌    | Mobile                      |
| POST   | `/avatar`               | `avatarService.uploadAvatarForUser`        | ✅   | ❌    | Web, Mobile                 |

#### PROFILE (`/api/profile`)

| Method | Route                 | Controller                            | Auth | Admin |
| ------ | --------------------- | ------------------------------------- | ---- | ----- |
| GET    | `/username-available` | `profileController.checkUsername`     | ✅   | ❌    |
| POST   | `/set-username`       | `profileController.setUsername`       | ✅   | ❌    |
| POST   | `/onboarding`         | `profileController.onboard`           | ✅   | ❌    |
| GET    | `/preferences`        | `profileController.getPreferences`    | ✅   | ❌    |
| PUT    | `/preferences`        | `profileController.updatePreferences` | ✅   | ❌    |
| DELETE | `/history`            | `profileController.clearHistory`      | ✅   | ❌    |

#### ANIME (`/api/anime`)

| Method | Route                      | Controller                           | Auth     | Admin |
| ------ | -------------------------- | ------------------------------------ | -------- | ----- |
| GET    | `/trending`                | `animeController.getTrending`        | ❌       | ❌    |
| GET    | `/latest`                  | `animeController.getLatest`          | ❌       | ❌    |
| GET    | `/recent`                  | `animeController.getLatest`          | ❌       | ❌    |
| GET    | `/popular`                 | `animeController.getTrending`        | ❌       | ❌    |
| GET    | `/featured`                | `animeController.getFeatured`        | ❌       | ❌    |
| GET    | `/search`                  | `animeController.search`             | ❌       | ❌    |
| GET    | `/search/advanced`         | `catalogueController.advancedSearch` | ❌       | ❌    |
| GET    | `/genres`                  | `animeController.getGenres`          | ❌       | ❌    |
| GET    | `/recommendations/:id`     | `animeController.getRecommendations` | ❌       | ❌    |
| GET    | `/resolve/stream`          | `animeController.resolveStream`      | ❌       | ❌    |
| GET    | `/kitsu/:kitsuId/episodes` | inline                               | ❌       | ❌    |
| GET    | `/:animeId/episodes`       | inline                               | optional | ❌    |
| GET    | `/:id`                     | `animeController.getById`            | optional | ❌    |
| GET    | `/:id/stream/:episode`     | `catalogueController.getStream`      | ✅       | ❌    |

#### WATCH (`/api/watch`) — All require auth

| Method | Route                         | Description             |
| ------ | ----------------------------- | ----------------------- |
| GET    | `/next/:animeId/:ep`          | Next episode resolution |
| GET    | `/skip-times/:malId/:ep`      | OP/ED skip timestamps   |
| PUT    | `/progress`                   | Save watch progress     |
| GET    | `/progress/:episodeId`        | Get episode progress    |
| GET    | `/markers/:episodeId`         | Skip markers            |
| GET    | `/anime/:animeId/progress`    | Anime progress map      |
| GET    | `/continue-watching`          | Continue-watching rail  |
| DELETE | `/continue-watching/:animeId` | Dismiss from rail       |
| POST   | `/restart/:animeId`           | Reset anime progress    |
| GET    | `/history`                    | Watch history           |
| DELETE | `/history`                    | Clear history           |
| GET    | `/progress/batch/:animeId`    | Batch progress          |

#### WATCHLIST (`/api/watchlist`) — All require auth

| Method | Route             | Description      |
| ------ | ----------------- | ---------------- |
| POST   | `/add`            | Legacy alias     |
| POST   | `/`               | UPSERT watchlist |
| GET    | `/continue`       | Legacy alias     |
| GET    | `/`               | Get watchlist    |
| GET    | `/stats`          | Profile stats    |
| POST   | `/progress`       | Legacy alias     |
| GET    | `/progress/:epId` | Legacy alias     |
| DELETE | `/:animeId`       | Remove anime     |
| POST   | `/:animeId`       | Toggle watchlist |

#### STREAMING (`/api/stream`)

| Method | Route                   | Auth     | Description            |
| ------ | ----------------------- | -------- | ---------------------- |
| POST   | `/authorize`            | ✅       | Mint stream tokens     |
| GET    | `/:animeTitle/:ep`      | ✅       | Resolve stream         |
| GET    | `/providers/:title/:ep` | optional | Provider capabilities  |
| POST   | `/offline-download`     | ✅       | Download authorization |

#### STREAM PROXY (`/api/stream-proxy`)

| Method  | Route                | Auth  | Description    |
| ------- | -------------------- | ----- | -------------- |
| OPTIONS | `/:streamId`         | ❌    | CORS preflight |
| OPTIONS | `/:streamId/:suffix` | ❌    | CORS preflight |
| GET     | `/:streamId`         | token | Stream media   |
| GET     | `/:streamId/:suffix` | token | Stream media   |

#### PAYMENTS (`/api/payments`)

| Method | Route                   | Auth | Admin | Description                     |
| ------ | ----------------------- | ---- | ----- | ------------------------------- |
| POST   | `/checkout`             | ✅   | ❌    | Initiate payment                |
| GET    | `/ipn-listener`         | ❌   | ❌    | Pesapal webhook                 |
| GET    | `/callback`             | ❌   | ❌    | Payment callback (returns HTML) |
| GET    | `/verify-subscription`  | ❌   | ❌    | Poll subscription status        |
| POST   | `/refund`               | ✅   | ✅    | Refund subscription             |
| POST   | `/cancel`               | ✅   | ✅    | Cancel subscription             |
| GET    | `/subscription-revenue` | ✅   | ✅    | Revenue stats                   |

#### ADMIN (`/api/admin`) — All require auth + admin

| Method              | Route                        | Description             |
| ------------------- | ---------------------------- | ----------------------- |
| GET                 | `/stats`                     | Dashboard stats         |
| GET                 | `/dashboard/overview`        | Overview                |
| GET                 | `/dashboard/health`          | Health                  |
| GET                 | `/dashboard/health/history`  | Health history          |
| GET                 | `/dashboard/health/metrics`  | Health metrics          |
| GET                 | `/dashboard/charts/:type`    | Chart data              |
| GET                 | `/dashboard/activity/recent` | Recent activity         |
| GET                 | `/dashboard/ads-metrics`     | Ads metrics             |
| GET                 | `/audit`                     | Audit logs              |
| GET/POST/PUT/DELETE | `/users/*`                   | User management         |
| GET/POST/PUT/DELETE | `/anime/*`                   | Anime CMS               |
| GET/POST            | `/animeheaven/*`             | AnimeHeaven import/sync |
| GET/POST/PUT/DELETE | `/genres/*`                  | Genre management        |
| GET/POST/PUT/DELETE | `/episodes/*`                | Episode management      |
| GET/PUT             | `/settings`                  | Settings                |
| GET/POST/PUT/DELETE | `/ads/*`                     | Ads management          |
| GET/PUT             | `/payments/*`                | Payments                |
| GET                 | `/logs`                      | Activity logs           |

#### ADS (`/api/ads`)

| Method | Route     | Auth | Admin |
| ------ | --------- | ---- | ----- |
| GET    | `/config` | ✅   | ❌    |
| PUT    | `/config` | ✅   | ✅    |
| GET    | `/policy` | ✅   | ❌    |
| POST   | `/event`  | ✅   | ❌    |

#### HOME (`/api/home`)

| Method | Route                      | Auth | Admin |
| ------ | -------------------------- | ---- | ----- |
| GET    | `/sections`                | ❌   | ❌    |
| GET    | `/recommendations`         | ✅   | ❌    |
| POST   | `/recommendations/refresh` | ✅   | ❌    |
| POST   | `/refresh`                 | ✅   | ✅    |

#### REPORTS (`/api/reports`)

| Method | Route                | Auth | Admin |
| ------ | -------------------- | ---- | ----- |
| POST   | `/stream`            | ✅   | ❌    |
| POST   | `/client-event`      | ❌   | ❌    |
| GET    | `/stream`            | ✅   | ✅    |
| PUT    | `/stream/:id/status` | ✅   | ✅    |

#### DOWNLOAD (`/api/download`)

| Method | Route         | Auth |
| ------ | ------------- | ---- |
| GET    | `/:episodeId` | ✅   |

#### UPLOAD (`/api/admin/upload`)

| Method | Route                                    | Auth | Admin |
| ------ | ---------------------------------------- | ---- | ----- |
| GET    | `/_ping`                                 | ❌   | ❌    |
| GET    | `/_health`                               | ✅   | ❌    |
| POST   | `/`                                      | ✅   | ✅    |
| POST   | `/anime`, `/cover`, `/covers`            | ✅   | ✅    |
| POST   | `/banner`, `/banners`                    | ✅   | ✅    |
| POST   | `/thumbnail`, `/thumbnails`              | ✅   | ✅    |
| POST   | `/avatar`, `/profile`, `/profile/avatar` | ✅   | ❌    |
| POST   | `/video`                                 | ✅   | ✅    |
| DELETE | `/video/:videoId`                        | ✅   | ✅    |

#### HEALTH (/api/health, /health/provider)

| Method | Route              | Auth | Description     |
| ------ | ------------------ | ---- | --------------- |
| GET    | `/api/health`      | ❌   | Server health   |
| GET    | `/health/provider` | ❌   | Provider health |

---

## B. Controllers Used by Each Route

| Controller                 | Routes                                                    | Services Used                                                                                           |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `authController`           | `/api/auth/*`                                             | `sessionService`, `userDtoService`, `mailer`                                                            |
| `googleVerifyController`   | `/api/auth/google/verify`, `/signup`                      | `googleIdentityService`, `sessionService`, `userDtoService`                                             |
| `googleAuthController`     | `/api/auth/google/start`, `/callback`, `/token`           | `googleIdentityService`, `sessionService`, `userDtoService`                                             |
| `avatarService`            | `/api/auth/avatar`                                        | `cloudinary`, `bunnyUpload`, `sharp`                                                                    |
| `profileController`        | `/api/profile/*`                                          | `userDtoService`, `preferencesService`                                                                  |
| `animeController`          | `/api/anime/*`                                            | `contentVisibility`, `episodeAccess`, `cacheService`, `consumetProvider`                                |
| `catalogueController`      | `/api/anime/search/advanced`, `/api/anime/:id/stream/:ep` | `catalogueService`, `kitsuProvider`, `consumetProvider`, `cacheService`                                 |
| `watchController`          | `/api/watch/*`                                            | `aniSkipService`                                                                                        |
| `watchlistController`      | `/api/watchlist/*`                                        | — (direct DB)                                                                                           |
| `streamController`         | `/api/stream/*`                                           | `streamingService`, `streamProxy`, `streamToken`, `streamProxyStore`, `episodeAccess`, `sessionService` |
| `streamProxyController`    | `/api/stream-proxy/*`                                     | `streamToken`, `streamProxyStore`, `ssrfGuard`                                                          |
| `adsController`            | `/api/ads/*`                                              | — (direct DB)                                                                                           |
| `reportController`         | `/api/reports/*`                                          | `auditLogger`                                                                                           |
| `homeShelfController`      | `/api/home/sections`, `/refresh`                          | `homeShelfService`                                                                                      |
| `recommendationController` | `/api/home/recommendations`, `/refresh`                   | `recommendationService`, `preferencesService`                                                           |
| `paymentController`        | `/api/payments/*`                                         | `pesapalService`, `premiumScheduler`                                                                    |
| `adminController`          | `/api/admin/*`                                            | `adminHealthMetrics`, `auditLogger`                                                                     |
| `adminImportController`    | `/api/admin/animeheaven/*`, `/import/*`                   | `animeHeavenImportService`, `animeHeavenCatalogService`                                                 |
| `bunnyStreamController`    | `/api/admin/upload/video`                                 | `bunnyUpload`, `cloudinary`                                                                             |

---

## C. Services Used by Controllers

| Service                     | Used By                                                                        | Purpose                                    |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `sessionService`            | authController, googleVerifyController, googleAuthController, streamController | Session + refresh token lifecycle          |
| `userDtoService`            | authController, profileController                                              | Canonical user DTO                         |
| `googleIdentityService`     | googleVerifyController, googleAuthController                                   | Google identity resolution                 |
| `googleUpsert`              | googleIdentityService                                                          | Google user create/find/auth               |
| `preferencesService`        | profileController, userDtoService, recommendationController                    | User preferences                           |
| `streamingService`          | streamController                                                               | Stream resolution                          |
| `streamProxy`               | streamController                                                               | URL rewriting to proxy                     |
| `streamToken`               | streamController, streamProxyController                                        | HMAC stream tokens                         |
| `streamProxyStore`          | streamController, streamProxyController                                        | Server-side stream context                 |
| `episodeAccess`             | animeController, streamController, middleware/auth                             | Episode entitlement                        |
| `contentVisibility`         | animeController, adminController                                               | Public content filtering                   |
| `homeShelfService`          | homeShelfController                                                            | Home-shelf section building                |
| `recommendationService`     | recommendationController                                                       | Personalized recommendations               |
| `animeHeavenImportService`  | adminImportController                                                          | AnimeHeaven catalog import                 |
| `animeHeavenCatalogService` | adminImportController                                                          | Catalog daily refresh                      |
| `animeHeavenProvider`       | streamingService                                                               | AnimeHeaven scraping                       |
| `consumetProvider`          | catalogueController, animeController                                           | Consumet/AniList search                    |
| `kitsuProvider`             | catalogueController                                                            | Kitsu search                               |
| `hostedConsumetProvider`    | streamingService                                                               | Hosted Consumet fallback                   |
| `providerRegistry`          | streamingService                                                               | Provider registration                      |
| `aniSkipService`            | watchController                                                                | Skip timestamps                            |
| `pesapalService`            | paymentController                                                              | Pesapal payment integration                |
| `premiumScheduler`          | paymentController                                                              | Subscription state management              |
| `avatarService`             | avatarRoutes                                                                   | Avatar upload pipeline                     |
| `cacheService`              | animeController, catalogueController                                           | Redis/in-memory cache                      |
| `healthService`             | server.js                                                                      | Health sample pruning                      |
| `providerHealthMonitor`     | server.js                                                                      | Provider health monitoring                 |
| `adminHealthMetrics`        | adminController                                                                | Health metrics for admin                   |
| `premiumAutomation`         | server.js                                                                      | Premium automation (Viral Threshold)       |
| `streamCacheService`        | server.js                                                                      | Stream cache sweeper                       |
| `inFlightResolverManager`   | streamingService                                                               | Concurrent stream resolution deduplication |

---

## D. Authentication Flow

```
LOGIN
  → POST /api/auth/login { email, password }
  → Validate credentials (bcrypt.compare)
  → Check is_verified, status = 'active'
  → sessionService.createSession(user)
      → INSERT into user_sessions (id, refresh_hash, device, platform, ip_hash)
      → INSERT into session_refresh_tokens
      → jwt.sign → access token (15min, claims: uid, sid, tv, roles[])
  → buildUserDto(user) → canonical user object
  → return { token, refreshToken, sessionId, user: DTO }

API REQUEST
  → Authorization: Bearer <access_token>
  → middleware/auth.js verifyBearerToken()
      → jwt.verify (HS256, JWT_SECRET)
      → Reject non-session tokens (purpose claim)
      → DB reload user (authoritative status, token_version)
      → Status gate: must be 'active'
      → token_version check: decoded.tv === user.token_version
      → Session check: user_sessions.id === decoded.sid, not revoked
      → Attach req.user, req.userId, req.tokenClaims

ACCESS TOKEN EXPIRY (after 15 minutes)
  → Client receives 401
  → POST /api/auth/refresh { refreshToken }
  → sessionService.rotateRefresh()
      → Look up presented hash in session_refresh_tokens
      → REUSE DETECTION: if already used → revoke ALL sessions
      → Check session not revoked, not expired
      → Check user active
      → Mark old token used, generate new refresh token
      → Update user_sessions.refresh_hash, expires_at
      → INSERT new hash into session_refresh_tokens
      → Sign new access token
  → return { token, refreshToken, sessionId, user: DTO }

LOGOUT
  → POST /api/auth/logout (with access token)
  → authController.logout
  → sessionService.revokeSession(sid, userId)
  → Also revokes in-flight stream tokens for the session
  → return { success: true }

LOGOUT-ALL
  → POST /api/auth/logout-all
  → UPDATE users SET token_version = token_version + 1
  → Revoke all sessions
  → return { success: true }
```

---

## E. Refresh-Token Flow

| Aspect                | Value                                                     |
| --------------------- | --------------------------------------------------------- |
| Access token TTL      | 15 minutes                                                |
| Refresh token TTL     | 30 days                                                   |
| Refresh token storage | Hashed (SHA-256) in `user_sessions.refresh_hash`          |
| Rotation tracking     | `session_refresh_tokens` table                            |
| Reuse detection       | If presented hash has `used_at` set → revoke ALL sessions |
| Storage               | Database (not Redis)                                      |
| Revocation            | `user_sessions.revoked_at`, `users.token_version`         |

---

## F. Streaming Flow

```
GET /api/stream/:animeTitle/:episodeNumber
  → protect middleware (auth required)
  → Determine premium status (entitlement, not JWT claim)
  → resolveEpisodeAuth(): DB lookup for anime + episode
  → If premium episode and not premium user → 403
  → streamingService.resolveStream(animeTitle, ep, { isPremium })
      → providerRegistry picks AnimeHeaven / Consumet / Hosted Consumet
      → inFlightResolverManager dedupes concurrent resolves
      → streamCacheService caches results
  → streamProxy.rewriteResultToProxy()
      → Sources rewritten to /api/stream-proxy/:streamId
      → Cookies/referer/origin stored server-side
  → return { success, provider, streamUrl, sources, subtitles, bestQuality, tier, episodeNumber }

POST /api/stream/authorize { episodeId }
  → protect middleware
  → canWatch() authorization gate
  → enforceDeviceLimit() based on plan
  → Ensure stream contexts exist (resolve if needed)
  → mint() HMAC token per streamId (bound: userId, episodeId, streamId, ip, sid, tv)
  → return { token, streamId, streams[], expiresIn }

GET /api/stream-proxy/:streamId?token=...
  → Verify HMAC token
  → Check token matches store context (userId/episodeId/streamId)
  → Proxy media (HLS rewrite, subtitle, range requests)
```

---

## G. Payment Flow

```
POST /api/payments/checkout
  → protect middleware
  → pesapalService.initializeCheckout()
  → Saves PENDING subscription record
  → Returns payment_link (Pesapal redirect URL)

GET /api/payments/ipn-listener
  → Public IPN webhook (Pesapal → backend)
  → No auth
  → Returns 200 to confirm receipt

GET /api/payments/callback
  → Pesapal redirects user browser here
  → Returns HTML page (with inline CSS/JS)
  → Deep-links back to app (anistrim:// or web URL)

GET /api/payments/verify-subscription
  → Public polling endpoint
  → Returns subscription status
```

---

## H. Google Authentication Flow

```
WEB:
  → GET /api/auth/google/client-id
  → Google Identity Services (GIS) on frontend
  → POST /api/auth/google/verify { idToken }
  → googleIdentityService.resolveGoogleIdentity(token, 'login')
  → findGoogleUser (by google_id) or findUserByEmail
  → If no account → 404 GOOGLE_NO_ACCOUNT
  → If password account → 403 GOOGLE_ACCOUNT_NOT_LINKED
  → authenticateExistingGoogleUser()
  → createSession() → tokens + DTO

MOBILE (Capacitor):
  → GET /api/auth/google/start?intent=login
  → Redirects to Google OAuth
  → GET /api/auth/google/callback?code=...
  → Returns HTML with deep-link redirect (window.location)
  → App receives deep-link, extracts short-lived code
  → GET /api/auth/google/token?code=...
  → Exchanges code for JWT + user + intent
```

---

## I. Current Response Formats

Responses are **inconsistent** across the codebase:

| Pattern         | Example                                    | Used By                                        |
| --------------- | ------------------------------------------ | ---------------------------------------------- |
| Raw array       | `[...]`                                    | `/api/anime/trending`, `/api/anime/latest`     |
| Raw object      | `{ id, title, ... }`                       | `/api/anime/:id`                               |
| Nested          | `{ results, currentPage, totalPages }`     | `/api/anime/search/advanced` (Consumet format) |
| Envelope        | `{ success: true, data }`                  | Some admin endpoints                           |
| Auth envelope   | `{ token, refreshToken, sessionId, user }` | `/api/auth/login`, `/api/auth/refresh`         |
| Stream envelope | `{ success, ...result }`                   | `/api/stream/:title/:ep`                       |
| Simple object   | `{ id: r.insertId, message }`              | `/api/admin/ads` create                        |

### Field Naming Inconsistency

| Field (DB)    | API Name (camelCase)         | API Name (snake_case)           |
| ------------- | ---------------------------- | ------------------------------- |
| `avatar_url`  | `avatarUrl` (userDtoService) | `avatar_url` (raw endpoints)    |
| `cover_image` | `coverImage` (Consumet)      | `cover_image` (animeController) |
| `is_premium`  | `isPremium` (DTO)            | `is_premium` (raw)              |
| `created_at`  | `createdAt` (DTO)            | `created_at` (raw)              |

---

## J. Current Error Formats

| Format                                         | Example                                              | Used By          |
| ---------------------------------------------- | ---------------------------------------------------- | ---------------- |
| `{ message }`                                  | `{ message: 'Anime not found.' }`                    | Most controllers |
| `{ code, message }`                            | `{ code: 'TOKEN_VERSION_MISMATCH', message: '...' }` | Auth, session    |
| `{ success: false, error }`                    | `{ success: false, error: 'Stream failed.' }`        | Stream           |
| `{ error }`                                    | `{ error: 'Invalid ID' }`                            | Some endpoints   |
| `{ code, requiredTier, availableAt, message }` | Premium gate                                         | episodeAccess    |

**Missing everywhere:** request ID, consistent machine-readable error code.

---

## K. Current Pagination Formats

| Endpoint                     | Pagination           | Format                                 |
| ---------------------------- | -------------------- | -------------------------------------- |
| `/api/anime/trending`        | ✅ `page`, `perPage` | `.slice()` on client, no metadata      |
| `/api/anime/latest`          | ✅ `limit`           | `.slice()` on client                   |
| `/api/anime/search`          | ❌ Fixed `LIMIT 50`  | Array only                             |
| `/api/anime/search/advanced` | ✅ Consumet format   | `{ results, currentPage, totalPages }` |
| `/api/watch/history`         | ✅ `limit`           | `{ items }`                            |
| `/api/admin/users`           | ❌ Returns all       | Array                                  |
| `/api/admin/anime`           | ❌ Returns all       | Array                                  |

**No standard pagination metadata envelope.**

---

## L. Current Frontend-Specific Responses

| Location                  | Issue                                                 | Impact                                    |
| ------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| `paymentController.js`    | Returns full HTML pages for callback                  | Mobile/desktop clients can't consume JSON |
| `googleAuthController.js` | Returns HTML with `window.location` JS redirect       | Non-browser clients broken                |
| `watchController.js`      | `resumeUrl: 'watch.html?id=...'`                      | Hardcoded frontend page                   |
| `authController.js`       | `reset-password.html?token=`                          | Hardcoded frontend URL                    |
| `server.js`               | Serves `Frontend/` and `AdminDashboard/` static files | API coupled to UI                         |

---

## M. Current CORS Configuration

```javascript
const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://10.5.50.55:3000',
  ...(process.env.FRONTEND_URL || '').split(',')
]);
const localDevOrigin = NODE_ENV === 'production'
  ? /^$/
  : /^https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?$/;

app.use(cors({
  origin(origin, callback) { ... },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true,
}));
```

**Issues:** Mobile (Capacitor) and desktop origins not in allowlist. Production blocks all localhost regardless of platform.

---

## N. Current Static Frontend Serving

```javascript
app.use(express.static(path.join(__dirname, 'Frontend')));
app.use('/admin', express.static(path.join(__dirname, 'AdminDashboard')));
app.use('/uploads', ...);

// SPA fallback
app.get(/^\/admin(\/.*)?$/, (req, res) => res.sendFile(... 'dashboard.html'));
app.get(/.*/, (req, res) => res.sendFile(... 'index.html'));
```

The API serves the web frontend and admin dashboard — presentation coupled to the API deployment.

---

## O. Current Database-to-Response Transformations

### GOOD (Transformed)

| Endpoint                       | Transformation                                                             |
| ------------------------------ | -------------------------------------------------------------------------- |
| `/api/auth/me`, login, refresh | `buildUserDto()` — camelCase, filters `password_hash`, `verification_code` |
| `/api/anime/:id`               | Explicit column selection + `maskEpisodes()`                               |
| `/api/watch/*`                 | Canonical field names (camelCase)                                          |
| `/api/watchlist/*`             | Canonical camelCase fields                                                 |

### BAD (Raw DB Rows Exposed)

| Endpoint                 | Issue                          |
| ------------------------ | ------------------------------ |
| `/api/admin/anime/:id`   | `SELECT *` raw row returned    |
| `/api/admin/episodes`    | `SELECT e.*, a.title` raw rows |
| `/api/admin/getAllAnime` | Assumes `selectAllAnime` shape |
| `/api/admin/ads`         | Raw row with renames           |

### RAW SQL USAGE (18 occurrences of `SELECT *`)

Found in: authController (internal), profileController (internal), animeController (anime+episodes), adminController (users, episodes, anime, ads), adminImportController, adsController, watchController, paymentController.

---

## P. Hidden Dependencies Between Frontend/AdminDashboard and API

### Frontend Dependencies

| Frontend File            | Depends On                           | API Endpoint                       |
| ------------------------ | ------------------------------------ | ---------------------------------- |
| `Frontend/config.js`     | `window.Auth` localStorage keys      | `token`, `user`, `refresh_token`   |
| `Frontend/js/session.js` | `GET /api/auth/me`                   | Returns DTO with `avatarUrl`       |
| `Frontend/js/api.js`     | `POST /api/auth/refresh`             | Envelope `{ token, refreshToken }` |
| `Frontend/browse.js`     | `GET /api/anime/trending?perPage=10` | Array format                       |
| `Frontend/watch.js`      | `GET /api/watch/progress/:ep`        | Canonical camelCase                |
| `Frontend/profile.js`    | `POST /api/auth/avatar`              | `{ success, avatar_url }`          |
| `Frontend/scrpt.js`      | `State.user` localStorage            | Mixed case object                  |

### AdminDashboard Dependencies

| AdminDashboard File          | Depends On                                                  |
| ---------------------------- | ----------------------------------------------------------- |
| `AdminDashboard/js/api.js`   | `/api/admin/*` with `{ success, data }` envelope assumption |
| `AdminDashboard/js/auth.js`  | `/api/auth/login` returns `{ token, user }`                 |
| `AdminDashboard/js/users.js` | `/api/admin/users` array format                             |
| `AdminDashboard/js/anime.js` | `/api/admin/anime` array format                             |

---

## Conclusions

### ALREADY SAFE FOR INDEPENDENT CLIENTS

1. **Authentication system** — JWT + refresh rotation + reuse detection is fully client-agnostic (Authorization header, no cookies required).
2. **Streaming API** — Properly isolated. Clients get proxied URLs + tokens, never see provider internals.
3. **Watch/Progress APIs** — Canonical camelCase field names, client-agnostic.
4. **Public catalog APIs** — `/api/anime/trending`, `/latest`, `/featured`, `/genres` work from any HTTP client.
5. **Admin API separation** — All under `/api/admin` with `protect, adminOnly` middleware. JSON-only.
6. **User DTO** — `buildUserDto()` provides a clean, consistent user object (camelCase, filtered).
7. **Session management** — Fully API-based, no cookie coupling.

### MUST CHANGE (for independent clients)

| Priority | Change                                                               | Affected Files                                    |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| P0       | Fix CORS for mobile/desktop origins                                  | `server.js`                                       |
| P0       | Standardize error responses (machine-readable code + request ID)     | All controllers                                   |
| P1       | Add consistent response envelope                                     | All controllers                                   |
| P1       | Add pagination metadata                                              | animeController, adminController, watchController |
| P1       | Remove HTML from payment callback                                    | `paymentController.js`                            |
| P1       | Remove HTML from Google OAuth callback                               | `googleAuthController.js`                         |
| P1       | Remove hardcoded frontend URLs (`watch.html`, `reset-password.html`) | `watchController.js`, `authController.js`         |
| P2       | Add `/api/v1` version boundary                                       | `server.js`, all route files                      |
| P2       | DTO transformation for admin raw-row endpoints                       | `adminController.js`                              |
| P2       | Separate static serving (Frontend/, AdminDashboard/)                 | `server.js` deployment                            |
| P3       | OpenAPI documentation                                                | New file                                          |

### MUST NOT CHANGE

| Item                               | Reason                                         |
| ---------------------------------- | ---------------------------------------------- |
| **Streaming/provider logic**       | Working, properly isolated, security-hardened  |
| **Stream proxy + token system**    | Secure, client-agnostic                        |
| **Authentication/session system**  | Solid, working, client-agnostic                |
| **Database schema**                | No changes in baseline phase                   |
| **Watch/Progress API field names** | Frontend already depends on camelCase contract |
| **Public catalog API shapes**      | Frontend depends on array format               |
| **Admin API auth model**           | `protect` + `adminOnly` is correct             |

### Files to be Modified in Subsequent Phases

| Phase                | Files                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| P0 CORS + Errors     | `server.js`, `middleware/errorHandler.js` (new), `middleware/requestId.js` (new), all controllers (error mapping) |
| P1 Response Envelope | All controllers, `utils/response.js` (new)                                                                        |
| P1 Pagination        | `animeController.js`, `adminController.js`, `watchController.js`                                                  |
| P1 HTML Removal      | `paymentController.js`, `googleAuthController.js`                                                                 |
| P1 URL Decoupling    | `watchController.js`, `authController.js`                                                                         |
| P2 Versioning        | `server.js`, `routes/` restructure                                                                                |
| P2 Admin DTO         | `adminController.js`                                                                                              |
| P2 Static Separation | Deployment config, `server.js`                                                                                    |
| P3 OpenAPI           | New `api-docs/` directory                                                                                         |

### Sensitive APIs Requiring Regression Testing

| API                                    | Why Sensitive                                  |
| -------------------------------------- | ---------------------------------------------- |
| `POST /api/auth/login`                 | Core auth — cannot break                       |
| `POST /api/auth/refresh`               | Token rotation — security critical             |
| `POST /api/auth/logout`, `/logout-all` | Session revocation                             |
| `GET /api/stream/:title/:ep`           | Streaming — must not break playback            |
| `POST /api/stream/authorize`           | Token minting — security critical              |
| `GET /api/stream-proxy/:streamId`      | Media proxy — streaming must remain functional |
| `POST /api/payments/checkout`          | Payment — must not break billing               |
| `GET /api/payments/ipn-listener`       | Webhook — must not break payment confirmation  |
| `GET /api/anime/trending`              | Homepage load — must not break web client      |
| `GET /api/anime/search/advanced`       | Search — must not break browse                 |
| `GET /api/watch/history`               | Watch progress — must not break resume         |
| `GET /api/auth/me`                     | Session restore — must not break login state   |
| All `/api/admin/*`                     | Admin dashboard — must remain functional       |

---

## Regression Test Strategy

For each phase, run:

1. `npm test` — existing 97 tests
2. Manual API smoke tests via curl/Postman for the sensitive APIs
3. Web frontend manual test (login, browse, watch, profile)
4. Admin dashboard manual test (stats, anime, users)
