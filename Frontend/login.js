// login.js — BACKEND defined in scrpt.js
//
// Uses the shared Google auth module (google-auth-handler.js) for GIS.
// Shared module handles: library loading, client ID fetch, GIS init,
// credential callback, error states, and loading UI.

// ── Email/Password Login ────────────────────────────────────
async function handleLogin() {
  const email    = document.getElementById('login-email')?.value?.trim();
  const password = document.getElementById('login-pass')?.value;
  const btn      = document.querySelector('.auth-submit');

  if (!email || !password) { showError('Please fill in all fields.'); return; }
  btn.textContent = 'Signing in...';
  btn.disabled = true;

  try {
    const res  = await fetch(`${BACKEND}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (res.ok) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('isFirstVisit', 'true');
      window.location.href = data.user.isAdmin ? 'admin.html' : 'index.html';
    } else {
      showError(data.message || 'Incorrect email or password.');
      btn.textContent = 'Sign In';
      btn.disabled = false;
    }
  } catch (e) {
    showError('Cannot reach server. Please check your connection.');
    btn.textContent = 'Sign In';
    btn.disabled = false;
  }
}
window.handleLogin = handleLogin;

// ── Google Identity Services (GIS) Popup Login ──────────────
// Uses the shared google-auth-handler.js module.
// Flow:
//   1. User clicks "Continue with Google" button
//   2. handleGoogleLogin() calls window.initGoogleAuth('google-login-btn')
//   3. Shared module shows Google account chooser via GIS prompt()
//   4. GIS returns credential (ID token) in callback
//   5. We send the ID token to POST /api/auth/google/verify
//   6. Backend verifies and returns our JWT
//   7. We store the token and redirect into the app

async function handleGoogleLogin() {
  try {
    // Use the shared Google auth module
    const response = await window.initGoogleAuth('google-login-btn');

    if (!response || !response.credential) {
      showError('Google sign-in failed. No credential received.');
      return;
    }

    const idToken = response.credential;
    console.log('[Login] Google ID token received, verifying with backend...');

    // Send the ID token to our backend for verification
    await sendIdTokenToBackend(idToken);

  } catch (err) {
    // Error already displayed by shared module
    console.error('[Login] Google auth error:', err.message);
    // Only show error if the shared module didn't already display one
  }
}

// Send the ID token to POST /api/auth/google/verify
async function sendIdTokenToBackend(idToken) {
  try {
    const res = await fetch(`${BACKEND}/api/auth/google/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });

    const data = await res.json();

    if (res.ok && data.token && data.user) {
      // Success — store session and redirect
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('isFirstVisit', 'true');

      // Redirect based on role — same logic as email login
      window.location.href = data.user.isAdmin ? 'admin.html' : 'index.html';
    } else {
      showError(data.message || 'Google sign-in failed. Please try again.');
    }
  } catch (e) {
    console.error('[Login] Backend verification error:', e);
    showError('Cannot reach server. Please check your connection.');
  }
}

// ── Error Display ─────────────────────────────────────────
function showError(msg) {
  if (!msg) return;
  let el = document.getElementById('auth-error');
  if (!el) {
    el = document.createElement('p');
    el.id = 'auth-error';
    el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
    const btn = document.getElementById('google-login-btn');
    if (btn && btn.parentNode) {
      btn.parentNode.insertBefore(el, btn.nextSibling);
    } else {
      document.querySelector('.auth-submit')?.before(el);
    }
  }
  el.style.display = 'block';
  el.textContent = msg;
  // Auto-clear after 10 seconds
  if (el._clearTimer) clearTimeout(el._clearTimer);
  el._clearTimer = setTimeout(() => {
    if (el && el.parentNode) {
      el.style.display = 'none';
      el.textContent = '';
    }
  }, 10000);
}

// ── Event Listeners ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('login-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
});

// Export globally
window.handleLogin = handleLogin;
window.handleGoogleLogin = handleGoogleLogin;
window.showError = showError;

