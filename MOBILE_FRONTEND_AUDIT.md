# AniStrim — Mobile Frontend Audit

**Audit date:** 2026-08-20
**Audit type:** READ-ONLY (no changes made)
**Scope:** Frontend/, capacitor.config.json, package.json, android/, ios/, CORS config, auth/session/payment/streaming/player/render flows
**Canonical mobile client:** `Frontend/` (webDir for Capacitor; confirmed by `capacitor.config.json` and `scripts/capacitor-preflight.js`)

---

## 1. Current Status

`Frontend/` **is structurally wired for Capacitor** and is the declared `webDir` for both Android and iOS. The app shell, navigation, API layer, session layer, player engine, auth flows, and native CSS are all present and Capacitor-aware in several important places. However, the build is **not currently ship-safe for iOS/Android** because of several **critical** native-configuration and runtime gaps (detailed below). The Android native folders exist; the iOS folder exists but its bundled `public/` copy and `Info.plist` are out of sync/incomplete.

---

## 2. Architecture Findings

| Area               | Finding                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **webDir**         | `capacitor.config.json` sets `"webDir": "Frontend"`. `scripts/capacitor-preflight.js` validates `index.html`, `admin.html`, `config.js`, `scrpt.js` before `cap copy/sync`. No bundler — `Frontend/` is the shipped output. ✅                                         |
| **App shell**      | `config.js` detects native via `window.Capacitor.isNative` and forces the absolute Render backend URL for all API calls (localStorage / `file:` / `localhost` webview origins). ✅                                                                                     |
| **Navigation**     | `js/navigation.js` uses relative paths (`index.html`) inside Capacitor WebView and root-absolute paths otherwise; sanitizes `?redirect=` against an allowlist (open-redirect safe). ✅                                                                                 |
| **Session/auth**   | Centralized `Auth` module (config.js), `Session` module (js/session.js), single canonical `apiFetch` (js/api.js) with 401 auto-refresh + single-flight refresh + envelope unwrapping. ✅                                                                               |
| **Player**         | `js/player/core.js` detects native HLS (`canPlayType('application/vnd.apple.mpegurl')`) and falls back to native for iOS; uses hls.js otherwise. Player gestures use Pointer Events (mobile-friendly). Resilience ladder, skip intro/outro, ads gating all present. ✅ |
| **Premium gating** | Frontend gating is cosmetic; authority is server-side (`/api/stream/authorize` → 403 `PREMIUM_REQUIRED` / `DEVICE_LIMIT_REACHED`). Server-emitted `locked`/`effectiveTier`/`accessState` used for UX only. ✅                                                          |
| **Native CSS**     | `mobile-native.css` adds safe-area insets, larger tap targets, `touch-action: manipulation` (no double-tap zoom), keyboard avoidance, etc. ✅                                                                                                                          |
| **CORS**           | `config/cors.js` allows `capacitor://localhost` (iOS) and `https://localhost` (Android prod WebView) in dev; production relies on `API_ALLOWED_ORIGINS`. ✅ (production value must include the app origins — see Risks)                                                |

---

## 3. Compatibility Issues Found

### 3.1 Critical

**C1 — iOS deep-link scheme is NOT registered in `Info.plist`.**
`ios/App/App/Info.plist` has **no `CFBundleURLTypes`** entry for the `anistrim://` scheme (or the Google reversed-client-id). The Google auth deep-link listener in `google-auth-handler.js` listens for `anistrim://auth?code=…` via `App.addListener('appUrlOpen')`, and the `AppDelegate.swift` forwards URLs, but on iOS the OS will **never route `anistrim://` back to the app** without `CFBundleURLTypes`. Google Sign-In and any payment/verification deep-link **cannot work on iOS** until this is added.

**C2 — iOS bundled web assets are a stale/separate copy.**
`ios/App/App/public/` mirrors `Frontend/` but is itself a copy that must be re-synced (`cap copy ios` / `cap sync ios`). It already diverges from `Frontend/` (it is missing some files that `Frontend/` has — compare the file trees). If anyone edits `Frontend/` and forgets to `cap sync ios`, the iOS build ships stale/partial code. There is **no single source-of-truth guard** enforcing that `ios/App/App/public` always equals `Frontend/` after every change.

**C3 — Payment checkout navigates the WebView to an external URL.**
`upgrade.js` does `window.location.href = data.payment_link` after the checkout call. In a Capacitor WebView this navigates the app shell **away** to the external Pesapal payment page. The subsequent return to `payment-callback.html` relies on the external page redirecting back with `?status=…&tx_ref=…`. This works only if (a) that return URL is a **web** URL (e.g. `https://anistrimbackend.onrender.com/payment-callback.html` served by the backend), and (b) the WebView allows navigation back into the app. Today the return target is the **backend-hosted** `payment-callback.html` (hardcoded in `paymentRoutes.js`), which breaks the mobile deep-link model. Also, if the return URL is a `file://`/Capacitor-local page it will lose the JWT/localStorage context between navigations (native WebView storage persists, but a full page reload from an external domain is fragile and can drop the `anistrim://` origin).

**C4 — `alert()` / `confirm()` are used widely and are broken/blocked on iOS WKWebView.**
Found in `upgrade.js`, `profile.js`, `details.js`, `scrpt.js`, and `watch.js`. iOS WKWebView does **not** support `window.alert`/`window.confirm` (they silently no-op or require approval). Flows such as revoke-device confirmation, clear-history confirmation, deactivate/delete-account confirmation, download prompts, and payment errors will be **silently broken on iPhone**. These must be replaced with in-app modal/toast confirmations.

**C5 — No secure token storage on mobile.**
The backend contract (docs/client-integration-spec.md §3.1–3.2) explicitly recommends **Keychain/Keystore** for mobile, but the app stores `token`, `session_token`, `refresh_token`, and `user` in **`localStorage`**. On iOS WKWebView, `localStorage` can be evicted (WKWebsiteDataStore), and it is **not** encrypted. Refresh-token rotation logic is solid server-side (`services/sessionService.js` rotates + reuse-detection), but the client storing it in plain localStorage weakens that and is fragile across app restarts on iOS.

**C6 — The iOS Info.plist lacks `NSAppTransportSecurity`/`NSAllowsArbitraryLoads` exceptions (if any HTTP is used) and any Google OAuth URL schemes.**
The app calls an `https` backend (fine), so ATS is okay for the API. But the Google/CID + `anistrim://` schemes (C1) are the real blocker.

### 3.2 Medium

**M1 — HLS manifest interception across origins on native.**
`js/player/core.js` falls back to native HLS on iOS, which is correct. On Android it uses hls.js against the **hardened proxy** `/api/stream-proxy/:streamId` (token-authorized, IP-bound). This is the designed path and is correct. But the subtitles/quality logic depends on the backend rewriter emitting proxied child URLs (`?ct=<child_token>`). On iOS native HLS, `video.src` is set directly to the proxy manifest; the WKWebView fetches children — this should work as long as CORS/`credentials` allow it. **Risk:** if the proxy requires the stream token as a header vs query and the iOS native player cannot pass it. Currently tokens are appended as `?token=` (query) — good for native players. ✅ (low risk, but note as watch item.)

**M2 — Google Sign-In on mobile relies on a browser OAuth deep-link; the native `@capawesome/capacitor-google-sign-in` plugin is installed but not used.**
`package.json` includes `@capawesome/capacitor-google-sign-in`, but `google-auth-handler.js` uses **Google Identity Services (GIS)** via `https://accounts.google.com/gsi/client` — a **browser-only** flow. In a Capacitor WebView, loading the remote GIS script, rendering the GIS button, and the popup/session behavior is unreliable on iOS (WKWebView restricts third-party cookies/data) and on Android it may work partially. The more robust mobile approach is the **native sign-in plugin** with a proper `credential` → backend verify flow. The current GIS + `anistrim://auth` deep-link fallback is a workaround that depends on C1 (iOS scheme) being fixed.

**M3 — `payment-callback.html` polls via `localStorage`-based refs across a full page unload.**
Because C3 navigates the WebView away, `pending_tx_ref`/`pending_subscription_ref` must survive the external round-trip. Native WebView storage _may_ persist, but this is fragile. A mobile-native payment bridge (open in `@capacitor/browser` and receive `appUrlOpen`) is the correct architecture.

**M4 — Fullscreen and Picture-in-Picture are browser APIs without native fallback.**
`player-controls.js` uses `requestFullscreen`/`requestPictureInPicture`. iOS Safari supports `webkitEnterFullscreen` on `<video>` and webkit `presentationMode`; the code does **not** use `video.webkitEnterFullscreen()`. On iOS the fullscreen button may do nothing. Add `webkitEnterFullscreen`/PiP `webkitSetPresentationMode` fallbacks for iOS.

**M5 — Offline download feature uses `IndexedDB` blob storage (sandboxed).**
`watch.js` uses `storeBlobInIndexedDB`. This works but is not visible to the OS Files app and can be evicted. Functionally fine for the "Download" button MVP, but not a true OS-level download. Low/medium.

**M6 — Dev CORS origins only; production `API_ALLOWED_ORIGINS` must include the native origins.**
`config/cors.js` auto-allows `capacitor://localhost`/`https://localhost` **only when `NODE_ENV !== 'production'`**. For production builds, `API_ALLOWED_ORIGINS` must explicitly include `capacitor://localhost` and `https://localhost`, or the native WebView fetch calls will be **blocked by CORS** in production. This is the single most likely silent production failure. (The CAPACITOR server `androidScheme: https` → Android WebView origin is `https://localhost`; iOS is `capacitor://localhost`.)

**M7 — No `@capacitor/share` / `@capacitor/filesystem` / `@capacitor/splash-screen` / `@capacitor/status-bar` usage.**
Present functionality (share, file save, status bar safe areas) uses web APIs only. Not blocking, but native plugins would improve the mobile feel.

### 3.3 Low Priority

**L1 — `alert`/`console` debug statements** throughout `watch.js` (e.g. `[WATCH DEBUG]`) should be removed/guarded for release.

**L2 — No pull-to-refresh / offline-friendly caching** implemented (`.ptr-indicator` CSS exists but unused).

**L3 — No service worker / PWA offline shell** (not required for Capacitor, but would help).

**L4 — `account-status.html`, `verify-otp.html`, `google-callback.html`** are web-hosted pages; on mobile they must remain part of the `Frontend/` bundle (they are — good). `google-callback.html` is the web fallback and is harmless.

---

## 4. Files Requiring Changes (for the implementation phase — NOT done in this audit)

| File                                                                      | Change needed (when fixes are approved)                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ios/App/App/Info.plist`                                                  | Add `CFBundleURLTypes` for `anistrim` scheme + Google reversed-client-id; (optional) ATS policy. **Critical.**                                               |
| `Frontend/upgrade.js`                                                     | Replace `window.location.href = data.payment_link` with native browser-open (`@capacitor/browser`) + `appUrlOpen` deep-link callback; keep in-app fallback.  |
| `Frontend/payment-callback.html`                                          | Handle deep-link invocation; re-read refs robustly; use in-app modal state instead of full-page reload.                                                      |
| `Frontend/profile.js`, `details.js`, `scrpt.js`, `upgrade.js`, `watch.js` | Replace `alert()`/`confirm()` with in-app modal/toast confirmation. **Critical for iOS.**                                                                    |
| `Frontend/js/player-controls.js`                                          | Add iOS fullscreen/PiP fallbacks (`webkitEnterFullscreen`, `webkitSetPresentationMode`).                                                                     |
| `Frontend/google-auth-handler.js`                                         | Add native `@capawesome/capacitor-google-sign-in` path (or ensure iOS scheme + GIS works); keep deep-link handler.                                           |
| `Frontend/config.js` + `js/api.js` + `js/session.js`                      | Optionally gate secure storage (Keychain/Keystore) for tokens on mobile via a native storage plugin; at minimum document the iOS localStorage-eviction risk. |
| `config/cors.js` / `.env`                                                 | Ensure production `API_ALLOWED_ORIGINS` includes `capacitor://localhost` and `https://localhost`. **Critical for prod builds.**                              |
| `scripts/capacitor-preflight.js`                                          | Extend to validate `ios/App/App/public` is in sync with `Frontend/` (or enforce `cap sync ios` runs).                                                        |
| iOS native folders                                                        | Run `cap add ios`/`cap sync ios` so the bundled `public/` matches `Frontend/` exactly. **Critical.**                                                         |

## 5. Files That MUST NOT Be Changed

These are backend/contract boundaries — the audit found no mobile-compatibility bug requiring a contract change, so they must stay as-is:

- `routes/*`, `controllers/*`, `services/*`, `middleware/*`, `utils/streamToken.js`, `utils/streamProxy.js`, `config/clientAgnostic.js`
- `docs/client-integration-spec.md` (the contract — used as the reference, not edited)
- `sql/*` migrations (schema)
- `server.js`
- `Web/`, `Desktop/` (reference/client stubs — not to be repurposed)
- **`Frontend/` must NOT be renamed/moved/replaced.** It is the canonical mobile client.

## 6. Files Verified As Mobile-Ready (no changes needed for structure)

- `Frontend/config.js` — Capacitor detection + single API base URL ✅
- `Frontend/js/api.js` — single canonical apiFetch, 401 refresh, envelope ✅
- `Frontend/js/session.js` — server-authoritative user DTO ✅
- `Frontend/js/navigation.js` — Capacitor-safe relative navigation + sanitized redirect ✅
- `Frontend/js/player/core.js` — native-HLS detection ✅
- `Frontend/js/player/{resilience,gestures,markers,ads}.js` — mobile interaction/recovery ✅
- `Frontend/mobile-native.css` — safe areas / tap targets / touch-action ✅
- `Frontend/js/avatar.js` — renders avatars everywhere, no browser-only API ✅
- `android/app/src/main/AndroidManifest.xml` — has `anistrim` scheme + INTERNET ✅
- `ios/App/App/AppDelegate.swift` — forwards `open url` + universal links to Capacitor proxy ✅ (deep link plumbing present; only the URL scheme registration is missing)

## 7. Recommended Mobile Architecture

**Target:** Keep `Frontend/` as the single web source of truth. On `cap sync`, copy `Frontend/` → Android & iOS bundles. The app uses `capacitor://localhost` (iOS) / `https://localhost` (Android) origins with `capacitor.config.json` `server.androidScheme:"https"` and `CapacitorHttp` enabled.

1. **Native auth:** Use `@capawesome/capacitor-google-sign-in` on device devices (native popup → idToken → `POST /api/auth/google/verify`). For web/dev keep GIS. Keep the `anistrim://auth?code=` deep-link path as a secondary flow — requires `CFBundleURLTypes` on iOS.
2. **Token storage:** Adopt a native secure-storage plugin (Keychain/Keystore) for `token`/`refresh_token`; keep `localStorage` only as a fallback for web.
3. **Payments:** Open the Pesapal checkout via `@capacitor/browser`; return via `appUrlOpen` to `payment-callback` in-app; never navigate the WebView to an external host.
4. **Persistence/refresh:** Keep single-flight refresh; on mobile, after app restart, call `/api/auth/me` and, on 401, refresh from secure storage — already the pattern, just needs secure storage.
5. **Streaming:** Keep the hardened `/api/stream-proxy/:streamId?token=` proxy for both platforms; ensure native HLS (iOS) can request child URLs (token in query is compatible). Add iOS fullscreen fallback.
6. **Confirmation UX:** Replace `alert/confirm` with in-app modals (`showToast` + a reusable confirm modal).
7. **CORS in prod:** Ensure `API_ALLOWED_ORIGINS` contains `capacitor://localhost` and `https://localhost`.
8. **Sync guard:** Extend `capacitor-preflight.js` to fail if `ios/App/App/public` or `android/app/src/main/assets/public` differ from `Frontend/`, or auto-run `cap synergy` for both platforms.

---

## 8. Verdict

```
MOBILE FRONTEND STATUS:
NEEDS FIXES
```

**Why not READY / BLOCKED:**

- The codebase is structurally Capacitor-ready (webDir, navigation, sessions, player, CSS), which is why it is **not BLOCKED**.
- It is **not READY** because of the **critical** iOS config gaps (C1/C2/C6: no URL scheme, stale iOS bundle), the **payment navigation model** (C3), and the **browser-only `alert/confirm`/GIS reliance** (C4/M2), plus the production-CORS risk (M6). None of these require a backend contract change — they are all client/native-config fixes — so they are fixable without affecting the objective constraints.
