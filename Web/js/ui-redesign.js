// AniStrim UI Redesign — overrides home/upgrade views
(function () {
  'use strict';
  var UI = window.AniStrimUI;
  var Auth = window.AniStrimAuth && window.AniStrimAuth.state;
  var API = window.AniStrimApi;
  var R = window.AniStrimRouter;
  var V = window.AniStrimViews;
  if (!UI || !V || !API) return;
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fb(t) { var c = (t || '?').charAt(0).toUpperCase(); return 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#18182a"/><text x="150" y="245" font-family="sans-serif" font-size="72" fill="#8b5cf6" text-anchor="middle">' + c + '</text></svg>'); }
  function nl(l) { return Array.isArray(l) ? l : (l && (l.rows || l.items || l.data)) || []; }
  var si = 0, sd = [], st = null;
  function stTo(i) { si = Math.max(0, Math.min(i, sd.length - 1)); rdSl(); rst(); }
  function stPr() { stTo(si - 1); }
  function stNx() { stTo(si + 1); }
  function rst() { if (st) clearInterval(st); if (sd.length > 1) st = setInterval(function () { stTo(si + 1); }, 6000); }
  function rdSl() {
    var w = document.getElementById('home-slider');
    if (!w) return;
    if (!sd.length) { w.innerHTML = '<div class="slide-inner" style="height:460px;background:var(--bg3);display:flex;align-items:center;justify-content:center"><div style="text-align:center"><div class="skeleton" style="width:300px;height:40px;margin:0 auto 16px"></div><div class="skeleton" style="width:500px;height:20px;margin:0 auto"></div></div></div>'; return; }
    var h = '<div class="slider-track" style="transform:translateX(' + (-si * 100) + '%)">';
    for (var i = 0; i < sd.length; i++) {
      var a = sd[i], bg = (a.banner_image || a.cover_image || ''), st2 = a.type || a.media_type || '';
      h += '<div class="slide"><div class="slide-inner"' + (bg ? ' style="background-image:linear-gradient(to top,rgba(10,10,15,1) 0,rgba(10,10,15,.7) 40%,rgba(10,10,15,.3) 70%,transparent 100%),url(' + bg + ')"' : '') + '>' +
        '<div class="slide-overlay"></div><div class="slide-content">' +
        (st2 ? '<span class="slide-badge">' + esc(st2) + '</span>' : '') +
        '<h2>' + esc(a.title) + '</h2>' +
        (a.description ? '<p>' + esc(a.description.substring(0, 180)) + '</p>' : '') +
        '<div class="slide-actions"><a href="#/anime/' + a.id + '" class="btn-primary">&#9654; Watch Now</a></div></div></div></div>';
    }
    h += '</div>';
    if (sd.length > 1) {
      h += '<button class="slider-btn slider-prev" onclick="AniStrimRedesign.stPr()" aria-label="Previous">&#8249;</button>';
      h += '<button class="slider-btn slider-next" onclick="AniStrimRedesign.stNx()" aria-label="Next">&#8250;</button>';
      h += '<div class="slider-dots">';
      for (var j = 0; j < sd.length; j++) h += '<button class="slider-dot' + (j === si ? ' active' : '') + '" onclick="AniStrimRedesign.stTo(' + j + ')" aria-label="Slide ' + (j + 1) + '"></button>';
      h += '</div>';
    }
    w.innerHTML = h;
  }
function ac(a) {
    var img = (a && (a.cover_image || a.poster || a.coverImage)) || '', t = (a && a.title) || '', id = a && (a.id != null ? a.id : a.animeId);
    var st2 = a.type || a.media_type || '', ep = a.episode_count || a.total_episodes || '', rt = a.rating || '', pm = a.is_premium || a.premium;
    return '<div class="anime-card" onclick="window.AniStrimRedesign.goAnime(' + id + ')"><div class="anime-card-img"><img src="' + (img || fb(t)) + '" alt="' + esc(t) + '" loading="lazy">' +
      (st2 ? '<span class="badge-type">' + esc(st2) + '</span>' : '') + (pm ? '<span class="badge-premium">&#x1F451;</span>' : '') +
      (rt ? '<span class="badge-rating">&#9733; ' + esc(rt) + '</span>' : '') + (ep ? '<span class="badge-ep">' + esc(ep) + '</span>' : '') +
      '</div><div class="anime-card-body"><div class="anime-card-title">' + esc(t) + '</div><div class="anime-card-sub">' + (st2 || 'Anime') + (ep ? ' &middot; ' + esc(ep) + ' EP' : '') + '</div></div></div>';
  }
  function ag(l) { var items = nl(l).slice(0, 10); return '<div class="anime-grid">' + items.map(ac).join('') + '</div>'; }
  function sc(n) { n = n || 5; var h = ''; for (var i = 0; i < n; i++) h += '<div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-text" style="margin-top:10px"></div></div>'; return '<div class="skeleton-grid">' + h + '</div>'; }
  function sn(t, l) { return '<div class="section-header"><h2>' + esc(t) + '</h2>' + (l ? '<a class="section-link" href="' + l + '">View all &rarr;</a>' : '') + '</div>'; }
  function goAnime(id) { if (id != null) { R.navigate('/anime/' + id); } }
  function rc(a, idx) {
    var img = (a.cover_image || a.poster || ''), st2 = a.type || a.media_type || '', ep = a.episode_count || a.total_episodes || '';
    return '<div class="rank-item" onclick="window.AniStrimRedesign.goAnime(' + (a.id || a.animeId) + ')">' +
      '<span class="rank-num' + (idx < 3 ? ' top-3' : '') + '">' + (idx + 1) + '</span>' +
      '<div class="rank-thumb"><img src="' + (img || fb(a.title)) + '" alt="" loading="lazy"></div>' +
      '<div class="rank-info"><div class="rank-title">' + esc(a.title || '') + '</div>' +
      '<div class="rank-meta">' + (st2 || 'Anime') + (ep ? ' &middot; ' + esc(ep) + ' EP' : '') + '</div></div></div>';
  }
  // Override home view
  V.home = function () {
    UI.renderHeader();
    return '<div class="page" style="padding-top:0">' +
      '<div class="slider-wrapper" id="home-slider"></div>' +
      '<div class="container"><div class="home-content">' +
      '<div class="home-main" id="home-main"></div>' +
      '<div class="home-sidebar" id="home-sidebar">' +
      '<div class="rank-section"><div class="rank-header"><span class="rank-icon">&#x1F525;</span><h3>All Time Popular</h3></div><div class="rank-list" id="rank-popular-list">' + sc(5) + '</div></div>' +
      '<div class="rank-section"><div class="rank-header"><span class="rank-icon">&#x2B50;</span><h3>All Time Favorites</h3></div><div class="rank-list" id="rank-favorites-list">' + sc(3) + '</div></div>' +
      '</div></div></div></div>';
  };
// Override loadHome
  UI.loadHome = function () {
    var mainEl = document.getElementById('home-main');
    if (!mainEl) return;
    rdSl();
    mainEl.innerHTML = sc(10);
    API.homeSections().then(function (s) {
      if (s && s.trending && s.trending.length) { sd = s.trending; si = 0; rdSl(); rst(); }
      var out = '';
      if (window.AniStrimAuth && window.AniStrimAuth.state && window.AniStrimAuth.state.isLoggedIn) {
        out += '<div id="cw-section">' + sn('Continue Watching') + sc(4) + '</div>';
        API.continueWatching().then(function (cw) {
          var rows = nl(cw).slice(0, 8), el = document.getElementById('cw-section');
          if (el && rows.length) {
            var h2 = '<div class="section-header"><h2>Continue Watching</h2></div><div class="continue-strip">';
            for (var i = 0; i < rows.length; i++) {
              var r = rows[i], pct = (r.progressSeconds && r.durationSec && r.durationSec > 0) ? Math.min(100, Math.round(r.progressSeconds / r.durationSec * 100)) : 0;
              h2 += '<div class="continue-card anime-card" onclick="window.AniStrimRedesign.goWatch(' + (r.animeId || (r.anime && r.anime.id)) + ',' + (r.episodeNumber || 1) + ',' + (r.episodeId || 'null') + ')">' +
                '<div class="anime-card-img" style="aspect-ratio:16/9"><img src="' + (r.thumbnailUrl || r.coverImage || (r.anime && r.anime.cover_image) || fb(r.title)) + '" alt="" loading="lazy">' +
                '<div class="card-progress"><div style="width:' + pct + '%"></div></div></div>' +
                '<div class="anime-card-body"><div class="anime-card-title">' + esc(r.title || (r.anime && r.anime.title) || '') + '</div>' +
                '<div class="anime-card-sub">Ep ' + (r.episodeNumber || r.episode_number || 1) + '</div></div></div>';
            }
            h2 += '</div>'; el.innerHTML = h2;
          } else if (el) { el.style.display = 'none'; }
        }).catch(function () {});
      }
      var order = [['trending', 'Trending Now', '#/browse'], ['popular', 'Popular', '#/browse'], ['newReleases', 'New Releases', '#/browse'], ['classics', 'Classics', '#/browse']];
      for (var oi = 0; oi < order.length; oi++) {
        var key = order[oi][0];
        if (s && s[key] && s[key].length) out += '<div>' + sn(order[oi][1], order[oi][2]) + ag(s[key]) + '</div>';
      }
      mainEl.innerHTML = out || '<div class="empty-state"><div class="empty-icon">&#x1F4FA;</div><h3>Welcome to AniStrim</h3><p>Anime content is being updated.</p></div>';
      if (s && s.popular && s.popular.length) {
        var pe = document.getElementById('rank-popular-list');
        if (pe) { var ph = ''; for (var pi = 0; pi < Math.min(10, s.popular.length); pi++) ph += rc(s.popular[pi], pi); pe.innerHTML = ph; }
      }
      if (s && s.trending && s.trending.length) {
        var fe = document.getElementById('rank-favorites-list');
        if (fe) { var fh = ''; for (var fi = 0; fi < Math.min(10, s.trending.length); fi++) fh += rc(s.trending[fi], fi); fe.innerHTML = fh; }
      }
    }).catch(function (e) {
      mainEl.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x26A0;&#xFE0F;</div><h3>Could not load content</h3><p>' + esc(e.message) + '</p><button class="btn-primary" onclick="window.AniStrimRedesign.rl()">Try Again</button></div>';
    });
  };
  function rl() { var el = document.getElementById('home-main'); if (el) el.innerHTML = sc(10); UI.loadHome(); }
  // Override upgrade view
  V.upgrade = function () {
    UI.renderHeader();
    if (Auth && Auth.isPremium) return '<div class="page"><div class="container"><div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:48px;text-align:center;margin:40px 0"><div style="font-size:4rem;margin-bottom:16px">&#x1F451;</div><h1 style="font-size:1.8rem;margin-bottom:8px">You are Premium</h1><p style="color:var(--text-dim)">Enjoy unlimited access.</p></div></div></div>';
    return '<div class="page"><div class="container" style="max-width:800px;text-align:center;padding-top:40px">' +
      '<h1 style="font-size:2rem;font-weight:800;margin-bottom:8px">Upgrade to Premium</h1>' +
      '<p style="color:var(--text-dim);margin-bottom:32px;font-size:1rem">Unlock HD streaming, ad-free experience, and early access.</p>' +
      '<div class="plans">' +
      '<div class="plan"><h3>Monthly</h3><div class="price">UGX 15,000<span>/mo</span></div><ul class="features"><li>HD Streaming</li><li>Ad-Free</li><li>Early Access</li></ul><button class="btn-primary btn-block" onclick="AniStrimUI.checkout(\'monthly\')">Choose Monthly</button></div>' +
      '<div class="plan featured"><h3>Yearly</h3><div class="price">UGX 180,000<span>/yr</span></div><ul class="features"><li>All Premium Features</li><li>2 Months Free</li><li>Cancel Anytime</li></ul><button class="btn-primary btn-block" onclick="AniStrimUI.checkout(\'yearly\')">Choose Yearly</button></div>' +
      '</div></div></div>';
  };
  window.AniStrimRedesign = {
    stTo: stTo, stPr: stPr, stNx: stNx,
    goAnime: goAnime,
    goWatch: function (aid, epn, eid) { if (window.AniStrimUI) window.AniStrimUI.watch(aid, epn || 1, eid); },
    rl: rl, rdSl: rdSl, rst: rst,
  };
})();
// ── Browse view override ─────────────────────────────────
  V.browse = function () {
    UI.renderHeader();
    return '<div class="page"><div class="container"><div class="page-toolbar"><h1>Browse</h1></div>' +
      '<div id="browse-grid" class="anime-grid">' + sc(10).replace('skeleton-grid','anime-grid') + '</div>' +
      '</div></div>';
  };
  function afterBrowse() {
    var grid = document.getElementById('browse-grid');
    if (!grid) return;
    API.trending(1, 20).then(function (res) {
      var data = res && res.data ? res.data : res;
      grid.innerHTML = ag(data);
    }).catch(function (e) { grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">&#x26A0;&#xFE0F;</div><h3>Could not load</h3><p>' + esc(e.message) + '</p></div>'; });
  }
// ── Search override ─────────────────────────────────────
  V.search = function () {
    UI.renderHeader();
    return '<div class="page"><div class="container"><div class="page-toolbar"><h1>Search</h1></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px">' +
      '<input type="text" id="search-input" placeholder="Search anime..." style="flex:1;min-width:200px;max-width:400px" onkeydown="if(event.key===\'Enter\')AniStrimRedesign.dos()">' +
      '<button class="btn-primary" onclick="AniStrimRedesign.dos()">Search</button></div>' +
      '<div id="search-results" class="empty-state"><div class="empty-icon">&#x1F50D;</div><h3>Search for anime</h3><p>Type a title and press Enter.</p></div></div></div>';
  };
  function dos() {
    var q = document.getElementById('search-input'), res = document.getElementById('search-results');
    if (!q || !res) return;
    var query = q.value.trim();
    if (!query) { res.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x1F50D;</div><h3>Enter a search term</h3></div>'; return; }
    res.innerHTML = sc(8);
    API.search(query).then(function (data) {
      var items = nl(data);
      if (items.length) res.innerHTML = '<div class="anime-grid">' + items.map(ac).join('') + '</div>';
      else res.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x1F50D;</div><h3>No results</h3><p>Try a different search.</p></div>';
    }).catch(function (e) { res.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x26A0;&#xFE0F;</div><h3>Search failed</h3><p>' + esc(e.message) + '</p><button class="btn-primary" onclick="AniStrimRedesign.dos()">Retry</button></div>'; });
  }
  function afterSearch() { setTimeout(function () { var i = document.getElementById('search-input'); if (i) i.focus(); }, 100); }
  V.afterSearch = afterSearch;
  V.afterBrowse = afterBrowse;
// ── Anime Details override ──────────────────────────────
  V.anime = function (params) {
    UI.renderHeader();
    return '<div class="page"><div class="anime-detail-hero" id="anime-hero"><div class="overlay"></div><div class="container"><div class="anime-detail-content">' +
      '<div class="anime-detail-poster"><div class="skeleton" style="width:100%;height:100%;border-radius:var(--radius)"></div></div>' +
      '<div class="anime-detail-info" id="anime-info"><div class="skeleton" style="height:32px;width:70%;margin-bottom:12px"></div><div class="skeleton" style="height:16px;width:40%;margin-bottom:8px"></div><div class="skeleton" style="height:12px;width:100%;margin:4px 0"></div><div class="skeleton" style="height:12px;width:80%"></div></div>' +
      '</div></div></div></div><div class="container"><div id="anime-episodes"><div class="section-header"><h2>Episodes</h2></div>' + sc(6).replace('skeleton-grid','anime-grid') + '</div></div></div>';
  };
  function afterAnime(main, params) {
    var id = params && params.id;
    if (!id) return;
    API.anime(id).then(function (a) {
      if (!a) return;
      var bg = a.banner_image || a.cover_image || '';
      var hero = document.getElementById('anime-hero');
      if (hero && bg) hero.style.backgroundImage = 'linear-gradient(to top,rgba(10,10,15,1) 0,rgba(10,10,15,0.8) 50%,rgba(10,10,15,0.4) 100%),url(' + bg + ')';
      var info = document.getElementById('anime-info');
      if (!info) return;
      var img = a.cover_image || a.poster || '';
      var st = a.type || a.media_type || '', yr = a.year || '', status = a.status || '';
      info.innerHTML = '<div class="anime-detail-poster"><img src="' + (img || fb(a.title)) + '" alt="" onerror="this.src=\'' + fb(a.title) + '\'"></div>' +
        '<div class="anime-detail-info" style="flex:1"><h1>' + esc(a.title) + '</h1>' +
        (a.title_japanese ? '<p style="color:var(--text-muted);font-size:0.9rem;margin-bottom:8px">' + esc(a.title_japanese) + '</p>' : '') +
        '<div class="anime-meta-tags">' + (st ? '<span class="anime-meta-tag">' + esc(st) + '</span>' : '') + (yr ? '<span class="anime-meta-tag">' + esc(yr) + '</span>' : '') + (status ? '<span class="anime-meta-tag">' + esc(status) + '</span>' : '') + '</div>' +
        (a.description ? '<div class="description">' + esc(a.description) + '</div>' : '') +
        '<div class="anime-actions"><a href="#/watch/' + a.id + '/1" class="btn-primary">&#9654; Watch Now</a>' +
        '<button class="btn-outline" onclick="AniStrimUI.toggleWatchlist(' + a.id + ')">+ My List</button></div></div>';
    }).catch(function () {});
    API.episodes(id).then(function (eps) {
      var list = nl(eps);
      var el = document.getElementById('anime-episodes');
      if (!el) return;
      if (!list.length) { el.innerHTML = '<div class="section-header"><h2>Episodes</h2></div><p style="color:var(--text-muted)">No episodes available.</p>'; return; }
      var h = '<div class="section-header"><h2>Episodes (' + list.length + ')</h2></div><div class="episode-grid">';
      for (var i = 0; i < list.length; i++) {
        var ep = list[i];
        var num = ep.number || ep.episode_number || (i + 1);
        var locked = ep.locked || (ep.accessState && ep.accessState === 'premium_required');
        h += '<div class="episode-item' + (locked ? ' locked' : '') + '"' + (locked ? '' : ' onclick="window.AniStrimRedesign.goWatch(' + id + ',' + num + ',' + (ep.id || 'null') + ')"') + ' title="Ep ' + num + (locked ? ' (Premium)' : '') + '">' + num + '</div>';
      }
      h += '</div>';
      el.innerHTML = h;
    }).catch(function () {});
  }
  V.afterAnime = afterAnime;
// ── Auth pages ────────────────────────────────────────────
  function af(title, sub, fields, btn, sw, js) {
    return '<div class="page"><div class="auth-page"><div class="auth-card"><h1>' + esc(title) + '</h1>' +
      (sub ? '<div class="auth-subtitle">' + esc(sub) + '</div>' : '') +
      '<div id="auth-error" class="form-error" style="display:none"></div>' +
      '<form onsubmit="' + js + ';return false">' + fields +
      '<button type="submit" class="btn-primary btn-block" style="margin-top:8px">' + esc(btn) + '</button></form>' +
      (sw ? '<div class="auth-switch">' + sw + '</div>' : '') + '</div></div></div>';
  }
  V.login = function () {
    UI.renderHeader();
    return af('Welcome Back', 'Sign in to continue', '<div class="form-group"><label>Email</label><input type="email" id="login-email" placeholder="your@email.com" required></div><div class="form-group"><label>Password</label><input type="password" id="login-password" placeholder="Enter password" required></div>',
      'Sign In', 'New here? <a href="#/signup">Create account</a>', 'AniStrimRedesign.dl()');
  };
  async function dl() {
    var e = document.getElementById('login-email'), p = document.getElementById('login-password'), err = document.getElementById('auth-error');
    if (!e || !p) return;
    try { await window.AniStrimAuth.login(e.value.trim(), p.value); await window.AniStrimAuth.refreshMe(); UI.renderHeader(); R.navigate('/'); }
    catch (x) { if (err) { err.textContent = x.message || 'Login failed'; err.style.display = 'block'; } }
  }
  V.signup = function () {
    UI.renderHeader();
    return af('Create Account', 'Start streaming', '<div class="form-group"><label>Name</label><input type="text" id="signup-name" placeholder="Your name" required></div><div class="form-group"><label>Email</label><input type="email" id="signup-email" placeholder="your@email.com" required></div><div class="form-group"><label>Password</label><input type="password" id="signup-password" placeholder="Min 6 characters" minlength="6" required></div>',
      'Create Account', 'Have an account? <a href="#/login">Sign in</a>', 'AniStrimRedesign.ds()');
  };
  async function ds() {
    var nm = document.getElementById('signup-name'), em = document.getElementById('signup-email'), pw = document.getElementById('signup-password'), err = document.getElementById('auth-error');
    if (!nm || !em || !pw) return;
    try { var res = await window.AniStrimAuth.signup({name: nm.value.trim(), email: em.value.trim(), password: pw.value});
      if (res && res.requiresVerification) { R.navigate('/verify', {email: em.value.trim()}); return; }
      await window.AniStrimAuth.refreshMe(); UI.renderHeader(); R.navigate('/'); }
    catch (x) { if (err) { err.textContent = x.message || 'Signup failed'; err.style.display = 'block'; } }
  }
  V.verify = function (params, query) {
    UI.renderHeader();
    var email = (query && query.email) || '';
    return af('Verify Email', 'Code sent to ' + esc(email), '<div class="form-group"><label>Code</label><input type="text" id="verify-code" placeholder="000000" maxlength="6" class="otp-input" inputmode="numeric" required></div><input type="hidden" id="verify-email" value="' + esc(email) + '">',
      'Verify', 'Didn\'t get it? <a href="#" onclick="AniStrimRedesign.ro();return false">Resend</a>', 'AniStrimRedesign.dv()');
  };
  async function dv() {
    var c = document.getElementById('verify-code'), em = document.getElementById('verify-email'), err = document.getElementById('auth-error');
    if (!c || !em) return;
    try { await window.AniStrimAuth.verifyEmail(em.value, c.value.trim()); await window.AniStrimAuth.refreshMe(); UI.renderHeader(); R.navigate('/'); }
    catch (x) { if (err) { err.textContent = x.message || 'Verification failed'; err.style.display = 'block'; } }
  }
  async function ro() {
    var em = document.getElementById('verify-email'), err = document.getElementById('auth-error');
    if (!em) return;
    try { await API.resendOtp(em.value); if (err) { err.textContent = 'Code resent!'; err.style.display = 'block'; err.style.color = 'var(--success)'; } } catch (x) { if (err) { err.textContent = x.message || 'Failed'; err.style.display = 'block'; } }
  }
  V.forgotPassword = function () {
    UI.renderHeader();
    return af('Reset Password', 'Enter your email.', '<div class="form-group"><label>Email</label><input type="email" id="forgot-email" placeholder="your@email.com" required></div>',
      'Send Reset Link', '<a href="#/login">Back to sign in</a>', 'AniStrimRedesign.df()');
  };
  async function df() {
    var em = document.getElementById('forgot-email'), err = document.getElementById('auth-error');
    if (!em) return;
    try { await API.forgotPassword(em.value.trim()); if (err) { err.textContent = 'If an account exists, a reset link has been sent.'; err.style.display = 'block'; err.style.color = 'var(--success)'; } } catch (x) { if (err) { err.textContent = x.message || 'Failed'; err.style.display = 'block'; } }
  }
  V.resetPassword = function () {
    UI.renderHeader();
    return af('Set New Password', 'Enter your new password.', '<div class="form-group"><label>New Password</label><input type="password" id="reset-pw" placeholder="Min 6 characters" minlength="6" required></div>',
      'Reset Password', '', 'AniStrimRedesign.dr()');
  };
  async function dr() {
    var pw = document.getElementById('reset-pw'), err = document.getElementById('auth-error');
    if (!pw) return;
    try { await API.resetPassword(R.query().token || '', pw.value); if (err) { err.textContent = 'Password reset successfully!'; err.style.display = 'block'; err.style.color = 'var(--success)'; } } catch (x) { if (err) { err.textContent = x.message || 'Failed'; err.style.display = 'block'; } }
  }