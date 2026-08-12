// login.js — BACKEND defined in scrpt.js
//
// Google login uses the In-App Browser OAuth workflow via the official
// @capacitor/browser and @capacitor/app plugins. The backend starts the
// Google OAuth flow in an in-app browser window, then hands back to the
// app through a deep link carrying the session token.

import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';

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

// ── In-App Browser Google Login ─────────────────────────────
// Opens the backend's Google OAuth start endpoint inside the in-app browser.
// After the user authenticates, the backend redirects back to the app via a
// deep link, which is handled by the appUrlOpen listener below.
async function loginWithInAppBrowser() {
  try {
    const oauthUrl = `${BACKEND}/api/auth/google/start`;
    await Browser.open({ url: oauthUrl, windowName: '_blank' });
  } catch (err) {
    console.error('[Login] In-App Browser error:', err?.message || err);
    showError('Could not open Google sign-in. Please try again.');
  }
}
window.loginWithInAppBrowser = loginWithInAppBrowser;

// ── Deep Link Handler ───────────────────────────────────────
// Fires when the app is woken up via a deep link (e.g. anistrim://auth?token=...).
async function handleAppUrlOpen(data) {
  try {
    // Shut down the in-app browser window
    await Browser.close();
  } catch (e) {
    // Browser may already be closed — safe to ignore
  }

  if (!data || !data.url) return;

  try {
    const url = new URL(data.url);
    const token = url.searchParams.get('token');

    // Preferred flow: backend hands back a direct session token
    if (token) {
      localStorage.setItem('session_token', token);
      localStorage.setItem('token', token);
      window.location.href = '/home.html';
      return;
    }

    // Fallback for the existing backend handoff: a short-lived exchange code.
    // If the deep link carries ?code=, exchange it for the session token.
    const code = url.searchParams.get('code');
    if (code) {
      const res = await fetch(`${BACKEND}/api/auth/google/token?code=${encodeURIComponent(code)}`);
      const data2 = await res.json();
      if (res.ok && data2.token) {
        localStorage.setItem('session_token', data2.token);
        localStorage.setItem('token', data2.token);
        if (data2.user) localStorage.setItem('user', JSON.stringify(data2.user));
        localStorage.setItem('isFirstVisit', 'true');
        window.location.href = data2.user?.isAdmin ? 'admin.html' : 'index.html';
      } else {
        showError(data2.message || 'Google sign-in failed. Please try again.');
      }
      return;
    }

    // Cancelled / error deep link (e.g. anistrim://auth-error)
    if (url.href.includes('auth-error')) {
      showError('Google sign-in was cancelled or failed.');
    }
  } catch (err) {
    console.error('[Login] Deep link parse error:', err?.message || err);
  }
}

// Register the global appUrlOpen listener once
App.addListener('appUrlOpen', handleAppUrlOpen);

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
  // Bind the in-app browser login to the "Continue with Google" button
  document.getElementById('google-login-btn')?.addEventListener('click', loginWithInAppBrowser);

  document.getElementById('login-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('login-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
});

// Export globally
window.handleLogin = handleLogin;
window.loginWithInAppBrowser = loginWithInAppBrowser;
window.showError = showError;