# AniStrim API Field Contract

**Date:** 2026-08-20  
**Status:** All public API responses use **camelCase** field names. Database columns are NEVER renamed — DTO/serializer utilities transform snake_case DB rows into camelCase at the controller/service boundary.

---

## Naming Convention

| DB column (snake_case) | API field (camelCase) |
| ---------------------- | --------------------- |
| `avatar_url`           | `avatarUrl`           |
| `cover_image`          | `coverImage`          |
| `access_tier`          | `accessTier`          |
| `is_premium`           | `isPremium`           |
| `created_at`           | `createdAt`           |
| `updated_at`           | `updatedAt`           |
| `episode_number`       | `number`              |
| `duration_sec`         | `durationSec`         |
| `position_sec`         | `positionSec`         |
| `video_url`            | `videoUrl`            |
| `thumbnail_url`        | `thumbnailUrl`        |
| `order_tracking_id`    | `orderTrackingId`     |
| `payment_link`         | `paymentLink`         |
| `tx_ref`               | `txRef`               |
| `ends_at`              | `endsAt`              |
| `paid_at`              | `paidAt`              |

> Legacy snake_case aliases (e.g. `cover_image`, `video_url`, `is_premium`) are also emitted in limited cases to preserve backward compatibility with existing clients, but the **canonical names are camelCase**.

---

## Domain DTOs

### User / Auth (services/userDtoService.js)

`id`, `email`, `username`, `displayName`, `avatarUrl`, `status`, `emailVerified`, `authProvider`, `isAdmin`, `roles`, `createdAt`, `lastLoginAt`, `onboarded`, `entitlement`, `preferences`

`entitlement: { isPremium, plan, expiresAt, source }`

### Anime (controllers/animeController.js → publicAnime)

`id`, `title`, `titleJapanese`, `description`, `coverImage`, `bannerUrl`, `rating`, `year`, `studio`, `status`, `isPremium`, `isFeatured`, `viewCount`, `genres`, `mediaType`, `tags`, `accessTier`, `createdAt`, `updatedAt`

### Episode (routes/animeRoutes.js, controllers/animeController.js → maskEpisodes)

`id`, `number`, `season`, `title`, `description`, `thumbnailUrl`, `videoUrl`, `durationSec`, `isPremium`, `viewCount`, `locked`, `effectiveTier`, `availableAt`, `accessState`, `accessTier`

### Watchlist (controllers/watchlistController.js)

`id`, `animeId`, `title`, `poster`, `status`, `episodesWatched`, `totalEpisodes`, `createdAt`, `updatedAt`

Stats: `watching`, `completed`, `planToWatch`, `total`

### Watch Progress (controllers/watchController.js)

`positionSec`, `durationSec`, `percent`, `completed`, `updatedAt`

### Payment / Subscription (controllers/paymentController.js)

- Checkout: `paymentLink`, `txRef`, `orderTrackingId`
- Verify: `status`, `state`, `plan`, `amount`, `currency`, `isPremium`, `name`, `email`, `endsAt`, `paidAt`

### Admin Dashboard (controllers/adminController.js)

- `recentAnime`: `id`, `title`, `coverImage`, `status`, `year`, `createdAt`
- `recentEpisodes`: `id`, `episodeNumber`, `title`, `thumbnailUrl`, `videoStatus`, `createdAt`, `animeTitle`
- `activityLogs`: `action`, `createdAt`, `ipAddress`, `userName`
- `topAnime`: `id`, `title`, `coverImage`, `viewCount`
- `latestUsers`: `id`, `name`, `email`, `avatarUrl`, `createdAt`

---

## Sensitive / Internal Fields — NEVER Exposed

The following are **stripped** from all public responses via the DTO mappers:

- `users.password_hash`
- `users.verification_code` / `otp_hash` / `otp_expires_at`
- `users.refresh_token` / `token_version`
- `users.google_refresh_token`
- `email_change_requests.otp_hash`
- `anime.cover_public_id` / `banner_public_id`
- `episodes.cloudinary_public_id` / `thumbnail_public_id`
- `episodes.animeheaven_episode_key`
- `anime.mal_id` / `consumet_id` / `anime_mappings` / `provider_slug`

> **`video_url` is masked to `null` for non-entitled callers** by `maskEpisodes()` (utils/episodeAccess.js) — the frontier is the server, never the client.

---

## Sensitive Query Hygiene

Public-facing `SELECT *` queries were replaced with **explicit column whitelists** in:

- `controllers/animeController.js` (`getById` — anime + episodes)
- `routes/animeRoutes.js` (`/:animeId/episodes`)

This ensures sensitive/internal DB rows are never loaded into the response object in the first place.

---

## Reusable DTO Utilities

- `services/userDtoService.js` — canonical user DTO (auth, profile, me).
- `services/apiDtoService.js` — anime/episode/watchlist/watch/payment mappers + `USER_SENSITIVE`/`INTERNAL_ID_FIELDS` denylists.

---

## Client Compatibility

Frontend (`Frontend/js/api.js`) and Admin Dashboard (`AdminDashboard/js/api.js`) unwrap the success envelope (`{ success, data, meta }`), so legacy consumers reading `result.data.<field>` continue to work. Limited snake_case aliases (`cover_image`, `video_url`, `is_premium`) are retained for older React clients.

---

## Regression

Run `node --test` (or `node run-regression-tests.js`) to verify the success envelope, error contract, and episode masking (no `video_url` leak to anonymous/free users).
