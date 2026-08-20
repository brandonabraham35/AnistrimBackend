// Desktop/js/renderer.js — Electron renderer entry point.
// Uses the shared client contract (endpoints/envelope/session/http).
// Talks to the API with X-Client: desktop. No Origin header is sent from
// file:// pages, so CORS permits it without wildcard.

/* eslint-disable no-undef */
'use strict';

(function () {
  // API base: ANISTRIM_API_BASE env or default to Render URL
  const API_BASE = window.ANISTRIM_API_BASE || 'https://anistrimbackend.onrender.com';

  // Desktop-scoped session (B8 fix: anistrim.desktop.* keys)
  const session = window.AniStrimSession.create('desktop');

  // HTTP client bound to this desktop session
  const http = window.AniStrimHttp.create({
    apiBase: API_BASE,
    client: 'desktop',
    session: session,
    onUnauthorized: () => { showLogin(); },
    onRequiresVerification: (email) => { showVerify(email); },
  });

  const app = document.getElementById('app');
  const content = document.getElementById('content');
  const userArea = document.getElementById('user-area');

  // ── Views ──────────────────────────────────────────────────
  function render(html) {
    content.innerHTML = html;
  }

  function showLogin() {
    render(`
      <div class="auth-card">
        <h2>Welcome to AniStrim</h2>
        <form id="login-form">
          <input type="email" id="email" placeholder="Email" required>
          <input type="password" id="password" placeholder="Password" required>
          <button type="submit">Sign In</button>
        </form>
        <p class="muted">No account? <a href="#" id="go-signup">Sign up</a></p>
      </div>
    `);
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const res = await http.post('/api/auth/login', { email, password });
      if (res.ok && res.data && res.data.token) {
        session.setTokens(res.data.token, res.data.refreshToken);
        location.reload();
      } else {
        showToast('Login failed: ' + ((res.error && res.error.message) || 'Unknown error'));
      }
    });
    document.getElementById('go-signup').addEventListener('click', (e) => {
      e.preventDefault();
      showSignup();
    });
  }

  function showSignup() {
    render(`
      <div class="auth-card">
        <h2>Create account</h2>
        <form id="signup-form">
          <input type="text" id="name" placeholder="Name" required>
          <input type="email" id="email" placeholder="Email" required>
          <input type="password" id="password" placeholder="Password (min 6)" required>
          <button type="submit">Sign Up</button>
        </form>
        <p class="muted">Already have an account? <a href="#" id="go-login">Sign in</a></p>
      </div>
    `);
    document.getElementById('signup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('name').value;
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const res = await http.post('/api/auth/signup', { name, email, password });
      if (res.ok) {
        showOtp(email);
      } else {
        showToast('Signup failed: ' + ((res.error && res.error.message) || 'Unknown error'));
      }
    });
    document.getElementById('go-login').addEventListener('click', (e) => {
      e.preventDefault();
      showLogin();
    });
  }

  function showOtp(email) {
    render(`
      <div class="auth-card">
        <h2>Verify your email</h2>
        <p class="muted">Enter the 6-digit code sent to ${esc(email)}</p>
        <form id="otp-form">
          <input type="text" id="code" placeholder="6-digit code" maxlength="6" required>
          <button type="submit">Verify</button>
        </form>
        <p class="muted"><a href="#" id="resend">Resend code</a></p>
      </div>
    `);
    document.getElementById('otp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = document.getElementById('code').value;
      const res = await http.post('/api/auth/verify-otp', { email, code });
      if (res.ok && res.data && res.data.token) {
        session.setTokens(res.data.token, res.data.refreshToken);
        location.hash = '/';
        location.reload();
      } else {
        showToast('Verification failed');
      }
    });
    document.getElementById('resend').addEventListener('click', async (e) => {
      e.preventDefault();
      await http.post('/api/auth/resend-otp', { email });
      showToast('New code sent');
    });
  }

  async function showHome() {
    const res = await http.get('/api/home/sections');
    if (!res.ok || !res.data) {
      render(`<div class="error-state"><h3>Could not load home</h3><p>${esc((res.error && res.error.message) || 'Server error')}</p></div>`);
      return;
    }
    let html = '<h1>Browse</h1>';
    const sections = res.data.sections || res.data.rows || [];
    for (const sec of sections) {
      html += `<h2>${esc(sec.title || 'Anime')}</h2><div class="grid">`;
      for (const item of (sec.items || [])) {
        html += `<a class="card" href="#/anime/${item.id}">
          <img src="${esc(item.poster || item.image || '')}" alt="${esc(item.title)}" loading="lazy">
          <span>${esc(item.title)}</span></a>`;
      }
      html += '</div>';
    }
    if (!sections.length) html += '<p class="muted">No content yet.</p>';
    render(html);
  }

  async function showBrowse() {
    const res = await http.get('/api/anime/latest');
    if (!res.ok) {
      render(`<div class="error"><h3>Error</h3><p>${esc((res.error && res.error.message) || 'Failed to load')}</p></div>`);
      return;
    }
    const items = res.data.items || res.data.rows || [];
    let html = '<h1>Latest Anime</h1><div class="grid">';
    for (const a of items) {
      html += `<a class="card" href="#/anime/${a.id}">
        <img src="${esc(a.image || a.poster || '')}" loading="lazy">
        <span>${esc(a.title)}</span></a>`;
    }
    html += '</div>';
    render(html);
  }

  async function showAnime(id) {
    const res = await http.get('/api/anime/' + encodeURIComponent(id));
    if (!res.ok || !res.data) {
      render(`<div class="error"><h3>Not found</h3></div>`);
      return;
    }
    const a = res.data;
    render(`
      <div class="detail">
        <img class="detail-poster" src="${esc(a.image || a.poster || '')}">
        <div>
          <h1>${esc(a.title)}</h1>
          <p>${esc(a.synopsis || a.description || '')}</p>
          <a href="#/watch/${a.id}/1" class="btn primary">\u25B6 Watch</a>
          <button class="btn" data-watchlist="${a.id}">+ Watchlist</button>
        </div>
      </div>
    `);
  }

  async function showWatchlist() {
    const res = await http.get('/api/watchlist');
    const items = (res.ok && res.data && (res.data.items || res.data.rows)) || [];
    let html = '<h1>Watchlist</h1><div class="grid">';
    for (const w of items) {
      const anime = w.anime || w;
      html += `<a class="card" href="#/anime/${anime.id}">
        <img src="${esc(anime.image || anime.poster || '')}" loading="lazy">
        <span>${esc(anime.title || anime.name || 'Unknown')}</span></a>`;
    }
    html += '</div>';
    if (!items.length) html += '<p class="muted">Your watchlist is empty.</p>';
    render(html);
  }

  // ── Router (simple hash-based) ─────────────────────────────
  async function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const parts = hash.split('/').filter(Boolean);

    if (!session.hasSession()) {
      showLogin();
      return;
    }

    if (parts.length === 0) return showHome();
    if (parts[0] === 'browse') return showBrowse();
    if (parts[0] === 'anime') return showAnime(parts[1]);
    if (parts[0] === 'watchlist') return showWatchlist();
    if (parts[0] === 'profile') return showProfile();
    return showHome();
  }

  function showProfile() {
    render('<h1>Profile</h1><div id="profile-content" class="muted">Loading…</div>');
    http.get('/api/auth/me').then(res => {
      if (res.ok && res.data) {
        const u = res.data;
        document.getElementById('profile-content').innerHTML = `
          <div><strong>Name:</strong> ${esc(u.name || '')}</div>
          <div><strong>Email:</strong> ${esc(u.email || '')}</div>
          <div><strong>Premium:</strong> ${u.isPremium ? 'Yes' : 'No'}</div>
          <button class="btn danger" id="logout-btn">Sign out</button>
        `;
        document.getElementById('logout-btn').addEventListener('click', async () => {
          await http.post('/api/auth/logout');
          session.clear();
          showLogin();
        });
      }
    });
  }

  function showVerify(email) {
    showOtp(email);
  }

  function esc(s) {
    var amp = String.fromCharCode(38);
    var lt = String.fromCharCode(60);
    var gt = String.fromCharCode(62);
    var quot = String.fromCharCode(34);
    return String(s == null ? '' : s)
      .replace(/&/g, amp + 'amp;')
      .replace(/</g, lt + ';')
      .replace(/>/g, gt + ';')
      .replace(/"/g, quot + 'quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(msg) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('visible');
    setTimeout(() => t.classList.remove('visible'), 4000);
  }

  // ── Boot ───────────────────────────────────────────────────
  window.addEventListener('hashchange', route);
  route();
})();