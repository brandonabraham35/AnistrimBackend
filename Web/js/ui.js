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
    return '<a class="anime-card" href="/anime/' + encodeURIComponent(id) + '" onclick="return AniStrimUI.goCard(event,' + id + ')">' +
      '<div class="anime-card-img"><img src="' + (img || fallback(title)) + '" alt="' + esc(title) + '" loading="lazy" ' +
      'onerror="this.src=AniStrimUI.fallback(\'' + esc(title) + '\')">' +
      (type ? '<span class="anime-card-badge">' + esc(type) + '</span>' : '') +
      (a && a.rating ? '<span class="anime-card-rating">&#9733; ' + esc(a.rating) + '</span>' : '') +
      '</div><div class="anime-card-body"><div class="anime-card-title">' + esc(title) + '</div>' +
      '<div class="anime-card-sub">' +
      (type ? '<span>' + esc(type) + '</span>' : '') +
      (type && a && a.year ? '<span class="sep">·</span>' : '') +
      (a && a.year ? '<span>' + esc(a.year) + '</span>' : '') +
      ((type || (a && a.year)) && eps ? '<span class="sep">·</span>' : '') +
      (eps ? '<span>' + esc(eps) + ' ep</span>' : '') +
      '</div></div></a>';
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
  function navActive(path) {
    var current = Router.currentPath();
    if (path === '/') return current === '/' ? ' class="active"' : '';
    return current.indexOf(path) === 0 ? ' class="active"' : '';
  }
  function renderHeader() {
    var h = document.getElementById('site-header');
    var user = Auth.state.user;
    var logged = Auth.state.isLoggedIn;
    var name = user && (user.displayName || user.username || user.email || '');
    var initial = name ? name.charAt(0).toUpperCase() : '?';
    var avatar = (user && user.avatar) || '';
    h.innerHTML =
      '<nav class="nav"><div class="nav-inner">' +
      '<button class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Toggle navigation" aria-expanded="false" onclick="AniStrimUI.toggleMobileNav()"><span class="bar"></span><span class="bar"></span><span class="bar"></span></button>' +
      '<a class="brand" href="#/">AniStrim</a>' +
      '<div class="nav-links"><a' + navActive('/') + ' href="#/">Home</a><a' + navActive('/search') + ' href="#/search">Search</a>' +
      (logged ? '<a' + navActive('/watchlist') + ' href="#/watchlist">Watchlist</a><a' + navActive('/history') + ' href="#/history">History</a><a' + navActive('/upgrade') + ' href="#/upgrade">Upgrade</a>' : '') + '</div>' +
      '<div class="nav-search"><input type="text" placeholder="Search anime\u2026" id="nav-search-input" autocomplete="off"><div id="nav-search-autocomplete" class="search-autocomplete" aria-label="Search suggestions" role="listbox"></div></div>' +
      '<div class="nav-auth">' +
      (logged
        ? '<a href="#/profile" class="nav-avatar" aria-label="Profile">' +
          (avatar ? '<img src="' + esc(avatar) + '" alt="">' : esc(initial)) +
          '</a>'
        : '<a href="#/login" class="btn-outline btn-sm">Sign In</a><a href="#/signup" class="btn-primary btn-sm">Get Started</a>') +
      '</div></div></nav>' +
      // Mobile navigation backdrop and panel rendered as siblings of <nav>,
      // not children — otherwise backdrop-filter on .nav makes it the
      // containing block for position:fixed, collapsing the panel to 0 height.
      '<div class="mobile-nav-backdrop" id="mobile-nav-backdrop" onclick="AniStrimUI.closeMobileNav()"></div>' +
      '<div class="mobile-nav" id="mobile-nav" role="dialog" aria-label="Navigation menu">' +
      '<div class="mobile-nav-header"><button class="mobile-nav-close" onclick="AniStrimUI.closeMobileNav()" aria-label="Close menu">\u2715</button></div>' +
      (logged && user ? '<div class="nav-user">' +
        '<div class="nav-avatar">' + (avatar ? '<img src="' + esc(avatar) + '" alt="">' : esc(initial)) + '</div>' +
        '<div><div style="font-weight:600">' + esc(name) + '</div>' +
        (user.email ? '<div style="font-size:.85rem;color:var(--clr-text-muted)">' + esc(user.email) + '</div>' : '') +
        '</div></div>' : '') +
      '<a href="#/"' + navActive('/') + ' onclick="AniStrimUI.closeMobileNav()">Home</a><a href="#/search"' + navActive('/search') + ' onclick="AniStrimUI.closeMobileNav()">Search</a>' +
      (logged ? '<a href="#/watchlist"' + navActive('/watchlist') + ' onclick="AniStrimUI.closeMobileNav()">Watchlist</a><a href="#/history"' + navActive('/history') + ' onclick="AniStrimUI.closeMobileNav()">History</a>' : '') +
      '<a href="#/upgrade"' + navActive('/upgrade') + ' onclick="AniStrimUI.closeMobileNav()">Upgrade</a>' +
      (logged
        ? '<a href="#/profile"' + navActive('/profile') + ' onclick="AniStrimUI.closeMobileNav()">Profile</a><a href="javascript:void(0)" onclick="AniStrimUI.logout();AniStrimUI.closeMobileNav();return false">Logout</a>'
        : '<a href="#/login"' + navActive('/login') + ' onclick="AniStrimUI.closeMobileNav()">Sign In</a><a href="#/signup"' + navActive('/signup') + ' onclick="AniStrimUI.closeMobileNav()">Sign Up</a>') +
      '</div>';
    var f = document.getElementById('site-footer');
    f.innerHTML = '<div class="footer-inner"><span>\u00a9 ' + new Date().getFullYear() + ' AniStrim</span>' +
            '<div class="footer-links"><a href="#/search">Search</a>' +
      (Auth.state.isPremium ? '<a href="#/profile">Account</a>' : '<a href="#/upgrade">Upgrade</a>') + '</div></div>';
    acInit();
  }
  function toggleMobileNav() {
    var el = document.getElementById('mobile-nav');
    var bd = document.getElementById('mobile-nav-backdrop');
    var btn = document.getElementById('mobile-menu-btn');
    var isOpen = el && el.classList.contains('open');
    if (isOpen) {
      closeMobileNav();
    } else {
      if (el) el.classList.add('open');
      if (bd) bd.classList.add('open');
      if (btn) btn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden'; // prevent background scroll
      document.addEventListener('keydown', mobileNavEscHandler);
      // Focus the first link inside the nav for accessibility
      if (el) {
        var firstLink = el.querySelector('a');
        if (firstLink) firstLink.focus();
      }
    }
  }
  function mobileNavEscHandler(e) {
    if (e.key === 'Escape') closeMobileNav();
  }
  function closeMobileNav() {
    var el = document.getElementById('mobile-nav');
    var bd = document.getElementById('mobile-nav-backdrop');
    var btn = document.getElementById('mobile-menu-btn');
    if (el) el.classList.remove('open');
    if (bd) bd.classList.remove('open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', mobileNavEscHandler);
    // Restore focus to the hamburger button
    if (btn) btn.focus();
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
        '<div class="slide-inner"' + (bg ? ' style="background-image:url(' + bg + ')"' : '') + '>' +
        '<div class="slide-content">' +
        (type ? '<span class="slide-badge">' + esc(type) + '</span>' : '') +
        '<div class="slide-meta">' +
        (a.genres && a.genres.length ? '<span>' + esc(Array.isArray(a.genres) ? a.genres.slice(0, 2).join(', ') : a.genres) + '</span><span class="meta-dot">·</span>' : '') +
        (a.year ? '<span>' + esc(a.year) + '</span>' : '') +
        (a.rating ? '<span class="meta-dot">·</span><span>★ ' + esc(a.rating) + '</span>' : '') +
        '</div>' +
        '<h2>' + esc(a.title) + '</h2>' +
        (a.description ? '<p>' + esc(a.description.substring(0, 180)) + '</p>' : '') +
        '<div class="slide-actions">' +
        '<a href="#/anime/' + a.id + '" class="btn-primary">▶ Watch Now</a>' +
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
          if (!el) return;
        if (!rows.length) {
          el.innerHTML = '<div class="section-header"><h2>Continue Watching</h2></div><div class="empty" style="padding:var(--space-8) 0;color:var(--clr-text-muted);font-size:var(--font-size-sm)">No watch history yet. Start watching to see your progress here.</div>';
          return;
        }
        var h = '<div class="section-header"><h2>Continue Watching</h2></div><div class="cw-strip">';
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var pct = (r.progressSeconds && r.durationSec && r.durationSec > 0) ? Math.min(100, Math.round(r.progressSeconds / r.durationSec * 100)) : 0;
          var img = r.poster || r.thumbnailUrl || r.coverImage || (r.anime && r.anime.cover_image) || '';
          var anId = r.animeId || (r.anime && r.anime.id) || '';
          var epNum = r.episodeNumber || 1;
          var epId = r.episodeId || '';
          h += '<div class="cw-card" onclick="AniStrimUI.watch(' + anId + ',' + epNum + ',\'' + esc(epId) + '\')">' +
            '<div class="cw-card-img"><img src="' + (img || fallback(r.title)) + '" alt="' + esc(r.title || (r.anime && r.anime.title) || 'Continue watching') + '" loading="lazy" onerror="this.style.background=\'var(--clr-card2)\'">' +
            '<div class="cw-progress"><div style="width:' + pct + '%"></div></div>' +
            '<span class="cw-ep">EP ' + epNum + '</span></div>' +
            '<div class="cw-card-title">' + esc(r.title || (r.anime && r.anime.title) || '') + '</div>' +
            (pct ? '<div class="cw-card-pct">' + pct + '%</div>' : '') + '</div>';
        }
        h += '</div>';
        el.innerHTML = h;
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
      '</div><div class="rank-list" id="rank-list"></div></div>' +
      (!Auth.state.isPremium ? '<div class="premium-cta-card"><div class="premium-cta-icon">👑</div><h4>Go Premium</h4><p>Unlock HD streaming, ad-free viewing, and more.</p><a href="#/upgrade" class="btn-primary btn-block" style="margin-top:var(--space-3);font-size:var(--font-size-sm);padding:8px 16px">Upgrade Now</a></div>' : '');
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
      h += '<a class="rank-item" href="/anime/' + encodeURIComponent(a.id || a.animeId) + '">' +
        '<span class="rank-num' + topClass + '">' + (i + 1) + '</span>' +
        '<div class="rank-thumb"><img src="' + (img || fallback(a.title)) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'"></div>' +
        '<div class="rank-info"><div class="rank-title">' + esc(a.title || '') + '</div>' +
        '<div class="rank-meta">' + (type || 'Anime') + (eps ? ' &middot; ' + eps + ' EP' : '') + '</div></div></a>';
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
  // ── Auth pages ──────────────────────────────────────────
  function authShell(title, subtitle) {
    return '<div class="page auth-page"><div class="auth-card">' +
      '<div class="auth-brand"><img src="assets/logo2.png" alt="AniStrim" class="auth-logo-img"><h1>' + title + '</h1>' +
      (subtitle ? '<p class="auth-subtitle">' + subtitle + '</p>' : '') +
      '</div>' +
      '<div id="auth-error" class="form-error" role="alert"></div>';
  }

  function loginView() {
    renderHeader();
    postAuthRoute();
    return authShell('Welcome back', 'Sign in to continue watching anime on AniStrim') +
      '<form id="login-form" onsubmit="return AniStrimUI.doLogin(event)">' +
      '<div class="auth-field"><label for="login-email">Email</label>' +
      '<input type="email" id="login-email" required autocomplete="email" placeholder="you@example.com"></div>' +
      '<div class="auth-field"><label for="login-password">Password</label>' +
      '<div class="auth-password-wrap">' +
      '<input type="password" id="login-password" required autocomplete="current-password" placeholder="Enter your password">' +
      '<button type="button" class="auth-pw-toggle" onclick="AniStrimUI.togglePassword(\'login-password\',this)" aria-label="Show password" tabindex="-1">&#128065;</button>' +
      '</div></div>' +
      '<div class="auth-forgot"><a href="#/forgot-password">Forgot password?</a></div>' +
      '<button class="btn-primary btn-block btn-auth-submit" type="submit">Sign In</button></form>' +
      '<div class="auth-divider"><span>or continue with</span></div>' +
      '<button class="btn-google btn-block" onclick="AniStrimUI.doGoogleLogin()">' +
      '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>' +
      'Google</button>' +
      '<p class="auth-switch">Don\'t have an account? <a href="#/signup">Create one</a></p></div></div>';
  }

  function signupView() {
    renderHeader();
    postAuthRoute();
    var html = authShell('Create your account', 'Join AniStrim to discover and watch thousands of anime') +
      '<form id="signup-form" onsubmit="return AniStrimUI.doSignup(event)">' +
      '<div class="auth-field"><label for="signup-name">Name</label>' +
      '<input type="text" id="signup-name" required autocomplete="name" placeholder="Your name"></div>' +
      '<div class="auth-field"><label for="signup-email">Email</label>' +
      '<input type="email" id="signup-email" required autocomplete="email" placeholder="you@example.com"></div>' +
      '<div class="auth-field"><label for="signup-password">Password</label>' +
      '<div class="auth-password-wrap">' +
      '<input type="password" id="signup-password" required minlength="6" autocomplete="new-password" placeholder="Create a password" oninput="AniStrimUI.updatePasswordStrength(this.value)">' +
      '<button type="button" class="auth-pw-toggle" onclick="AniStrimUI.togglePassword(\'signup-password\',this)" aria-label="Show password" tabindex="-1">&#128065;</button>' +
      '</div>' +
      '<div class="auth-password-requirements" id="signup-password-requirements">' +
      '<span class="req-item">\u25cb At least 6 characters</span>' +
      '</div></div>' +
      '<div class="auth-field"><label for="signup-confirm">Confirm Password</label>' +
      '<div class="auth-password-wrap">' +
      '<input type="password" id="signup-confirm" required minlength="6" autocomplete="new-password" placeholder="Confirm your password">' +
      '<button type="button" class="auth-pw-toggle" onclick="AniStrimUI.togglePassword(\'signup-confirm\',this)" aria-label="Show password" tabindex="-1">&#128065;</button>' +
      '</div></div>' +
      '<button class="btn-primary btn-block btn-auth-submit" type="submit">Create Account</button></form>' +
      '<div class="auth-divider"><span>or sign up with</span></div>' +
      '<button class="btn-google btn-block" onclick="AniStrimUI.doGoogleSignup()">' +
      '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>' +
      'Google</button>' +
      '<p class="auth-switch">Already have an account? <a href="#/login">Sign in</a></p></div></div>';
    // Defer attaching listener so the DOM is ready
    setTimeout(attachSignupPasswordListener, 0);
    return html;
  }

  // Toggle password visibility
  function togglePassword(inputId, btn) {
    var input = document.getElementById(inputId);
    if (!input) return;
    var isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.textContent = isPassword ? '\U0001f441\u200d\U0001f5e8' : '\U0001f441';
    btn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
  }

  // Password strength indicator for signup
  function updatePasswordStrength(value) {
    var req = document.getElementById('signup-password-requirements');
    if (!req) return;
    var items = req.querySelectorAll('.req-item');
    items.forEach(function(item) {
      var check = item.dataset.minlen;
      if (check === 'true' || item.hasAttribute('data-minlen')) {
        var met = value.length >= 6;
        item.innerHTML = (met ? '\u2713' : '\u25cb') + item.textContent.replace(/^[\u2713\u25cb]\s*/, ' ').trim();
        item.style.color = met ? 'var(--clr-success)' : '';
      }
    });
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

  // Attach password strength listener after signup renders
  var _signupPasswordListenerAttached = false;
  function attachSignupPasswordListener() {
    if (_signupPasswordListenerAttached) return;
    var pw = document.getElementById('signup-password');
    if (!pw) return;
    pw.addEventListener('input', function () { updatePasswordStrength(pw.value); });
    _signupPasswordListenerAttached = true;
  }
  function forgotPasswordView() {
    renderHeader();
    return authShell('Reset your password', 'Enter your account email and we will send a reset link.') +
      '<form id="forgot-form" onsubmit="return AniStrimUI.doForgotPassword(event)">' +
      '<div class="auth-field"><label for="forgot-email">Email</label>' +
      '<input type="email" id="forgot-email" required autocomplete="email" placeholder="you@example.com"></div>' +
      '<button class="btn-primary btn-block btn-auth-submit" id="forgot-submit" type="submit">Send Reset Link</button></form>' +
      '<p class="auth-switch"><a href="#/login">Back to sign in</a></p></div></div>';
  }
  function resetPasswordView(params, query) {
    renderHeader();
    var token = (query && query.token) || '';
    if (!token) {
      return authShell('Reset Password', 'Your reset link is invalid or incomplete. Please request a new one.') +
        '<p class="auth-switch"><a href="#/forgot-password">Request a new reset link</a></p></div></div>';
    }
    return authShell('Reset Password', 'Choose a new password for your account.') +
      '<form id="reset-form" onsubmit="return AniStrimUI.doResetPassword(event)">' +
      '<div class="auth-field"><label for="reset-password">New Password</label>' +
      '<div class="auth-password-wrap">' +
      '<input type="password" id="reset-password" required minlength="6" autocomplete="new-password" placeholder="Create a new password">' +
      '<button type="button" class="auth-pw-toggle" onclick="AniStrimUI.togglePassword(\'reset-password\',this)" aria-label="Show password" tabindex="-1">&#128065;</button>' +
      '</div></div>' +
      '<div class="auth-field"><label for="reset-password-confirm">Confirm Password</label>' +
      '<div class="auth-password-wrap">' +
      '<input type="password" id="reset-password-confirm" required minlength="6" autocomplete="new-password" placeholder="Confirm your new password">' +
      '<button type="button" class="auth-pw-toggle" onclick="AniStrimUI.togglePassword(\'reset-password-confirm\',this)" aria-label="Show password" tabindex="-1">&#128065;</button>' +
      '</div></div>' +
      '<button class="btn-primary btn-block btn-auth-submit" id="reset-submit" type="submit">Reset Password</button></form></div></div>';
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
    var email = document.getElementById('login-email');
    var password = document.getElementById('login-password');
    var btn = document.querySelector('#login-form .btn-auth-submit');
    // Validate
    if (!email.value.trim()) { err.textContent = 'Please enter your email.'; err.style.display = 'block'; email.focus(); return false; }
    if (!password.value) { err.textContent = 'Please enter your password.'; err.style.display = 'block'; password.focus(); return false; }
    // Loading state
    err.style.display = 'none'; err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in\u2026'; }
    try {
      var data = await Auth.login(email.value, password.value);
      // Analytics: track login
      if (API.trackEvent) API.trackEvent('login');
      await Auth.refreshMe();
      renderHeader();
      if (data.user && data.user.emailVerified === false) {
        Router.navigate('/verify', { email: data.user.email || email.value, redirect: postAuthRoute() });
      } else Router.navigate(consumePostAuthRoute());
    } catch (e2) {
      if (err) {
        var msg = e2.message || '';
        if (msg.indexOf('401') !== -1 || msg.indexOf('credentials') !== -1 || msg.indexOf('incorrect') !== -1 || msg.indexOf('Invalid') !== -1) {
          err.textContent = 'Email or password is incorrect. Please try again.';
        } else if (msg.indexOf('network') !== -1 || msg.indexOf('fetch') !== -1 || msg.indexOf('connect') !== -1) {
          err.textContent = 'We couldn\'t connect to AniStrim. Please check your connection and try again.';
        } else {
          err.textContent = 'Something went wrong. Please try again.';
        }
        err.style.display = 'block';
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    }
    return false;
  }

  async function doSignup(e) {
    e.preventDefault();
    var err = document.getElementById('auth-error');
    var name = document.getElementById('signup-name');
    var email = document.getElementById('signup-email');
    var password = document.getElementById('signup-password');
    var confirm = document.getElementById('signup-confirm');
    var btn = document.querySelector('#signup-form .btn-auth-submit');
    // Validate
    if (!name.value.trim()) { err.textContent = 'Please enter your name.'; err.style.display = 'block'; name.focus(); return false; }
    if (!email.value.trim()) { err.textContent = 'Please enter your email.'; err.style.display = 'block'; email.focus(); return false; }
    if (!password.value) { err.textContent = 'Please choose a password.'; err.style.display = 'block'; password.focus(); return false; }
    if (password.value.length < 6) { err.textContent = 'Password must be at least 6 characters.'; err.style.display = 'block'; password.focus(); return false; }
    if (confirm && confirm.value !== password.value) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; confirm.focus(); return false; }
    // Loading state
    err.style.display = 'none'; err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Creating account\u2026'; }
    try {
      var data = await Auth.signup({
        name: name.value,
        email: email.value,
        password: password.value,
      });
      if (data && data.token) { await Auth.refreshMe(); renderHeader(); Router.navigate(consumePostAuthRoute()); }
      else Router.navigate('/verify', { email: email.value, redirect: postAuthRoute() });
    } catch (e2) {
      if (err) {
        var msg = e2.message || '';
        if (msg.indexOf('already') !== -1 || msg.indexOf('exists') !== -1 || msg.indexOf('duplicate') !== -1) {
          err.textContent = 'An account with this email already exists. Please sign in instead.';
        } else if (msg.indexOf('network') !== -1 || msg.indexOf('fetch') !== -1 || msg.indexOf('connect') !== -1) {
          err.textContent = 'We couldn\'t connect to AniStrim. Please check your connection and try again.';
        } else {
          err.textContent = 'Something went wrong. Please try again.';
        }
        err.style.display = 'block';
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
    }
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
    var email = document.getElementById('forgot-email');
    var btn = document.getElementById('forgot-submit');
    // Validate
    if (!email.value.trim()) { err.textContent = 'Please enter your email.'; err.style.display = 'block'; email.focus(); return false; }
    // Loading state
    err.style.display = 'none'; err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Sending\u2026'; }
    try {
      await API.forgotPassword(email.value);
      if (err) { err.textContent = 'If an account exists for that email, a reset link has been sent.'; err.style.display = 'block'; }
    } catch (e2) { if (err) { err.textContent = e2.message || 'Could not request a reset link.'; err.style.display = 'block'; } }
    if (btn) { btn.disabled = false; btn.textContent = 'Send Reset Link'; }
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
    var password = document.getElementById('reset-password');
    var confirm = document.getElementById('reset-password-confirm');
    var btn = document.getElementById('reset-submit');
    // Validate
    if (!password.value) { err.textContent = 'Please choose a new password.'; err.style.display = 'block'; password.focus(); return false; }
    if (password.value.length < 6) { err.textContent = 'Password must be at least 6 characters.'; err.style.display = 'block'; password.focus(); return false; }
    if (confirm.value !== password.value) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; confirm.focus(); return false; }
    // Loading state
    err.style.display = 'none'; err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Resetting\u2026'; }
    try {
      await API.request('/api/auth/reset-password', {
        method: 'POST',
        body: { token: token, newPassword: password.value },
      });
      toast('Password reset successfully. Please sign in.');
      Router.navigate('/login');
    } catch (e2) {
      if (err) {
        var msg = e2.message || '';
        if (msg.indexOf('expired') !== -1 || msg.indexOf('invalid') !== -1 || msg.indexOf('token') !== -1) {
          err.textContent = 'This reset link has expired or is invalid. Please request a new one.';
        } else {
          err.textContent = 'Could not reset password. Please try again.';
        }
        err.style.display = 'block';
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Reset Password'; }
    }
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
      var msg = (e && e.message) || 'Google sign-in could not be completed.';
      if (err) err.textContent = msg;
      toast(msg, 'error');
      // Do not leave stale OAuth state behind after a failed attempt: drop any
      // retained guarded post-auth route, then return the user to the login
      // screen (short delay so the inline error is visible before navigation).
      try { sessionStorage.removeItem(POST_AUTH_ROUTE_KEY); } catch (e2) { void e2; }
      setTimeout(function () { Router.navigate('/login'); }, 1400);
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
    return '<div class="page"><div class="container"><div class="browse-header">' +
      '<div class="browse-title-group"><span class="browse-label">CATALOGUE</span>' +
      '<h1>Browse</h1>' +
      '<span class="browse-count" id="browse-count"></span></div>' +
      '<div class="filter-bar"><div class="filter-controls">' +
      '<select id="browse-sort" onchange="AniStrimUI.reloadBrowse()"><option value="popular">Trending</option><option value="rating">Highest Rated</option><option value="latest">Recently Added</option><option value="az">A–Z</option><option value="za">Z–A</option></select>' +
      '<select id="browse-genre" onchange="AniStrimUI.reloadBrowse()">' + filterOptions() + '</select>' +
      '<select id="browse-status" onchange="AniStrimUI.reloadBrowse()">' + statusOptions() + '</select>' +
      '<div class="filter-search"><span class="search-icon">\U0001f50d</span><input id="browse-q" type="search" placeholder="Search anime..." autocomplete="off" oninput="AniStrimUI.debounceBrowse()" onkeydown="if(event.key===\'Enter\')AniStrimUI.reloadBrowse()"></div>' +
      '</div></div></div>' +
      '<div id="browse-grid" class="anime-grid"><div class="list-loading">Loading catalogue...</div></div>' +
      '<div id="browse-more" style="text-align:center;margin-top:var(--space-6)"></div></div></div>';
  }
  function afterBrowse(root, params, query) {
    // Populate all filter dropdowns in parallel
    Promise.all([
      fillGenreSelect('browse-genre', query && query.genre),
      fillSelectFromAPI('browse-year', API.years, query && query.year),
    ]).then(function () {
      // Restore filter values from URL query
      if (query) {
        if (query.q) { var qi = document.getElementById('browse-q'); if (qi) qi.value = query.q; }
        if (query.status) { var si = document.getElementById('browse-status'); if (si) si.value = query.status; }
        if (query.sort) { var soi = document.getElementById('browse-sort'); if (soi) soi.value = query.sort; }
      }
      reloadBrowse(false);
    });
  }

  // Helper: populate a select with values from an API endpoint
  function fillSelectFromAPI(selectId, apiMethod, selectedValue) {
    var select = document.getElementById(selectId);
    if (!select) return Promise.resolve();
    return apiMethod().then(function (items) {
      var current = selectedValue || select.value || '';
      var firstOption = select.querySelector('option');
      var firstLabel = firstOption ? firstOption.textContent : '';
      select.innerHTML = '<option value="">' + esc(firstLabel) + '</option>' +
        norm(items).map(function (item) {
          return '<option value="' + esc(item) + '">' + esc(item) + '</option>';
        }).join('');
      select.value = current;
    }).catch(function () {});
  }

  // Clear all browse filters and reload
  function clearBrowseFilters() {
    var qi = document.getElementById('browse-q'); if (qi) qi.value = '';
    var gi = document.getElementById('browse-genre'); if (gi) gi.value = '';
    var si = document.getElementById('browse-status'); if (si) si.value = '';
    var yi = document.getElementById('browse-year'); if (yi) yi.value = '';
    var soi = document.getElementById('browse-sort'); if (soi) soi.value = 'popular';
    Router.navigate('/browse');
  }

  function debounceBrowse() { clearTimeout(browseTimer); browseTimer = setTimeout(function () { reloadBrowse(false); }, 350); }

  async function reloadBrowse(loadMore) {
    clearTimeout(browseTimer);
    var el = document.getElementById('browse-grid');
    var more = document.getElementById('browse-more');
    var countEl = document.getElementById('browse-count');
    var clearBtn = document.getElementById('browse-clear');
    if (!el) return;

    var sort = document.getElementById('browse-sort') ? document.getElementById('browse-sort').value : 'popular';
    var q = document.getElementById('browse-q') ? document.getElementById('browse-q').value.trim() : '';
    var genre = document.getElementById('browse-genre') ? document.getElementById('browse-genre').value : '';
    var status = document.getElementById('browse-status') ? document.getElementById('browse-status').value : '';
    var year = document.getElementById('browse-year') ? document.getElementById('browse-year').value : '';

    // Check if any filter is active
    var filtered = Boolean(q || genre || status || year);

    // Update URL with current filter state
    var queryParams = [];
    if (q) queryParams.push('q=' + encodeURIComponent(q));
    if (genre) queryParams.push('genre=' + encodeURIComponent(genre));
    if (status) queryParams.push('status=' + encodeURIComponent(status));
    if (year) queryParams.push('year=' + encodeURIComponent(year));
    if (sort && sort !== 'popular') queryParams.push('sort=' + encodeURIComponent(sort));
    if (browseState.page > 1) queryParams.push('page=' + browseState.page);
    var qs = queryParams.length ? '?' + queryParams.join('&') : '';
    if (window.location.hash !== '#/browse' + qs) {
      history.replaceState(null, '', '#/browse' + qs);
    }

    // Show/hide clear filters button
    if (clearBtn) clearBtn.style.display = filtered ? 'inline-block' : 'none';

    var page = loadMore && browseState.hasNext ? browseState.page + 1 : 1;
    var requestId = ++browseRequest;
    if (!loadMore) el.innerHTML = '<div class="grid-loading">Loading catalogue...</div>';
    if (more) more.innerHTML = loadMore ? '<div class="grid-loading">Loading more...</div>' : '';

    try {
      // Use the unified search endpoint for all browse queries
      var filters = { genre: genre, status: status, year: year, sort: sort, page: page, perPage: 24 };
      var result = await API.search(q, filters);
      var list = norm(result && result.data ? result.data : result);
      var meta = (result && result.meta && result.meta.pagination) || {};
      var totalItems = meta.totalItems || list.length;

      if (requestId !== browseRequest || !document.getElementById('browse-grid')) return;

      browseState = {
        page: page,
        items: loadMore ? browseState.items.concat(list) : list,
        hasNext: meta.hasNext || (list.length === 24 && !filtered),
        totalItems: totalItems,
      };

      // Update count display
      if (countEl) {
        if (q || genre || status || year) {
          var descParts = [];
          if (q) descParts.push('matching "' + esc(q) + '"');
          if (genre) descParts.push('in ' + esc(genre));
          if (status) descParts.push('status: ' + esc(status));
          if (year) descParts.push('year ' + esc(year));
          countEl.textContent = totalItems + ' anime' + (descParts.length ? ' ' + descParts.join(', ') : '');
        } else {
          countEl.textContent = totalItems + ' anime';
        }
      }

      el.innerHTML = browseState.items.length
        ? grid(browseState.items)
        : '<div class="empty-state"><div class="empty-icon">\U0001f50d</div><h3>No anime found</h3><p>We couldn\'t find any anime matching your filters.</p><p style="margin-top:8px;color:var(--clr-text-muted);font-size:var(--font-size-sm)">Try adjusting your search or filters.</p></div>';

      // Pagination: show page numbers or load more
      if (more) {
        if (browseState.hasNext) {
          more.innerHTML = '<div style="padding:var(--space-4) 0;text-align:center">' + retryButton('loadMoreBrowse()', 'Load more') + '</div>';
        } else if (page > 1) {
          more.innerHTML = '<div style="padding:var(--space-4) 0;text-align:center;color:var(--clr-text-muted)">Showing all ' + browseState.items.length + ' results</div>';
        } else {
          more.innerHTML = '';
        }
      }
    } catch (e) {
      if (requestId !== browseRequest) return;
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">\u26A0\uFE0F</div><h3>Could not load catalogue</h3><p>' + esc(e.message) + '</p>' + retryButton('reloadBrowse()', 'Try again') + '</div>';
      if (more) more.innerHTML = '';
    }
  }
  function loadMoreBrowse() { return reloadBrowse(true); }
  function searchView() {
    renderHeader();
    return '<div class="page"><div class="container"><div class="search-hero">' +
      '<span class="search-label">Discover</span>' +
      '<h1>Search</h1>' +
      '<p class="search-subtitle">Find your next favorite anime</p>' +
      '<div class="search-bar-main"><div class="search-input-wrap"><input id="search-input" type="text" placeholder="Search anime..." autocomplete="off" oninput="AniStrimUI.debounceSearch()" onkeydown="if(event.key===\'Enter\')AniStrimUI.doSearch()">' +
      '<button class="btn-primary search-btn" onclick="AniStrimUI.doSearch()">Search</button></div></div>' +
      '<div class="search-filters"><select id="search-genre" onchange="AniStrimUI.doSearch()">' + filterOptions() + '</select>' +
      '<select id="search-status" onchange="AniStrimUI.doSearch()">' + statusOptions() + '</select></div></div>' +
      '<div id="search-results" class="search-results"><div class="search-empty"><div class="empty-icon">\U0001f50d</div><h3>Search for anime</h3><p>Type a title, pick a genre, or select a status to start exploring.</p></div></div></div></div>';
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
    if (!q && !genre && !status) { el.innerHTML = '<div class="search-empty"><div class="empty-icon">\U0001f50d</div><h3>Enter a search term</h3><p>Type a title or choose a filter.</p></div>'; return; }
    // Analytics: track search
    if (API.trackEvent) API.trackEvent('search', { query: q, genre: genre, status: status });
    var requestId = ++searchRequest;
    el.innerHTML = '<div class="search-loading">Searching...</div>';
    try {
      var list = norm(await API.search(q, { genre: genre, status: status }));
      if (requestId !== searchRequest || !document.getElementById('search-results')) return;
      el.innerHTML = list.length ? grid(list) : '<div class="search-empty"><div class="empty-icon">\U0001f50d</div><h3>No results found</h3><p>Try a different search term or filter.</p></div>';
    } catch (e) {
      if (requestId !== searchRequest) return;
      el.innerHTML = '<div class="search-empty"><div class="empty-icon">\u26A0\uFE0F</div><h3>Search failed</h3><p>' + esc(e.message) + '</p>' + retryButton('doSearch()', 'Try again') + '</div>';
    }
  }

  // ── Live search autocomplete (header nav) ───────────────
  var acTimer = null, acQueryId = 0, acHover = -1, acResults = [], acOpen = false, acAbort = null;
  function acNormalize(q){return String(q||'').toLowerCase().replace(/[\s_]+/g,'').replace(/[^\p{L}\p{N}]/gu,'');}
  function acRank(q,list){var nq=acNormalize(q);if(!nq)return list.slice(0,10);return list.slice().sort(function(a,b){var ra=a&&a.title?acNormalize(a.title):'';var rb=b&&b.title?acNormalize(b.title):'';function r(t){if(!t)return 99;if(t===nq)return 0;if(t.indexOf(nq)===0)return 1;if(t.indexOf(nq)!==-1)return 2;return 3;}var ra2=r(ra),rb2=r(rb);if(ra2!==rb2)return ra2-rb2;return (ra?ra.length:99)-(rb?rb.length:99);}).slice(0,10);}
  function acClose(){var dd=document.getElementById('nav-search-autocomplete');if(dd)dd.innerHTML='';acOpen=false;acHover=-1;acResults=[];}
  function acRender(q,list){var dd=document.getElementById('nav-search-autocomplete');if(!dd){acClose();return;}if(!list||!list.length){dd.innerHTML='<div class="sa-empty">No anime found matching "'+esc(q)+'"</div>';acOpen=true;acResults=[];return;}var ranked=acRank(q,list);acResults=ranked;var h='';for(var i=0;i<ranked.length;i++){var a=ranked[i];var id=a.id!=null?a.id:a.animeId;var t=a.title||'';var p=a.cover_image||a.poster||a.coverImage||'';var ty=a.type||a.media_type||'';var yr=a.year||'';h+='<div class="search-suggestion" role="option" aria-selected="false" data-id="'+esc(String(id))+'" data-index="'+i+'"><img src="'+(p||fallback(t))+'" alt="'+esc(t)+'" loading="lazy"><div class="sa-info"><div class="sa-title">'+esc(t)+'</div><div class="sa-sub">'+[ty,yr].filter(function(x){return x;}).join(' · ')+'</div></div>'+(a.is_premium?'<span class="sa-meta">👑</span>':'')+'</div>';}dd.innerHTML=h;acOpen=true;acHover=-1;var items=dd.querySelectorAll('.search-suggestion');items.forEach(function(item,idx){item.addEventListener('click',function(){acSelect(item.getAttribute('data-id'));});item.addEventListener('mousedown',function(e){e.preventDefault();});item.addEventListener('mouseenter',function(){acHighlight(idx);});});}
  function acHighlight(idx){acHover=idx;var dd=document.getElementById('nav-search-autocomplete');if(!dd)return;dd.querySelectorAll('.search-suggestion').forEach(function(item,i){item.classList.toggle('active',i===idx);});}
  function acLoading(){var dd=document.getElementById('nav-search-autocomplete');if(!dd)return;dd.innerHTML='<div class="sa-loading">Searching…</div>';acOpen=true;}
  function acSelect(id){acClose();var inp=document.getElementById('nav-search-input');if(inp)inp.value='';if(id!=null&&id!=='')Router.navigate('/anime/'+encodeURIComponent(id));}
  function acSearch(q){if(!q||q.length<1){acClose();return;}if(acAbort)acAbort.abort();var cid=++acQueryId;acLoading();acHover=-1;acAbort=new AbortController();clearTimeout(acTimer);acTimer=setTimeout(function(){if(acAbort.signal.aborted)return;API.search(q).then(function(data){if(acAbort.signal.aborted||cid!==acQueryId)return;var list=[];if(Array.isArray(data))list=data;else if(data&&Array.isArray(data.data))list=data.data;else if(data&&Array.isArray(data.items))list=data.items;else if(data&&Array.isArray(data.rows))list=data.rows;acRender(q,list);}).catch(function(){if(acAbort.signal.aborted||cid!==acQueryId)return;var dd=document.getElementById('nav-search-autocomplete');if(dd)dd.innerHTML='<div class="sa-empty">Error loading results</div>';acOpen=true;});},350);}
  function acOnKey(e){var inp=document.getElementById('nav-search-input');var dd=document.getElementById('nav-search-autocomplete');if(!inp||!dd)return;if(e.key==='Escape'){acClose();inp.blur();e.preventDefault();return;}if(e.key==='ArrowDown'&&acOpen&&acResults.length){e.preventDefault();acHighlight(acHover<acResults.length-1?acHover+1:0);}else if(e.key==='ArrowUp'&&acOpen&&acResults.length){e.preventDefault();acHighlight(acHover>0?acHover-1:acResults.length-1);}else if(e.key==='Enter'){if(acOpen&&acHover>=0&&acHover<acResults.length){e.preventDefault();var r=acResults[acHover];acSelect(r.id!=null?r.id:r.animeId);return false;}var q=inp.value.trim();if(q){acClose();Router.navigate('/search',{q:q});inp.value='';}e.preventDefault();return false;}}
  function acInit(){var inp=document.getElementById('nav-search-input');if(!inp)return;inp.removeEventListener('input',acSearch);inp.removeEventListener('keydown',acOnKey);inp.addEventListener('input',function(e){acSearch(e.target.value);});inp.addEventListener('keydown',acOnKey);}

  // Global: close autocomplete on click outside or Escape
  if (typeof window !== 'undefined') {
    document.addEventListener('click', function (e) {
      var dd = document.getElementById('nav-search-autocomplete');
      var inp = document.getElementById('nav-search-input');
      if (dd && dd.innerHTML && !dd.contains(e.target) && e.target !== inp) acClose();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && typeof acOpen !== 'undefined' && acOpen) { acClose(); var i = document.getElementById('nav-search-input'); if (i) i.blur(); }
    });
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
      // Analytics: track anime view
      if (API.trackEvent) API.trackEvent('anime_view', { anime_id: id, title: anime && anime.title });
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
      // Per-title browser tab title (crawlers get the full SEO page instead).
      if (title) document.title = title + ' — Watch Online | AniStrim';
      if (Auth.state.isLoggedIn) {
        refreshWatchlistState().then(syncWatchlistButtons).catch(function () {});
      }
    } catch (e) { root.innerHTML = '<div class="empty">Could not load this anime. ' + retryButton('loadAnime(\'' + esc(id) + '\')', 'Try again') + '<p>' + esc(e.message) + '</p></div>'; }
  }

  // ── Watch / Player ──────────────────────────────────────
  function watchView(params) {
    renderHeader();
    return '<div class="page watch-page">' +
      '<div class="watch-breadcrumb"><a href="#/browse">Browse</a><span class="breadcrumb-sep">/</span><a href="#/anime/' + esc(params.id) + '" id="watch-breadcrumb-anime">Anime</a><span class="breadcrumb-sep">/</span><span id="watch-breadcrumb-ep">Episode ' + esc(params.ep || 1) + '</span></div>' +
      '<div class="watch-container">' +
      '<div class="player-stage"><video id="animePlayer" class="video-element" controls playsinline></video>' +
      '<div class="player-loading" id="player-loading" aria-live="polite">Preparing playback…</div>' +
      '<div class="player-error" id="player-error" style="display:none"></div>' +
      '<div class="skip-actions" id="skip-actions"><button id="skip-intro" class="skip-btn" style="display:none" onclick="AniStrimUI.skipMarker(\'intro\')">Skip intro</button><button id="skip-outro" class="skip-btn" style="display:none" onclick="AniStrimUI.skipMarker(\'outro\')">Skip outro</button></div>' +
      '<div class="autoplay-next" id="autoplay-next" style="display:none"><span id="autoplay-next-text"></span><button class="btn-primary" onclick="AniStrimUI.playNextEpisode()">Play now</button><button class="btn-ghost" onclick="AniStrimUI.cancelAutoplay()">Cancel</button></div></div>' +
      '<div class="watch-info-panel"><div class="watch-info-main"><div class="watch-episode-label" id="watch-episode-label">Episode ' + esc(params.ep || 1) + '</div>' +
      '<h2 id="watch-title">Loading...</h2>' +
      '<div class="watch-meta-row" id="watch-meta-row"><span id="watch-meta-sub">Sub</span><span class="meta-dot">·</span><span id="watch-meta-quality">HD</span><span class="meta-dot">·</span><span id="watch-meta-duration">-- min</span><span class="meta-dot">·</span><span id="watch-meta-genres">Loading...</span></div></div>' +
      '<div class="watch-info-actions"><div class="watch-speed-ctrl"><label>Speed</label><select id="player-speed" onchange="AniStrimUI.setPlaybackSpeed(this.value)"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>Normal</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></div>' +
      '<div class="watch-nav-buttons" id="watch-nav"></div></div></div>' +
      '<div class="player-options" id="player-options" style="display:none">' +
      '<label id="quality-option" style="display:none">Quality <select id="player-quality" onchange="AniStrimUI.setQuality(this.value)"></select></label>' +
      '<label id="audio-option" style="display:none">Audio <select id="player-audio" onchange="AniStrimUI.setAudioTrack(this.value)"></select></label>' +
      '<label id="subtitle-option" style="display:none">Subtitles <select id="player-subtitle" onchange="AniStrimUI.setSubtitleTrack(this.value)"></select></label></div>' +
      '<div class="season-nav" id="season-nav"></div>' +
      '<div class="watch-episodes-section"><div class="watch-episodes-header"><h3>Episodes</h3><span class="watch-episodes-count" id="watch-episodes-count"></span></div>' +
      '<div class="episode-list" id="watch-episodes"><div class="grid-loading">Loading...</div></div></div>' +
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
      nav.innerHTML = '<button class="btn-ghost" ' + (previous ? '' : 'disabled') + ' onclick="AniStrimUI.playPreviousEpisode()">← Prev</button>' +
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
    var watchedCount = visible.filter(function (ep) { return watchState.progress && watchState.progress[ep.id]; }).length;
    listEl.innerHTML = '<div class="episode-grid">' + visible.map(function (item) {
      var n = episodeNumber(item);
      var current = String(item.id) === String(watchState.target.id) ? ' current' : '';
      var watched = (watchState.progress && watchState.progress[item.id]) ? ' watched' : '';
      return '<button class="ep-btn' + current + watched + '" onclick="AniStrimUI.watch(\'' + esc(watchState.animeId) + '\',' + (n || 1) + ',\'' + esc(item.id) + '\')" title="Episode ' + esc(n) + '">' + n + '</button>';
    }).join('') + '</div>';
    var countEl = document.getElementById('watch-episodes-count');
    if (countEl) countEl.textContent = watchedCount + ' of ' + visible.length + ' watched';
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
      var breadcrumbAnime = document.getElementById('watch-breadcrumb-anime');
      if (breadcrumbAnime) breadcrumbAnime.textContent = anime && anime.title;
      var breadcrumbEp = document.getElementById('watch-breadcrumb-ep');
      if (breadcrumbEp) breadcrumbEp.textContent = 'Episode ' + (ep || 1);
      var episodeLabel = document.getElementById('watch-episode-label');
      if (episodeLabel) episodeLabel.textContent = 'Episode ' + (ep || 1) + ' of ' + eps.length;
      var metaRow = document.getElementById('watch-meta-row');
      if (metaRow && anime) {
        var genres = Array.isArray(anime.genres) ? anime.genres.slice(0, 3).join(' · ') : '';
        var duration = anime.episode_duration || anime.duration || '';
        metaRow.innerHTML = '<span>Sub</span><span class="meta-dot">·</span><span>HD</span>' +
          (duration ? '<span class="meta-dot">·</span><span>' + esc(String(duration)) + '</span>' : '') +
          (genres ? '<span class="meta-dot">·</span><span>' + esc(genres) + '</span>' : '');
      }
      var epCountEl = document.getElementById('watch-episodes-count');
      if (epCountEl) epCountEl.textContent = eps.length + ' episodes';
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
    return '<div class="page"><div class="container"><div class="watchlist-header">' +
      '<span class="watchlist-label">Saved</span>' +
      '<h1>My Watchlist</h1>' +
      '<span class="watchlist-count" id="watchlist-count"></span></div>' +
      '<div id="watchlist-grid" class="grid-loading"><div class="list-loading">Loading your watchlist...</div></div></div></div>';
  }
  async function loadWatchlist() {
    var el = document.getElementById('watchlist-grid');
    if (!el) return;
    el.innerHTML = '<div class="list-loading">Loading your watchlist...</div>';
    try {
      var list = await refreshWatchlistState();
      var countEl = document.getElementById('watchlist-count');
      if (countEl) countEl.textContent = list.length ? list.length + ' titles' : '';
      if (list.length) {
        var h = '<div class="anime-grid">';
        for (var i = 0; i < list.length; i++) {
          var w = list[i];
          var animeId = w.animeId || (w.anime && w.anime.id) || w.id;
          var anime = w.anime || { animeId: animeId, title: w.title, poster: w.poster };
          h += '<div class="watchlist-entry">' + card(anime) +
            '<button class="watchlist-remove" onclick="AniStrimUI.removeWatchlist(\'' + esc(animeId) + '\')" title="Remove from watchlist">✕</button></div>';
        }
        h += '</div>';
        el.innerHTML = h;
      } else {
        el.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><h3>Your watchlist is empty</h3><p>Start exploring and add anime to your list.</p><a href="#/browse" class="btn-primary" style="display:inline-flex;margin-top:var(--space-4)">Browse Anime</a></div>';
      }
    } catch (e) { el.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Could not load watchlist</h3><p>' + esc(e.message) + '</p>' + retryButton('loadWatchlist()', 'Try again') + '</div>'; }
  }
  function historyView() {
    renderHeader();
    if (!Auth.state.isLoggedIn) { Router.navigate('/login', { redirect: '/history' }); return ''; }
    return '<div class="page"><div class="container"><div class="history-header">' +
      '<span class="history-label">Activity</span>' +
      '<h1>Watch History</h1>' +
      '<span class="history-count" id="history-count">0 episodes</span></div>' +
      '<div class="history-toolbar"><button class="btn-outline history-clear-btn" onclick="AniStrimUI.clearHistory()">Clear History</button></div>' +
      '<div id="history-list"><div class="list-loading">Loading your watch history...</div></div></div></div>';
  }
  async function loadHistory() {
    var el = document.getElementById('history-list');
    if (!el) return;
    el.innerHTML = '<div class="list-loading">Loading your watch history...</div>';
    try {
      var list = norm(await API.watchHistory(1, 30));
      var countEl = document.getElementById('history-count');
      if (countEl) countEl.textContent = list.length + ' episodes';
      if (list.length) {
        var h = '<div class="history-list">';
        for (var i = 0; i < list.length; i++) {
          var entry = list[i];
          var title = entry.animeTitle || entry.title || 'Anime';
          var episode = entry.episodeNumber || 1;
          var percent = Math.max(0, Math.min(100, Number(entry.percent) || 0));
          var img = entry.poster || entry.thumbnailUrl || entry.coverImage || '';
          var anId = entry.animeId || (entry.anime && entry.anime.id) || '';
          var epId = entry.episodeId || '';
          var completed = entry.completed || percent >= 95;
          h += '<div class="history-entry">' +
            (img ? '<div class="history-thumb"><img src="' + img + '" alt="" loading="lazy" onerror="this.style.display=\'none\'"></div>' : '') +
            '<div class="history-info"><div class="history-title">' + esc(title) + '</div>' +
            '<div class="history-meta">Episode ' + esc(episode) + (entry.episodeTitle ? ': ' + esc(entry.episodeTitle) : '') + '</div>' +
            (!completed ? '<div class="history-progress"><div class="history-progress-bar"><div style="width:' + percent + '%"></div></div><span class="history-progress-text">' + Math.round(percent) + '%</span></div>' : '<span class="history-completed-badge">Completed</span>') +
            '</div>' +
            '<button class="btn-primary history-resume-btn" onclick="AniStrimUI.resumeHistory(\'' + esc(anId) + '\',' + Number(episode) + ',\'' + esc(epId) + '\')">' + (completed ? 'Watch again' : 'Resume') + '</button></div>';
        }
        h += '</div>';
        el.innerHTML = h;
      } else {
        el.innerHTML = '<div class="empty-state"><div class="empty-icon">🎬</div><h3>No watch history</h3><p>Start watching anime and your progress will appear here.</p><a href="#/browse" class="btn-primary" style="display:inline-flex;margin-top:var(--space-4)">Browse Anime</a></div>';
      }
    } catch (e) { el.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Could not load watch history</h3><p>' + esc(e.message) + '</p>' + retryButton('loadHistory()', 'Try again') + '</div>'; }
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
      '<div class="profile-card"><div class="avatar-wrap"><div class="avatar-ring"><img id="profile-avatar" class="avatar" src="" alt="avatar"></div></div>' +
      '<h2 id="profile-display-name" class="profile-name">' + esc(user && (user.displayName || user.name)) + '</h2>' +
      '<p class="profile-username" id="profile-username">' + (user && user.username ? '@' + esc(user.username) : '') + '</p>' +
      '<p class="muted" id="profile-email">' + esc(user && user.email) + '</p>' +
      '<div class="profile-meta">' + (Auth.state.isPremium ? '<span class="badge-premium">👑 Premium</span>' : '') + (Auth.state.isAdmin ? '<span class="badge-admin">🛡️ Admin</span>' : '') + (!Auth.state.isPremium && !Auth.state.isAdmin ? '<a href="#/upgrade" class="btn-outline upgrade-btn">Upgrade</a>' : '') + '</div>' +
      '<div class="profile-actions"><button class="btn-ghost btn-profile" onclick="AniStrimUI.uploadAvatar()">Change Avatar</button>' +
      '<input type="file" id="avatar-input" accept="image/*" style="display:none" onchange="AniStrimUI.doAvatarUpload(event)">' +
      '<button class="btn-outline btn-profile logout-btn" onclick="AniStrimUI.logout()">Logout</button></div></div>' +
      '<div class="profile-settings">' +
      '<div class="settings-card"><div class="settings-group"><h3>Playback</h3><div class="settings-divider"></div>' +
      '<label class="toggle-row"><span class="toggle-label"><span class="toggle-label-text">Auto-skip intros</span><span class="toggle-desc">Automatically skip opening and ending sequences</span></span><span class="toggle-wrap"><input type="checkbox" id="pref-auto-skip" class="toggle-input"><span class="toggle-track"></span></span></label>' +
      '<label class="toggle-row"><span class="toggle-label"><span class="toggle-label-text">Auto-play next</span><span class="toggle-desc">Automatically start the next episode</span></span><span class="toggle-wrap"><input type="checkbox" id="pref-auto-play" class="toggle-input"><span class="toggle-track"></span></span></label>' +
      '<label class="select-row"><span class="select-label"><span class="select-label-text">Autoplay delay</span><span class="select-desc">Wait time before the next episode starts</span></span><select id="pref-auto-countdown"><option value="0">Start immediately</option><option value="5">5 seconds</option><option value="10">10 seconds</option><option value="15">15 seconds</option><option value="30">30 seconds</option></select></label>' +
      '<label class="select-row"><span class="select-label"><span class="select-label-text">Default quality</span><span class="select-desc">Preferred video quality when available</span></span><select id="pref-quality"><option value="auto">Auto</option><option value="360">360p</option><option value="480">480p</option><option value="720">720p</option><option value="1080">1080p</option></select></label>' +
      '<label class="select-row"><span class="select-label"><span class="select-label-text">Playback speed</span><span class="select-desc">Default playback speed for all videos</span></span><select id="pref-playback-rate"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">Normal</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label></div>' +
      '<div class="settings-group"><h3>Subtitles &amp; Audio</h3><div class="settings-divider"></div>' +
      '<label class="select-row"><span class="select-label"><span class="select-label-text">Subtitles</span><span class="select-desc">Show subtitles during playback</span></span><select id="pref-subtitles"><option value="on">On</option><option value="off">Off</option></select></label>' +
      '<label class="select-row"><span class="select-label"><span class="select-label-text">Subtitle language</span><span class="select-desc">Preferred subtitle language</span></span><select id="pref-subtitle-lang"><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="pt">Portuguese</option><option value="ja">Japanese</option><option value="ar">Arabic</option><option value="none">None</option></select></label></div>' +
      '<div class="settings-group"><h3>Accessibility</h3><div class="settings-divider"></div>' +
      '<label class="toggle-row"><span class="toggle-label"><span class="toggle-label-text">Reduce motion</span><span class="toggle-desc">Minimize animations and transitions</span></span><span class="toggle-wrap"><input type="checkbox" id="pref-reduce-motion" class="toggle-input"><span class="toggle-track"></span></span></label></div>' +
      '<div class="settings-group"><h3>Account</h3><div class="settings-divider"></div>' +
      '<label class="input-row"><span class="input-label"><span class="input-label-text">Username</span><span class="input-desc">Your display name on the platform</span></span><input id="pref-username" type="text" placeholder="Set username"></label></div>' +
      '<div class="settings-divider"></div>' +
      '<div class="support-section"><h3>Need Help?</h3><p class="support-desc">Having trouble with your account, playback, payments, or found a bug? Our support team is here to help.</p>' +
      '<a href="#/support" class="btn-outline btn-block btn-support-link">Contact Support</a>' +
      '<a href="#/support/my-requests" class="btn-ghost btn-block btn-support-link">View My Support Requests</a></div></div>' +
      '<button class="btn-primary btn-block" onclick="AniStrimUI.saveProfile()" id="profile-save-btn">Save Changes</button>' +
      '</div></div></div></div>';
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
    var username = document.getElementById('profile-username');
    if (username) username.textContent = (user && user.username ? '@' + esc(user.username) : '');
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
    var btn = document.getElementById('profile-save-btn');
    try {
      if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
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
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
  }
  function uploadAvatar() { var i = document.getElementById('avatar-input'); if (i) i.click(); }
  async function doAvatarUpload(e) {
    var file = e.target && e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Image too large. Max 5 MB.', 'error'); return; }
    if (!String(file.type || '').startsWith('image/')) { toast('Choose an image file.', 'error'); return; }
    var av = document.getElementById('profile-avatar');
    if (av) av.style.opacity = '0.5';
    try {
      await API.uploadAvatar(file);
      await Auth.refreshMe();
      var user = Auth.state.user;
      if (av && user && user.avatarUrl) av.src = user.avatarUrl + (user.avatarUrl.indexOf('?') === -1 ? '?v=' : '&v=') + Date.now();
      if (av) av.style.opacity = '';
      renderHeader(); toast('Avatar updated');
    } catch (err) {
      if (av) av.style.opacity = '';
      toast(err.message, 'error');
    }
    // Reset file input so the same file can be selected again
    e.target.value = '';
  }

  // ── Upgrade ─────────────────────────────────────────────
  function upgradeView() {
    renderHeader();
    if (Auth.state.isPremium) return '<div class="page"><div class="container"><div class="card premium-card"><h1>You are Premium 👑</h1><p style="color:var(--clr-text-secondary);margin-top:var(--space-2)">You already have access to all Premium features.</p></div></div></div>';
    return '<div class="page upgrade-page"><div class="container">' +
      '<div class="upgrade-hero"><span class="upgrade-label">✦ Premium</span><h1>Upgrade to Premium</h1><p class="upgrade-subtitle">Unlock the full AniStrim experience. Watch more, enjoy more.</p></div>' +
      '<div class="plans">' +
      '<div class="plan"><div class="plan-header"><h3>Monthly</h3><div class="price">UGX 15,000<span>/mo</span></div></div>' +
      '<ul class="plan-features"><li><span class="feat-icon">🎬</span> Access to all anime series</li><li><span class="feat-icon">🎯</span> HD &amp; 4K video quality</li><li><span class="feat-icon">🚫</span> Completely ad-free</li><li><span class="feat-icon">📱</span> Multi-device streaming</li><li><span class="feat-icon">⬇️</span> Offline downloads</li><li><span class="feat-icon">📋</span> Unlimited watchlists</li></ul>' +
      '<button class="btn-primary btn-block" onclick="AniStrimUI.checkout(\'monthly\')">Subscribe Monthly</button></div>' +
      '<div class="plan featured"><div class="plan-header"><h3>Yearly</h3><div class="price">UGX 180,000<span>/yr</span></div></div>' +
      '<ul class="plan-features"><li><span class="feat-icon">🎬</span> Access to all anime series</li><li><span class="feat-icon">🎯</span> HD &amp; 4K video quality</li><li><span class="feat-icon">🚫</span> Completely ad-free</li><li><span class="feat-icon">📱</span> Multi-device streaming</li><li><span class="feat-icon">⬇️</span> Offline downloads</li><li><span class="feat-icon">📋</span> Unlimited watchlists</li></ul>' +
      '<div class="plan-savings">Save 16% compared to monthly</div>' +
      '<button class="btn-primary btn-block" onclick="AniStrimUI.checkout(\'yearly\')">Subscribe Yearly</button></div>' +
      '</div>' +
      '<div class="upgrade-faq"><h2>Why Premium?</h2><div class="faq-grid">' +
      '<div class="faq-item"><div class="faq-icon">🎯</div><h3>Crystal Clear Quality</h3><p>Stream in HD and 4K with adaptive bitrate — no more buffering on slow connections.</p></div>' +
      '<div class="faq-item"><div class="faq-icon">🚫</div><h3>Ad-Free Experience</h3><p>Enjoy uninterrupted anime without any ads, pop-ups, or interstitials.</p></div>' +
      '<div class="faq-item"><div class="faq-icon">📱</div><h3>Watch Anywhere</h3><p>Stream on your phone, tablet, desktop, or TV — all synced with your watch history.</p></div>' +
      '<div class="faq-item"><div class="faq-icon">⬇️</div><h3>Offline Mode</h3><p>Download episodes and watch them offline, even without an internet connection.</p></div>' +
      '</div></div>' +
      '</div></div>';
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

  // ── Support ─────────────────────────────────────────────
  var CATEGORIES = [
    { value: 'complaint', label: 'Complaint' },
    { value: 'bug', label: 'Bug / Something isn\'t working' },
    { value: 'account', label: 'Account problem' },
    { value: 'payment', label: 'Payment problem' },
    { value: 'video', label: 'Video / Playback problem' },
    { value: 'episode', label: 'Anime / Episode problem' },
    { value: 'other', label: 'Other' },
  ];

  function supportView() {
    renderHeader();
    if (!Auth.state.isLoggedIn) { Router.navigate('/login', { redirect: '/support' }); return ''; }
    var user = Auth.state.user;
    var cats = CATEGORIES.map(function (c) { return '<option value="' + esc(c.value) + '">' + esc(c.label) + '</option>'; }).join('');
    return '<div class="page"><div class="container"><div class="support-page">' +
      '<h1>Contact Support</h1>' +
      '<p class="support-intro">Need help? Tell us what happened and we\'ll get back to you.</p>' +
      '<form id="support-form" class="support-form" onsubmit="return AniStrimUI.submitSupport(event)">' +
      '<div class="support-field">' +
      '<label for="support-category">Category</label>' +
      '<select id="support-category" required>' +
      '<option value="" disabled selected>Select a category</option>' + cats +
      '</select></div>' +
      '<div class="support-field">' +
      '<label for="support-subject">Subject</label>' +
      '<input type="text" id="support-subject" required placeholder="e.g. Video won\'t play for One Piece Episode 1100" maxlength="150"></div>' +
      '<div class="support-field">' +
      '<label for="support-message">Message</label>' +
      '<textarea id="support-message" required rows="6" placeholder="Please describe the problem in as much detail as possible..." maxlength="5000"></textarea>' +
      '<span class="field-counter"><span id="msg-count">0</span>/5000</span></div>' +
      '<div class="support-field support-optional">' +
      '<label for="support-anime">Related Anime (optional)</label>' +
      '<input type="text" id="support-anime" placeholder="e.g. One Piece"></div>' +
      '<div class="support-field support-optional">' +
      '<label for="support-episode">Related Episode (optional)</label>' +
      '<input type="text" id="support-episode" placeholder="e.g. Episode 1100"></div>' +
      '<div id="support-error" class="form-error" role="alert"></div>' +
      '<button type="submit" class="btn-primary btn-block" id="support-submit-btn">Send Support Request</button>' +
      '</form></div></div>';
  }

  function afterSupport() {
    var msg = document.getElementById('support-message');
    if (msg) {
      msg.addEventListener('input', function () {
        var counter = document.getElementById('msg-count');
        if (counter) counter.textContent = msg.value.length;
      });
    }
  }

  async function submitSupport(e) {
    e.preventDefault();
    var errorEl = document.getElementById('support-error');
    var submitBtn = document.getElementById('support-submit-btn');
    if (errorEl) errorEl.style.display = 'none';
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending\u2026'; }

    var category = document.getElementById('support-category').value;
    var subject = document.getElementById('support-subject').value.trim();
    var message = document.getElementById('support-message').value.trim();
    var animeName = document.getElementById('support-anime').value.trim();

    try {
      var data = await API.createSupportTicket({
        category: category,
        subject: subject,
        message: message,
      });

      // Show success screen
      var main = document.getElementById('site-main');
      if (main) {
        main.innerHTML = '<div class="page"><div class="container"><div class="support-success">' +
          '<div class="success-icon">&#10004;</div>' +
          '<h1>Support Request Sent!</h1>' +
          '<p class="ticket-number">Ticket #' + esc(data.ticket_number) + '</p>' +
          '<p class="success-text">We\'ve received your request and our support team will review it shortly.</p>' +
          '<p class="success-email">A confirmation has been sent to your email.</p>' +
          '<div class="success-actions">' +
          '<a href="#/profile" class="btn-outline">Back to Profile</a>' +
          '<a href="#/support/my-requests" class="btn-ghost">View My Support Requests</a>' +
          '</div></div></div></div>';
      }
      window.scrollTo(0, 0);
    } catch (err) {
      if (errorEl) { errorEl.textContent = err.message || 'Failed to submit request. Please try again.'; errorEl.style.display = 'block'; }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send Support Request'; }
    }
  }

  function mySupportView() {
    renderHeader();
    if (!Auth.state.isLoggedIn) { Router.navigate('/login', { redirect: '/support/my-requests' }); return ''; }
    return '<div class="page"><div class="container">' +
      '<div class="support-list-header"><h1>My Support Requests</h1></div>' +
      '<div id="support-list-loading" class="loading">Loading...</div>' +
      '<div id="support-list" class="support-list" style="display:none"></div>' +
      '<div id="support-list-empty" class="empty" style="display:none">' +
      '<p>No support requests yet.</p>' +
      '<a href="#/support" class="btn-outline">Submit a Request</a></div>' +
      '</div></div>';
  }

  async function afterMySupport() {
    var loading = document.getElementById('support-list-loading');
    var list = document.getElementById('support-list');
    var empty = document.getElementById('support-list-empty');
    try {
      var tickets = await API.listSupportTickets();
      if (loading) loading.style.display = 'none';
      if (!tickets || !tickets.length) {
        if (empty) empty.style.display = 'block';
        return;
      }
      if (list) {
        list.style.display = 'block';
        list.innerHTML = tickets.map(function (t) {
          var statusClass = t.status === 'open' ? 'status-open' :
            t.status === 'resolved' ? 'status-resolved' :
            t.status === 'closed' ? 'status-closed' : 'status-other';
          var date = t.created_at ? new Date(t.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
          return '<a class="support-list-item" href="#/support/ticket/' + esc(t.ticket_number) + '">' +
            '<div class="support-ticket-row">' +
            '<span class="ticket-num">' + esc(t.ticket_number) + '</span>' +
            '<span class="ticket-status ' + statusClass + '">' + esc(t.status.charAt(0).toUpperCase() + t.status.slice(1)) + '</span>' +
            '</div>' +
            '<div class="ticket-subject">' + esc(t.subject) + '</div>' +
            '<div class="ticket-meta">' + esc(t.category_label || t.category) + ' &middot; ' + date + '</div>' +
            '</a>';
        }).join('');
      }
    } catch (err) {
      if (loading) loading.style.display = 'none';
      if (list) { list.style.display = 'block'; list.innerHTML = '<div class="empty">Could not load support requests. ' + esc(err.message) + '</div>'; }
    }
  }

  function ticketDetailView(params) {
    renderHeader();
    if (!Auth.state.isLoggedIn) { Router.navigate('/login', { redirect: '#/support/ticket/' + (params.ticket_number || '') }); return ''; }
    return '<div class="page"><div class="container">' +
      '<div id="ticket-detail-loading" class="loading">Loading ticket...</div>' +
      '<div id="ticket-detail" class="ticket-detail" style="display:none"></div>' +
      '<div id="ticket-detail-error" class="empty" style="display:none"></div>' +
      '</div></div>';
  }

  async function afterTicketDetail(params) {
    var loading = document.getElementById('ticket-detail-loading');
    var detail = document.getElementById('ticket-detail');
    var error = document.getElementById('ticket-detail-error');
    try {
      var ticket = await API.getSupportTicket(params.ticket_number);
      if (loading) loading.style.display = 'none';
      if (detail) {
        detail.style.display = 'block';
        var statusClass = ticket.status === 'open' ? 'status-open' :
          ticket.status === 'resolved' ? 'status-resolved' :
          ticket.status === 'closed' ? 'status-closed' : 'status-other';
        var createdDate = ticket.created_at ? new Date(ticket.created_at).toLocaleString() : '';
        var updatedDate = ticket.updated_at && ticket.updated_at !== ticket.created_at ? new Date(ticket.updated_at).toLocaleString() : null;
        var resolvedDate = ticket.resolved_at ? new Date(ticket.resolved_at).toLocaleString() : null;
        var h = '<div class="ticket-detail-header">' +
          '<a href="#/support/my-requests" class="btn-ghost">&larr; Back to Requests</a>' +
          '<h2>Ticket ' + esc(ticket.ticket_number) + '</h2>' +
          '<span class="ticket-status ' + statusClass + '">' + esc(ticket.status.charAt(0).toUpperCase() + ticket.status.slice(1)) + '</span>' +
          '</div>' +
          '<div class="ticket-detail-body">' +
          '<div class="ticket-row"><strong>Category:</strong> ' + esc(ticket.category_label || ticket.category) + '</div>' +
          '<div class="ticket-row"><strong>Subject:</strong> ' + esc(ticket.subject) + '</div>' +
          '<div class="ticket-row"><strong>Message:</strong><pre>' + esc(ticket.message) + '</pre></div>';
        if (ticket.anime_title) h += '<div class="ticket-row"><strong>Anime:</strong> ' + esc(ticket.anime_title) + '</div>';
        if (ticket.episode_title) h += '<div class="ticket-row"><strong>Episode:</strong> ' + esc(ticket.episode_title) + '</div>';
        h += '<div class="ticket-row"><strong>Created:</strong> ' + createdDate + '</div>';
        if (updatedDate) h += '<div class="ticket-row"><strong>Last Updated:</strong> ' + updatedDate + '</div>';
        if (resolvedDate) h += '<div class="ticket-row"><strong>Resolved:</strong> ' + resolvedDate + '</div>';
        h += '</div>';
        detail.innerHTML = h;
      }
    } catch (err) {
      if (loading) loading.style.display = 'none';
      if (error) { error.style.display = 'block'; error.textContent = 'Could not load ticket: ' + (err.message || 'Not found'); }
    }
  }

  // ── Public API ──────────────────────────────────────────
  window.AniStrimUI = {
    fallback: fallback,
    goAnime: function (id) { Router.navigate('/anime/' + encodeURIComponent(id)); },
    // Anchor-card click handler: crawlable href stays for SEO; humans get SPA nav.
    goCard: function (event, id) {
      if (event && event.preventDefault) event.preventDefault();
      Router.navigate('/anime/' + encodeURIComponent(id));
      return false;
    },
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
    toggleMobileNav: toggleMobileNav, closeMobileNav: closeMobileNav,
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
    switchRankTab: switchRankTab,
    checkout: checkout, renderHeader: renderHeader,
    submitSupport: submitSupport,
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
    support: supportView, afterSupport: afterSupport,
    mySupport: mySupportView, afterMySupport: afterMySupport,
    ticketDetail: ticketDetailView, afterTicketDetail: afterTicketDetail,
  };

  Auth.state.onChange(renderHeader);
  Player.setErrorDisplay(function (m) {
    var el = document.getElementById('player-error');
    if (el) { el.textContent = m; el.style.display = 'block'; }
  });
})();
