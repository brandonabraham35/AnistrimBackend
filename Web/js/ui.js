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
    var type = a && (a.type || a.media_type || '');
    var eps = a && (a.episode_count || a.total_episodes || '');
    return '<div class="anime-card" onclick="AniStrimUI.goAnime(' + id + ')">' +
      '<div class="anime-card-img"><img src="' + (img || fallback(title)) + '" alt="' + esc(title) + '" loading="lazy" ' +
      'onerror="this.src=AniStrimUI.fallback(\'' + esc(title) + '\')">' +
      (type ? '<span class="badge-type">' + esc(type) + '</span>' : '') +
      (a && a.is_premium ? '<span class="badge-premium">&#x1F451;</span>' : '') +
      (a && a.rating ? '<span class="badge-rating">&#9733; ' + esc(a.rating) + '</span>' : '') +
      (eps ? '<span class="badge-ep">' + esc(eps) + '</span>' : '') +
      '</div><div class="anime-card-body"><div class="anime-card-title">' + esc(title) + '</div>' +
      '<div class="anime-card-sub">' + (type || 'Anime') + (eps ? ' &middot; ' + esc(eps) + ' EP' : '') +
      (a && a.year ? ' &middot; ' + esc(a.year) : '') + '</div></div></div>';
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

  // Keep one server-derived watchlist snapshot for controls rendered on detail
  // and watchlist pages. Mutations update it only from the API response.
  var watchlistIds = new Set();
  var watchlistLoaded = false;
  var watchlistRequests = {};
  function refreshWatchlistState() {
    if (!Auth.state.isLoggedIn) { watchlistIds = new Set(); watchlistLoaded = false; return Promise.resolve([]); }
    return API.watchlist().then(function (rows) {
      var list = norm(rows);
      watchlistIds = new Set(list.map(function (item) { return String(item.animeId || (item.anime && item.anime.id) || item.id); }));
      watchlistLoaded = true;
      return list;
    });
  }
  function syncWatchlistButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-watchlist-id]'), function (button) {
      var inList = watchlistIds.has(String(button.getAttribute('data-watchlist-id')));
      button.textContent = inList ? 'Remove from List' : 'My List';
      button.setAttribute('aria-pressed', inList ? 'true' : 'false');
    });
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
    var name = user && (user.displayName || user.username || user.email || '');
    var initial = name ? name.charAt(0).toUpperCase() : '?';
    var avatar = (user && user.avatar) || '';
    h.innerHTML = '<nav class="nav"><div class="nav-inner">' +
      '<button class="mobile-menu-btn" onclick="AniStrimUI.toggleMobileNav()" aria-label="Toggle navigation">\u2630</button>' +
      '<a class="brand" href="#/">AniStrim</a>' +
      '<div class="nav-links"><a href="#/">Home</a><a href="#/browse">Browse</a><a href="#/search">Search</a>' +
      (logged ? '<a href="#/watchlist">Watchlist</a><a href="#/history">History</a><a href="#/upgrade">Upgrade</a>' : '') + '</div>' +
      '<div class="nav-search"><input type="text" placeholder="Search anime\u2026" id="nav-search-input" onkeydown="if(event.key===\'Enter\'){var q=this.value.trim();if(q){window.AniStrimRouter.navigate(\'/search\',{q:q});this.value=\'\'}}"></div>' +
      '<div class="nav-auth">' +
      (logged
        ? '<a href="#/profile" class="nav-avatar" aria-label="Profile">' +
          (avatar ? '<img src="' + esc(avatar) + '" alt="">' : esc(initial)) +
          '</a>'
        : '<a href="#/login" class="btn-outline btn-sm">Sign In</a><a href="#/signup" class="btn-primary btn-sm">Get Started</a>') +
      '</div></div>' +
      // Mobile navigation panel
      '<div class="mobile-nav" id="mobile-nav">' +
      (logged && user ? '<div class="nav-user">' +
        '<div class="nav-avatar">' + (avatar ? '<img src="' + esc(avatar) + '" alt="">' : esc(initial)) + '</div>' +
        '<div><div style="font-weight:600">' + esc(name) + '</div>' +
        (user.email ? '<div style="font-size:.85rem;color:var(--clr-text-muted)">' + esc(user.email) + '</div>' : '') +
        '</div></div>' : '') +
      '<a href="#/">Home</a><a href="#/browse">Browse</a><a href="#/search">Search</a>' +
      (logged ? '<a href="#/watchlist">Watchlist</a><a href="#/history">History</a>' : '') +
      '<a href="#/upgrade">Upgrade</a>' +
      (logged
        ? '<a href="#/profile">Profile</a><a href="#" onclick="AniStrimUI.logout();AniStrimUI.closeMobileNav();return false">Logout</a>'
        : '<a href="#/login">Sign In</a><a href="#/signup">Sign Up</a>') +
      '</div></nav>';
    var f = document.getElementById('site-footer');
    f.innerHTML = '<div class="footer-inner"><span>\u00a9 ' + new Date().getFullYear() + ' AniStrim</span>' +
      '<div class="footer-links"><a href="#/browse">Browse</a><a href="#/search">Search</a>' +
      (Auth.state.isPremium ? '<a href="#/profile">Account</a>' : '<a href="#/upgrade">Upgrade</a>') + '</div></div>';
  }
  function toggleMobileNav() {
    var el = document.getElementById('mobile-nav');
    if (el) el.classList.toggle('open');
  }
  function closeMobileNav() {
    var el = document.getElementById('mobile-nav');
    if (el) el.classList.remove('open');
  }

  // ── Slider state ──────────────────────────────────────────
  var slideIdx = 0, slideData = [], slideTimer = null, slideTouchX = 0;

  function renderSlider() {
    var el = document.getElementById('home-slider');
    if (!el) return;
    if (!slideData.length) {
      el.innerHTML = '<div class="slider-wrapper"><div class="slide-inner" style="height:460px;background:var(--clr-surface);display:flex;align-items:center;justify-content:center"><div style="text-align:center"><div class="skeleton" style="width:300px;height:40px;margin:0 auto 16px;border-radius:8px;background:var(--clr-border)"></div><div class="skeleton" style="width:500px;height:20px;margin:0 auto;border-radius:8px;background:var(--clr-border)"></div></div></div></div>';
      return;
    }
    var h = '<div class="slider-wrapper" role="region" aria-label="Featured anime">' +
      '<div class="slider-track" style="transform:translateX(-' + (slideIdx * 100) + '%)">';
    for (var i = 0; i < slideData.length; i++) {
      var a = slideData[i], bg = a.banner_image || a.cover_image || '';
      var type = a.type || a.media_type || '';
      h += '<div class="slide" role="group" aria-roledescription="slide" aria-label="Slide ' + (i + 1) + ' of ' + slideData.length + '">' +
        '<div class="slide-inner"' + (bg ? ' style="background-image:linear-gradient(to top,rgba(8,8,14,1) 0%,rgba(8,8,14,.7) 40%,rgba(8,8,14,.3) 70%,transparent 100%),url(' + bg + ')"' : '') + '>' +
        '<div class="slide-overlay"></div>' +
        '<div class="slide-content">' +
        (type ? '<span class="slide-badge">' + esc(type) + '</span>' : '') +
        '<h2>' + esc(a.title) + '</h2>' +
        (a.description ? '<p>' + esc(a.description.substring(0, 180)) + '</p>' : '') +
        '<div class="slide-actions">' +
        '<a href="#/anime/' + a.id + '" class="btn-primary">\u25B6 Watch Now</a>' +
        '<a href="#/anime/' + a.id + '" class="btn-outline">Details</a>' +
        '</div></div></div></div>';
    }
    h += '</div>';
    if (slideData.length > 1) {
      h += '<button class="slider-btn slider-prev" onclick="AniStrimUI.prevSlide()" aria-label="Previous slide">\u2039</button>' +
        '<button class="slider-btn slider-next" onclick="AniStrimUI.nextSlide()" aria-label="Next slide">\u203A</button>' +
        '<div class="slider-dots" role="tablist" aria-label="Slides">';
      for (var j = 0; j < slideData.length; j++)
        h += '<button class="slider-dot' + (j === slideIdx ? ' active' : '') + '" onclick="AniStrimUI.goToSlide(' + j + ')" role="tab" aria-selected="' + (j === slideIdx ? 'true' : 'false') + '" aria-label="Slide ' + (j + 1) + '"></button>';
      h += '</div>';
    }
    el.innerHTML = h;
    if (slideData.length > 1) {
      el.addEventListener('mouseenter', clearSlideTimer);
      el.addEventListener('mouseleave', startSlideTimer);
      el.addEventListener('touchstart', onSlideTouchStart, { passive: true });
      el.addEventListener('touchend', onSlideTouchEnd, { passive: true });
    }
  }
  function goToSlide(i) {
    if (i < 0 || i >= slideData.length) return;
    slideIdx = i; renderSlider();
  }
  function nextSlide() { goToSlide(slideIdx + 1 < slideData.length ? slideIdx + 1 : 0); }
  function prevSlide() { goToSlide(slideIdx > 0 ? slideIdx - 1 : slideData.length - 1); }
  function clearSlideTimer() { if (slideTimer) { clearInterval(slideTimer); slideTimer = null; } }
  function startSlideTimer() { clearSlideTimer(); if (slideData.length > 1) slideTimer = setInterval(function () { nextSlide(); }, 6000); }
  function onSlideTouchStart(e) { slideTouchX = e.touches ? e.touches[0].clientX : 0; }
  function onSlideTouchEnd(e) {
    var diff = slideTouchX - (e.changedTouches ? e.changedTouches[0].clientX : 0);
    if (Math.abs(diff) > 50) { diff > 0 ? nextSlide() : prevSlide(); }
  }

  // ── Home ────────────────────────────────────────────────
  function homeView() {
    renderHeader();
    return Promise.resolve('<div class="page home-page" style="padding-top:0">' +
      '<div class="slider-wrapper" id="home-slider"></div>' +
      '<div class="container"><div class="home-content">' +
      '<div class="home-main" id="home-sections"></div>' +
      '<div class="home-sidebar" id="home-sidebar"></div>' +
      '</div></div></div>').then(function (h) {
      renderSlider();
      setTimeout(loadHome, 0);
      return h;
    });
  }

  async function loadHome() {
    var wrap = document.getElementById('home-sections');
    if (!wrap) return;
    try {
      var s = await API.homeSections();
      if (s && s.trending && s.trending.length) {
        slideData = s.trending.slice(0, 8); slideIdx = 0;
        renderSlider(); startSlideTimer();
      }
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
      loadRanking(s);
    } catch (e) {
      wrap.innerHTML = '<div class="empty">Could not load home sections. ' + retryButton('loadHome()', 'Try again') + '<p>' + esc(e.message) + '</p></div>';
    }


  // ── Ranking sidebar ──────────────────────────────────────
  var rankData = { popular: [], trending: [] };
  function loadRanking(s) {
    var side = document.getElementById('home-sidebar');
    if (!side) return;
    rankData.popular = (s && s.popular) || [];
    rankData.trending = (s && s.trending) || [];
    side.innerHTML = '<div class="rank-section">' +
      '<div class="rank-tabs" role="tablist">' +
      '<button class="rank-tab active" onclick="AniStrimUI.switchRankTab(0)" role="tab">All Time Popular</button>' +
      '<button class="rank-tab" onclick="AniStrimUI.switchRankTab(1)" role="tab">All Time Favorites</button>' +
      '</div><div class="rank-list" id="rank-list"></div></div>';
    renderRankItems(0);
  }
  function renderRankItems(tab) {
    var list = document.getElementById('rank-list');
    if (!list) return;
    var items = tab === 0 ? rankData.popular : rankData.trending;
    if (!items || !items.length) {
      list.innerHTML = '<div class="rank-item" style="padding:16px;justify-content:center;color:var(--clr-text-muted);font-size:var(--font-size-sm)">No data available.</div>';
      return;
    }
    var items2 = items.slice(0, 10);
    var h = '';
    for (var i = 0; i < items2.length; i++) {
      var a = items2[i];
      var img = a.cover_image || a.poster || '';
      var type = a.type || a.media_type || '';
      var eps = a.episode_count || a.total_episodes || '';
      var topClass = i < 3 ? ' top-' + (i + 1) : '';
      h += '<div class="rank-item" onclick="AniStrimUI.goAnime(' + (a.id || a.animeId) + ')">' +
        '<span class="rank-num' + topClass + '">' + (i + 1) + '</span>' +
        '<div class="rank-thumb"><img src="' + (img || fallback(a.title)) + '" alt="" loading="lazy" onerror="this.style.display='none'"></div>' +
        '<div class="rank-info"><div class="rank-title">' + esc(a.title || '') + '</div>' +
        '<div class="rank-meta">' + (type || 'Anime') + (eps ? ' &middot; ' + eps + ' EP' : '') + '</div></div></div>';
    }
    list.innerHTML = h;
  }
  function switchRankTab(tab) {
    var tabs = document.querySelectorAll('.rank-tab');
    if (tabs.length) {
      tabs[0].className = tab === 0 ? 'rank-tab active' : 'rank-tab';
      tabs[1].className = tab === 1 ? 'rank-tab active' : 'rank-tab';
    }
    renderRankItems(tab);
  }
  }  // ── Auth pages ──────────────────────────────────────────
  function authShell(title) {
    return '<div class="page auth-page"><div class="auth-card"><h1>' + title + '</h1><div id="auth-error" class="form-error"></div>';
  }
  function loginView() {
    renderHeader();
    postAuthRoute();
    return authShell('Sign In') +
      '<form onsubmit="return AniStrimUI.doLogin(event)"><label>Email<input type="email" id="login-email" required></label>' +
      '<label>Password<input type="password" id="login-password" required></label>' +
      '<button class="btn-primary btn-block" type="submit">Sign In</button></form>' +
      '<div class="auth-alt"><span>or</span></div><button class="btn-google" onclick="AniStrimUI.doGoogleLogin()">Continue with Google</button>' +
      '<p class="auth-switch"><a href="#/forgot-password">Forgot password?</a> · New here? <a href="#/signup">Create an account</a></p></div></div>';
  }
  function signupView() {
    renderHeader();
    postAuthRoute();
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
      await Auth.refreshMe();
      renderHeader();
      if (data.user && data.user.emailVerified === false) {
        Router.navigate('/verify', { email: data.user.email || document.getElementById('login-email').value, redirect: postAuthRoute() });
      } else Router.navigate(consumePostAuthRoute());
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
      if (data && data.token) { await Auth.refreshMe(); renderHeader(); Router.navigate(consumePostAuthRoute()); }
      else Router.navigate('/verify', { email: document.getElementById('signup-email').value, redirect: postAuthRoute() });
    } catch (e2) { if (err) err.textContent = e2.message; }
    return false;
  }
  async function doVerify(e) {
    e.preventDefault();
    var err = document.getElementById('auth-error');
    try {
      await Auth.verifyEmail(document.getElementById('verify-email').value, document.getElementById('verify-otp').value);
      await Auth.refreshMe();
      renderHeader(); Router.navigate(consumePostAuthRoute());
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
  var POST_AUTH_ROUTE_KEY = 'anistrim.web.postAuthRoute';
  function safePostAuthRoute(requested) {
    requested = String(requested || '');
    // Hash routes only; reject external URLs and unknown top-level destinations.
    if (/^\/(?:watch|anime|browse|search|watchlist|history|profile|settings|upgrade)(?:\/|\?|$)/.test(requested)) return requested;
    return '';
  }
  function postAuthRoute() {
    var requested = safePostAuthRoute(Router.query().redirect);
    if (requested) {
      try { sessionStorage.setItem(POST_AUTH_ROUTE_KEY, requested); } catch (e) { /* ignore */ }
      return requested;
    }
    try { requested = safePostAuthRoute(sessionStorage.getItem(POST_AUTH_ROUTE_KEY)); } catch (e2) { requested = ''; }
    if (requested) return requested;
    return '/';
  }
  function consumePostAuthRoute() {
    var route = postAuthRoute();
    try { sessionStorage.removeItem(POST_AUTH_ROUTE_KEY); } catch (e) { /* ignore */ }
    return route;
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
      if (query.error) {
        throw new Error(String(query.error));
      } else if (query.token) {
        data = { token: query.token, refreshToken: query.refreshToken || '', user: null };
      } else if (query.code) {
        data = await API.request('/api/auth/google/token?code=' + encodeURIComponent(query.code));
      } else {
        throw new Error('Google sign-in did not return an authentication code.');
      }
      if (!data || !data.token) throw new Error('Google sign-in did not return a session.');
      // Persist the scoped session and user state before returning home.
      Auth.state.save(data);
      await Auth.refreshMe();
      renderHeader();
      Router.navigate(consumePostAuthRoute());
    } catch (e) {
      if (err) err.textContent = e.message || 'Google sign-in could not be completed.';
    }
  }

  async function gAuth(intent) {
    try {
      // OAuth leaves this page for Google, so retain a previously requested
      // guarded hash route until the callback returns to this Web client.
      sessionStorage.setItem(POST_AUTH_ROUTE_KEY, postAuthRoute());
      // Redirect to backend Google OAuth flow (documented endpoint).
      window.location.href = API.API_BASE + '/api/auth/google/start?intent=' + intent + '&client=web';
    } catch (err) { toast(err.message || 'Google sign-in failed.', 'error'); }
  }

  // ── Browse / Search ─────────────────────────────────────
  var browseRequest = 0;
  var browseTimer = null;
  var searchRequest = 0;
  var searchTimer = null;
  var browseState = { page: 1, items: [], hasNext: false };
  var STATUS_FILTERS = ['airing', 'completed', 'upcoming'];

  function retryButton(action, label) {
    return '<button class="btn-outline" onclick="AniStrimUI.' + action + '">' + (label || 'Try again') + '</button>';
  }
  function filterOptions() { return '<option value="">All genres</option>'; }
  function statusOptions() {
    return '<option value="">All statuses</option>' + STATUS_FILTERS.map(function (status) {
      return '<option value="' + status + '">' + esc(status.charAt(0).toUpperCase() + status.slice(1)) + '</option>';
    }).join('');
  }
  function fillGenreSelect(id, selected) {
    var select = document.getElementById(id);
    if (!select) return Promise.resolve();
    return API.genres().then(function (genres) {
      var current = selected || select.value || '';
      select.innerHTML = filterOptions() + norm(genres).map(function (genre) {
        return '<option value="' + esc(genre) + '">' + esc(genre) + '</option>';
      }).join('');
      select.value = current;
    }).catch(function () {});
  }
  function browseView() {
    renderHeader();
    return '<div class="page"><div class="container"><div class="page-toolbar"><h1>Browse</h1><div class="toolbar-controls">' +
      '<select id="browse-sort" onchange="AniStrimUI.reloadBrowse()"><option value="trending">Trending</option><option value="popular">Popular</option><option value="latest">Latest</option></select>' +
      '<select id="browse-genre" onchange="AniStrimUI.reloadBrowse()">' + filterOptions() + '</select>' +
      '<select id="browse-status" onchange="AniStrimUI.reloadBrowse()">' + statusOptions() + '</select>' +
      '<input id="browse-q" placeholder="Search anime..." autocomplete="off" oninput="AniStrimUI.debounceBrowse()" onkeydown="if(event.key===\'Enter\')AniStrimUI.reloadBrowse()"></div></div>' +
      '<div id="browse-grid" class="grid-loading" style="padding:40px 0;text-align:center;color:var(--clr-text-muted)">Loading catalogue...</div>' +
      '<div id="browse-more" style="text-align:center;margin-top:var(--space-6)"></div></div></div>';
  }
  function afterBrowse() { fillGenreSelect('browse-genre'); reloadBrowse(false); }
  function debounceBrowse() { clearTimeout(browseTimer); browseTimer = setTimeout(function () { reloadBrowse(false); }, 350); }
  async function reloadBrowse(loadMore) {
    clearTimeout(browseTimer);
    var el = document.getElementById('browse-grid');
    var more = document.getElementById('browse-more');
    if (!el) return;
    var sort = document.getElementById('browse-sort') ? document.getElementById('browse-sort').value : 'trending';
    var q = document.getElementById('browse-q') ? document.getElementById('browse-q').value.trim() : '';
    var genre = document.getElementById('browse-genre') ? document.getElementById('browse-genre').value : '';
    var status = document.getElementById('browse-status') ? document.getElementById('browse-status').value : '';
    var filtered = Boolean(q || genre || status);
    var page = loadMore && !filtered && sort !== 'latest' ? browseState.page + 1 : 1;
    var requestId = ++browseRequest;
    if (!loadMore) el.innerHTML = '<div class="grid-loading">Loading catalogue...</div>';
    if (more) more.innerHTML = loadMore ? '<div class="grid-loading">Loading more...</div>' : '';
    try {
      var list, meta = {};
      if (filtered) list = norm(await API.search(q, { genre: genre, status: status }));
      else if (sort === 'latest') list = norm(await API.latest(50));
      else {
        var pageResult = sort === 'popular' ? await API.popular(page, 10) : await API.trending(page, 10);
        list = norm(pageResult && pageResult.data);
        meta = (pageResult && pageResult.meta && pageResult.meta.pagination) || {};
      }
      if (requestId !== browseRequest || !document.getElementById('browse-grid')) return;
      browseState = { page: page, items: loadMore ? browseState.items.concat(list) : list, hasNext: Boolean(meta.hasNext) };
      el.innerHTML = browseState.items.length ? grid(browseState.items) : '<div class="empty">No anime matched those filters.</div>';
      if (more) more.innerHTML = browseState.hasNext && !filtered ? '<div style="padding:var(--space-6) 0;text-align:center">' + retryButton('loadMoreBrowse()', 'Load more') + '</div>' : '';
    } catch (e) {
      if (requestId !== browseRequest) return;
      el.innerHTML = '<div class="empty">Could not load the catalogue. ' + retryButton('reloadBrowse()', 'Try again') + '<p>' + esc(e.message) + '</p></div>';
      if (more) more.innerHTML = '';
    }
  }
  function loadMoreBrowse() { return reloadBrowse(true); }
  function searchView() {
    renderHeader();
    return '<div class="page"><div class="container"><div class="page-toolbar"><h1>Search</h1><div class="toolbar-controls">' +
      '<input id="search-input" placeholder="Search anime..." autocomplete="off" oninput="AniStrimUI.debounceSearch()" onkeydown="if(event.key===\'Enter\')AniStrimUI.doSearch()">' +
      '<select id="search-genre" onchange="AniStrimUI.doSearch()">' + filterOptions() + '</select><select id="search-status" onchange="AniStrimUI.doSearch()">' + statusOptions() + '</select><button class="btn-primary" onclick="AniStrimUI.doSearch()">Search</button></div></div>' +
      '<div id="search-results" class="empty">Enter a search term to find anime.</div></div></div>';
  }
  function afterSearch(root, params, query) {
    var q = query && query.q;
    var input = document.getElementById('search-input');
    var status = document.getElementById('search-status');
    var genresReady = fillGenreSelect('search-genre', query && query.genre);
    if (input && q) input.value = q;
    if (status && query && query.status) status.value = query.status;
    if (q || (query && (query.genre || query.status))) genresReady.then(doSearch);
  }
  function debounceSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 350); }
  async function doSearch() {
    clearTimeout(searchTimer);
    var input = document.getElementById('search-input');
    var q = input ? input.value.trim() : '';
    var genre = document.getElementById('search-genre') ? document.getElementById('search-genre').value : '';
    var status = document.getElementById('search-status') ? document.getElementById('search-status').value : '';
    var el = document.getElementById('search-results');
    if (!el) return;
    if (!q && !genre && !status) { el.innerHTML = '<div class="empty">Enter a search term or choose a filter.</div>'; return; }
    var requestId = ++searchRequest;
    el.innerHTML = '<div class="grid-loading">Searching...</div>';
    try {
      var list = norm(await API.search(q, { genre: genre, status: status }));
      if (requestId !== searchRequest || !document.getElementById('search-results')) return;
      el.innerHTML = list.length ? grid(list) : '<div class="empty">No anime matched your search.</div>';
    } catch (e) {
      if (requestId !== searchRequest) return;
      el.innerHTML = '<div class="empty">Search failed. ' + retryButton('doSearch()', 'Try again') + '<p>' + esc(e.message) + '</p></div>';
    }
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
      // Current servers embed access-masked episodes in the detail response.
      // Only ask the legacy endpoint when an older server omits that field.
      var eps = Array.isArray(anime && anime.episodes) ? anime.episodes : norm(await API.episodes(id));
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
        '<button class="btn-outline" data-watchlist-id="' + esc(id) + '" onclick="AniStrimUI.toggleWatchlist(\'' + esc(id) + '\')">My List</button></div></div></div></div>' +
        '<div class="container"><div class="episodes-section"><h2>Episodes</h2><div class="episode-grid">' +
        eps.map(function (ep, i) {
          var num = ep && (ep.number || ep.episode_number);
          return '<button class="episode-item" onclick="AniStrimUI.watch(\'' + esc(id) + '\',' + (num || i + 1) + ',\'' + esc(ep.id) + '\')">' +
            '<span class="ep-num">' + (num || i + 1) + '</span><span class="ep-title">' + esc(ep.title || ('Episode ' + (num || i + 1))) + '</span>' +
            (ep.locked ? '<span class="ep-lock">🔒</span>' : '') + '</button>';
        }).join('') + '</div></div>' +
        (recs.length ? '<div class="recommend-section">' + section('Recommended') + grid(recs) + '</div>' : '') + '</div>';
      if (Auth.state.isLoggedIn) {
        refreshWatchlistState().then(syncWatchlistButtons).catch(function () {});
      }
    } catch (e) { root.innerHTML = '<div class="empty">Could not load this anime. ' + retryButton('loadAnime(\'' + esc(id) + '\')', 'Try again') + '<p>' + esc(e.message) + '</p></div>'; }
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
  function episodeSeason(ep) { return Number(ep && ep.season) || 1; }
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
      var list = await refreshWatchlistState();
      el.innerHTML = list.length ? '<div class="anime-grid">' + list.map(function (w) {
        var animeId = w.animeId || (w.anime && w.anime.id) || w.id;
        var anime = w.anime || { animeId: animeId, title: w.title, poster: w.poster };
        return '<div class="watchlist-entry">' + card(anime) + '<button class="btn-ghost" onclick="AniStrimUI.removeWatchlist(\'' + esc(animeId) + '\')">Remove</button></div>';
      }).join('') + '</div>' : '<div class="empty">Your watchlist is empty.</div>';
    } catch (e) { el.innerHTML = '<div class="empty">Could not load your watchlist. ' + retryButton('loadWatchlist()', 'Try again') + '<p>' + esc(e.message) + '</p></div>'; }
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
      el.innerHTML = list.length ? '<div class="history-list">' + list.map(function (h) {
        var title = h.animeTitle || h.title || 'Anime';
        var episode = h.episodeNumber || 1;
        var percent = Math.max(0, Math.min(100, Number(h.percent) || 0));
        return '<div class="history-entry"><div><strong>' + esc(title) + '</strong><div class="muted">Episode ' + esc(episode) + (h.episodeTitle ? ': ' + esc(h.episodeTitle) : '') + ' · ' + Math.round(percent) + '% watched</div></div>' +
          '<button class="btn-outline" onclick="AniStrimUI.resumeHistory(\'' + esc(h.animeId) + '\',' + Number(episode) + ',\'' + esc(h.episodeId) + '\')">' + (h.completed ? 'Watch again' : 'Resume') + '</button></div>';
      }).join('') + '</div>' : '<div class="empty">No watch history.</div>';
    } catch (e) { el.innerHTML = '<div class="empty">Could not load watch history. ' + retryButton('loadHistory()', 'Try again') + '<p>' + esc(e.message) + '</p></div>'; }
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
      '<h2 id="profile-display-name">' + esc(user && (user.displayName || user.name)) + '</h2><p class="muted" id="profile-email">' + esc(user && user.email) + '</p>' +
      '<div class="profile-meta">' + (Auth.state.isPremium ? '<span class="badge-premium">👑 Premium</span>' : '<a href="#/upgrade" class="btn-outline">Upgrade</a>') + '</div>' +
      '<button class="btn-ghost btn-block" onclick="AniStrimUI.uploadAvatar()">Change Avatar</button>' +
      '<input type="file" id="avatar-input" accept="image/*" style="display:none" onchange="AniStrimUI.doAvatarUpload(event)">' +
      '<button class="btn-outline btn-block" onclick="AniStrimUI.logout()">Logout</button></div>' +
      '<div class="profile-settings"><div class="settings-card"><h3>Preferences</h3>' +
      '<label class="checkbox"><input type="checkbox" id="pref-auto-skip"> Auto-skip intros</label>' +
      '<label class="checkbox"><input type="checkbox" id="pref-auto-play"> Auto-play next</label>' +
      '<label>Autoplay delay <select id="pref-auto-countdown"><option value="0">Start immediately</option><option value="5">5 seconds</option><option value="10">10 seconds</option><option value="15">15 seconds</option><option value="30">30 seconds</option></select></label>' +
      '<label>Default quality <select id="pref-quality"><option value="auto">Auto</option><option value="360">360p</option><option value="480">480p</option><option value="720">720p</option><option value="1080">1080p</option></select></label>' +
      '<label>Subtitles <select id="pref-subtitles"><option value="on">On</option><option value="off">Off</option></select></label>' +
      '<label>Subtitle language <select id="pref-subtitle-lang"><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="pt">Portuguese</option><option value="ja">Japanese</option><option value="ar">Arabic</option><option value="none">None</option></select></label>' +
      '<label>Playback speed <select id="pref-playback-rate"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">Normal</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>' +
      '<label class="checkbox"><input type="checkbox" id="pref-reduce-motion"> Reduce motion</label>' +
      '<label>Username<input id="pref-username" placeholder="Set username"></label>' +
      '<button class="btn-primary" onclick="AniStrimUI.saveProfile()">Save</button></div></div></div></div></div>';
  }
  async function afterProfile() {
    await Auth.refreshMe();
    var user = Auth.state.user;
    var av = document.getElementById('profile-avatar');
    if (av) av.src = (user && (user.avatarUrl || user.avatar || user.avatar_url)) || fallback(user && (user.name || 'A'));
    var displayName = document.getElementById('profile-display-name');
    if (displayName) displayName.textContent = (user && (user.displayName || user.name || user.username)) || 'Profile';
    var email = document.getElementById('profile-email');
    if (email) email.textContent = (user && user.email) || '';
    var u = document.getElementById('pref-username');
    if (u && user && user.username) u.value = user.username;
    var preferencesRequest = user && user.preferences
      ? Promise.resolve({ preferences: user.preferences })
      : API.profilePreferences();
    preferencesRequest.then(function (data) {
      var prefs = data && (data.preferences || data);
      var skip = document.getElementById('pref-auto-skip');
      var autoplay = document.getElementById('pref-auto-play');
      if (skip) skip.checked = !!(prefs && prefs.skipIntroAuto);
      if (autoplay) autoplay.checked = !!(prefs && prefs.autoplayNext);
      var countdown = document.getElementById('pref-auto-countdown');
      var quality = document.getElementById('pref-quality');
      var subtitles = document.getElementById('pref-subtitles');
      var language = document.getElementById('pref-subtitle-lang');
      var rate = document.getElementById('pref-playback-rate');
      var motion = document.getElementById('pref-reduce-motion');
      if (countdown) countdown.value = String((prefs && prefs.autoplayCountdown) || 10);
      if (quality) quality.value = (prefs && prefs.defaultQuality) || 'auto';
      if (subtitles) subtitles.value = prefs && prefs.subtitlesOn === false ? 'off' : 'on';
      if (language) language.value = (prefs && prefs.subtitleLang) || 'en';
      if (rate) rate.value = String((prefs && prefs.playbackRate) || 1);
      if (motion) motion.checked = !!(prefs && prefs.reduceMotion);
    }).catch(function () { /* preferences are non-critical on the profile page */ });
  }
  async function saveProfile() {
    try {
      var u = document.getElementById('pref-username') ? document.getElementById('pref-username').value : '';
      var skip = document.getElementById('pref-auto-skip') ? document.getElementById('pref-auto-skip').checked : false;
      var play = document.getElementById('pref-auto-play') ? document.getElementById('pref-auto-play').checked : false;
      var countdown = Number(document.getElementById('pref-auto-countdown').value);
      var quality = document.getElementById('pref-quality').value;
      var subtitles = document.getElementById('pref-subtitles').value === 'on';
      var language = document.getElementById('pref-subtitle-lang').value;
      var rate = Number(document.getElementById('pref-playback-rate').value);
      var motion = document.getElementById('pref-reduce-motion').checked;
      if (u) await API.profileSetUsername(u);
      await API.profileUpdatePreferences({ skipIntroAuto: skip, autoplayNext: play, autoplayCountdown: countdown, defaultQuality: quality, subtitlesOn: subtitles, subtitleLang: language, playbackRate: rate, reduceMotion: motion });
      await Auth.refreshMe();
      renderHeader();
      toast('Saved');
    } catch (e) { toast(e.message, 'error'); }
  }
  function uploadAvatar() { var i = document.getElementById('avatar-input'); if (i) i.click(); }
  async function doAvatarUpload(e) {
    var file = e.target && e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Image too large. Max 5 MB.', 'error'); return; }
    if (!String(file.type || '').startsWith('image/')) { toast('Choose an image file.', 'error'); return; }
    try {
      await API.uploadAvatar(file);
      await Auth.refreshMe();
      var avatar = document.getElementById('profile-avatar');
      var user = Auth.state.user;
      if (avatar && user && user.avatarUrl) avatar.src = user.avatarUrl + (user.avatarUrl.indexOf('?') === -1 ? '?v=' : '&v=') + Date.now();
      renderHeader(); toast('Avatar updated');
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
      var paymentLink = data && (data.paymentLink || data.payment_link);
      var reference = data && (data.txRef || data.tx_ref);
      if (paymentLink && reference) {
        // The reference is not proof of payment; it only lets the callback
        // verify the server-side subscription record after the provider return.
        try { sessionStorage.setItem('anistrim.web.pendingPaymentReference', reference); } catch (e) { /* ignore */ }
        window.location.href = paymentLink;
        return;
      }
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
    if (!reference) {
      try { reference = sessionStorage.getItem('anistrim.web.pendingPaymentReference'); } catch (e) { /* ignore */ }
    }
    if (!reference) { if (status) status.textContent = 'Missing payment reference. Please contact support if you were charged.'; return; }
    var attempts = 0;
    var maxAttempts = 40;
    async function checkPayment() {
      if (Router.currentPath() !== '/payment-return') return;
      attempts += 1;
      try {
        var result = await API.verifySubscription(reference);
        var paymentStatus = String(result && result.status || '').toUpperCase();
        var paymentState = String(result && result.state || '').toLowerCase();
        if (paymentStatus === 'COMPLETED' && paymentState === 'active') {
          await Auth.refreshMe();
          renderHeader();
          try { sessionStorage.removeItem('anistrim.web.pendingPaymentReference'); } catch (e) { /* ignore */ }
          if (status) status.textContent = 'Payment confirmed. Premium access is now active.';
          return;
        }
        if (paymentStatus === 'FAILED' || paymentStatus === 'CANCELLED' || paymentStatus === 'REFUNDED' || paymentState === 'expired' || paymentState === 'cancelled' || paymentState === 'refunded') {
          if (status) status.textContent = (result && result.message) || 'Payment was not completed. You have not been charged.';
          return;
        }
        if (attempts < maxAttempts) {
          if (status) status.textContent = 'Payment is being confirmed. Checking again shortly…';
          setTimeout(checkPayment, 3000);
        } else if (status) {
          status.textContent = 'Payment is still being confirmed. Refresh this page in a few minutes to check again.';
        }
      } catch (e) {
        if (attempts < maxAttempts) setTimeout(checkPayment, 3000);
        else if (status) status.textContent = e.message || 'Could not verify this payment yet.';
      }
    }
    checkPayment();
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
      var key = String(id);
      if (watchlistRequests[key]) return;
      watchlistRequests[key] = true;
      try {
        var result = await API.toggleWatchlist(id);
        if (result && result.inList === true) watchlistIds.add(key);
        else if (result && result.inList === false) watchlistIds.delete(key);
        else await refreshWatchlistState();
        watchlistLoaded = true;
        syncWatchlistButtons();
        toast(result && result.inList === false ? 'Removed from My List.' : 'Added to My List.');
        if (Router.currentPath() === '/watchlist') loadWatchlist();
      } catch (e) { toast(e.message, 'error'); }
      finally { delete watchlistRequests[key]; }
    },
    removeWatchlist: async function (id) {
      var key = String(id);
      if (watchlistRequests[key]) return;
      watchlistRequests[key] = true;
      try {
        await API.removeWatchlist(id);
        watchlistIds.delete(key); watchlistLoaded = true;
        syncWatchlistButtons();
        toast('Removed from My List.');
        loadWatchlist();
      } catch (e) { toast(e.message, 'error'); }
      finally { delete watchlistRequests[key]; }
    },
    resumeHistory: function (animeId, episodeNumber, episodeId) {
      if (!animeId || !episodeId) { toast('This history entry cannot be resumed.', 'error'); return; }
      AniStrimUI.watch(animeId, episodeNumber || 1, episodeId);
    },
    logout: async function () { await Auth.logout(); renderHeader(); Router.navigate('/'); },
    doLogin: doLogin, doSignup: doSignup, doVerify: doVerify, resendOtp: resendOtp, doForgotPassword: doForgotPassword, doResetPassword: doResetPassword,
    doGoogleLogin: function () { gAuth('login'); }, doGoogleSignup: function () { gAuth('signup'); },
    loadHome: loadHome,
    reloadBrowse: reloadBrowse, loadMoreBrowse: loadMoreBrowse, debounceBrowse: debounceBrowse,
    doSearch: doSearch, debounceSearch: debounceSearch,
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
    browse: browseView, afterBrowse: afterBrowse, search: searchView, afterSearch: afterSearch,
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
