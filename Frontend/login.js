// login.js — BACKEND defined in scrpt.js
//
// Uses the native @capawesome/capacitor-google-sign-in plugin for Google
// authentication inside the Capacitor WebView. Replaces the previous
// web-based Google Identity Services (GIS) flow, which caused a WebView crash.

import { GoogleSignIn } from '@capawesome/capacitor-google-sign-in';

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

// ── Native Google Login (Capacitor) ─────────────────────────
// Handles the "Continue with Google" button inside the native app.
// Flow:
//   1. User clicks the button -> nativeGoogleLogin() is triggered
//   2. GoogleSignIn.signIn() opens the native Google account chooser
//   3. We extract the returned ID token and log it
//   4. We send the ID token to POST /api/auth/google/verify
//   5. Backend verifies and returns our JWT
//   6. We store the token and redirect into the app
async function nativeGoogleLogin() {
  try {
    const result = await GoogleSignIn.signIn();

    // Extract the ID token. The plugin exposes it directly on the result,
    // with fallbacks for different plugin versions.
    const idToken = result.idToken
      || result.authentication?.idToken
      || result.user?.idToken;

    if (!idToken) {
      throw new Error('No ID token received from Google.');
    }

    console.log('[Login] Native Google ID token received:', idToken);

    // Send the ID token to our backend for verification
    await sendIdTokenToBackend(idToken);

  } catch (err) {
    console.error('[Login] Native Google login error:', err?.message || err);
    showError('Google sign-in failed. Please try again.');
  }
}
window.nativeGoogleLogin = nativeGoogleLogin;

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
  // Bind the native Google login to the "Continue with Google" button
  document.getElementById('google-login-btn')?.addEventListener('click', nativeGoogleLogin);

  document.getElementById('login-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('login-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
});

// Export globally
window.handleLogin = handleLogin;
window.nativeGoogleLogin = nativeGoogleLogin;
window.showError = showError;