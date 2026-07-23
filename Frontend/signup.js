// signup.js — BACKEND defined in scrpt.js

async function handleSignUp() {
  const name     = document.getElementById('signup-name')?.value?.trim();
  const email    = document.getElementById('signup-email')?.value?.trim();
  const password = document.getElementById('signup-pass')?.value;
  const btn      = document.querySelector('.auth-submit');

  if (!name || !email || !password) { showError('Please fill in all fields.'); return; }
  if (password.length < 6) { showError('Password must be at least 6 characters.'); return; }

  btn.textContent = 'Creating account...';
  btn.disabled = true;

  try {
    const res  = await fetch(`${BACKEND}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();

    if (res.ok) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('isFirstVisit', 'true');
      window.location.href = 'index.html';
    } else {
      showError(data.message || 'Registration failed. Please try again.');
      btn.textContent = 'Create Account';
      btn.disabled = false;
    }
  } catch (e) {
    showError('Cannot reach server. Please check your connection.');
    btn.textContent = 'Create Account';
    btn.disabled = false;
  }
}
window.handleSignUp = handleSignUp;

async function googleSignUp() {
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      const Browser = window.Capacitor.Plugins.Browser;

      Browser.addListener('browserFinished', function() {
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
      window.location.href = `${BACKEND}/api/auth/google`;
    }
  } catch (e) {
    showError('Could not open Google sign-in. Please try again.');
  }
}
window.googleSignUp = googleSignUp;

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
  document.getElementById('signup-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSignUp();
  });
});
