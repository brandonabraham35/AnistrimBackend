# Google Auth Migration — Completion Report

## ✅ Step 1: Fix authController and add signup endpoint

**File: `controllers/authController.js`**

- Added `signup` function for new user registration
- Removed admin-only restriction from login — now works for any valid user
- Added `last_login` update on successful login
- Added Google-only account detection (users without password_hash get directed to Google login)
- Added `avatar_url` in login response for profile display
- Extended JWT expiry from `1d` to `7d`

**File: `routes/authRoutes.js`**

- Added `POST /api/auth/signup` route

## ✅ Step 2: Enhance googleVerifyController

**File: `controllers/googleVerifyController.js`**

- Added `last_login` and `updated_at` timestamp updates after successful auth
- Added avatar URL update when Google provides a new/different picture
- Added issuer validation (checks `accounts.google.com`)
- Added audience validation (checks against `GOOGLE_CLIENT_ID`)
- Added differentiated error messages:
  - Token expired
  - Invalid token
  - Network error (ECONNREFUSED/ETIMEDOUT)
  - Generic failure
- Added three-path user resolution:
  1. Lookup by `google_id` (fast path — returning Google users)
  2. Lookup by `email` (account linking — existing email users)
  3. Create new user (new Google sign-ups)
- Added comment header marking this as the PRIMARY Google auth flow for web

## ✅ Step 3: Create last_login migration

**File: `sql/migrations_v17_last_login.sql`**

- Adds `last_login DATETIME` column to users table
- Backfills existing records with `created_at` value
- Adds index on `last_login`

## ✅ Step 4: Legacy code isolation

The following files are **KEPT but isolated** exclusively for Capacitor/mobile support:

- `controllers/googleAuthController.js` — OAuth redirect + deep-link flow (mobile only)
- `Frontend/google-callback.html` — Mobile callback handler
- `AdminDashboard/google-callback.html` — Mobile admin callback handler
- `AdminDashboard/js/google-auth-handler.js` — Empty file, kept for compatibility

**Confirmation:** No web page references or calls these legacy files.

## ✅ Step 5: Verify shared GIS module usage

All web auth pages use the shared `google-auth-handler.js` module:

- `Frontend/login.html` ✅ — loads `google-auth-handler.js`
- `Frontend/signup.html` ✅ — loads `google-auth-handler.js`
- `AdminDashboard/index.html` ✅ — loads `google-auth-handler.js`

## Architecture Summary

**Single Google auth flow for web:** GIS ID Token verification via `googleVerifyController.js`

**Flow:**

1. User clicks "Continue with Google"
2. GIS shows account chooser (popup)
3. Google returns ID token to callback
4. Frontend sends `POST /api/auth/google/verify` with ID token
5. Backend verifies token (audience, issuer, email_verified)
6. Backend finds or creates user (with account linking)
7. Backend updates last_login and avatar
8. Backend returns JWT + user object
9. Frontend stores JWT and redirects to app

**Mobile only:** Legacy OAuth redirect flow kept for Capacitor deep-link support.
