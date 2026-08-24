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