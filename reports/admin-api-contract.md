# Admin API Contract Stabilization

## 1. Problem

The admin API endpoints (`/api/admin/*`) previously returned **raw MySQL rows** and `SELECT *` results directly. This created tight coupling between:

- the **database schema**,
- the **Admin dashboard**,
- any **future client** (Web / Mobile / Desktop / Admin).

A DB column rename, addition, or removal would change the API shape and silently break the dashboard, and sensitive/internal columns could leak.

## 2. Goal

Admin API responses must use **explicit DTOs** — a stable, whitelisted, camelCase contract independent of the DB schema — while preserving every field the existing AdminDashboard reads (to avoid breaking it).

## 3. Approach

**New module:** `services/adminDtoService.js`

- Provides explicit DTO mappers: `userDto`, `animeDto`, `episodeDto`, `genreDto`, `adDto`, `paymentDto`, `logDto`, `auditDto`.
- Each DTO emits **camelCase canonical fields** (stable contract) **plus snake_case aliases** (so the existing dashboard forms/reads keep working — important because `anime.js` binds form fields by snake_case `name` attributes, and `users.js`/`payments.js`/`logs.js` read snake_case).
- **Whitelists** fields — no `SELECT *` passthrough; internal/provider/sensitive columns (public IDs, provider keys, tokens, password_hash, etc.) are never emitted.
- Audit `before_json`/`after_json` diffs are **redacted** to drop sensitive keys (`password_hash`, `verification_code`, `otp_hash`, `refresh_token`, `reset_token`, `stripe_customer_id`, `google_refresh_token`).

`controllers/adminController.js` GET handlers now route rows through these mappers and use the standard success/paginated envelope (`{ success, data, meta }`). The `AdminDashboard/js/api.js` `unwrapAdminEnvelope` continues to work because the envelope is preserved.

## 4. Endpoint audit & DTO mapping

| Endpoint                                 | DB query                                       | DTO applied                 | Pagination                   |
| ---------------------------------------- | ---------------------------------------------- | --------------------------- | ---------------------------- |
| `GET /api/admin/users`                   | `users` (whitelist)                            | `userDto`                   | **Added** (page/limit/count) |
| `GET /api/admin/users/:id`               | `users` (whitelist)                            | `userDto`                   | –                            |
| `GET /api/admin/anime`                   | `anime` + episode_count + genres               | `animeDto` + genres         | Already present              |
| `GET /api/admin/anime/:id`               | `anime` + genres + episode_count + total views | `animeDto`                  | –                            |
| `GET /api/admin/episodes`                | `episodes` join `anime`                        | `episodeDto`                | –                            |
| `GET /api/admin/anime/:animeId/episodes` | `episodes`                                     | `episodeDto`                | –                            |
| `GET /api/admin/episodes/:id`            | `episodes`                                     | `episodeDto`                | –                            |
| `GET /api/admin/genres`                  | `genres` (id, name)                            | `genreDto`                  | –                            |
| `GET /api/admin/ads`                     | `ads`                                          | `adDto`                     | –                            |
| `GET /api/admin/payments`                | `payments` join `users`                        | `paymentDto`                | Already present              |
| `GET /api/admin/logs`                    | `activity_logs`/`admin_logs` join `users`      | `logDto`                    | – (capped at 50)             |
| `GET /api/admin/audit`                   | `admin_logs` (before/after)                    | `auditDto` (redacted diffs) | Already present              |

The dashboard **overview/charts/health/metrics** (`/api/admin/dashboard/*`) already returned shaped aggregates and were left unchanged (no raw rows).

## 5. Fields exposed per DTO (camelCase canonical + snake_case compat)

### User

`id, name, email, isAdmin, isPremium, premiumExpiresAt, status, createdAt, updatedAt, avatarUrl` + snake_case aliases.
**Sensitive stripped:** `password_hash`, `verification_code`, `otp_hash`, `refresh_token`, `reset_token`, `stripe_customer_id`.

### Anime

`id, title, titleJapanese, description, coverImage, bannerImage, bannerUrl, trailerUrl, rating, year, studio, status, mediaType, season, isPremium, isFeatured, isPublished, accessTier, episodeCount, viewCount, totalEpisodeViews, createdAt, updatedAt, animeheavenSlug, tags, genres`.
**Sensitive/internal stripped:** `cover_public_id`, `banner_public_id`, provider keys, `anime_mappings`, etc.

### Episode

`id, animeId, animeTitle, number, title, description, thumbnailUrl, videoUrl (admin-only), durationSec, viewCount, isPremium, accessTier, premiumUntil, createdAt, updatedAt`.
**Sensitive/internal stripped:** `cloudinary_public_id`, `thumbnail_public_id`, `animeheaven_episode_key`, `provider_episode_key`, etc.

### Genre

`id, name`.

### Ad

`id, title, type, imageUrl, bannerUrl, videoUrl, targetUrl, frequencyMinutes, isActive, targetFreeOnly, startDate, endDate, createdAt, updatedAt`.

### Payment

`id, userId, name, email, amount, currency, plan, status, reference, flwTxRef, createdAt, paidAt`.
**Sensitive/internal stripped:** `order_tracking_id`, webhook internals, payload blobs.

### Log

`id, userName, action, targetType, targetId, details, createdAt, ipAddress`.

### Audit

`id, adminId, adminName, action, entityType, entityId, before, after (redacted), ipHash, createdAt`.

## 6. Consistency & envelope

- All list responses use `{ success:true, data:[...], meta:{ pagination } }`.
- Single resources use `{ success:true, data:{...} }`.
- `getAllUsers` now paginates (page/limit, default 50, capped 100) so large user collections are bounded.
- camelCase is the canonical shape; snake_case aliases remain solely for dashboard backward-compatibility during migration (future clients should target camelCase).

## 7. Dashboard compatibility

`AdminDashboard/js/api.js` already unwraps the envelope (`unwrapAdminEnvelope`), exposing `items`/`rows`/`pagination`. Because each DTO emits the snake_case aliases the dashboard's forms and reads use (`anime.js` binds by `name=`, `users.js` reads `is_admin`/`is_premium`/`premium_expires_at`, `payments.js` reads `flw_tx_ref`, `logs.js` reads `user_name`/`target_type`/`target_id`, `ads.js` reads `is_active`/`target_free_only`, `settings.js` reads settings keys), the dashboard continues to function without changes.

## 8. Verified

- DTO service + admin controller load cleanly (module evaluation passes; only the pre-existing `.env` MySQL access warning prints, which is unrelated).
- Existing `test/apiVersioning.test.js` still passes (admin endpoints weren't part of it, but the route mounting is unchanged).

## 9. Out of scope / intentionally unchanged

- Admin **write** handlers (create/update/delete) — logic untouched.
- Streaming logic and `/api/v1/stream*` / `/api/v1/stream-proxy*` — untouched.
- Dashboard analytics (`/api/admin/dashboard/*`) — already shaped aggregates.
