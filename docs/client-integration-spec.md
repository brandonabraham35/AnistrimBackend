# AniStrim Client Integration Specification

**Version:** 1.0  
**Last Updated:** 2026-08-20  
**Status:** READY  
**Backend Version:** AniStrimBackend2

---

## Table of Contents

1. [Overview](#1-overview)
2. [API Endpoints Reference](#2-api-endpoints-reference)
3. [Authentication Contract](#3-authentication-contract)
4. [API Response Contract](#4-api-response-contract)
5. [Streaming Client Contract](#5-streaming-client-contract)
6. [Premium Access Contract](#6-premium-access-contract)
7. [Error Handling Contract](#7-error-handling-contract)
8. [CORS & Platform Compatibility](#8-cors--platform-compatibility)
9. [Client Responsibilities](#9-client-responsibilities)
10. [Client Architecture Recommendations](#10-client-architecture-recommendations)
11. [API Client Layer](#11-api-client-layer)
12. [Caching Strategy](#12-caching-strategy)
13. [Offline Behavior](#13-offline-behavior)
14. [Navigation Principles](#14-navigation-principles)
15. [Payments](#15-payments)
16. [Admin API](#16-admin-api)
17. [Security Rules](#17-security-rules)

---

## 1. Overview

### 1.1 Purpose

This document is the **authoritative integration guide** for all AniStrim clients:

- **AniStrim Web** — Browser-based SPA
- **AniStrim Mobile** — Android/iOS Capacitor app
- **AniStrim Desktop** — Future desktop application
- **AniStrim Admin** — Administrative dashboard

All clients communicate with the **same backend API**. The backend is client-agnostic and returns identical responses regardless of which client makes the request.

### 1.2 Base URL

```
Production: https://api.anistrim.com
Development: http://localhost:5000
```

All API endpoints are prefixed with `/api/` or `/api/v1/`.

### 1.3 API Versioning

The backend supports two route prefixes:

| Prefix      | Status  | Notes                       |
| ----------- | ------- | --------------------------- |
| `/api/*`    | Legacy  | Still fully supported       |
| `/api/v1/*` | Current | Recommended for new clients |

Both prefixes route to the same controllers. New clients should use `/api/v1/*`.

### 1.4 Key Principles

1. **Backend is authoritative** — All business logic, authorization, and data validation happens server-side
2. **Client is presentation-only** — Frontends render what the API returns
3. **No client-specific logic** — The API does not branch based on user-agent or client type
4. **Security first** — Credentials, provider URLs, and business rules never reach the client

---

## 2. API Endpoints Reference

### 2.1 AUTH Endpoints

| Method | Endpoint                         | Auth   | Description                   |
| ------ | -------------------------------- | ------ | ----------------------------- |
| POST   | `/api/auth/login`                | Public | Email/password login          |
| POST   | `/api/auth/signup`               | Public | Register new account          |
| POST   | `/api/auth/verify-email`         | Public | Verify email with OTP         |
| POST   | `/api/auth/verify-otp`           | Public | Alias for verify-email        |
| POST   | `/api/auth/resend-otp`           | Public | Resend verification code      |
| GET    | `/api/auth/me`                   | Bearer | Get current user profile      |
| POST   | `/api/auth/forgot-password`      | Public | Request password reset        |
| POST   | `/api/auth/set-password`         | Bearer | Set password (Google users)   |
| POST   | `/api/auth/reset-password`       | Public | Reset password with token     |
| POST   | `/api/auth/refresh`              | Public | Refresh access token          |
| POST   | `/api/auth/logout`               | Bearer | Revoke current session        |
| POST   | `/api/auth/logout-all`           | Bearer | Revoke all sessions           |
| GET    | `/api/auth/sessions`             | Bearer | List active sessions          |
| DELETE | `/api/auth/sessions/:id`         | Bearer | Revoke specific session       |
| POST   | `/api/auth/change-password`      | Bearer | Change password               |
| POST   | `/api/auth/change-email`         | Bearer | Initiate email change         |
| POST   | `/api/auth/change-email/confirm` | Bearer | Confirm email change          |
| POST   | `/api/auth/account/deactivate`   | Bearer | Deactivate account            |
| POST   | `/api/auth/account/delete`       | Bearer | Soft-delete account           |
| POST   | `/api/auth/google/verify`        | Public | Google login (existing users) |
| POST   | `/api/auth/google/signup`        | Public | Google signup (new users)     |
| GET    | `/api/auth/google/client-id`     | Public | Get Google Client ID          |
| GET    | `/api/auth/google/start`         | Public | Start OAuth redirect flow     |
| GET    | `/api/auth/google/callback`      | Public | OAuth callback handler        |
| GET    | `/api/auth/google/token`         | Public | Exchange login code for JWT   |

### 2.2 PROFILE Endpoints

| Method | Endpoint                          | Auth   | Description                 |
| ------ | --------------------------------- | ------ | --------------------------- |
| GET    | `/api/profile/username-available` | Bearer | Check username availability |
| POST   | `/api/profile/set-username`       | Bearer | Set/update username         |
| POST   | `/api/profile/onboarding`         | Bearer | Complete onboarding         |
| GET    | `/api/profile/preferences`        | Bearer | Get user preferences        |
| PUT    | `/api/profile/preferences`        | Bearer | Update preferences          |
| DELETE | `/api/profile/history`            | Bearer | Clear watch history         |

### 2.3 ANIME Endpoints

| Method | Endpoint                             | Auth     | Description                           |
| ------ | ------------------------------------ | -------- | ------------------------------------- |
| GET    | `/api/anime/trending`                | Public   | Get trending anime                    |
| GET    | `/api/anime/latest`                  | Public   | Get latest anime                      |
| GET    | `/api/anime/recent`                  | Public   | Alias for latest                      |
| GET    | `/api/anime/popular`                 | Public   | Get popular anime                     |
| GET    | `/api/anime/featured`                | Public   | Get featured anime                    |
| GET    | `/api/anime/search`                  | Public   | Search anime                          |
| GET    | `/api/anime/genres`                  | Public   | Get all genres                        |
| GET    | `/api/anime/search/advanced`         | Public   | Advanced search                       |
| GET    | `/api/anime/recommendations/:id`     | Public   | Get recommendations                   |
| GET    | `/api/anime/resolve/stream`          | Public   | Resolve stream URL                    |
| GET    | `/api/anime/kitsu/:kitsuId/episodes` | Public   | Get episodes by Kitsu ID              |
| GET    | `/api/anime/:animeId/episodes`       | Optional | Get episodes (masked for non-premium) |
| GET    | `/api/anime/:id/stream/:episode`     | Bearer   | Get stream (protected)                |
| GET    | `/api/anime/:id`                     | Optional | Get anime details                     |

### 2.4 WATCH Endpoints

| Method | Endpoint                                | Auth   | Description                    |
| ------ | --------------------------------------- | ------ | ------------------------------ |
| GET    | `/api/watch/next/:animeId/:epNum`       | Bearer | Get next episode               |
| GET    | `/api/watch/skip-times/:malId/:epNum`   | Bearer | Get OP/ED skip times           |
| PUT    | `/api/watch/progress`                   | Bearer | Save playback progress         |
| GET    | `/api/watch/progress/:episodeId`        | Bearer | Get episode progress           |
| GET    | `/api/watch/markers/:episodeId`         | Bearer | Get episode markers            |
| GET    | `/api/watch/anime/:animeId/progress`    | Bearer | Get all progress for anime     |
| GET    | `/api/watch/continue-watching`          | Bearer | Get continue watching list     |
| DELETE | `/api/watch/continue-watching/:animeId` | Bearer | Dismiss from continue watching |
| POST   | `/api/watch/restart/:animeId`           | Bearer | Reset anime progress           |
| GET    | `/api/watch/history`                    | Bearer | Get watch history (paginated)  |
| DELETE | `/api/watch/history`                    | Bearer | Clear all watch history        |
| GET    | `/api/watch/progress/batch/:animeId`    | Bearer | Batch progress (legacy)        |

### 2.5 WATCHLIST Endpoints

| Method | Endpoint                        | Auth   | Description                |
| ------ | ------------------------------- | ------ | -------------------------- |
| POST   | `/api/watchlist/add`            | Bearer | Legacy add to watchlist    |
| POST   | `/api/watchlist`                | Bearer | Add/update watchlist entry |
| GET    | `/api/watchlist/continue`       | Bearer | Legacy continue watching   |
| GET    | `/api/watchlist`                | Bearer | Get watchlist              |
| GET    | `/api/watchlist/stats`          | Bearer | Get watchlist stats        |
| POST   | `/api/watchlist/progress`       | Bearer | Legacy progress save       |
| GET    | `/api/watchlist/progress/:epId` | Bearer | Legacy progress lookup     |
| DELETE | `/api/watchlist/:animeId`       | Bearer | Remove from watchlist      |
| POST   | `/api/watchlist/:animeId`       | Bearer | Toggle watchlist           |

### 2.6 STREAMING Endpoints

| Method | Endpoint                                   | Auth     | Description                  |
| ------ | ------------------------------------------ | -------- | ---------------------------- |
| POST   | `/api/stream/authorize`                    | Bearer   | Authorize stream (get token) |
| GET    | `/api/stream/:animeTitle/:epNum`           | Bearer   | Get best stream              |
| GET    | `/api/stream/providers/:animeTitle/:epNum` | Optional | List providers               |
| POST   | `/api/stream/offline-download`             | Bearer   | Authorize download           |

### 2.7 STREAM PROXY Endpoints

| Method  | Endpoint                              | Auth         | Description        |
| ------- | ------------------------------------- | ------------ | ------------------ |
| OPTIONS | `/api/stream-proxy/:streamId`         | None         | CORS preflight     |
| OPTIONS | `/api/stream-proxy/:streamId/:suffix` | None         | CORS preflight     |
| GET     | `/api/stream-proxy/:streamId`         | Stream Token | Stream media       |
| GET     | `/api/stream-proxy/:streamId/:suffix` | Stream Token | Stream media (HLS) |

### 2.8 PAYMENTS Endpoints

| Method | Endpoint                             | Auth   | Description         |
| ------ | ------------------------------------ | ------ | ------------------- |
| POST   | `/api/payments/checkout`             | Bearer | Initialize checkout |
| GET    | `/api/payments/ipn-listener`         | Public | Pesapal IPN handler |
| GET    | `/api/payments/callback`             | Public | Payment callback    |
| GET    | `/api/payments/verify-subscription`  | Public | Verify subscription |
| POST   | `/api/payments/refund`               | Admin  | Refund subscription |
| POST   | `/api/payments/cancel`               | Admin  | Cancel subscription |
| GET    | `/api/payments/subscription-revenue` | Admin  | Revenue stats       |

### 2.9 ADS Endpoints

| Method | Endpoint          | Auth   | Description             |
| ------ | ----------------- | ------ | ----------------------- |
| GET    | `/api/ads/config` | Bearer | Get ad configuration    |
| PUT    | `/api/ads/config` | Admin  | Update ad configuration |
| GET    | `/api/ads/policy` | Bearer | Get ad policy           |
| POST   | `/api/ads/event`  | Bearer | Log ad event            |

### 2.10 HOME Endpoints

| Method | Endpoint                            | Auth   | Description                      |
| ------ | ----------------------------------- | ------ | -------------------------------- |
| GET    | `/api/home/sections`                | Public | Get home sections                |
| GET    | `/api/home/recommendations`         | Bearer | Get personalized recommendations |
| POST   | `/api/home/recommendations/refresh` | Bearer | Refresh recommendations          |
| POST   | `/api/home/refresh`                 | Admin  | Rebuild all sections             |

### 2.11 REPORTS Endpoints

| Method | Endpoint       | Auth   | Description     |
| ------ | -------------- | ------ | --------------- |
| POST   | `/api/reports` | Bearer | Submit a report |

### 2.12 DOWNLOAD Endpoints

| Method | Endpoint                   | Auth   | Description                     |
| ------ | -------------------------- | ------ | ------------------------------- |
| GET    | `/api/download/:episodeId` | Bearer | Download episode (premium only) |

### 2.13 ADMIN Endpoints

All admin endpoints require `Bearer` token + `admin` role.

| Method | Endpoint                                     | Description             |
| ------ | -------------------------------------------- | ----------------------- |
| GET    | `/api/admin/stats`                           | Dashboard stats         |
| GET    | `/api/admin/dashboard/overview`              | Dashboard overview      |
| GET    | `/api/admin/dashboard/health`                | Health snapshot         |
| GET    | `/api/admin/dashboard/health/history`        | Health metrics history  |
| GET    | `/api/admin/dashboard/charts/:type`          | Chart data              |
| GET    | `/api/admin/dashboard/activity/recent`       | Recent activity         |
| GET    | `/api/admin/dashboard/ads-metrics`           | Ads metrics             |
| GET    | `/api/admin/audit`                           | Audit logs              |
| GET    | `/api/admin/users`                           | List users              |
| GET    | `/api/admin/users/:id`                       | Get user                |
| GET    | `/api/admin/users/:id/watch-history`         | User watch history      |
| GET    | `/api/admin/users/:id/login-history`         | User login history      |
| PUT    | `/api/admin/users/:id`                       | Update user             |
| POST   | `/api/admin/users/bulk-delete`               | Bulk delete users       |
| GET    | `/api/admin/anime`                           | List anime              |
| POST   | `/api/admin/anime`                           | Create anime            |
| PUT    | `/api/admin/anime/bulk`                      | Bulk update anime       |
| POST   | `/api/admin/anime/bulk-delete`               | Bulk delete anime       |
| GET    | `/api/admin/anime/import/search`             | Search for import       |
| POST   | `/api/admin/anime/import`                    | Import anime            |
| GET    | `/api/admin/anime/:id`                       | Get anime               |
| PUT    | `/api/admin/anime/:id`                       | Update anime            |
| DELETE | `/api/admin/anime/:id`                       | Delete anime            |
| GET    | `/api/admin/animeheaven/search`              | Search AnimeHeaven      |
| GET    | `/api/admin/animeheaven/preview/:identifier` | Preview AnimeHeaven     |
| POST   | `/api/admin/animeheaven/import`              | Import from AnimeHeaven |
| POST   | `/api/admin/animeheaven/sync/:animeId`       | Sync AnimeHeaven        |
| GET    | `/api/admin/animeheaven/status/:animeId`     | AnimeHeaven status      |
| GET    | `/api/admin/genres`                          | List genres             |
| POST   | `/api/admin/genres`                          | Create genre            |
| PUT    | `/api/admin/genres/:id`                      | Update genre            |
| DELETE | `/api/admin/genres/:id`                      | Delete genre            |
| POST   | `/api/admin/anime/:animeId/episodes`         | Add episode             |
| GET    | `/api/admin/anime/:animeId/episodes`         | Get anime episodes      |
| GET    | `/api/admin/episodes`                        | List all episodes       |
| GET    | `/api/admin/episodes/:id`                    | Get episode             |
| PUT    | `/api/admin/episodes/:id`                    | Update episode          |
| DELETE | `/api/admin/episodes/:id`                    | Delete episode          |
| POST   | `/api/admin/episodes/bulk-delete`            | Bulk delete episodes    |
| GET    | `/api/admin/settings`                        | Get settings            |
| PUT    | `/api/admin/settings`                        | Update settings         |
| GET    | `/api/admin/ads`                             | List ads                |
| POST   | `/api/admin/ads`                             | Create ad               |
| PUT    | `/api/admin/ads/:id`                         | Update ad               |
| DELETE | `/api/admin/ads/:id`                         | Delete ad               |
| GET    | `/api/admin/payments`                        | List payments           |
| PUT    | `/api/admin/payments/:id`                    | Update payment status   |
| GET    | `/api/admin/logs`                            | Activity logs           |

### 2.14 UPLOAD Endpoints

| Method | Endpoint                  | Auth  | Description  |
| ------ | ------------------------- | ----- | ------------ |
| POST   | `/api/admin/upload/image` | Admin | Upload image |
| POST   | `/api/admin/upload/video` | Admin | Upload video |

### 2.15 AVATAR Endpoints

| Method | Endpoint           | Auth   | Description   |
| ------ | ------------------ | ------ | ------------- |
| POST   | `/api/auth/avatar` | Bearer | Upload avatar |

### 2.16 HEALTH Endpoints

| Method | Endpoint           | Auth   | Description      |
| ------ | ------------------ | ------ | ---------------- |
| GET    | `/api/health`      | Public | API health check |
| GET    | `/health/provider` | Public | Provider health  |

---

## 3. Authentication Contract

### 3.1 Access Token

| Property | Value                                     |
| -------- | ----------------------------------------- |
| Lifetime | 15 minutes                                |
| Format   | JWT (HS256)                               |
| Header   | `Authorization: Bearer <token>`           |
| Claims   | `uid`, `sid`, `tv`, `roles`, `iat`, `exp` |

**Storage Recommendations:**

| Client  | Storage                            |
| ------- | ---------------------------------- |
| Web     | `localStorage` or `sessionStorage` |
| Mobile  | Secure storage (Keychain/Keystore) |
| Desktop | Secure storage (OS keychain)       |

### 3.2 Refresh Token

| Property        | Value                               |
| --------------- | ----------------------------------- |
| Lifetime        | 30 days                             |
| Format          | Opaque random 32 bytes              |
| Storage         | Secure storage (NEVER localStorage) |
| Rotation        | Rotated on every use                |
| Reuse Detection | Triggers full session revocation    |

**Storage Recommendations:**

| Client  | Storage                                         |
| ------- | ----------------------------------------------- |
| Web     | `httpOnly` cookie (preferred) or secure storage |
| Mobile  | Secure storage (Keychain/Keystore)              |
| Desktop | Secure storage (OS keychain)                    |

### 3.3 Authentication Flows

#### 3.3.1 Login Flow

```
1. POST /api/auth/login { email, password }
2. Response: { success: true, data: { token, refreshToken, sessionId, user } }
3. Store token and refreshToken securely
4. Use token in Authorization header for subsequent requests
```

#### 3.3.2 Token Refresh Flow

```
1. Access token expires (401 response)
2. POST /api/auth/refresh { refreshToken }
3. Response: { success: true, data: { token, refreshToken, sessionId, user } }
4. Store new tokens
5. Retry original request with new token
```

**IMPORTANT:** The refresh token is rotated on every use. The old refresh token becomes invalid immediately.

#### 3.3.3 Token Expiration Handling

When a 401 response is received:

```javascript
async function handle401(originalRequest) {
  // 1. Try to refresh
  try {
    const newTokens = await api.refreshToken(getStoredRefreshToken());
    storeTokens(newTokens);

    // 2. Retry original request
    return await api.request(originalRequest);
  } catch (refreshError) {
    // 3. Refresh failed — redirect to login
    clearTokens();
    redirectToLogin();
  }
}
```

#### 3.3.4 Logout Flow

```
1. POST /api/auth/logout (with valid token)
2. Server revokes current session
3. Client clears stored tokens
4. Redirect to login
```

#### 3.3.5 Logout-All Flow

```
1. POST /api/auth/logout-all (with valid token)
2. Server increments token_version, revokes ALL sessions
3. All devices are logged out
4. Client clears stored tokens
5. Redirect to login
```

### 3.4 Google Authentication

#### Web Flow

```
1. Load Google Identity Services
2. User clicks "Continue with Google"
3. Google returns ID token
4. POST /api/auth/google/verify { idToken } (login)
   OR POST /api/auth/google/signup { idToken } (signup)
5. Response: { success: true, data: { token, refreshToken, sessionId, user } }
```

#### Mobile Flow (Capacitor)

```
1. GET /api/auth/google/start?intent=login|signup
2. Server redirects to Google OAuth
3. Google redirects to /api/auth/google/callback
4. Server deep-links back to app with short-lived code
5. GET /api/auth/google/token?code=<code>
6. Response: { success: true, data: { token, refreshToken, sessionId, user, intent } }
```

### 3.5 Session Management

**List Sessions:**

```
GET /api/auth/sessions
Response: { success: true, data: [{ id, device_name, platform, last_seen_at, ... }] }
```

**Revoke Session:**

```
DELETE /api/auth/sessions/:id
Response: { success: true, data: null, meta: { message: "Session revoked." } }
```

### 3.6 Account Management

**Change Password:**

```
POST /api/auth/change-password { oldPassword, newPassword }
Response: { success: true, data: { token, refreshToken, sessionId, user } }
```

Note: Returns new tokens because token_version is incremented.

**Change Email:**

```
1. POST /api/auth/change-email { newEmail }
   → Sends OTP to new email
2. POST /api/auth/change-email/confirm { newEmail, otp }
   → Confirms email change
```

**Deactivate Account:**

```
POST /api/auth/account/deactivate
Response: { success: true, data: null, meta: { message: "Account deactivated." } }
```

**Delete Account:**

```
POST /api/auth/account/delete
Response: { success: true, data: null, meta: { message: "Account deleted." } }
```

---

## 4. API Response Contract

### 4.1 Success Response Envelope

**Single Resource:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "title": "Attack on Titan",
    "titleJapanese": "進撃の巨人",
    "coverImage": "https://...",
    "viewCount": 1000
  }
}
```

**List Resource (Paginated):**

```json
{
  "success": true,
  "data": [
    { "id": 1, "title": "..." },
    { "id": 2, "title": "..." }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "perPage": 25,
      "totalItems": 100,
      "totalPages": 4,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

**Authentication Response:**

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "a1b2c3d4e5f6...",
    "sessionId": "uuid-here",
    "user": {
      "id": 1,
      "email": "user@example.com",
      "username": "user123",
      "displayName": "User 123",
      "avatarUrl": "https://...",
      "status": "active",
      "emailVerified": true,
      "authProvider": "password",
      "isAdmin": false,
      "roles": ["user"],
      "createdAt": "2024-01-01T00:00:00Z",
      "entitlement": {
        "isPremium": false,
        "plan": null,
        "expiresAt": null,
        "source": null
      },
      "preferences": {
        "genrePreferences": ["Action", "Drama"]
      }
    }
  }
}
```

### 4.2 Error Response Envelope

```json
{
  "success": false,
  "error": {
    "code": "EPISODE_NOT_FOUND",
    "message": "Episode not found.",
    "details": {},
    "requestId": "req_abc123def456"
  }
}
```

**Error Codes:**

| HTTP Status | Code                   | Description                   |
| ----------- | ---------------------- | ----------------------------- |
| 400         | BAD_REQUEST            | Invalid request               |
| 401         | UNAUTHORIZED           | Not authenticated             |
| 401         | TOKEN_VERSION_MISMATCH | Session invalidated           |
| 401         | SESSION_REVOKED        | Session revoked               |
| 401         | REFRESH_REUSE_DETECTED | Refresh token reused          |
| 403         | FORBIDDEN              | Access denied                 |
| 403         | ACCOUNT_SUSPENDED      | Account suspended             |
| 403         | ACCOUNT_DEACTIVATED    | Account deactivated           |
| 403         | ACCOUNT_DELETED        | Account deleted               |
| 403         | PREMIUM_REQUIRED       | Premium subscription required |
| 403         | DEVICE_LIMIT_REACHED   | Device limit reached          |
| 404         | NOT_FOUND              | Resource not found            |
| 409         | CONFLICT               | Resource conflict             |
| 422         | VALIDATION_ERROR       | Validation failed             |
| 429         | RATE_LIMITED           | Rate limit exceeded           |
| 500         | INTERNAL_ERROR         | Server error                  |
| 502         | BAD_GATEWAY            | Upstream error                |
| 503         | SERVICE_UNAVAILABLE    | Service unavailable           |

### 4.3 Episode Response (with Premium Masking)

**For Premium Users:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "number": 1,
      "season": 1,
      "title": "Episode 1",
      "description": "...",
      "thumbnailUrl": "https://...",
      "videoUrl": "https://...",
      "durationSec": 1440,
      "viewCount": 1000,
      "isPremium": true,
      "locked": false,
      "effectiveTier": "premium",
      "availableAt": null,
      "accessState": "available",
      "accessTier": "premium"
    }
  ]
}
```

**For Free Users (Premium Content):**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "number": 1,
      "season": 1,
      "title": "Episode 1",
      "description": "...",
      "thumbnailUrl": "https://...",
      "videoUrl": null,
      "durationSec": 1440,
      "viewCount": 1000,
      "isPremium": true,
      "locked": true,
      "effectiveTier": "premium",
      "availableAt": null,
      "accessState": "premium_required",
      "accessTier": "premium"
    }
  ]
}
```

---

## 5. Streaming Client Contract

### 5.1 Streaming Architecture

```
┌─────────────┐     ┌─────────────────────┐     ┌───────────────────────┐
│   Client    │────▶│  /api/stream/authorize │────▶│  Backend (canWatch)   │
│  (Player)   │     └─────────────────────┘     └───────────────────────┘
│             │                                        │
│             │     ┌─────────────────────┐            │
│             │◀────│  Stream Token (120s)│◀───────────┘
│             │     └─────────────────────┘
│             │
│             │     ┌─────────────────────┐     ┌───────────────────────┐
│             │────▶│ /api/stream-proxy/  │────▶│  AnimeHeaven CDN      │
│             │     │    :streamId        │     │  (cookies server-side)│
│             │◀────│  (proxied stream)   │◀────│                       │
└─────────────┘     └─────────────────────┘     └───────────────────────┘
```

### 5.2 Stream Authorization

**Step 1: Authorize Stream**

```
POST /api/stream/authorize
Headers: Authorization: Bearer <access_token>
Body: { "episodeId": 123 }

Response:
{
  "success": true,
  "data": {
    "streamId": "abc123...",
    "streamUrl": "/api/stream-proxy/abc123...",
    "expiresAt": 1234567890,
    "subtitles": [...],
    "qualities": [...]
  }
}
```

**Step 2: Play Stream**

```
GET /api/stream-proxy/:streamId
Headers: Authorization: Bearer <stream_token> (or ?token=<stream_token>)

Response: Video stream (MP4 or HLS)
```

### 5.3 Stream Token

| Property | Value                                                    |
| -------- | -------------------------------------------------------- |
| Lifetime | 120 seconds (parent)                                     |
| Lifetime | 6 hours (HLS child)                                      |
| Format   | HMAC-SHA256 signed                                       |
| Binding  | userId, episodeId, streamId, IP, sessionId, tokenVersion |

**Token Scopes:**

- `undefined` — Parent token (can access manifest/MP4)
- `hls-child` — Child token (can only access segments/keys)

### 5.4 Stream URL Structure

**NEVER construct provider URLs directly.** Always use the proxy:

```
✅ CORRECT:
GET /api/stream-proxy/:streamId
GET /api/stream-proxy/:streamId?url=<encoded_child_url>&ct=<child_token>

❌ WRONG:
GET https://animeheaven-cdn.com/... (direct CDN access)
```

### 5.5 HLS Playback

For HLS streams, the backend rewrites the manifest to proxy all child URLs:

```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000
/api/stream-proxy/:streamId?url=<encoded_variant>&ct=<child_token>
```

The player should:

1. Fetch the manifest from `/api/stream-proxy/:streamId`
2. Parse the manifest
3. Fetch segments/keys through the proxied URLs
4. The `ct` (child token) is embedded in the URLs

### 5.6 Quality Selection

Quality is determined server-side. The client receives available qualities in the authorize response:

```json
{
  "qualities": [
    { "label": "1080p", "url": "..." },
    { "label": "720p", "url": "..." },
    { "label": "480p", "url": "..." }
  ]
}
```

### 5.7 Subtitle Handling

Subtitles are returned in the authorize response:

```json
{
  "subtitles": [
    {
      "language": "English",
      "languageCode": "en",
      "url": "/api/stream-proxy/:streamId?url=<subtitle_url>&ct=<token>"
    }
  ]
}
```

### 5.8 Premium Restrictions

- Free users: Cannot authorize premium episodes (403 PREMIUM_REQUIRED)
- Premium users: Can authorize all episodes
- Admin users: Can authorize all episodes

### 5.9 What Clients Must NEVER Do

| NEVER                             | Reason                           |
| --------------------------------- | -------------------------------- |
| Access provider CDN URLs directly | URLs are signed and time-limited |
| Extract cookies from the app      | Cookies are server-side only     |
| Construct stream URLs manually    | URLs require server-side context |
| Bypass the authorize endpoint     | Authorization is mandatory       |
| Cache stream tokens beyond TTL    | Tokens expire in 120 seconds     |
| Share stream URLs                 | URLs are IP-bound                |

---

## 6. Premium Access Contract

### 6.1 Access Determination

**The backend is the sole authority on premium access.** Clients must NEVER:

- Read `is_premium` from localStorage
- Parse JWT claims for premium status
- Implement premium logic client-side

### 6.2 Episode Access States

| accessState        | Meaning                     | Client Action       |
| ------------------ | --------------------------- | ------------------- |
| `available`        | Free or entitled            | Show play button    |
| `premium_required` | Premium subscription needed | Show upgrade prompt |
| `scheduled`        | Not yet available           | Show countdown      |
| `expired`          | Premium expired             | Show renew prompt   |

### 6.3 Episode Response Fields

| Field           | Type         | Description              |
| --------------- | ------------ | ------------------------ |
| `locked`        | boolean      | True if user cannot play |
| `effectiveTier` | string       | "free" or "premium"      |
| `accessState`   | string       | See table above          |
| `availableAt`   | string\|null | ISO date if scheduled    |
| `videoUrl`      | string\|null | null if locked           |

### 6.4 Premium Error Response

```json
{
  "success": false,
  "error": {
    "code": "PREMIUM_REQUIRED",
    "message": "Premium subscription required.",
    "details": {
      "requiredTier": "premium",
      "availableAt": null
    },
    "requestId": "req_..."
  }
}
```

### 6.5 Client Implementation

```javascript
function handleEpisode(episode) {
  if (episode.locked) {
    if (episode.accessState === "premium_required") {
      showUpgradePrompt();
    } else if (episode.accessState === "scheduled") {
      showCountdown(episode.availableAt);
    }
    return;
  }

  // Episode is playable
  playEpisode(episode);
}
```

---

## 7. Error Handling Contract

### 7.1 Universal Error Handler

```javascript
async function handleApiError(error, request) {
  const status = error.response?.status;
  const code = error.response?.data?.error?.code;

  switch (status) {
    case 401:
      if (code === "TOKEN_VERSION_MISMATCH" || code === "SESSION_REVOKED") {
        // Session invalidated — force re-login
        clearTokens();
        redirectToLogin();
      } else {
        // Try refresh
        await refreshTokenAndRetry(request);
      }
      break;

    case 403:
      if (code === "PREMIUM_REQUIRED") {
        showUpgradeUI();
      } else if (code === "DEVICE_LIMIT_REACHED") {
        showDeviceLimitUI(error.response.data.error.details);
      } else if (code === "ACCOUNT_SUSPENDED") {
        showSuspendedUI();
      }
      break;

    case 404:
      showNotFoundUI();
      break;

    case 409:
      showConflictUI(error.response.data.error.message);
      break;

    case 422:
      showValidationErrors(error.response.data.error.details);
      break;

    case 429:
      showRateLimitUI();
      // Retry after delay
      await delay(error.response.headers["retry-after"] * 1000);
      return retry(request);

    case 500:
    case 502:
    case 503:
      showOfflineUI();
      // Retry with backoff
      await retryWithBackoff(request);
      break;
  }
}
```

### 7.2 Error Categories

| Category         | Status Codes  | Action                                         |
| ---------------- | ------------- | ---------------------------------------------- |
| Auth Error       | 401           | Refresh token or re-login                      |
| Permission Error | 403           | Show appropriate UI (upgrade, suspended, etc.) |
| Not Found        | 404           | Show not found message                         |
| Conflict         | 409           | Show conflict message                          |
| Validation       | 422           | Show field errors                              |
| Rate Limit       | 429           | Wait and retry                                 |
| Server Error     | 500, 502, 503 | Show offline message, retry                    |

### 7.3 Retry Strategy

```javascript
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  retryableStatuses: [429, 500, 502, 503],
};

async function retryWithBackoff(request, attempt = 1) {
  if (attempt > RETRY_CONFIG.maxRetries) {
    throw new Error("Max retries exceeded");
  }

  const delay = Math.min(
    RETRY_CONFIG.baseDelay * Math.pow(2, attempt - 1),
    RETRY_CONFIG.maxDelay,
  );

  await delay;
  return api.request(request);
}
```

---

## 8. CORS & Platform Compatibility

### 8.1 Allowed Origins

| Client  | Origin                                       | Configuration                 |
| ------- | -------------------------------------------- | ----------------------------- |
| Web     | `https://anistrim.com`                       | `API_ALLOWED_ORIGINS` env var |
| Admin   | `https://admin.anistrim.com`                 | `API_ALLOWED_ORIGINS` env var |
| Android | `capacitor://localhost`, `https://localhost` | Dev defaults                  |
| iOS     | `capacitor://localhost`                      | Dev defaults                  |
| Desktop | `http://localhost:4200`                      | Dev defaults                  |

### 8.2 Development Origins

In non-production environments, these origins are auto-allowed:

- `http://localhost:3000`
- `http://127.0.0.1:3000`
- `http://localhost:8100` (Capacitor web)
- `http://localhost:4200` (Angular desktop)
- `capacitor://localhost`
- `https://localhost`
- Private LAN: `10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`

### 8.3 CORS Headers

```
Access-Control-Allow-Origin: <request-origin>
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, Accept, Origin
Access-Control-Allow-Credentials: false
```

Note: `credentials: false` because auth uses Bearer JWT, not cookies.

---

## 9. Client Responsibilities

### 9.1 Responsibility Matrix

| Feature          | Web    | Mobile | Desktop | Admin  | Backend |
| ---------------- | ------ | ------ | ------- | ------ | ------- |
| Authentication   | CLIENT | CLIENT | CLIENT  | CLIENT | BOTH    |
| Anime catalogue  | CLIENT | CLIENT | CLIENT  | CLIENT | BACKEND |
| Search           | CLIENT | CLIENT | CLIENT  | CLIENT | BACKEND |
| Watch history    | CLIENT | CLIENT | CLIENT  | N/A    | BACKEND |
| Watchlist        | CLIENT | CLIENT | CLIENT  | N/A    | BACKEND |
| Streaming        | CLIENT | CLIENT | CLIENT  | N/A    | BACKEND |
| Downloads        | CLIENT | CLIENT | CLIENT  | N/A    | BACKEND |
| Payments         | CLIENT | CLIENT | CLIENT  | CLIENT | BACKEND |
| Notifications    | CLIENT | CLIENT | CLIENT  | N/A    | CLIENT  |
| Profile          | CLIENT | CLIENT | CLIENT  | CLIENT | BACKEND |
| Preferences      | CLIENT | CLIENT | CLIENT  | CLIENT | BACKEND |
| Admin operations | N/A    | N/A    | N/A     | CLIENT | BACKEND |
| File uploads     | N/A    | N/A    | N/A     | CLIENT | BACKEND |
| Local storage    | CLIENT | CLIENT | CLIENT  | CLIENT | N/A     |
| Caching          | CLIENT | CLIENT | CLIENT  | CLIENT | N/A     |
| Navigation       | CLIENT | CLIENT | CLIENT  | CLIENT | N/A     |
| Media player     | CLIENT | CLIENT | CLIENT  | N/A    | CLIENT  |

### 9.2 Key Responsibilities

**Backend:**

- User authentication and authorization
- Data persistence
- Business logic
- Premium enforcement
- Stream proxying
- Provider communication

**Client:**

- UI rendering
- Local state management
- Token storage
- Navigation
- Media playback
- Offline caching (where applicable)

---

## 10. Client Architecture Recommendations

### 10.1 Web Architecture

```
┌─────────────────────────────────────────┐
│              Web Application            │
├─────────────────────────────────────────┤
│  UI Layer (React/Vue/Angular)           │
├─────────────────────────────────────────┤
│  Router                                 │
├─────────────────────────────────────────┤
│  State Management (Redux/Zustand)       │
├─────────────────────────────────────────┤
│  Auth Manager                           │
├─────────────────────────────────────────┤
│  API Client                             │
├─────────────────────────────────────────┤
│  Media Player (hls.js/video.js)         │
└─────────────────────────────────────────┘
```

### 10.2 Mobile Architecture

```
┌─────────────────────────────────────────┐
│           Mobile Application            │
├─────────────────────────────────────────┤
│  UI Layer (Native/Web Components)       │
├─────────────────────────────────────────┤
│  Navigation                             │
├─────────────────────────────────────────┤
│  State Management                       │
├─────────────────────────────────────────┤
│  Auth Manager                           │
├─────────────────────────────────────────┤
│  API Client                             │
├─────────────────────────────────────────┤
│  Secure Token Storage (Keychain/Keystore)│
├─────────────────────────────────────────┤
│  Media Player (ExoPlayer/AVPlayer)      │
├─────────────────────────────────────────┤
│  Offline/Cache Layer                    │
└─────────────────────────────────────────┘
```

### 10.3 Desktop Architecture

```
┌─────────────────────────────────────────┐
│          Desktop Application            │
├─────────────────────────────────────────┤
│  UI Layer (Electron/Tauri)              │
├─────────────────────────────────────────┤
│  Router                                 │
├─────────────────────────────────────────┤
│  State Management                       │
├─────────────────────────────────────────┤
│  Auth Manager                           │
├─────────────────────────────────────────┤
│  API Client                             │
├─────────────────────────────────────────┤
│  Secure Storage (OS Keychain)           │
├─────────────────────────────────────────┤
│  Media Player                           │
└─────────────────────────────────────────┘
```

### 10.4 Admin Architecture

```
┌─────────────────────────────────────────┐
│           Admin Dashboard               │
├─────────────────────────────────────────┤
│  UI Layer (React/Vue/Angular)           │
├─────────────────────────────────────────┤
│  Router                                 │
├─────────────────────────────────────────┤
│  CMS State Management                   │
├─────────────────────────────────────────┤
│  Admin Auth Manager                     │
├─────────────────────────────────────────┤
│  API Client                             │
├─────────────────────────────────────────┤
│  Data Tables                            │
├─────────────────────────────────────────┤
│  Charts/Analytics                       │
├─────────────────────────────────────────┤
│  Upload Manager                         │
└─────────────────────────────────────────┘
```

---

## 11. API Client Layer

### 11.1 Recommended Abstraction

```javascript
class AniStrimApiClient {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.token = null;
    this.refreshToken = null;
  }

  // ─── Auth ──────────────────────────────────────
  async login(email, password) { ... }
  async signup(email, password, name) { ... }
  async verifyEmail(email, otp) { ... }
  async refreshToken(refreshToken) { ... }
  async logout() { ... }
  async logoutAll() { ... }
  async getCurrentUser() { ... }
  async changePassword(oldPassword, newPassword) { ... }
  async changeEmail(newEmail) { ... }

  // ─── Google Auth ───────────────────────────────
  async googleVerify(idToken) { ... }
  async googleSignup(idToken) { ... }
  async googleStart(intent) { ... }
  async googleToken(code) { ... }

  // ─── Anime ─────────────────────────────────────
  async getTrendingAnime() { ... }
  async getLatestAnime() { ... }
  async getFeaturedAnime() { ... }
  async searchAnime(query, filters) { ... }
  async getAnime(id) { ... }
  async getEpisodes(animeId) { ... }
  async getGenres() { ... }
  async getRecommendations(animeId) { ... }

  // ─── Watch ─────────────────────────────────────
  async getWatchHistory(page, perPage) { ... }
  async saveProgress(episodeId, positionSec, durationSec) { ... }
  async getProgress(episodeId) { ... }
  async getAnimeProgress(animeId) { ... }
  async getContinueWatching() { ... }
  async getNextEpisode(animeId, currentEp) { ... }
  async getSkipTimes(malId, episodeNumber) { ... }

  // ─── Watchlist ─────────────────────────────────
  async getWatchlist(status) { ... }
  async addToWatchlist(animeId, status) { ... }
  async removeFromWatchlist(animeId) { ... }
  async toggleWatchlist(animeId) { ... }
  async getWatchlistStats() { ... }

  // ─── Streaming ─────────────────────────────────
  async authorizeStream(episodeId) { ... }
  async getStream(animeTitle, episodeNumber) { ... }
  async getProviders(animeTitle, episodeNumber) { ... }

  // ─── Profile ───────────────────────────────────
  async getProfile() { ... }
  async updatePreferences(prefs) { ... }
  async setDisplayName(name) { ... }
  async setUsername(username) { ... }
  async uploadAvatar(file) { ... }

  // ─── Payments ──────────────────────────────────
  async initializeCheckout(plan) { ... }
  async verifySubscription() { ... }

  // ─── Home ──────────────────────────────────────
  async getHomeSections() { ... }
  async getPersonalizedRecommendations() { ... }

  // ─── Ads ───────────────────────────────────────
  async getAdConfig() { ... }
  async getAdPolicy() { ... }
  async logAdEvent(event) { ... }

  // ─── Downloads ─────────────────────────────────
  async authorizeDownload(episodeId) { ... }
}
```

---

## 12. Caching Strategy

### 12.1 Cache Categories

| Category         | Cacheable | TTL      | Notes                        |
| ---------------- | --------- | -------- | ---------------------------- |
| Public catalogue | YES       | 5-15 min | Anime list, genres, trending |
| User-specific    | YES       | 1-5 min  | Watchlist, progress, profile |
| Auth data        | NO        | -        | Tokens, sessions             |
| Stream data      | NO        | -        | Stream tokens, URLs          |
| Premium data     | NO        | -        | Access decisions             |

### 12.2 Cache Keys

```javascript
const CACHE_KEYS = {
  trending: "anime:trending",
  latest: "anime:latest",
  genres: "anime:genres",
  animeDetails: (id) => `anime:${id}`,
  episodes: (id) => `episodes:${id}`,
  watchlist: "user:watchlist",
  progress: (id) => `progress:${id}`,
  profile: "user:profile",
  homeSections: "home:sections",
};
```

### 12.3 Cache Invalidation

Invalidate on:

- User action (add to watchlist, save progress)
- Auth state change (login, logout)
- Data mutation (update profile)

---

## 13. Offline Behavior

### 13.1 What Works Offline

| Feature            | Web | Mobile | Desktop |
| ------------------ | --- | ------ | ------- |
| Cached anime list  | YES | YES    | YES     |
| Cached episodes    | YES | YES    | YES     |
| Watchlist (cached) | YES | YES    | YES     |
| Progress (cached)  | YES | YES    | YES     |
| Streaming          | NO  | NO     | NO      |
| Search (cached)    | YES | YES    | YES     |

### 13.2 Offline Strategy

```javascript
// On app start
async function initialize() {
  // 1. Load cached data
  const cachedAnime = await cache.get("anime:trending");
  if (cachedAnime) {
    renderAnimeList(cachedAnime);
  }

  // 2. Fetch fresh data
  try {
    const freshAnime = await api.getTrendingAnime();
    cache.set("anime:trending", freshAnime, 15 * 60 * 1000);
    renderAnimeList(freshAnime);
  } catch (error) {
    if (error.code === "OFFLINE") {
      showOfflineBanner();
      // Keep showing cached data
    }
  }
}
```

---

## 14. Navigation Principles

### 14.1 Client-Constructed Routes

The API returns data, not URLs. Clients construct their own routes.

**BAD (Backend dictates URL):**

```json
{
  "resumeUrl": "watch.html?id=123&ep=5"
}
```

**GOOD (Backend returns data, client builds URL):**

```json
{
  "animeId": 123,
  "episodeId": 456,
  "episodeNumber": 5
}
```

Client code:

```javascript
// Client constructs the route
const url = `/watch/${animeId}/${episodeNumber}`;
router.push(url);
```

### 14.2 Deep Linking

Mobile clients should handle deep links:

```
anistrim://anime/123        → Anime details
anistrim://watch/123/5      → Watch episode
anistrim://watchlist        → Watchlist screen
anistrim://upgrade          → Upgrade screen
```

---

## 15. Payments

### 15.1 Payment Flow

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│  Client │     │ Backend │     │ Pesapal │     │ Backend │
└────┬────┘     └────┬────┘     └────┬────┘     └────┬────┘
     │ 1. POST /checkout│            │               │
     │─────────────────▶│            │               │
     │                  │ 2. Create   │               │
     │                  │ subscription│               │
     │                  │────────────▶│               │
     │ 3. Redirect URL  │            │               │
     │◀─────────────────│            │               │
     │ 4. User pays     │            │               │
     │──────────────────────────────▶│               │
     │                  │            │ 5. IPN        │
     │                  │◀───────────│               │
     │                  │ 6. Update   │               │
     │                  │ subscription│               │
     │ 7. Callback      │            │               │
     │◀──────────────────────────────│               │
     │ 8. Verify        │            │               │
     │─────────────────▶│            │               │
     │ 9. Status        │            │               │
     │◀─────────────────│            │               │
```

### 15.2 Client Implementation

```javascript
async function initiateCheckout(plan) {
  // 1. Initialize checkout
  const { data } = await api.initializeCheckout(plan);

  // 2. Redirect to payment provider
  window.location.href = data.paymentLink;
}

// On callback
async function handlePaymentCallback() {
  // 1. Get callback params
  const params = new URLSearchParams(window.location.search);
  const orderTrackingId = params.get("OrderTrackingId");

  // 2. Verify subscription
  const { data } = await api.verifySubscription(orderTrackingId);

  // 3. Update UI
  if (data.status === "COMPLETED") {
    showSuccessMessage();
    refreshUserEntitlement();
  } else {
    showPendingMessage();
  }
}
```

### 15.3 Subscription Verification

```javascript
async function checkEntitlement() {
  const { data } = await api.verifySubscription();

  if (data.isPremium) {
    enablePremiumFeatures();
  } else {
    disablePremiumFeatures();
  }
}
```

---

## 16. Admin API

### 16.1 Authentication

All admin endpoints require:

1. Valid Bearer token
2. User has `admin` role

```javascript
// Admin API client
class AdminApiClient extends AniStrimApiClient {
  constructor(config) {
    super(config);
    this.requireAdmin = true;
  }

  // Dashboard
  async getDashboardOverview() { ... }
  async getDashboardHealth() { ... }
  async getChartData(type, days) { ... }

  // Users
  async getUsers(page, filters) { ... }
  async updateUser(id, data) { ... }
  async bulkDeleteUsers(ids) { ... }

  // Anime CMS
  async getAnime(page, filters) { ... }
  async createAnime(data) { ... }
  async updateAnime(id, data) { ... }
  async deleteAnime(id) { ... }
  async bulkUpdateAnime(ids, action) { ... }

  // Episodes
  async addEpisode(animeId, data) { ... }
  async updateEpisode(id, data) { ... }
  async deleteEpisode(id) { ... }

  // Genres
  async getGenres() { ... }
  async createGenre(name) { ... }
  async updateGenre(id, name) { ... }
  async deleteGenre(id) { ... }

  // Settings
  async getSettings() { ... }
  async updateSettings(settings) { ... }

  // Ads
  async getAds() { ... }
  async createAd(data) { ... }
  async updateAd(id, data) { ... }
  async deleteAd(id) { ... }

  // Payments
  async getPayments(page, filters) { ... }
  async updatePaymentStatus(id, status) { ... }

  // Logs
  async getLogs(page) { ... }
  async getAuditLogs(page, filters) { ... }
}
```

### 16.2 Admin-Only Operations

| Operation          | Endpoint                 | Notes              |
| ------------------ | ------------------------ | ------------------ |
| User management    | `/api/admin/users/*`     | CRUD, bulk delete  |
| Anime management   | `/api/admin/anime/*`     | CRUD, import, sync |
| Episode management | `/api/admin/episodes/*`  | CRUD, bulk delete  |
| Genre management   | `/api/admin/genres/*`    | CRUD               |
| Settings           | `/api/admin/settings`    | Site configuration |
| Ads                | `/api/admin/ads/*`       | CRUD               |
| Payments           | `/api/admin/payments/*`  | Status updates     |
| Logs               | `/api/admin/logs`        | Activity logs      |
| Audit              | `/api/admin/audit`       | Audit trail        |
| Health             | `/api/admin/dashboard/*` | System health      |

---

## 17. Security Rules

### 17.1 DO NOT DO THIS

| Rule                                                 | Reason                               |
| ---------------------------------------------------- | ------------------------------------ |
| ❌ Never embed database credentials                  | Credentials must be server-side only |
| ❌ Never call MySQL directly                         | All data access through API          |
| ❌ Never expose provider credentials                 | Cookies/API keys are server-side     |
| ❌ Never bypass premium checks                       | Backend is authoritative             |
| ❌ Never construct provider URLs                     | URLs are signed and time-limited     |
| ❌ Never trust client-side premium flags             | Always verify with backend           |
| ❌ Never store refresh tokens in localStorage        | Use secure storage                   |
| ❌ Never expose JWT secrets                          | Secrets are server-side only         |
| ❌ Never bypass API authorization                    | Backend enforces all rules           |
| ❌ Never implement business authorization only in UI | Backend must enforce                 |

### 17.2 Token Storage

| Token Type    | Web                         | Mobile            | Desktop     |
| ------------- | --------------------------- | ----------------- | ----------- |
| Access token  | localStorage/sessionStorage | Keychain/Keystore | OS Keychain |
| Refresh token | httpOnly cookie             | Keychain/Keystore | OS Keychain |

### 17.3 HTTPS Required

All production API calls must use HTTPS. Never make HTTP calls to the API in production.

### 17.4 Certificate Pinning (Mobile)

Mobile clients should implement certificate pinning to prevent MITM attacks.

---

## Appendix A: Files Inspected

### Route Files

- `routes/authRoutes.js`
- `routes/profileRoutes.js`
- `routes/animeRoutes.js`
- `routes/watchRoutes.js`
- `routes/watchlistRoutes.js`
- `routes/streamRoutes.js`
- `routes/streamProxyRoutes.js`
- `routes/paymentRoutes.js`
- `routes/adsRoutes.js`
- `routes/homeShelfRoutes.js`
- `routes/reportRoutes.js`
- `routes/downloadRoutes.js`
- `routes/adminRoutes.js`
- `routes/uploadRoutes.js`
- `routes/avatarRoutes.js`
- `routes/v1/index.js`

### Middleware

- `middleware/auth.js`
- `middleware/errorHandler.js`
- `middleware/requestId.js`
- `middleware/rateLimit.js`

### Services

- `services/sessionService.js`
- `services/apiDtoService.js`
- `services/userDtoService.js`
- `services/adminDtoService.js`

### Utils

- `utils/response.js`
- `utils/apiError.js`
- `utils/streamToken.js`
- `utils/episodeAccess.js`
- `utils/redact.js`

### Config

- `config/cors.js`
- `config/clientAgnostic.js`

---

## Appendix B: API Endpoints Documented

| Category     | Count    |
| ------------ | -------- |
| AUTH         | 24       |
| PROFILE      | 6        |
| ANIME        | 14       |
| WATCH        | 12       |
| WATCHLIST    | 9        |
| STREAMING    | 4        |
| STREAM PROXY | 4        |
| PAYMENTS     | 7        |
| ADS          | 4        |
| HOME         | 4        |
| REPORTS      | 1        |
| DOWNLOAD     | 1        |
| ADMIN        | 45+      |
| UPLOAD       | 2        |
| AVATAR       | 1        |
| HEALTH       | 2        |
| **Total**    | **130+** |

---

## Appendix C: Contracts Discovered

1. **Response Envelope Contract** — `{ success, data, meta }`
2. **Error Envelope Contract** — `{ success, error: { code, message, details, requestId } }`
3. **Authentication Contract** — JWT Bearer tokens with refresh rotation
4. **Streaming Contract** — Token-gated proxy with 120s TTL
5. **Premium Access Contract** — Backend-authoritative access decisions
6. **Pagination Contract** — `{ page, perPage, totalItems, totalPages, hasNext, hasPrev }`
7. **CORS Contract** — Environment-driven origins with dev defaults

---

## Appendix D: Inconsistencies Found

1. **Dual field naming** — Some DTOs return both camelCase and snake_case (e.g., `videoUrl` and `video_url`). Clients should use camelCase.

2. **Legacy route aliases** — Some watchlist endpoints have legacy aliases (`/add`, `/continue`). Clients should use the canonical routes.

3. **Optional auth variation** — Some endpoints use `optionalAuth` while others use `protect`. This is intentional based on whether the endpoint should reject anonymous users.

---

## Appendix E: Remaining Backend Blockers

**None.** The backend is READY for multi-client deployment.

---

## Appendix F: Recommended Next Steps

### For Web

1. Implement API client using the abstraction in Section 11
2. Set up secure token storage (httpOnly cookies preferred)
3. Implement token refresh flow
4. Build media player with HLS support

### For Mobile

1. Implement API client with secure storage (Keychain/Keystore)
2. Set up deep link handling
3. Implement certificate pinning
4. Build native media player (ExoPlayer/AVPlayer)

### For Desktop

1. Implement API client with OS keychain integration
2. Set up deep link handling
3. Implement media player
4. Build offline cache layer

### For Admin

1. Implement admin API client
2. Build CMS UI components
3. Implement data tables with pagination
4. Build analytics/charts dashboard

---

## Conclusion

**The current backend can safely serve all four clients (Web, Mobile, Desktop, Admin) without backend redesign.**

The API is:

- ✅ Client-agnostic
- ✅ Consistently structured
- ✅ Secure by design
- ✅ Well-documented
- ✅ Production-ready

Clients should follow this specification to ensure correct integration with the backend.

---

_End of Client Integration Specification_
