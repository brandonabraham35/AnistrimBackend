// signup.js - BACKEND defined in scrpt.js
//
// Google Sign-Up uses the Capacitor Browser OAuth redirect flow.
// This module does NOT use GIS, @capawesome/capacitor-google-sign-in,
// or Credential Manager.
//
// Email/password signup uses the shared apiFetch wrapper (js/api.js).

// ── Capacitor plugin handles ──
const CapBrowser = window.Capacitor?.Plugins?.Browser;

// ── Email/Password Sign Up ──
async function handleSignUp() {
  const name     = document.getElementById('signup-name')?.value?.trim();
  const email    = document.getElementById('signup-email')?.value?.trim();
  const password = document.getElementById('signup-pass')?.value;
  const btn      = document.querySelector('.auth-submit');

  if (!name || !email || !password) { showError('Please fill in all fields.'); return; }
  if (password.length < 6) { showError('Password must be at least 6 characters.'); return; }

  btn.textContent = 'Creating account...';
  btn.disabled = true;

  const { ok, data } = await window.apiFetch('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name, email, password })
  });

  if (data && data.requiresVerification) {
    sessionStorage.setItem('pendingEmail', email);
    const emailSent = data.emailSent ? '1' : '0';
    sessionStorage.setItem('otpEmailSent', emailSent);
    window.location.href = 'verify-otp.html?email=' + encodeURIComponent(email) + '&emailSent=' + emailSent;
    return;
  }

  if (!ok && data && data.code === 'EMAIL_SEND_FAILED') {
    showError(data.message || "We couldn't send your verification email. Please try again.");
    btn.textContent = 'Create Account';
    btn.disabled = false;
    return;
  }

  if (ok && data && data.token) {
    if (window.setAuthTokens) window.setAuthTokens(data.token, data.refreshToken);
    else localStorage.setItem('token', data.token);
    localStorage.setItem('isFirstVisit', 'true');
    window.redirectAfterAuthentication(data.user, data.token, data.refreshToken);
    return;
  }

  showError((data && data.message) || 'Registration failed. Please try again.');
  btn.textContent = 'Create Account';
  btn.disabled = false;
}
window.handleSignUp = handleSignUp;

// ── Google Sign-Up (Capacitor Browser OAuth redirect) ──
async function googleSignUp() {
  try {
    const backend = (typeof window.getApiBaseUrl === 'function')
      ? window.getApiBaseUrl()
      : 'https://anistrimbackend.onrender.com';
    const url = backend + '/api/auth/google/start?intent=signup';

    if (CapBrowser) {
      CapBrowser.addListener('browserFinished', function () {
        var t = localStorage.getItem('token') || '';
        var u = localStorage.getItem('user');
        if (t && u) {
          try {
            var ud = JSON.parse(u);
            window.location.href = (ud && ud.isAdmin) ? 'admin.html' : 'index.html';
          } catch (e) { }
        }
      });

      await CapBrowser.open({
        url: url,
        windowName: '_self',
        presentationStyle: 'fullscreen',
      });
    } else {
      window.location.href = url;
    }
  } catch (e) {
    console.error('Google signup error:', e);
    showError('Could not open Google sign-in. Please try again.');
  }
}
window.googleSignUp = googleSignUp;

function showError(msg) {
  if (!msg) return;
  var el = document.getElementById('auth-error');
  if (!el) {
    el = document.createElement('p');
    el.id = 'auth-error';
    el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
    var s = document.querySelector('.auth-submit');
    if (s && s.parentNode) s.parentNode.insertBefore(el, s.nextSibling);
  }
  el.textContent = msg;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('google-signup-btn')?.addEventListener('click', googleSignUp);
  document.getElementById('signup-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSignUp();
  });
});
