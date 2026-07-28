# Google OAuth GIS Migration Plan

## ✅ Completed Steps

### Step 1: Backend — Register the GIS verify route

- [x] Added `POST /api/auth/google/verify` route pointing to `googleVerifyController.verifyGoogleToken`
- [x] Added `GET /api/auth/google/client-id` endpoint to expose the Google Client ID to frontend
- Files: `routes/authRoutes.js`, `controllers/googleVerifyController.js` (already existed)

### Step 2: Frontend login.html — Add GIS library

- [x] Added `<script src="https://accounts.google.com/gsi/client" async defer>`
- [x] Button now has id `google-login-btn` for JS targeting
- [x] Added disabled state styles for Google button

### Step 3: Frontend login.js — Replace redirect with GIS popup

- [x] Replaced `window.location.href = ${BACKEND}/api/auth/google` with GIS popup
- [x] Added `handleGoogleLogin()` that calls `google.accounts.id.prompt()`
- [x] Added `handleGISCredentialResponse()` callback to receive ID token
- [x] Added `sendIdTokenToBackend()` to POST to `/api/auth/google/verify`
- [x] Added loading state with spinner in button
- [x] Added disabled state to prevent multiple clicks
- [x] Added popup cancellation handling with user-friendly message
- [x] Added `initGIS()` and `fetchClientId()` for dynamic client ID config
- [x] Backward compatible — email/password login unchanged

### Step 4: Frontend signup.html

- [x] Same GIS library addition
- [x] Same button structure with id-based targeting

### Step 5: Frontend signup.js

- [x] Same GIS popup flow as login.js
- [x] `handleGoogleSignUp()` function for signup page
- [x] Both login and signup call the same `POST /api/auth/google/verify` endpoint
- [x] Backend handles account creation vs linking automatically

### Step 6: AdminDashboard login

- [x] Added GIS library to `AdminDashboard/index.html`
- [x] Replaced redirect in `AdminDashboard/js/auth.js` with GIS popup
- [x] Added admin role check after token verification
- [x] Same loading states, error handling, and popup cancellation

### Step 7: Clean up old redirect flow files

- [x] `controllers/googleAuthController.js` — preserved for Capacitor mobile deep-link flow
- [x] `Frontend/google-auth-handler.js` — preserved for Capacitor deep-link support
- [x] `Frontend/google-callback.html` — preserved for Capacitor fallback
- [x] `AdminDashboard/google-callback.html` — preserved for legacy compatibility

## 📋 Remaining

- [ ] Test the GIS popup opens on "Continue with Google" click
- [ ] Verify ID token is received and sent to backend
- [ ] Verify backend returns JWT on POST /api/auth/google/verify
- [ ] Verify redirect to dashboard/home after successful login
- [ ] Verify existing email/password login still works
- [ ] Verify account linking (Google + email/password)
- [ ] Verify AdminDashboard GIS login with admin role check
