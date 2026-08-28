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

  // Email captured from the login form. The backend's HTTP 403
  // ACCOUNT_UNVERIFIED response does NOT echo an email address back
  // (no data.email), so the OTP flow must use the address the user
  // actually entered.
  let pendingEmail = '';

  // HTTP client bound to this desktop session
  const http = window.AniStrimHttp.create({
    apiBase: API_BASE,
    client: 'desktop',
    session: session,
    onUnauthorized: () => { showLogin(); },
    // The shared HTTP layer passes '' here because the 403 ACCOUNT_UNVERIFIED
    // body carries no data.email — fall back to the login-form email.
    onRequiresVerification: (email) => { showVerify(email || pendingEmail); },
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
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      // Preserve the address the user actually typed — the 403
      // ACCOUNT_UNVERIFIED response does not echo an email back.
      pendingEmail = email;
      const res = await http.post('/api/auth/login', { email, password });

      // Unverified account: the backend answers 403 with a top-level
      // { requiresVerification: true } body and no data.email. Route to the
      // OTP screen with the email the user entered instead of treating this
      // as a generic login failure. (Backend response format is unchanged.)
      if (res.status === 403 && res.data && res.data.requiresVerification === true) {
        showVerify(email);
        return;
      }

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

      // Success ONLY when the backend explicitly requested verification
      // (201 envelope: { success:true, data:{ requiresVerification:true, ... } }).
      // The shared envelope legacy passthrough yields ok:true for raw error
      // bodies ({ message } with no success/error fields), so a bare res.ok
      // check used to false-positive the OTP screen on 400/409/502 failures.
      if (res.ok && res.data && res.data.requiresVerification === true) {
        showOtp(email);
        return;
      }

      // Failure — remain on the signup screen. Raw error bodies carry
      // `message` at top level (validation 400, duplicate-email 409,
      // email-send 502); canonical envelope errors and rate-limit ApiErrors
      // carry res.error.message. (The shared HTTP layer always resolves —
      // its outer .catch converts rejections into { ok:false, error } —
      // so every failure lands here.)
      showToast('Signup failed: ' + ((res.error && res.error.message) || (res.data && res.data.message) || 'Unknown error'));
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
      // Guard: an empty email must never be submitted to /api/auth/verify-otp.
      if (!hasEmail(email)) return;
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
      // Guard: resend must also use the correct (non-empty) email.
      if (!hasEmail(email)) return;
      await http.post('/api/auth/resend-otp', { email });
      showToast('New code sent');
    });
  }

  async function showHome() {
    const res = await http.get('/api/home/sections');
    if (!res.ok || !res.data || typeof res.data !== 'object') {
      render(`<div class="error-state"><h3>Could not load home</h3><p>${esc((res.error && res.error.message) || 'Server error')}</p></div>`);
      return;
    }
    // /api/home/sections returns the home shelf as four top-level arrays —
    // { trending, popular, newReleases, classics, diagnostics, generatedAt }.
    // There is no `sections` list; map each shelf key to its display title.
    const shelfSections = [
      ['trending', 'Trending'],
      ['popular', 'Popular'],
      ['newReleases', 'New Releases'],
      ['classics', 'Classics'],
    ];
    let html = '<h1>Browse</h1>';
    let shown = 0;
    for (const [key, label] of shelfSections) {
      const items = toItems(res.data[key]);
      if (!items.length) continue;
      shown += items.length;
      html += `<h2>${esc(label)}</h2><div class="grid">`;
      for (const item of items) {
        if (!item || item.id === undefined || item.id === null) continue;
        html += `<a class="card" href="#/anime/${esc(item.id)}">
          <img src="${esc(posterOf(item))}" alt="${esc(item.title)}" loading="lazy">
          <span>${esc(item.title || 'Unknown')}</span></a>`;
      }
      html += '</div>';
    }
    if (!shown) html += '<p class="muted">No content yet.</p>';
    render(html);
  }

  async function showBrowse() {
    const res = await http.get('/api/anime/latest');
    if (!res.ok) {
      render(`<div class="error"><h3>Error</h3><p>${esc((res.error && res.error.message) || 'Failed to load')}</p></div>`);
      return;
    }
    // /api/anime/latest returns a raw array (sendSuccess with an array
    // payload) — normalize defensively in case a wrapper shape ever arrives.
    const items = toItems(res.data);
    let html = '<h1>Latest Anime</h1><div class="grid">';
    for (const a of items) {
      if (!a || a.id === undefined || a.id === null) continue;
      html += `<a class="card" href="#/anime/${esc(a.id)}">
        <img src="${esc(posterOf(a))}" loading="lazy">
        <span>${esc(a.title || 'Unknown')}</span></a>`;
    }
    if (!items.length) html += '<p class="muted">No anime available yet.</p>';
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
        <img class="detail-poster" src="${esc(posterOf(a))}">
        <div>
          <h1>${esc(a.title)}</h1>
          <p>${esc(a.synopsis || a.description || '')}</p>
          <a href="#/watch/${a.id}/1" class="btn primary">\u25B6 Watch</a>
          <button class="btn" data-watchlist="${a.id}">+ Watchlist</button>
        </div>
      </div>
    `);

    // ── Attach watchlist add handler ─────────────────────────────
    // Uses the existing POST /api/watchlist/add endpoint (body: { animeId }).
    // The shared HTTP client handles auth, 401 refresh, and 403 verification
    // automatically — no separate auth logic here.
    const wlBtn = document.querySelector('[data-watchlist]');
    if (!wlBtn) return;
    let wlAdding = false;
    wlBtn.addEventListener('click', async function () {
      if (wlAdding) return;
      const animeId = this.getAttribute('data-watchlist');
      if (!animeId) return;
      wlAdding = true;
      this.disabled = true;
      this.textContent = 'Adding…';
      const addRes = await http.post('/api/watchlist/add', { animeId: animeId });
      if (addRes.ok) {
        // Success — keep button in "added" state.
        this.textContent = 'Added \u2713';
        showToast('Added to Watchlist');
      } else if (addRes.status === 401) {
        // The shared HTTP layer already called onUnauthorized → showLogin().
        // Restore button in case the user remains on page (e.g. refresh fails).
        this.textContent = '+ Watchlist';
        this.disabled = false;
      } else {
        // Restore button and show the backend error message when available.
        this.textContent = '+ Watchlist';
        this.disabled = false;
        const errMsg = (addRes.error && addRes.error.message)
          || (addRes.data && addRes.data.message)
          || 'Could not add to watchlist';
        showToast(errMsg);
      }
      wlAdding = false;
    });
  }

  async function showWatchlist() {
    const res = await http.get('/api/watchlist');
    // /api/watchlist returns a raw array of rows:
    // { id, animeId, title, poster, status, episodesWatched, totalEpisodes, ... }.
    // `animeId` is the authoritative anime identifier — the row `id` is the
    // watchlist entry id, NOT the anime id.
    const items = toItems(res.data);
    let html = '<h1>Watchlist</h1><div class="grid">';
    for (const w of items) {
      if (!w || typeof w !== 'object') continue;
      const anime = w.anime || null;
      const animeId = (w.animeId !== undefined && w.animeId !== null) ? w.animeId : (anime ? anime.id : undefined);
      if (animeId === undefined || animeId === null) continue;
      html += `<a class="card" href="#/anime/${esc(animeId)}">
        <img src="${esc(posterOf(w) || (anime ? posterOf(anime) : ''))}" loading="lazy">
        <span>${esc(w.title || (anime ? anime.title : '') || w.name || 'Unknown')}</span></a>`;
    }
    html += '</div>';
    if (!items.length) html += '<p class="muted">Your watchlist is empty.</p>';
    render(html);
  }

  // ── Watch / player ─────────────────────────────────────────
  // Uses the existing backend stream contract (no new endpoints):
  //   GET  /api/anime/:id              → title/meta
  //   GET  /api/anime/:id/episodes     → episode list (id/number/title)
  //   GET  /api/stream/:title/:episode → { sources: [{ url, quality }] }
  //   POST /api/stream/authorize       → { token, streams: [{ streamId, url }], expiresIn }
  //   PUT  /api/watch/progress         → { episodeId, positionSec, durationSec, event }
  // getStream sources are token-less /api/stream-proxy/:streamId paths; the
  // HMAC token (120 s TTL, session-bound) comes from authorize and gates them.
  let activeHls = null;        // hls.js instance for the current watch view
  let hlsLibPromise = null;    // memoized lazy loader for vendor/hls.min.js
  let streamAuth = null;       // { token, streams, expiresAt, episodeId }
  let streamAuthTimer = null;  // token-refresh timer
  let playback = null;         // { url, mode: 'hls' | 'native' }
  let watchCtx = null;         // { animeId, episodeNum, episode, anime }
  let watchGeneration = 0;     // incremented on teardown; voids async work

  // Tears the player down: destroys hls.js, cancels the token refresh timer,
  // voids in-flight attach work. Called on EVERY route change so navigation
  // and reloads never leave stale HLS/video instances running.
  function destroyPlayer() {
    watchGeneration += 1;
    if (streamAuthTimer) { clearTimeout(streamAuthTimer); streamAuthTimer = null; }
    streamAuth = null;
    destroyHlsInstance();
    playback = null;
  }

  function destroyHlsInstance() {
    if (activeHls) {
      try { activeHls.destroy(); } catch (e) { /* already destroyed */ }
      activeHls = null;
    }
  }

  // Lazily loads vendor/hls.min.js (already packaged via vendor/**/*) only
  // when a stream actually needs hls.js. Resolves with window.Hls.
  function loadHlsLibrary() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!hlsLibPromise) {
      hlsLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/hls.min.js';
        s.onload = () => {
          if (window.Hls) resolve(window.Hls);
          else { hlsLibPromise = null; reject(new Error('HLS library failed to initialize.')); }
        };
        s.onerror = () => { hlsLibPromise = null; reject(new Error('HLS library failed to load.')); };
        document.head.appendChild(s);
      });
    }
    return hlsLibPromise;
  }

  function isProxySource(url) {
    return typeof url === 'string' && url.indexOf('/api/stream-proxy/') !== -1;
  }

  function isHlsSource(url) {
    // .m3u8 manifests are HLS; the token-gated proxy serves HLS without an
    // extension, so proxy URLs are treated as HLS too (same as Mobile/Web).
    return (typeof url === 'string' && /\.m3u8(?:$|\?)/i.test(url)) || isProxySource(url);
  }

  function absoluteStreamUrl(url) {
    if (!url) return '';
    return /^https?:\/\//i.test(url) ? url : API_BASE + url;
  }

  // Token-realize a proxy URL: prefer the exact concrete URL returned by
  // authorize (matched on streamId); fall back to appending the primary token
  // (the proxy rejects streamId mismatches — the playback error state covers it).
  function tokenedUrlFor(url) {
    const abs = absoluteStreamUrl(url);
    if (!isProxySource(abs) || !streamAuth || !streamAuth.token) return abs;
    const m = abs.match(/\/api\/stream-proxy\/([^/?]+)/);
    const streamId = m && m[1] ? m[1] : null;
    if (streamId && Array.isArray(streamAuth.streams)) {
      for (const s of streamAuth.streams) {
        if (s && String(s.streamId) === String(streamId) && s.url) return absoluteStreamUrl(s.url);
      }
    }
    const sep = abs.indexOf('?') !== -1 ? '&' : '?';
    return abs + sep + 'token=' + encodeURIComponent(streamAuth.token);
  }

  // POST /api/stream/authorize { episodeId } → { token, streams[], expiresIn }.
  // 403 bodies carry { code, message } at top level (legacy passthrough), so
  // the code is read off res.data regardless of res.ok.
  async function authorizePlayback(episodeId) {
    const res = await http.post('/api/stream/authorize', { episodeId: String(episodeId) });
    const data = (res && res.data && typeof res.data === 'object') ? res.data : {};
    if (data.token && Array.isArray(data.streams)) {
      streamAuth = {
        token: data.token,
        streams: data.streams,
        expiresAt: Date.now() + (Number(data.expiresIn) || 120) * 1000,
        episodeId: String(episodeId),
      };
      scheduleStreamAuthRefresh(episodeId);
      return streamAuth;
    }
    if (data.code === 'PREMIUM_REQUIRED') {
      throw new Error(data.message || 'Premium subscription required for this episode.');
    }
    if (data.code === 'DEVICE_LIMIT_REACHED') {
      throw new Error(data.message || 'Device limit reached for this account.');
    }
    throw new Error(data.message || data.error || 'Stream authorization failed.');
  }

  // Re-authorize before the 120 s token expires and swap the source URL in
  // place, preserving the playback position (episodes outlive one token).
  function scheduleStreamAuthRefresh(episodeId) {
    if (streamAuthTimer) clearTimeout(streamAuthTimer);
    if (!streamAuth) return;
    const delay = Math.max(5000, streamAuth.expiresAt - Date.now() - 20000);
    streamAuthTimer = setTimeout(() => {
      streamAuthTimer = null;
      if (!watchCtx || !watchCtx.episode || !playback || !streamAuth || streamAuth.episodeId !== String(episodeId)) return;
      const video = document.getElementById('player');
      if (!video) return;
      const at = video.currentTime || 0;
      const wasPlaying = video.paused === false;
      authorizePlayback(episodeId).then(() => {
        const newUrl = tokenedUrlFor(playback.url);
        if (!newUrl || newUrl === playback.url) return;
        playback.url = newUrl;
        const v = document.getElementById('player');
        if (!v) return;
        if (playback.mode === 'hls' && activeHls && window.Hls) {
          activeHls.loadSource(newUrl);
          const restore = () => {
            if (activeHls) activeHls.off(window.Hls.Events.MANIFEST_PARSED, restore);
            try { v.currentTime = at; } catch (e) { /* not seekable yet */ }
            if (wasPlaying) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
          };
          activeHls.on(window.Hls.Events.MANIFEST_PARSED, restore);
        } else {
          v.src = newUrl;
          v.load();
          const restore = () => {
            v.removeEventListener('loadedmetadata', restore);
            try { v.currentTime = at; } catch (e) { /* not seekable yet */ }
            if (wasPlaying) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
          };
          v.addEventListener('loadedmetadata', restore);
        }
      }).catch(() => { /* the old token may still work briefly; the playback error state covers hard failures */ });
    }, delay);
  }

  // Best source first: proxy/HLS sources win (same preference as Mobile).
  function pickSource(sources) {
    const ranked = sources.slice().sort((a, b) => {
      const ra = isProxySource(a.url) || /\.m3u8/i.test(a.url) ? 0 : 1;
      const rb = isProxySource(b.url) || /\.m3u8/i.test(b.url) ? 0 : 1;
      return ra - rb;
    });
    return ranked[0] || null;
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
    if (parts[0] === 'watch') return showWatch(parts[1], parts[2]);
    if (parts[0] === 'watchlist') return showWatchlist();
    if (parts[0] === 'profile') return showProfile();
    return showHome();
  }

  function renderWatchError(message) {
    destroyPlayer();
    const ctx = watchCtx || {};
    render(
      '<div class="error-state"><h3>Playback error</h3>' +
      '<p class="muted">' + esc(message) + '</p>' +
      '<p style="margin-top:12px">' +
      (ctx.animeId ? '<a class="btn" href="#/anime/' + esc(ctx.animeId) + '">Back to details</a> ' : '') +
      '<button class="btn primary" id="retry-playback">Retry</button>' +
      (ctx.animeId ? ' <a class="btn" href="#/browse">Browse</a>' : '') +
      '</p></div>'
    );
    const retry = document.getElementById('retry-playback');
    if (retry) retry.addEventListener('click', () => { showWatch(ctx.animeId, ctx.episodeNum); });
  }

  function saveProgressNow(event) {
    // Existing contract: PUT /api/watch/progress { episodeId, positionSec, durationSec, event }
    // event ∈ heartbeat|pause|seek|exit|ended (watchController.js:41).
    const video = document.getElementById('player');
    const epId = watchCtx && watchCtx.episode ? watchCtx.episode.id : null;
    if (!video || !epId || !video.duration || !isFinite(video.duration)) return;
    http.put('/api/watch/progress', {
      episodeId: String(epId),
      positionSec: Math.floor(video.currentTime || 0),
      durationSec: Math.floor(video.duration || 0),
      event: event,
    }).catch(() => { /* best-effort */ });
  }

  // Native HLS first; hls.js only when required (lazy-loaded). MP4 → native.
  function attachStream(video, url) {
    const gen = watchGeneration;
    playback = { url: url, mode: 'native' };
    const nativeHls = video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl');
    if (isHlsSource(url) && !nativeHls) {
      loadHlsLibrary().then((Hls) => {
        if (gen !== watchGeneration) return; // navigated away while loading
        destroyHlsInstance();
        playback.mode = 'hls';
        activeHls = new Hls();
        activeHls.loadSource(url);
        activeHls.attachMedia(video);
        activeHls.on(Hls.Events.MANIFEST_PARSED, () => {
          const p = video.play();
          if (p && p.catch) p.catch(() => { /* autoplay policy */ });
        });
        activeHls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data && data.fatal) renderWatchError('Playback failed. The stream may have expired or is unavailable.');
        });
      }).catch((err) => {
        if (gen !== watchGeneration) return;
        renderWatchError((err && err.message) || 'HLS playback is not supported in this environment.');
      });
      return;
    }
    // Native path (MP4 direct, or native HLS support).
    video.src = url;
    video.addEventListener('error', () => {
      if (gen === watchGeneration) renderWatchError('Playback failed. The video could not be loaded.');
    });
    const p = video.play();
    if (p && p.catch) p.catch(() => { /* autoplay policy */ });
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

  // Returns true when `email` is usable; otherwise shows the required error
  // and returns false. Guarantees an empty email is never rendered into the
  // OTP screen or sent to /api/auth/verify-otp / /api/auth/resend-otp.
  function hasEmail(email) {
    if (email && String(email).trim()) return true;
    showToast('Unable to continue verification because the email address is missing.');
    return false;
  }

  function showVerify(email) {
    // Never render the OTP screen without a real address — the backend 403
    // carries no data.email, so callers must supply the user-entered email
    // (or the pending login email captured in pendingEmail).
    if (!hasEmail(email)) return;
    showOtp(email);
  }

  // ── Response-shape helpers ─────────────────────────────────
  // List endpoints return either a raw array (sendSuccess with an array
  // payload) or an object wrapper. Never assume which shape arrived — and
  // never assume res.data is an object at all.
  function toItems(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      if (Array.isArray(data.items)) return data.items;
      if (Array.isArray(data.rows)) return data.rows;
    }
    return [];
  }

  // Anime rows carry the artwork in `cover_image`; keep the legacy
  // image/poster fallbacks so other payloads keep rendering.
  function posterOf(entry) {
    if (!entry || typeof entry !== 'object') return '';
    return entry.cover_image || entry.image || entry.poster || '';
  }

  function esc(s) {
    // & must be replaced first so the entities produced below are not
    // re-escaped. Escaping " and ' makes attribute interpolation safe.
    var amp = String.fromCharCode(38);
    return String(s == null ? '' : s)
      .replace(/&/g, amp + 'amp;')
      .replace(/</g, amp + 'lt;')
      .replace(/>/g, amp + 'gt;')
      .replace(/"/g, amp + 'quot;')
      .replace(/'/g, amp + '#39;');
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

  async function showWatch(animeIdRaw, episodeRaw) {
    destroyPlayer();
    const animeId = Number(animeIdRaw);
    const episodeNum = Number(episodeRaw);
    if (!Number.isInteger(animeId) || animeId <= 0 || !Number.isInteger(episodeNum) || episodeNum <= 0) {
      render(
        '<div class="error-state"><h3>Invalid watch request</h3>' +
        '<p class="muted">This watch link is missing a valid anime ID or episode number.</p>' +
        '<p style="margin-top:12px"><a class="btn" href="#/browse">Back to Browse</a></p></div>'
      );
      return;
    }
    watchCtx = { animeId: animeId, episodeNum: episodeNum, episode: null, anime: null };
    const gen = watchGeneration; // voids this view if the user navigates away mid-load

    render('<div class="loading">Loading player…</div>');

    // ── 1) Anime details + episode list (existing contract) ──
    const results = await Promise.all([
      http.get('/api/anime/' + encodeURIComponent(animeId)),
      http.get('/api/anime/' + encodeURIComponent(animeId) + '/episodes'),
    ]);
    if (gen !== watchGeneration) return; // navigated away mid-load
    const animeRes = results[0];
    const epsRes = results[1];
    if (!animeRes.ok || !animeRes.data || typeof animeRes.data !== 'object' || animeRes.data.id === undefined) {
      render('<div class="error-state"><h3>Anime not found</h3><p class="muted">This title does not exist or is currently unavailable.</p><p style="margin-top:12px"><a class="btn" href="#/browse">Back to Browse</a></p></div>');
      return;
    }
    const anime = animeRes.data;
    const title = anime.title || '';
    watchCtx.anime = anime;
    const episodes = toItems(epsRes && epsRes.ok ? epsRes.data : []);
    let episode = null;
    for (const e of episodes) {
      if (e && Number(e.number) === episodeNum) { episode = e; break; }
    }
    if (!episode || episode.id === undefined) {
      render(
        '<div class="error-state"><h3>Episode not found</h3>' +
        '<p class="muted">Episode ' + esc(episodeNum) + ' of "' + esc(title) + '" does not exist or has no playable entry.</p>' +
        '<p style="margin-top:12px"><a class="btn" href="#/anime/' + esc(animeId) + '">Back to details</a> ' +
        '<a class="btn" href="#/browse">Browse</a></p></div>'
      );
      return;
    }
    watchCtx.episode = episode;

    // ── 2) Resolve the stream (existing /api/stream contract) ──
    render('<div class="loading">Resolving stream…</div>');
    const streamRes = await http.get('/api/stream/' + encodeURIComponent(title) + '/' + encodeURIComponent(episodeNum));
    if (gen !== watchGeneration) return; // navigated away mid-resolve
    if (!streamRes.ok) {
      const msg = (streamRes.error && streamRes.error.message && streamRes.error.message !== 'Request failed')
        ? streamRes.error.message
        : ((streamRes.data && streamRes.data.error) || 'The stream could not be resolved. Please try again.');
      renderWatchError(msg);
      return;
    }
    const meta = (streamRes.data && typeof streamRes.data === 'object') ? streamRes.data : {};
    const sources = toItems(meta.sources).filter((s) => s && s.url);
    if (!sources.length) {
      renderWatchError('No playable source was returned for this episode.');
      return;
    }

    // ── 3) Best source first (proxy/HLS wins — same preference as Mobile) ──
    const picked = pickSource(sources);
    let sourceUrl = absoluteStreamUrl(picked.url);

    // ── 4) Authorize the proxy (HMAC token, 120 s TTL) ──
    if (isProxySource(sourceUrl)) {
      render('<div class="loading">Authorizing playback…</div>');
      try {
        await authorizePlayback(episode.id);
        if (gen !== watchGeneration) return; // navigated away mid-authorize
        sourceUrl = tokenedUrlFor(sourceUrl);
      } catch (err) {
        if (gen !== watchGeneration) return;
        renderWatchError((err && err.message) || 'Stream authorization failed.');
        return;
      }
    }

    // ── 5) Episode navigation (prev/next from the episode list) ──
    const numbers = [];
    for (const e of episodes) { const n = Number(e && e.number); if (Number.isInteger(n) && n > 0) numbers.push(n); }
    numbers.sort((a, b) => a - b);
    let prevEp = null;
    let nextEp = null;
    for (const n of numbers) {
      if (n < episodeNum) prevEp = n;
      if (nextEp === null && n > episodeNum) nextEp = n;
    }

    // ── 6) Player UI ──
    render(
      '<div class="watch">' +
        '<div class="watch-head">' +
          '<a class="btn" href="#/anime/' + esc(animeId) + '">Back to details</a>' +
          '<div><h2>' + esc(title) + '</h2>' +
          '<p class="muted">Episode ' + esc(episodeNum) + (episode.title ? ' - ' + esc(episode.title) : '') + '</p></div>' +
        '</div>' +
        '<video id="player" class="player" controls autoplay playsinline preload="auto"></video>' +
        '<div class="watch-nav">' +
          (prevEp !== null ? '<a class="btn" href="#/watch/' + esc(animeId) + '/' + esc(prevEp) + '">Episode ' + esc(prevEp) + '</a>' : '') +
          (nextEp !== null ? '<a class="btn" href="#/watch/' + esc(animeId) + '/' + esc(nextEp) + '">Episode ' + esc(nextEp) + '</a>' : '') +
          '<a class="btn" href="#/anime/' + esc(animeId) + '">Episode list</a>' +
        '</div>' +
      '</div>'
    );

    // ── 7) Attach playback (native HLS first; hls.js only when required) ──
    const video = document.getElementById('player');
    if (!video) return;
    attachStream(video, sourceUrl);

    // ── 8) Progress saves (existing PUT /api/watch/progress contract) ──
    video.addEventListener('pause', () => { saveProgressNow('pause'); });
    video.addEventListener('ended', () => { saveProgressNow('ended'); });
  }

  // ── Boot ───────────────────────────────────────────────────
  window.addEventListener('hashchange', route);
  // Menu "Home" (main process) sends a 'navigate' IPC; map it onto the
  // existing hash router. Guarded — window.anistrim is absent when the
  // renderer runs in a plain browser via /desktop-preview.
  if (window.anistrim && typeof window.anistrim.onNavigate === 'function') {
    window.anistrim.onNavigate((path) => { location.hash = path; });
  }
  route();
})();