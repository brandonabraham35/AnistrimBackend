/* eslint-env browser */
/* global AniStrimApi, AniStrimAuth, AniStrimRouter, AniStrimPlayer, AniStrimUI, google */
// AniStrim Web — UI layer (independent from Frontend/)
(function () {
  'use strict';

  var API = window.AniStrimApi;
  var Auth = window.AniStrimAuth;
  var Router = window.AniStrimRouter;
  var Player = window.AniStrimPlayer;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '\x26amp;').replace(/</g, '\x3C').replace(/>/g, '\x3E')
      .replace(/"/g, '\x22quot;').replace(/'/g, '\x26#039;');
  }
  function toast(msg, type) {
    var root = document.getElementById('toast-root');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () { el.classList.add('show'); }, 10);
    setTimeout(function () { el.classList.remove('show'); setTimeout(function () { el.remove(); }, 300); }, 3200);
  }
  function fallback(title) {
    var t = (title || '?').charAt(0).toUpperCase();
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#151527"/>' +
      '<text x="150" y="245" font-family="sans-serif" font-size="72" fill="#8b5cf6" text-anchor="middle">' + t + '</text></svg>');
  }
  function card(a) {
    var img = (a && (a.cover_image || a.poster || a.coverImage)) || '';
    var title = (a && a.title) || '';
    var id = a && (a.id != null ? a.id : a.animeId);
    return '<div class="anime-card" onclick="AniStrimUI.goAnime(' + id + ')">' +
      '<div class="anime-card-img"><img src="' + (img || fallback(title)) + '" alt="' + esc(title) + '" loading="lazy" ' +
      'onerror="this.src=AniStrimUI.fallback(\'' + esc(title) + '\')">' +
      (a && a.is_premium ? '<span class="badge-premium">👑</span>' : '') +
      (a && a.rating ? '<span class="badge-rating">★ ' + esc(a.rating) + '</span>' : '') +
      '</div><div class="anime-card-title">' + esc(title) + '</div>' +
      (a && a.year ? '<div class="anime-card-sub">' + esc(a.year) + '</div>' : '') + '</div>';
  }
  function grid(list, cols) {
    return '<div class="anime-grid' + (cols ? ' cols-' + cols : '') + '">' + list.map(card).join('') + '</div>';
  }
  function section(title, link) {
    return '<div class="section-header"><h2>' + esc(title) + '</h2>' +
      (link ? '<a class="section-link" href="' + link + '">View all →</a>' : '') + '</div>';
  }
  function norm(list) {
    if (Array.isArray(list)) return list;
    return (list && (list.rows || list.items || list.data || list.watchlist || list.history)) || [];
  }

  // Episode access is supplied by the API.  Do not infer entitlement from a
  // user profile, a JWT, or the legacy `is_premium` fields: those are not the
  // server's playback contract.
  function episodeAccess(ep) {
    ep = ep || {};
    var state = String(ep.accessState || '').toLowerCase();
    var tier = String(ep.effectiveTier || '').toLowerCase();
    if (state === 'free' || state === 'premium' || state === 'in_grace') {
      return { playable: ep.locked !== true, state: state, availableAt: ep.availableAt || null };
    }
    if (state === 'scheduled' || state === 'premium_required' || state === 'subscription_expired') {
      return { playable: false, state: state, availableAt: ep.availableAt || null };
    }
    // Compatibility for an older API response which did not yet emit
    // accessState. New responses always include it, and unknown data fails
    // closed rather than exposing a stream.
    if (!state && ep.locked === false && (tier === 'free' || !tier)) {
      return { playable: true, state: 'free', availableAt: ep.availableAt || null };
    }
    return { playable: false, state: state || 'unknown', availableAt: ep.availableAt || null };
  }

  function accessMessage(access) {
    if (access.state === 'scheduled') {
      var date = access.availableAt ? new Date(access.availableAt) : null;
      return date && !isNaN(date.getTime()) ? 'This episode is available on ' + date.toLocaleString() + '.' : 'This episode is not available yet.';
    }
    if (access.state === 'subscription_expired') return 'Your subscription has expired. Upgrade to continue watching.';
    if (access.state === 'premium_required') return 'This episode requires Premium access.';
    return 'This episode is currently unavailable.';
  }

  function showWatchAccess(errEl, listEl, access, returnPath, serverError) {
    var message;
    var action = '';
    var code = serverError && serverError.code;
    if (code === 'DEVICE_LIMIT_REACHED') {
      message = serverError.message || 'Your device limit has been reached. Manage your active devices to continue.';
    } else if (code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED' || (serverError && serverError.status === 401)) {
      message = 'Sign in to watch this episode.';
      action = '<a href="#/login?redirect=' + encodeURIComponent(returnPath) + '" class="btn-primary">Sign In</a>';
    } else {
      message = accessMessage(access);
      if (access.state === 'premium_required' || access.state === 'subscription_expired' || code === 'PREMIUM_REQUIRED') {
        action = Auth.state.isLoggedIn
          ? '<a href="#/upgrade" class="btn-primary">Upgrade</a>'
          : '<a href="#/login?redirect=' + encodeURIComponent(returnPath) + '" class="btn-primary">Sign In</a>';
      }
    }
    if (errEl) { errEl.textContent = message; errEl.style.display = 'block'; }
    if (listEl) {
      var old = listEl.querySelector('.upgrade-banner');
      if (old) old.remove();
      if (action) {
        var banner = document.createElement('div');
        banner.className = 'upgrade-banner';
        banner.innerHTML = '<span>' + esc(message) + '</span>' + action;
        listEl.appendChild(banner);
      }
    }
  }

  // ── Header / Footer ─────────────────────────────────────
  function renderHeader() {
    var h = document.getElementById('site-header');
    var user = Auth.state.user;
    var logged = Auth.state.isLoggedIn;
    h.innerHTML = '<nav class="nav"><div class="nav-inner">' +
      '<a class="brand" href="#/">AniStrim</a>' +
      '<div class="nav-links"><a href="#/">Home</a><a href="#/browse">Browse</a><a href="#/search">Search</a>' +
      (logged ? '<a href="#/watchlist">Watchlist</a><a href="#/history">History</a>' : '') + '</div>' +
      '<div class="nav-auth">' +
      (logged
        ? '<a href="#/profile" class="btn-ghost">' + esc(user && (user.displayName || user.username || user.email) || 'Profile') + '</a>' +
          '<button class="btn-outline" onclick="AniStrimUI.logout()">Logout</button>'
        : '<a href="#/login" class="btn-outline">Sign In</a><a href="#/signup" class="btn-primary">Get Started</a>') +
      '</div></div></nav>';
    var f = document.getElementById('site-footer');
    f.innerHTML = '<div class="footer-inner"><span>© ' + new Date().getFullYear() + ' AniStrim</span>' +
      '<div class="footer-links"><a href="#/browse">Browse</a><a href="#/search">Search</a>' +
      (Auth.state.isPremium ? '<a href="#/profile">Account</a>' : '<a href="#/upgrade">Upgrade</a>') + '</div></div>';
  }

  // ── Home ────────────────────────────────────────────────
  function homeView() {
    renderHeader();
    return Promise.resolve('<div class="page home-page"><div class="hero"><div class="hero-inner" id="hero-inner">' +
      '<h1 id="hero-title">Loading...</h1><p id="hero-desc"></p><div class="hero-actions"><a class="btn-primary" id="hero-watch" href="#/browse">Browse Anime</a></div>' +
      '</div></div><div class="container" id="home-sections"></div></div>').then(function (h) {
      setTimeout(loadHome, 0);
      return h;
    });
  }

  async function loadHome() {
    var wrap = document.getElementById('home-sections');
    if (!wrap) return;
    try {
      var s = await API.homeSections();
      var out = '';
      var order = [['trending', 'Trending Now'], ['popular', 'Popular'], ['newReleases', 'New Releases'], ['classics', 'Classics']];
      if (Auth.state.isLoggedIn) {
        out += '<div id="home-continue"></div>';
        API.continueWatching().then(function (cw) {
          var rows = norm(cw).slice(0, 10);
          var el = document.getElementById('home-continue');
          if (el && rows.length) el.innerHTML = section('Continue Watching') + grid(rows);
        }).catch(function () {});
      }
      order.forEach(function (o) {
        var key = o[0];
        if (s && s[key] && s[key].length) out += section(o[1]) + grid(s[key].slice(0, 10));
      });
      wrap.innerHTML = out || '<div class="empty">No content available.</div>';
      if (s && s.trending && s.trending[0]) {
        var t = s.trending[0];
        document.getElementById('hero-title').textContent = t.title;
        document.getElementById('hero-desc').textContent = (t.description || '').substring(0, 200);
        var hero = document.querySelector('.hero');
        if (hero && (t.banner_image || t.cover_image)) hero.style.backgroundImage = 'linear-gradient(to bottom, rgba(10,10,15,0.4), #0a0a0f), url(\'' + (t.banner_image || t.cover_image) + '\')';
        var w = document.getElementById('hero-watch');
        if (w && t.id) { w.href = '#/anime/' + t.id; w.textContent = 'Watch Now'; }
      }
    } catch (e) { wrap.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  // ── Auth pages ──────────────────────────────────────────
  function authShell(title) {
    return '<div class="page auth-page"><div class="auth-card"><h1>' + title + '</h1><div id="auth-error" class="form-error"></div>';
  }
  function loginView() {
    renderHeader();
    return authShell('Sign In') +
      '<form onsubmit="return AniStrimUI.doLogin(event)"><label>Email<input type="email" id="login-email" required></label>' +
      '<label>Password<input type="password" id="login-password" required></label>' +
      '<button class="btn-primary btn-block" type="submit">Sign In</button></form>' +
      '<div class="auth-alt"><span>or</span></div><button class="btn-google" onclick="AniStrimUI.doGoogleLogin()">Continue with Google</button>' +
      '<p class="auth-switch"><a href="#/forgot-password">Forgot password?</a> · New here? <a href="#/signup">Create an account</a></p></div></div>';
  }
  function signupView() {
    renderHeader();
    return authShell('Create Account') +
      '<form onsubmit="return AniStrimUI.doSignup(event)"><label>Name<input id="signup-name" required></label>' +
      '<label>Email<input type="email" id="signup-email" required></label>' +
      '<label>Password<input type="password" id="signup-password" required minlength="6"></label>' +
      '<button class="btn-primary btn-block" type="submit">Create Account</button></form>' +
      '<div class="auth-alt"><span>or</span></div><button class="btn-google" onclick="AniStrimUI.doGoogleSignup()">Continue with Google</button>' +
      '<p class="auth-switch">Have an account? <a href="#/login">Sign in</a></p></div></div>';
  }
  function verifyView() {
    renderHeader();
    var email = Router.query().email || '';
    return authShell('Verify Email') +
      '<form onsubmit="return AniStrimUI.doVerify(event)"><label>Email<input type="email" id="verify-email" value="' + esc(email) + '" required></label>' +
      '<label>Code<input type="text" id="verify-otp" required inputmode="numeric"></label>' +
      '<button class="btn-primary btn-block" type="submit">Verify</button></form>' +
      '<button class="btn-ghost btn-block" onclick="AniStrimUI.resendOtp()">Resend code</button></div></div>';
  }
  function forgotPasswordView() {
    renderHeader();
    return authShell('Reset your password') +
      '<p class="auth-switch">Enter your account email and we will send a reset link.</p>' +
      '<form onsubmit="return AniStrimUI.doForgotPassword(event)"><label>Email<input type="email" id="forgot-email" required autocomplete="email"></label>' +
      '<button class="btn-primary btn-block" type="submit">Send Reset Link</button></form>' +
      '<p class="auth-switch"><a href="#/login">Back to sign in</a></p></div></div>';
  }
  function resetPasswordView(params, query) {
    renderHeader();
    var token = (query && query.token) || '';
    if (!token) {
      return authShell('Reset Password') +
        '<p class="form-error">This reset link is invalid or incomplete. Please request a new one.</p></div></div>';
    }
    return authShell('Reset Password') +
      '<p class="auth-switch">Choose a new password for your account.</p>' +
      '<form onsubmit="return AniStrimUI.doResetPassword(event)">' +
      '<label>New password<input type="password" id="reset-password" required minlength="6" autocomplete="new-password"></label>' +
      '<label>Confirm password<input type="password" id="reset-password-confirm" required minlength="6" autocomplete="new-password"></label>' +
      '<button class="btn-primary btn-block" type="submit">Reset Password</button></form></div></div>';
  }
  function googleCallbackView(params, query) {
    renderHeader();
    // Let the route render before the one-time code exchange begins.
    setTimeout(function () { completeGoogleCallback(query || {}); }, 0);
    return '<div class="page auth-page"><div class="auth-card"><h1>Completing sign-in…</h1><div id="auth-error" class="form-error"></div><p class="auth-switch">Please wait.</p></div></div>';
  }

  async function doLogin(e) {
    e.preventDefault();
    var err = document.getElementById('auth-error');
    try {
      var data = await Auth.login(document.getElementById('login-email').value, document.getElementById('login-password').value);
      renderHeader();
      Router.navigate(data.user && data.user.emailVerified === false ? '/verify' : postAuthRoute());
    } catch (e2) { if (err) err.textContent = e2.message; }
    return false;
  }
  async function doSignup(e) {
    e.preventDefault();
    var err = document.getElementById('auth-error');
    try {
      var data = await Auth.signup({
        name: document.getElementById('signup-name').value,
        email: document.getElementById('signup-email').value,
        password: document.getElementById('signup-password').value,
      });
      if (data && data.token) { renderHeader(); Router.navigate('/'); }
      else Router.navigate('/verify?email=' + encodeURIComponent(document.getElementById('signup-email').value));
    } catch (e2) { if (err) err.textContent = e2.message; }
    return false;
  }
  async function doVerify(e) {
    e.preventDefault();
    var err = document.getElementById('auth-error');
    try {
      await Auth.verifyEmail(document.getElementById('verify-email').value, document.getElementById('verify-otp').value);
      renderHeader(); Router.navigate('/');
    } catch (e2) { if (err) err.textContent = e2.message; }
    return false;
  }
  async function resendOtp() {
    try { await API.resendOtp(document.getElementById('verify-email').value); toast('Code resent.'); } catch (e) { toast(e.message, 'error'); }
  }
  async function doForgotPassword(e) {
    e.preventDefault();
    var err = document.getElementById('auth-error');
    try {
      await API.forgotPassword(document.getElementById('forgot-email').value);
      if (err) { err.textContent = 'If an account exists for that email, a reset link has been sent.'; }
    } catch (e2) { if (err) err.textContent = e2.message || 'Could not request a reset link.'; }
    return false;
  }
  function postAuthRoute() {
    var requested = Router.query().redirect || '';
    // Hash routes only; reject external URLs and unknown top-level destinations.
    if (/^\/(?:watch|anime|browse|search|watchlist|history|profile|settings|upgrade)(?:\/|\?|$)/.test(requested)) return requested;
    return '/';
  }
  async function doResetPassword(e) {
    e.preventDefault();
    var err = document.getElementById('auth-error');
    var token = Router.query().token || '';
    var password = document.getElementById('reset-password').value;
    var confirm = document.getElementById('reset-password-confirm').value;
    if (password !== confirm) {
      if (err) err.textContent = 'Passwords do not match.';
      return false;
    }
    try {
      // The API contract calls this field newPassword; never put the reset
      // token in a URL or persistent storage.
      await API.request('/api/auth/reset-password', {
        method: 'POST',
        body: { token: token, newPassword: password },
      });
      toast('Password reset successfully. Please sign in.');
      Router.navigate('/login');
    } catch (e2) { if (err) err.textContent = e2.message || 'Could not reset password.'; }
    return false;
  }
  async function completeGoogleCallback(query) {
    var err = document.getElementById('auth-error');
    try {
      var data;
      if (query.token) {
        data = { token: query.token, refreshToken: query.refreshToken || '', user: null };
      } else if (query.code) {
        data = await API.request('/api/auth/google/token?code=' + encodeURIComponent(query.code));
      } else {
        throw new Error('Google sign-in did not return an authentication code.');
      }
      if (!data || !data.token) throw new Error('Google sign-in did not return a session.');
      // Persist the scoped session and user state before returning home.
      Auth.state.save(data);
      renderHeader();
      var pendingRoute = sessionStorage.getItem('anistrim.web.postAuthRoute') || postAuthRoute();
      sessionStorage.removeItem('anistrim.web.postAuthRoute');
      Router.navigate(pendingRoute);
    } catch (e) {
      if (err) err.textContent = e.message || 'Google sign-in could not be completed.';
    }
  }

  async function gAuth(intent) {
    try {
      var clientIdRes = await API.googleClientId();
      var clientId = clientIdRes && clientIdRes.clientId;
      if (!clientId) { toast('Google not configured', 'error'); return; }
      if (typeof google === 'undefined' || !google.accounts) {
        await new Promise(function (res, rej) {
          var s = document.createElement('script');
          s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
          s.onload = res; s.onerror = function () { rej(new Error('Google lib failed')); };
          document.head.appendChild(s);
        });
      }
      await new Promise(function (resolve, reject) {
        var tc;
        try {
          tc = google.accounts.oauth2.initTokenClient({
            client_id: clientId, scope: 'openid email profile',
            callback: function (r) { if (r && r.access_token) resolve(r); else reject(new Error('Cancelled')); },
          });
        } catch (e) { reject(e); }
        tc.requestAccessToken();
      });
      // OAuth leaves this page for Google, so retain a previously requested
      // guarded hash route until the callback returns to this Web client.
      sessionStorage.setItem('anistrim.web.postAuthRoute', postAuthRoute());
      // Redirect to backend Google OAuth flow (documented endpoint).
      window.location.href = API.API_BASE + '/api/auth/google/start?intent=' + intent + '&client=web';
    } catch (err) { toast(err.message || 'Google sign-in failed.', 'error'); }
  }

  // ── Browse / Search ─────────────────────────────────────
  function browseView() {
    renderHeader();
    return '<div class="page"><div class="container"><div class="page-toolbar"><h1>Browse</h1><div class="toolbar-controls">' +
      '<select id="browse-sort" onchange="AniStrimUI.reloadBrowse()"><option value="trending">Trending</option><option value="popular">Popular</option>' +
      '<option value="latest">Latest</option></select>' +
      '<input id="browse-q" placeholder="Search..." onkeydown="if(event.key===\'Enter\')AniStrimUI.reloadBrowse()"></div></div>' +
      '<div id="browse-grid" class="grid-loading">Loading...</div></div></div>';
  }
  async function reloadBrowse() {
    var el = document.getElementById('browse-grid');
    if (!el) return;
    el.innerHTML = '<div class="grid-loading">Loading...</div>';
    var sort = document.getElementById('browse-sort') ? document.getElementById('browse-sort').value : 'trending';
    var q = document.getElementById('browse-q') ? document.getElementById('browse-q').value : '';
    try {
      var list = q ? norm(await API.search(q)) : sort === 'popular' ? norm(await API.popular()) : sort === 'latest' ? norm(await API.latest()) : norm(await API.trending());
      el.innerHTML = list.length ? grid(list) : '<div class="empty">No results.</div>';
    } catch (e) { el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  function searchView() {
    renderHeader();
    return '<div class="page"><div class="container"><div class="page-toolbar"><h1>Search</h1><div class="search-bar">' +
      '<input id="search-input" placeholder="Search anime..." onkeydown="if(event.key===\'Enter\')AniStrimUI.doSearch()">' +
      '<button class="btn-primary" onclick="AniStrimUI.doSearch()">Search</button></div></div>' +
      '<div id="search-results" class="grid-loading">Enter a search term or pick a genre.</div></div></div>';
  }
  function afterSearch(root, params, query) {
    var q = query && query.q;
    var input = document.getElementById('search-input');
    if (input && q) {
      input.value = q;
      doSearch();
    }
  }
  async function doSearch() {
    var q = document.getElementById('search-input') ? document.getElementById('search-input').value : '';
    var el = document.getElementById('search-results');
    if (!el) return;
    el.innerHTML = '<div class="grid-loading">Searching...</div>';
    try {
      var list = norm(await API.search(q));
      el.innerHTML = list.length ? grid(list) : '<div class="empty">No results for "' + esc(q) + '".</div>';
    } catch (e) { el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  // ── Anime details ───────────────────────────────────────
  function animeView() {
    renderHeader();
    return '<div class="page"><div class="container" id="anime-main"><div class="grid-loading">Loading...</div></div></div>';
  }
  function afterAnime(root, params) { loadAnime(params.id); }
  async function loadAnime(id) {
    var root = document.getElementById('anime-main');
    if (!root) return;
    root.innerHTML = '<div class="grid-loading">Loading...</div>';
    try {
      var anime = await API.anime(id);
      var eps = norm(await API.episodes(id));
      var recs = [];
      try { recs = norm(await API.recommendations(id)); } catch (e) { recs = []; }
      var img = anime && (anime.banner_image || anime.cover_image || anime.poster);
      var title = anime && (anime.title || '');
      var genres = (anime && anime.genres) || [];
      root.innerHTML =
        '<div class="anime-hero" style="background-image:linear-gradient(to bottom, rgba(10,10,15,0.4), #0a0a0f), url(\'' + (img || '') + '\')">' +
        '<div class="anime-hero-inner"><div class="anime-poster"><img src="' + (img || fallback(title)) + '" onerror="this.src=AniStrimUI.fallback(\'' + esc(title) + '\')"></div>' +
        '<div class="anime-info"><h1>' + esc(title) + '</h1><div class="meta-line">' + (anime && anime.year ? esc(anime.year) + ' · ' : '') + (anime && anime.status ? esc(anime.status) : '') + '</div>' +
        '<div class="genres">' + genres.map(function (g) { return '<span class="genre-pill">' + esc(g) + '</span>'; }).join('') + '</div>' +
        '<p class="desc">' + esc(anime && anime.description) + '</p>' +
        '<div class="hero-actions"><a class="btn-primary play" onclick="AniStrimUI.playFirst(\'' + esc(id) + '\')">▶ Watch Now</a>' +
        '<button class="btn-outline" onclick="AniStrimUI.toggleWatchlist(\'' + esc(id) + '\')">My List</button></div></div></div></div>' +
        '<div class="container"><div class="episodes-section"><h2>Episodes</h2><div class="episode-grid">' +
        eps.map(function (ep, i) {
          var num = ep && (ep.number || ep.episode_number);
          return '<button class="episode-item" onclick="AniStrimUI.watch(\'' + esc(id) + '\',' + (num || i + 1) + ',\'' + esc(ep.id) + '\')">' +
            '<span class="ep-num">' + (num || i + 1) + '</span><span class="ep-title">' + esc(ep.title || ('Episode ' + (num || i + 1))) + '</span>' +
            (ep.locked ? '<span class="ep-lock">🔒</span>' : '') + '</button>';
        }).join('') + '</div></div>' +
        (recs.length ? '<div class="recommend-section">' + section('Recommended') + grid(recs) + '</div>' : '') + '</div>';
    } catch (e) { root.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  // ── Watch / Player ──────────────────────────────────────
  function watchView(params) {
    renderHeader();
    return '<div class="page watch-page"><div class="watch-container">' +
      '<div class="player-stage"><video id="animePlayer" class="video-element" controls playsinline></video>' +
      '<div class="player-loading" id="player-loading" aria-live="polite">Preparing playback…</div>' +
      '<div class="player-error" id="player-error" style="display:none"></div>' +
      '<div class="skip-actions" id="skip-actions"><button id="skip-intro" class="btn-ghost" style="display:none" onclick="AniStrimUI.skipMarker(\'intro\')">Skip intro</button><button id="skip-outro" class="btn-ghost" style="display:none" onclick="AniStrimUI.skipMarker(\'outro\')">Skip outro</button></div>' +
      '<div class="autoplay-next" id="autoplay-next" style="display:none"><span id="autoplay-next-text"></span><button class="btn-primary" onclick="AniStrimUI.playNextEpisode()">Play now</button><button class="btn-ghost" onclick="AniStrimUI.cancelAutoplay()">Cancel</button></div></div>' +
      '<div class="watch-meta"><h2 id="watch-title">Loading...</h2><div class="player-options" id="player-options">' +
      '<label>Speed <select id="player-speed" onchange="AniStrimUI.setPlaybackSpeed(this.value)"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>Normal</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>' +
      '<label id="quality-option" style="display:none">Quality <select id="player-quality" onchange="AniStrimUI.setQuality(this.value)"></select></label>' +
      '<label id="audio-option" style="display:none">Audio <select id="player-audio" onchange="AniStrimUI.setAudioTrack(this.value)"></select></label>' +
      '<label id="subtitle-option" style="display:none">Subtitles <select id="player-subtitle" onchange="AniStrimUI.setSubtitleTrack(this.value)"></select></label></div>' +
      '<div class="watch-nav" id="watch-nav"></div><div class="season-nav" id="season-nav"></div></div>' +
      '<div class="episode-list" id="watch-episodes"><div class="grid-loading">Loading...</div></div>' +
      '<div class="watch-back"><a href="#/anime/' + esc(params.id) + '" class="btn-ghost">← Back to Anime</a></div>' +
      '</div></div>';
  }
  function afterWatch(root, params, query) {
    // epId is intentionally carried in the hash query, not the path. Prefer it
    // over episode number when selecting the exact backend episode record.
    loadWatch(params.id, params.ep || params.episode || 1, (query && query.epId) || '');
  }

  var trackTimer = null;
  var progressCleanup = null;
  var progressSeekTimer = null;
  var autoplayTimer = null;
  var autoplayRemaining = 0;
  var watchState = null;
  var markerCleanup = null;
  var progressLastPosition = null;
  var PROGRESS_QUEUE_KEY = 'anistrim.web.pendingProgress';
  var PROGRESS_INTERVAL_MS = 15000;
  var PROGRESS_MIN_MOVE_SEC = 5;

  function pendingProgress() {
    try {
      var saved = JSON.parse(localStorage.getItem(PROGRESS_QUEUE_KEY) || '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch (e) { return {}; }
  }
  function queueProgress(payload) {
    // Keep only the newest state for each episode; this bounds storage and
    // prevents an offline session from replaying an unbounded write backlog.
    var queue = pendingProgress();
    queue[String(payload.episodeId)] = payload;
    var keys = Object.keys(queue);
    if (keys.length > 20) {
      keys.sort(function (a, b) { return (queue[a].queuedAt || 0) - (queue[b].queuedAt || 0); })
        .slice(0, keys.length - 20).forEach(function (key) { delete queue[key]; });
    }
    try { localStorage.setItem(PROGRESS_QUEUE_KEY, JSON.stringify(queue)); } catch (e) { /* quota/private mode */ }
  }
  function removeQueuedProgress(episodeId, acknowledgedAt) {
    var queue = pendingProgress();
    if (acknowledgedAt && queue[String(episodeId)] && queue[String(episodeId)].queuedAt > acknowledgedAt) return;
    delete queue[String(episodeId)];
    try { localStorage.setItem(PROGRESS_QUEUE_KEY, JSON.stringify(queue)); } catch (e) { /* ignore */ }
  }
  function flushProgressQueue() {
    if (!Auth.state.isLoggedIn || !navigator.onLine) return Promise.resolve();
    var queue = pendingProgress();
    var entries = Object.keys(queue).map(function (key) { return queue[key]; });
    return entries.reduce(function (chain, payload) {
      return chain.then(function () {
        return API.saveProgress(payload.episodeId, payload.positionSec, payload.durationSec, payload.event)
          .then(function () { removeQueuedProgress(payload.episodeId, payload.queuedAt); })
          .catch(function () { /* retain the newest payload for a later retry */ });
      });
    }, Promise.resolve());
  }
  function queueAndSendProgress(payload, useKeepalive) {
    if (!payload || !payload.episodeId || payload.positionSec <= 0 || !Auth.state.isLoggedIn) return;
    payload.queuedAt = Date.now();
    if (useKeepalive) {
      // Persist before the best-effort unload request, since browsers may stop
      // fetches during teardown. The ordinary online flush removes it on ACK.
      queueProgress(payload);
      try {
        fetch(API.API_BASE + '/api/watch/progress', {
          method: 'PUT', keepalive: true,
          headers: { 'Content-Type': 'application/json', 'X-Client': 'web', 'Authorization': 'Bearer ' + API.getToken() },
          body: JSON.stringify(payload),
        }).then(function (res) { if (res.ok) removeQueuedProgress(payload.episodeId, payload.queuedAt); }).catch(function () {});
      } catch (e) { /* queued above */ }
      return;
    }
    if (!navigator.onLine) { queueProgress(payload); return; }
    API.saveProgress(payload.episodeId, payload.positionSec, payload.durationSec, payload.event)
      .then(function () { removeQueuedProgress(payload.episodeId, payload.queuedAt); })
      .catch(function () { queueProgress(payload); });
  }
  function stopProgressTracking() {
    if (trackTimer) clearInterval(trackTimer);
    trackTimer = null;
    if (progressSeekTimer) clearTimeout(progressSeekTimer);
    progressSeekTimer = null;
    if (progressCleanup) progressCleanup();
    progressCleanup = null;
    progressLastPosition = null;
    if (markerCleanup) markerCleanup();
    markerCleanup = null;
  }
  function clearAutoplay() {
    if (autoplayTimer) clearInterval(autoplayTimer);
    autoplayTimer = null;
    var overlay = document.getElementById('autoplay-next');
    if (overlay) overlay.style.display = 'none';
  }
  function episodeNumber(ep) { return Number(ep && (ep.number || ep.episode_number)) || 0; }
  function episodeSeason(ep) { return Number(ep && (ep.season || ep.season_number)) || 1; }
  function orderedEpisodes(episodes) {
    return (episodes || []).slice().sort(function (a, b) {
      var seasonDelta = episodeSeason(a) - episodeSeason(b);
      return seasonDelta || episodeNumber(a) - episodeNumber(b);
    });
  }
  function currentEpisodeIndex() {
    if (!watchState) return -1;
    return watchState.episodes.findIndex(function (item) { return String(item.id) === String(watchState.target.id); });
  }
  function neighborEpisode(direction) {
    var index = currentEpisodeIndex();
    return index >= 0 && watchState && watchState.episodes[index + direction] || null;
  }
  function episodePath(animeId, episode) {
    return '/watch/' + encodeURIComponent(animeId) + '/' + encodeURIComponent(episodeNumber(episode) || 1) + '?epId=' + encodeURIComponent(episode.id);
  }
  function renderWatchNavigation() {
    if (!watchState) return;
    var nav = document.getElementById('watch-nav');
    var seasonNav = document.getElementById('season-nav');
    var previous = neighborEpisode(-1);
    var next = neighborEpisode(1);
    if (nav) {
      nav.innerHTML = '<button class="btn-ghost" ' + (previous ? '' : 'disabled') + ' onclick="AniStrimUI.playPreviousEpisode()">← Previous</button>' +
        '<button class="btn-ghost" ' + (next ? '' : 'disabled') + ' onclick="AniStrimUI.playNextEpisode()">Next →</button>';
    }
    var seasons = watchState.seasons;
    if (seasonNav) {
      seasonNav.innerHTML = seasons.length > 1
        ? '<label>Season <select onchange="AniStrimUI.selectSeason(this.value)">' + seasons.map(function (season) {
          return '<option value="' + season + '"' + (season === watchState.season ? ' selected' : '') + '>Season ' + season + '</option>';
        }).join('') + '</select></label>'
        : '';
    }
  }
  function renderWatchEpisodes() {
    var listEl = document.getElementById('watch-episodes');
    if (!listEl || !watchState) return;
    var visible = watchState.episodes.filter(function (episode) { return episodeSeason(episode) === watchState.season; });
    if (!visible.length) visible = watchState.episodes;
    listEl.innerHTML = '<div class="episode-grid">' + visible.map(function (item) {
      var n = episodeNumber(item);
      var active = String(item.id) === String(watchState.target.id) ? ' active' : '';
      return '<button class="episode-item' + active + '" onclick="AniStrimUI.watch(\'' + esc(watchState.animeId) + '\',' + (n || 1) + ',\'' + esc(item.id) + '\')">' +
        '<span class="ep-num">' + esc(n) + '</span><span class="ep-title">' + esc(item.title || 'Episode ' + n) + '</span>' +
        (item.locked ? '<span class="ep-lock">🔒</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function navigateEpisode(episode) {
    if (!episode || !watchState) return;
    var access = episodeAccess(episode);
    if (!access.playable) {
      showWatchAccess(document.getElementById('player-error'), document.getElementById('watch-episodes'), access, episodePath(watchState.animeId, episode), null);
      return;
    }
    clearAutoplay();
    Router.navigate(episodePath(watchState.animeId, episode));
  }
  function startAutoplay() {
    var next = neighborEpisode(1);
    if (!watchState || !watchState.autoplayNext || !next || !episodeAccess(next).playable) return;
    clearAutoplay();
    autoplayRemaining = Math.max(0, Number(watchState.autoplayCountdown) || 10);
    var overlay = document.getElementById('autoplay-next');
    var text = document.getElementById('autoplay-next-text');
    function render() { if (text) text.textContent = 'Next episode in ' + autoplayRemaining + '…'; }
    if (overlay) overlay.style.display = 'flex';
    render();
    autoplayTimer = setInterval(function () {
      autoplayRemaining -= 1;
      if (autoplayRemaining <= 0) { clearAutoplay(); navigateEpisode(next); return; }
      render();
    }, 1000);
  }
  function loadAutoplayPreference() {
    if (!watchState) return;
    // The persisted account preference is authoritative for signed-in users.
    // Guests have no server preference, so no automatic transition is made.
    if (!Auth.state.isLoggedIn) { watchState.autoplayNext = false; return; }
    API.profilePreferences().then(function (data) {
      if (!watchState) return;
      var prefs = data && (data.preferences || data);
      watchState.autoplayNext = !!(prefs && prefs.autoplayNext);
      watchState.autoplayCountdown = Number(prefs && prefs.autoplayCountdown) || 10;
      watchState.preferences = prefs || {};
      applyPlayerPreferences();
    }).catch(function () { watchState.autoplayNext = false; });
  }
  function fillSelect(id, options, value, prefix) {
    var select = document.getElementById(id);
    var label = document.getElementById(id.replace('player-', '') + '-option');
    if (!select || !label) return;
    if (!options || !options.length) { label.style.display = 'none'; return; }
    label.style.display = '';
    select.innerHTML = options.map(function (option) {
      return '<option value="' + esc((prefix || '') + option.value) + '"' + (String(option.value) === String(value) ? ' selected' : '') + '>' + esc(option.label) + '</option>';
    }).join('');
  }
  function refreshPlayerControls(capabilities) {
    capabilities = capabilities || Player.getCapabilities();
    if (!capabilities) return;
    fillSelect('player-quality', capabilities.qualities && capabilities.qualities.length > 1 ? capabilities.qualities : [], -1, '');
    fillSelect('player-audio', capabilities.audioTracks && capabilities.audioTracks.length > 1 ? capabilities.audioTracks : [], 0, '');
    var subtitles = [{ value: 'off', label: 'Off' }];
    (capabilities.subtitles || []).forEach(function (track) {
      subtitles.push({ value: (track.hls ? 'hls:' : 'native:') + track.index, label: track.label });
    });
    fillSelect('player-subtitle', subtitles.length > 1 ? subtitles : [], 'off', '');
    applyPlayerPreferences();
  }
  function applyPlayerPreferences() {
    if (!watchState) return;
    var preferences = watchState.preferences || {};
    var video = document.getElementById('animePlayer');
    var speed = Number(preferences.playbackRate) || Number(localStorage.getItem('anistrim.web.playbackRate')) || 1;
    var speedSelect = document.getElementById('player-speed');
    if (video) video.playbackRate = speed;
    if (speedSelect) speedSelect.value = String(speed);
    if (preferences.defaultQuality && preferences.defaultQuality !== 'auto') Player.setQuality(Number(preferences.defaultQuality));
    if (preferences.subtitlesOn === false) Player.setSubtitleTrack('off');
  }
  function loadEpisodeMarkers(video, episodeId) {
    if (!Auth.state.isLoggedIn || !video || !episodeId) return;
    API.episodeMarkers(episodeId).then(function (data) {
      var markers = data && data.markers || {};
      if (!watchState) return;
      watchState.markers = markers;
      function updateMarkerButtons() {
        ['intro', 'outro'].forEach(function (kind) {
          var marker = markers[kind];
          var button = document.getElementById('skip-' + kind);
          if (!button) return;
          var active = marker && Number(marker.end) > Number(marker.start) && video.currentTime >= Number(marker.start) && video.currentTime < Number(marker.end);
          button.style.display = active ? '' : 'none';
          if (active && kind === 'intro' && watchState.preferences && watchState.preferences.skipIntroAuto) video.currentTime = Number(marker.end);
        });
      }
      video.addEventListener('timeupdate', updateMarkerButtons);
      markerCleanup = function () {
        video.removeEventListener('timeupdate', updateMarkerButtons);
        ['intro', 'outro'].forEach(function (kind) { var button = document.getElementById('skip-' + kind); if (button) button.style.display = 'none'; });
      };
      updateMarkerButtons();
    }).catch(function () { /* markers are an optional playback enhancement */ });
  }
  function startProgressTracking(video, episodeId, onEnded) {
    stopProgressTracking();
    if (!Auth.state.isLoggedIn || !video || !episodeId) return;
    var restored = false;
    function restore() {
      if (restored) return;
      restored = true;
      API.getEpisodeProgress(episodeId).then(function (progress) {
        var position = progress && Number(progress.positionSec);
        var savedDuration = progress && Number(progress.durationSec);
        var duration = savedDuration > 0 ? savedDuration : video.duration;
        if (progress && !progress.completed && position > 10 &&
            (!isFinite(duration) || duration <= 0 || position < duration * 0.95)) {
          video.currentTime = position;
        }
      }).catch(function () { /* progress must never block playback */ });
    }
    if (video.readyState >= 1) restore();
    else video.addEventListener('loadedmetadata', restore, { once: true });
    function save(event, keepalive) {
      if (!video || !isFinite(video.currentTime) || video.currentTime <= 0) return;
      var position = Math.round(video.currentTime);
      var duration = Math.round(video.duration || 0);
      if (event === 'heartbeat' && progressLastPosition !== null && Math.abs(position - progressLastPosition) < PROGRESS_MIN_MOVE_SEC) return;
      progressLastPosition = position;
      queueAndSendProgress({ episodeId: episodeId, positionSec: position, durationSec: duration, event: event || 'heartbeat' }, keepalive);
    }
    function heartbeat() { if (!video.paused && !video.ended) save('heartbeat'); }
    function pause() { if (!video.ended) save('pause'); }
    function seeked() {
      if (progressSeekTimer) clearTimeout(progressSeekTimer);
      progressSeekTimer = setTimeout(function () { save('seek'); }, 1500);
    }
    function onVisibility() { if (document.visibilityState === 'hidden') save('exit', true); }
    function onPageHide() { save('exit', true); }
    function ended() { save('ended'); if (typeof onEnded === 'function') onEnded(); }
    trackTimer = setInterval(heartbeat, PROGRESS_INTERVAL_MS);
    video.addEventListener('pause', pause);
    video.addEventListener('seeked', seeked);
    video.addEventListener('ended', ended, { once: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    window.addEventListener('online', flushProgressQueue);
    progressCleanup = function () {
      save('exit', true);
      video.removeEventListener('pause', pause);
      video.removeEventListener('seeked', seeked);
      video.removeEventListener('ended', ended);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      window.removeEventListener('online', flushProgressQueue);
    };
    flushProgressQueue();
  }
  async function loadWatch(id, ep, epId) {
    var video = document.getElementById('animePlayer');
    var titleEl = document.getElementById('watch-title');
    var listEl = document.getElementById('watch-episodes');
    var errEl = document.getElementById('player-error');
    var loadingEl = document.getElementById('player-loading');
    stopProgressTracking();
    clearAutoplay();
    Player.destroy();
    Player.setErrorDisplay(function (m) { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } });
    Player.setStatusDisplay(function (m) {
      if (loadingEl) { loadingEl.textContent = m; loadingEl.style.display = m === 'Playing' ? 'none' : 'flex'; }
    });
    try {
      var anime = await API.anime(id);
      var eps = norm(await API.episodes(id));
      if (titleEl && anime) titleEl.textContent = anime.title + (ep ? ' — Ep ' + ep : '');
      var target = eps.find(function (x) { return epId && String(x.id) === String(epId); }) ||
        eps.find(function (x) { return String(x.number || x.episode_number) === String(ep); });
      if (!target) { if (errEl) { errEl.textContent = 'Episode not found.'; errEl.style.display = 'block'; } return; }
      var access = episodeAccess(target);
      var returnPath = '/watch/' + encodeURIComponent(id) + '/' + encodeURIComponent(ep) + (epId ? ('?epId=' + encodeURIComponent(epId)) : '');
      watchState = {
        animeId: id,
        episodes: orderedEpisodes(eps),
        target: target,
        season: episodeSeason(target),
        seasons: Array.from(new Set(eps.map(episodeSeason))).sort(function (a, b) { return a - b; }),
        autoplayNext: false,
        autoplayCountdown: 10,
      };
      renderWatchNavigation();
      renderWatchEpisodes();
      loadAutoplayPreference();
      // The episode DTO is the first access decision. A playable free episode
      // is allowed to reach the backend even for a guest; the backend remains
      // the final authority for entitlement and device restrictions.
      if (!access.playable) {
        if (loadingEl) loadingEl.style.display = 'none';
        showWatchAccess(errEl, listEl, access, returnPath, null);
        return;
      }
      await Player.playEpisode(target.id, video,
        function (err, authData) {
          if (err) {
            if (loadingEl) loadingEl.style.display = 'none';
            showWatchAccess(errEl, listEl, access, returnPath, err);
            return;
          } else {
            startProgressTracking(video, target.id, startAutoplay);
            loadEpisodeMarkers(video, target.id);
          }
        },
        function (err2) {
          if (loadingEl) loadingEl.style.display = 'none';
          if (errEl) { errEl.textContent = err2.message || 'Playback could not be started.'; errEl.style.display = 'block'; }
        },
        {
          animeTitle: anime && anime.title,
          episodeNumber: episodeNumber(target),
          onCapabilities: refreshPlayerControls,
          onMetadata: function () { refreshPlayerControls(); },
        }
      );
    } catch (e) {
      if (loadingEl) loadingEl.style.display = 'none';
      if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
    }
  }

  // ── Watchlist / History ─────────────────────────────────
  function watchlistView() {
    renderHeader();
    if (!Auth.state.isLoggedIn) { Router.navigate('/login', { redirect: '/watchlist' }); return ''; }
    return '<div class="page"><div class="container"><h1>My Watchlist</h1><div id="watchlist-grid" class="grid-loading">Loading...</div></div></div>';
  }
  async function loadWatchlist() {
    var el = document.getElementById('watchlist-grid');
    if (!el) return;
    el.innerHTML = '<div class="grid-loading">Loading...</div>';
    try {
      var list = norm(await API.watchlist());
      el.innerHTML = list.length ? grid(list.map(function (w) { return w.anime || w; })) : '<div class="empty">Your watchlist is empty.</div>';
    } catch (e) { el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  function historyView() {
    renderHeader();
    if (!Auth.state.isLoggedIn) { Router.navigate('/login', { redirect: '/history' }); return ''; }
    return '<div class="page"><div class="container"><div class="page-toolbar"><h1>Watch History</h1>' +
      '<button class="btn-outline" onclick="AniStrimUI.clearHistory()">Clear</button></div>' +
      '<div id="history-list"><div class="grid-loading">Loading...</div></div></div></div>';
  }
  async function loadHistory() {
    var el = document.getElementById('history-list');
    if (!el) return;
    el.innerHTML = '<div class="grid-loading">Loading...</div>';
    try {
      var list = norm(await API.watchHistory(1, 30));
      // History is backed by watch_progress rows, not full anime DTOs. Adapt
      // the documented response shape so cards retain their real title, art,
      // and navigation target instead of rendering an empty placeholder.
      el.innerHTML = list.length ? grid(list.map(function (h) {
        return h.anime || {
          id: h.animeId,
          title: h.animeTitle || h.title || 'Anime',
          cover_image: h.animeCoverImage || h.cover_image || '',
        };
      })) : '<div class="empty">No watch history.</div>';
    } catch (e) { el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  async function clearHistory() {
    try { await API.clearHistory(); toast('History cleared.'); loadHistory(); } catch (e) { toast(e.message, 'error'); }
  }

  // ── Profile ─────────────────────────────────────────────
  function profileView() {
    renderHeader();
    if (!Auth.state.isLoggedIn) { Router.navigate('/login', { redirect: '/profile' }); return ''; }
    var user = Auth.state.user;
    return '<div class="page"><div class="container"><div class="profile-grid">' +
      '<div class="profile-card"><div class="avatar-wrap"><img id="profile-avatar" class="avatar" src="" alt="avatar"></div>' +
      '<h2>' + esc(user && (user.displayName || user.name)) + '</h2><p class="muted">' + esc(user && user.email) + '</p>' +
      '<div class="profile-meta">' + (Auth.state.isPremium ? '<span class="badge-premium">👑 Premium</span>' : '<a href="#/upgrade" class="btn-outline">Upgrade</a>') + '</div>' +
      '<button class="btn-ghost btn-block" onclick="AniStrimUI.uploadAvatar()">Change Avatar</button>' +
      '<input type="file" id="avatar-input" accept="image/*" style="display:none" onchange="AniStrimUI.doAvatarUpload(event)">' +
      '<button class="btn-outline btn-block" onclick="AniStrimUI.logout()">Logout</button></div>' +
      '<div class="profile-settings"><div class="settings-card"><h3>Preferences</h3>' +
      '<label class="checkbox"><input type="checkbox" id="pref-auto-skip"> Auto-skip intros</label>' +
      '<label class="checkbox"><input type="checkbox" id="pref-auto-play"> Auto-play next</label>' +
      '<label>Username<input id="pref-username" placeholder="Set username"></label>' +
      '<button class="btn-primary" onclick="AniStrimUI.saveProfile()">Save</button></div></div></div></div></div>';
  }
  function afterProfile() {
    var user = Auth.state.user;
    var av = document.getElementById('profile-avatar');
    if (av) av.src = (user && (user.avatarUrl || user.avatar || user.avatar_url)) || fallback(user && (user.name || 'A'));
    var u = document.getElementById('pref-username');
    if (u && user && user.username) u.value = user.username;
    API.profilePreferences().then(function (data) {
      var prefs = data && (data.preferences || data);
      var skip = document.getElementById('pref-auto-skip');
      var autoplay = document.getElementById('pref-auto-play');
      if (skip) skip.checked = !!(prefs && prefs.skipIntroAuto);
      if (autoplay) autoplay.checked = !!(prefs && prefs.autoplayNext);
    }).catch(function () { /* preferences are non-critical on the profile page */ });
  }
  async function saveProfile() {
    try {
      var u = document.getElementById('pref-username') ? document.getElementById('pref-username').value : '';
      var skip = document.getElementById('pref-auto-skip') ? document.getElementById('pref-auto-skip').checked : false;
      var play = document.getElementById('pref-auto-play') ? document.getElementById('pref-auto-play').checked : false;
      if (u) await API.profileSetUsername(u);
      await API.profileUpdatePreferences({ skipIntroAuto: skip, autoplayNext: play });
      toast('Saved'); await Auth.refreshMe(); renderHeader();
    } catch (e) { toast(e.message, 'error'); }
  }
  function uploadAvatar() { var i = document.getElementById('avatar-input'); if (i) i.click(); }
  async function doAvatarUpload(e) {
    var file = e.target && e.target.files && e.target.files[0];
    if (!file) return;
    try {
      await API.uploadAvatar(file);
      await Auth.refreshMe(); renderHeader(); toast('Avatar updated');
    } catch (err) { toast(err.message, 'error'); }
  }

  // ── Upgrade ─────────────────────────────────────────────
  function upgradeView() {
    renderHeader();
    if (Auth.state.isPremium) return '<div class="page"><div class="container"><div class="card premium-card"><h1>You are Premium 👑</h1></div></div></div>';
    return '<div class="page"><div class="container"><h1>Upgrade to Premium</h1><div class="plans">' +
      '<div class="plan"><h3>Monthly</h3><div class="price">UGX 15,000<span>/mo</span></div><button class="btn-primary" onclick="AniStrimUI.checkout(\'monthly\')">Choose</button></div>' +
      '<div class="plan featured"><h3>Yearly</h3><div class="price">UGX 180,000<span>/yr</span></div><button class="btn-primary" onclick="AniStrimUI.checkout(\'yearly\')">Choose</button></div>' +
      '</div></div></div>';
  }
  async function checkout(plan) {
    try {
      var data = await API.checkout(plan);
      if (data && data.payment_link) { window.location.href = data.payment_link; return; }
      toast('Could not start checkout', 'error');
    } catch (e) { toast(e.message, 'error'); }
  }
  function paymentReturnView() {
    renderHeader();
    return '<div class="page"><div class="container"><div class="card premium-card"><h1>Verifying payment…</h1><p id="payment-return-status" class="muted">Please wait while we confirm your subscription.</p></div></div></div>';
  }
  async function afterPaymentReturn(root, params, query) {
    var status = document.getElementById('payment-return-status');
    var reference = query && (query.reference || query.tx_ref || query.OrderMerchantReference);
    if (!reference) { if (status) status.textContent = 'Missing payment reference. Please contact support if you were charged.'; return; }
    try {
      var result = await API.verifySubscription(reference);
      if (status) status.textContent = (result && (result.message || result.status)) || 'Payment status updated.';
      await Auth.refreshMe();
      renderHeader();
    } catch (e) { if (status) status.textContent = e.message || 'Could not verify this payment yet.'; }
  }

  // ── Public API ──────────────────────────────────────────
  window.AniStrimUI = {
    fallback: fallback,
    goAnime: function (id) { Router.navigate('/anime/' + encodeURIComponent(id)); },
    watch: function (id, ep, epId) {
      var path = '/watch/' + encodeURIComponent(id) + '/' + encodeURIComponent(ep || 1);
      Router.navigate(path, epId ? { epId: epId } : null);
    },
    playFirst: function (id) {
      API.episodes(id).then(function (eps) {
        var list = norm(eps);
        var e = list.find(function (episode) { return episodeAccess(episode).playable; });
        if (e) { AniStrimUI.watch(id, e.number || e.episode_number || 1, e.id); }
        else if (list.length) { toast(accessMessage(episodeAccess(list[0])), 'error'); }
        else toast('No episodes available.', 'error');
      }).catch(function (e) { toast(e.message, 'error'); });
    },
    toggleWatchlist: async function (id) {
      if (!Auth.state.isLoggedIn) { Router.navigate('/login'); return; }
      try { await API.toggleWatchlist(id); toast('Watchlist updated'); } catch (e) { toast(e.message, 'error'); }
    },
    logout: async function () { await Auth.logout(); renderHeader(); Router.navigate('/'); },
    doLogin: doLogin, doSignup: doSignup, doVerify: doVerify, resendOtp: resendOtp, doForgotPassword: doForgotPassword, doResetPassword: doResetPassword,
    doGoogleLogin: function () { gAuth('login'); }, doGoogleSignup: function () { gAuth('signup'); },
    reloadBrowse: reloadBrowse, doSearch: doSearch,
    loadAnime: loadAnime, loadWatch: loadWatch,
    stopWatchProgress: function () { stopProgressTracking(); clearAutoplay(); watchState = null; },
    playPreviousEpisode: function () { navigateEpisode(neighborEpisode(-1)); },
    playNextEpisode: function () { navigateEpisode(neighborEpisode(1)); },
    cancelAutoplay: clearAutoplay,
    selectSeason: function (season) {
      if (!watchState) return;
      var selected = Number(season);
      if (watchState.seasons.indexOf(selected) === -1) return;
      watchState.season = selected;
      renderWatchNavigation();
      renderWatchEpisodes();
    },
    setPlaybackSpeed: function (value) {
      var rate = Number(value);
      var video = document.getElementById('animePlayer');
      if (!video || !isFinite(rate) || rate < 0.25 || rate > 3) return;
      video.playbackRate = rate;
      try { localStorage.setItem('anistrim.web.playbackRate', String(rate)); } catch (e) { /* ignore */ }
      if (Auth.state.isLoggedIn) API.profileUpdatePreferences({ playbackRate: rate }).catch(function () {});
    },
    setQuality: function (value) { Player.setQuality(Number(value)); },
    setAudioTrack: function (value) { Player.setAudioTrack(Number(value)); },
    setSubtitleTrack: function (value) {
      Player.setSubtitleTrack(value);
      if (Auth.state.isLoggedIn) {
        var enabled = value !== 'off';
        API.profileUpdatePreferences({ subtitlesOn: enabled }).catch(function () {});
      }
    },
    skipMarker: function (kind) {
      var marker = watchState && watchState.markers && watchState.markers[kind];
      var video = document.getElementById('animePlayer');
      if (marker && video && Number(marker.end) > Number(marker.start)) video.currentTime = Number(marker.end);
    },
    loadWatchlist: loadWatchlist, loadHistory: loadHistory, clearHistory: clearHistory,
    saveProfile: saveProfile, uploadAvatar: uploadAvatar, doAvatarUpload: doAvatarUpload,
    checkout: checkout, renderHeader: renderHeader,
  };

  window.AniStrimViews = {
    home: homeView, login: loginView, signup: signupView, verify: verifyView, forgotPassword: forgotPasswordView,
    resetPassword: resetPasswordView, googleCallback: googleCallbackView,
    browse: browseView, afterBrowse: reloadBrowse, search: searchView, afterSearch: afterSearch,
    anime: animeView, afterAnime: afterAnime, watch: watchView, afterWatch: afterWatch,
    watchlist: watchlistView, afterWatchlist: loadWatchlist,
    history: historyView, afterHistory: loadHistory,
    profile: profileView, afterProfile: afterProfile, upgrade: upgradeView,
    paymentReturn: paymentReturnView, afterPaymentReturn: afterPaymentReturn,
  };

  Auth.state.onChange(renderHeader);
  Player.setErrorDisplay(function (m) {
    var el = document.getElementById('player-error');
    if (el) { el.textContent = m; el.style.display = 'block'; }
  });
})();
