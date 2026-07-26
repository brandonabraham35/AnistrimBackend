# Frontend Config Centralization — Progress Tracker

## Completed

### Files Created

- [x] `Frontend/config.js` — Centralized API_BASE_URL configuration, Capacitor detection, dark mode detection

### Files Modified — API Base URL Centralization

- [x] `Frontend/scrpt.js` — Replaced hardcoded `const API`, uses `window.API_BASE_URL` from config.js; added `reloadCatalog()` with retry logic; added error UI injection with retry button
- [x] `Frontend/details.js` — Removed hardcoded Render URLs, now uses `getApiBaseUrl()` and `apiFetch()`
- [x] `Frontend/google-auth-handler.js` — Uses `getApiBaseUrl()` from config.js
- [x] `Frontend/browse.js` — Added retry button and `reloadBrowse()` function

### Files Modified — Added config.js script tag

- [x] `Frontend/index.html`
- [x] `Frontend/login.html`
- [x] `Frontend/signup.html`
- [x] `Frontend/details.html`
- [x] `Frontend/watch.html`
- [x] `Frontend/browse.html`
- [x] `Frontend/watchlist.html`
- [x] `Frontend/profile.html`
- [x] `Frontend/upgrade.html`
- [x] `Frontend/admin.html`
- [x] `Frontend/payment-callback.html`
- [x] `Frontend/watch.js` — Replaced `BACKEND` with `API` in `downloadEpisode()`
- [x] `Frontend/details.js` — Replaced hardcoded fallback URLs with `API` variable
- [x] `Frontend/payment-callback.html` — Replaced hardcoded fallback URLs with `API` variable
- [x] `Frontend/src/utils/uploadImage-frontend-helper.js` — Removed `window.BACKEND` fallback

## ✅ All Tasks Complete

All hardcoded URLs and deprecated `BACKEND` variable usage have been cleaned up. The entire frontend now consistently uses `API` (from `config.js` → `scrpt.js`) for all API calls.

## Key Changes

### 1. Centralized API Base URL

- `config.js` exports `window.API_BASE_URL`
- `getApiBaseUrl()` detects Capacitor native
- All fetch calls now use this

### 2. Error Resilience

- `reloadCatalog()` function with retry counting
- Error overlay with retry button on homepage
- Retry button in browse page error state

### 3. No More Hardcoded Render URLs

- All `fetch('https://anistrimbackend.onrender.com/...')` replaced
- Uses `apiFetch()` or direct `getApiBaseUrl()` concatenation
