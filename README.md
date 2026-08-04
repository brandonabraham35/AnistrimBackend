# 🎬 AniStrim2 — Full-Stack Anime Streaming Platform

## 🏢 Recommended Business Name: **StreamVault Uganda Ltd.**

_Other options: WakaAnime, NileFlix, PearlStream, SavannaCinema_

---

## 📋 Complete Setup Guide

### STEP 1 — Install Prerequisites

Download and install:

- **Node.js** (v18+): https://nodejs.org
- **MySQL Workbench**: https://dev.mysql.com/downloads/workbench/

---

### STEP 2 — Set Up MySQL Database

1. Open **MySQL Workbench**
2. Connect to your local MySQL server (default: root / your password)
3. Click **File → Open SQL Script**
4. Select `Backend/sql/schema.sql`
5. Press **Ctrl+Shift+Enter** to run the entire script
6. You should see all tables created + seed data inserted

**Tables created:**
| Table | Purpose |
|-------|---------|
| `users` | All registered users + premium status |
| `anime` | Anime catalogue |
| `genres` | Genre master list |
| `anime_genres` | Links anime to genres |
| `episodes` | All episodes + video URLs |
| `watchlist` | User watchlists |
| `watch_history` | Playback progress per episode |
| `payments` | Flutterwave transactions |
| `admin_logs` | Audit trail |

---

### STEP 3 — Configure Environment

```bash
cd Backend
copy .env.example .env        # Windows
# OR
cp .env.example .env          # Mac/Linux
```

Open `.env` and fill in:

```env
DB_PASSWORD=your_mysql_password
JWT_SECRET=any_long_random_string_here

# Flutterwave (get from dashboard.flutterwave.com → Settings → API Keys)
FLW_PUBLIC_KEY=FLWPUBK_TEST-...
FLW_SECRET_KEY=FLWSECK_TEST-...
FLW_WEBHOOK_SECRET=any_secret_you_choose

# Payment amounts in UGX
PREMIUM_MONTHLY_AMOUNT=35000
PREMIUM_YEARLY_AMOUNT=350000
```

---

### Hosted Consumet Fallback (Tier 2)

The streaming pipeline uses a **3-tier fallback architecture**:

```
Tier 1: Local Consumet providers (consumet-kickassanime, consumet-animekai, ...)
   ↓  (all fail / no sources)
Tier 2: Hosted Consumet instance (via CONSUMET_API_URL)
   ↓  (also fails / not configured)
Tier 3: Graceful error → "No stream provider could resolve..." (logs + 502)
```

The hosted fallback:

- **Activates only** when Tier 1 local providers fail.
- Uses a **dedicated axios client** with an **independent timeout** (`CONSUMET_HOSTED_TIMEOUT_MS`).
- Has **no hardcoded endpoint URLs** — all paths are configurable via env vars.
- Preserves the existing API response format.

Environment variables (all optional; defaults applied):

```env
# Base URL of the hosted Consumet API instance. Leave empty to disable the
# hosted fallback entirely (it gracefully skips to Tier 3).
CONSUMET_API_URL=https://your-hosted-consumet.example

# Independent timeout (ms) for the hosted fallback's dedicated axios client.
CONSUMET_HOSTED_TIMEOUT_MS=10000

# Configurable endpoint path templates (no hardcoded URLs).
# Placeholders are URL-encoded before substitution:
#   {query}     — anime title
#   {id}        — anime id from the search result
#   {episodeId} — episode id from the anime info
CONSUMET_HOSTED_SEARCH_PATH=/anime/{query}
CONSUMET_HOSTED_INFO_PATH=/anime/{id}
CONSUMET_HOSTED_SOURCES_PATH=/anime/{id}/episodes/{episodeId}
```

### Structured Streaming Diagnostics (Debug Mode)

All streaming/provider activity is emitted as **structured JSON logs** through the
centralized `utils/logger.js`. Every provider attempt records: provider ID, anime
title, episode, start/end time, latency, result, failure reason, HTTP status,
timeout status, Cloudflare detection, search success, and stream success.

Enable verbose per-attempt debug logging (default `off` for production):

```env
# Set to '1'/'true' to enable verbose stream diagnostics (recommended only
# during development/troubleshooting). Off by default.
STREAM_DEBUG=1
```

> **Security:** Internal error messages are **never** returned to frontend users.
> The API returns generic messages (e.g. `"Could not resolve a stream."`) while
> full diagnostic details are logged server-side only.

### Miruro Provider — Intentionally Disabled

Miruro is **registered but intentionally disabled** in the streaming pipeline. The
compatibility audit (see `MIRURO_COMPATIBILITY_REPORT.md`) proved the previous resolver
assumed non-existent endpoints (`/search`, `/anime/{id}/episode/{n}`). The real Miruro
service is a same-origin `/api/*` SPA API protected by Cloudflare with undocumented
schemas, so it is **not** part of the active provider order.

- `buildMiruroResolver()` is a **no-op stub** — it logs `result: disabled`, returns
  `null`, and never makes HTTP requests. It never throws and never affects provider
  selection.
- `MIRURO_API_URL` is an optional env var; **setting it does NOT activate Miruro**.
  The provider remains disabled until a verified adapter (`services/miruroProvider.js`)
  is implemented after Phase 1 browser-traffic capture (see `TODO.md` roadmap).
- If a client forces `preferredProvider=miruro`, the pipeline safely falls through to
  the next provider.

---

### STEP 4 — Install & Run Backend

```bash
cd Backend
npm install
node server.js
```

Open browser → **http://localhost:5000**

---

### STEP 5 — Set Up Flutterwave Webhook

1. Go to **dashboard.flutterwave.com**
2. Settings → Webhooks
3. Set URL to: `https://your-domain.com/api/payments/webhook`
4. Set the hash to match your `FLW_WEBHOOK_SECRET` in `.env`

> For local testing, use **ngrok**: `ngrok http 5000`
> Then set webhook URL to: `https://xxxxx.ngrok.io/api/payments/webhook`

---

## 🗂️ Project Structure

```
AniStrim2/
├── Backend/
│   ├── server.js              ← Express entry point
│   ├── .env.example           ← Environment template
│   ├── package.json
│   ├── sql/
│   │   └── schema.sql         ← ⭐ Run this in MySQL Workbench
│   ├── config/
│   │   └── db.js              ← MySQL connection pool
│   ├── middleware/
│   │   └── auth.js            ← JWT protect / adminOnly / premiumOnly
│   ├── controllers/
│   │   ├── authController.js      ← Register, Login, JWT
│   │   ├── animeController.js     ← Trending, Search, Details
│   │   ├── watchlistController.js ← Add/Update/Remove + Progress
│   │   ├── paymentController.js   ← Flutterwave initiate + webhook
│   │   └── adminController.js     ← CMS + Users + Stats
│   └── routes/
│       ├── authRoutes.js
│       ├── animeRoutes.js
│       ├── watchlistRoutes.js
│       ├── paymentRoutes.js
│       └── adminRoutes.js
└── Frontend/
    ├── index.html             ← Home (hero slider)
    ├── browse.html            ← Search & filters
    ├── details.html           ← Anime details + episodes
    ├── watch.html             ← Video player
    ├── watchlist.html         ← My List
    ├── profile.html           ← User profile
    ├── upgrade.html           ← Premium upgrade (Flutterwave)
    ├── payment-callback.html  ← Payment result page
    ├── admin.html             ← Admin dashboard
    ├── login.html / signup.html
    └── style.css / scrpt.js / ...
```

---

## 🔑 API Reference

### Auth

| Method | Endpoint           | Description                     |
| ------ | ------------------ | ------------------------------- |
| POST   | `/api/auth/signup` | Register new user               |
| POST   | `/api/auth/login`  | Login → returns JWT             |
| GET    | `/api/auth/me`     | Get current user (JWT required) |

### Anime

| Method | Endpoint                              | Description         |
| ------ | ------------------------------------- | ------------------- |
| GET    | `/api/anime/trending`                 | All anime by rating |
| GET    | `/api/anime/featured`                 | Hero slider anime   |
| GET    | `/api/anime/search?q=&genre=&status=` | Search              |
| GET    | `/api/anime/:id`                      | Details + episodes  |

### Watchlist (JWT required)

| Method | Endpoint                  | Description            |
| ------ | ------------------------- | ---------------------- |
| GET    | `/api/watchlist`          | My list                |
| POST   | `/api/watchlist/add`      | Add anime              |
| PUT    | `/api/watchlist/:animeId` | Update status/progress |
| DELETE | `/api/watchlist/:animeId` | Remove                 |
| POST   | `/api/watchlist/progress` | Save video position    |

### Payments

| Method | Endpoint                       | Description                      |
| ------ | ------------------------------ | -------------------------------- |
| POST   | `/api/payments/initiate`       | Start Flutterwave checkout (JWT) |
| POST   | `/api/payments/webhook`        | Flutterwave webhook (no auth)    |
| GET    | `/api/payments/verify?tx_ref=` | Check payment status             |
| GET    | `/api/payments/revenue`        | Revenue stats (admin only)       |

### Admin (JWT + isAdmin required)

| Method     | Endpoint                        | Description              |
| ---------- | ------------------------------- | ------------------------ |
| GET        | `/api/admin/stats`              | Dashboard stats          |
| GET        | `/api/admin/users`              | All users                |
| PUT        | `/api/admin/users/:id/premium`  | Grant/revoke premium     |
| GET/POST   | `/api/admin/anime`              | List / Create anime      |
| PUT/DELETE | `/api/admin/anime/:id`          | Update / Delete          |
| POST       | `/api/admin/anime/:id/episodes` | Add episode              |
| PUT        | `/api/admin/episodes/:id`       | Update episode video URL |

---

## 💳 Flutterwave Payment Flow

```
User clicks "Confirm Upgrade"
        ↓
POST /api/payments/initiate
        ↓
Backend creates payment record (status: pending)
Backend calls Flutterwave API → gets payment_link
        ↓
Frontend redirects to Flutterwave hosted page
        ↓
User pays via MTN Mobile Money / Airtel / Card
        ↓
Flutterwave sends POST to /api/payments/webhook
        ↓
Backend verifies transaction
Backend sets user.is_premium = 1
Backend sets premium_expires_at
        ↓
Flutterwave redirects user to /payment-callback.html
        ↓
Frontend polls /api/payments/verify → shows success
```

---

## 🔐 Default Admin Login

Email: `admin@anistrim.com`
Password: `admin123`

> **Change this immediately after first login!**

---

## 🎥 Adding Video Content

In the Admin Dashboard → Episodes tab, paste your video URL:

- **Cloudinary**: upload and deliver videos through the Cloudinary media library.
- **Cloudinary**: `https://res.cloudinary.com/your-cloud/video/upload/v1/ep1.mp4`
- **AWS S3**: `https://your-bucket.s3.amazonaws.com/ep1.mp4`

---

## 🌐 Deployment (Production)

1. Deploy backend to **Railway** or **Render** (free tier available)
2. Use **PlanetScale** or **Railway MySQL** for database
3. Set all `.env` variables in your host's environment settings
4. Update `FRONTEND_URL` to your live domain
5. Update Flutterwave webhook URL to your live domain
