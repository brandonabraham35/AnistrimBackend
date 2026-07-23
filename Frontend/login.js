// login.js — BACKEND defined in scrpt.js

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

// ── Google Login ─────────────────────────────────────────────
// Opens Railway's Google auth page via Capacitor Browser
// After Google auth, backend redirects back using intent deep link
// google-auth-handler.js catches the deep link and exchanges code for JWT
async function googleLogin() {
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      const Browser = window.Capacitor.Plugins.Browser;

      // Listen for browser close — if user taps X
      Browser.addListener('browserFinished', function() {
        // If deep link was received and handler ran, token is already saved
        // Just check and redirect if needed
        const token = localStorage.getItem('token');
        const user  = localStorage.getItem('user');
        if (token && user) {
          try {
            const userData = JSON.parse(user);
            window.location.href = userData.isAdmin ? 'admin.html' : 'index.html';
          } catch(e) {}
        }
      });

      await Browser.open({
        url: `${BACKEND}/api/auth/google`,
        windowName: '_self',
        presentationStyle: 'fullscreen',
      });

    } else {
      // Fallback for desktop/web testing
      window.location.href = `${BACKEND}/api/auth/google`;
    }
  } catch (e) {
    console.error('Google login error:', e);
    showError('Could not open Google sign-in. Please try again.');
  }
}
window.googleLogin = googleLogin;

function showError(msg) {
  if (!msg) return;
  let el = document.getElementById('auth-error');
  if (!el) {
    el = document.createElement('p');
    el.id = 'auth-error';
    el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
    document.querySelector('.auth-submit')?.before(el);
  }
  el.textContent = msg;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('login-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
});
