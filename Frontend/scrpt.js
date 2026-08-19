// scrpt.js — AniStrim2 Global Script v3
const API = (typeof window.getApiBaseUrl === 'function') ? window.getApiBaseUrl() : 'https://anistrimbackend.onrender.com';
const BACKEND = API; // alias used by login.js, signup.js, google-auth-handler.js

// ===================== GLOBAL STATE =====================
// ── Global State ────────────────────────────────────────
// Delegates to the centralized Auth module (config.js) so there is a single
// source of truth for the JWT + user. Auth decodes the JWT only for expiry
// awareness — the server remains authoritative for authorization. This object
// is retained for backward compatibility with pages that read State.*.
const State = (function () {
  const getAuth = () => window.Auth || null; // Auth is defined in config.js (loaded first)
  return {
    get token()      { const a = getAuth(); return a ? a.token : (localStorage.getItem('token') || ''); },
    get user()       { const a = getAuth(); return a ? a.user : (() => { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } })(); },
    // FIX 9: prefer the canonical Session DTO entitlement (server-authoritative)
    // over the cached localStorage user. The cached copy is only a first-paint
    // hint that is replaced once /api/auth/me resolves.
    get isPremium()  {
      const s = window.Session && window.Session.getUser();
      if (s && s.entitlement) return s.entitlement.isPremium === true;
      return this.user?.isPremium === true;
    },
    get isAdmin()    {
      const s = window.Session && window.Session.getUser();
      if (s) return s.isAdmin === true || s.role === 'admin';
      return this.user?.isAdmin === true;
    },
    // token present AND not expired — used only for UX gating (not authz).
    get isLoggedIn() { const a = getAuth(); return a ? a.isLoggedIn : !!this.token; },
    save(token, user) { const a = getAuth(); if (a) a.save(token, user); else { localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user)); } },
    clear()          { const a = getAuth(); if (a) a.clear(); else localStorage.clear(); },
    async refresh()  { const a = getAuth(); if (a && a.refresh) return a.refresh(); return this.user; },
  };
})();

// ===================== AUTH GATE =====================
(function() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  // Public pages: no login required (details.html is semi-public — show content, lock premium eps)
  const publicPages = [
    'login.html','signup.html','payment-callback.html',
    'reset-password.html','forgot-password.html',
    'details.html','browse.html',''
  ];

  // When auth has just succeeded we immediately navigate to the intended home
  // (index.html or admin.html). Skip the gate so it never overrides that
  // destination with a second "already logged in -> index.html" redirect.
  const authRedirecting = sessionStorage.getItem('__authRedirecting') === '1';
  if (authRedirecting) {
    sessionStorage.removeItem('__authRedirecting');
    return;
  }

  // admin.html owns its own gate (and /admin serves admin.html). Two gates on
  // one document is how the redirect storm started — this one stands down.
  const isAdminPage = page === 'admin.html' || /^\/admin(?:\/|$)/.test(window.location.pathname);
  if (isAdminPage) return;

  const go = (dest) => (window.NavGuard ? window.NavGuard.go(dest) : (window.location.replace(dest), true));
  if (!State.isLoggedIn && !publicPages.includes(page)) {
    // Phase 1 (Item 15): guarded pages preserve the current path+search so the
    // user returns to the exact page after login.
    if (window.Navigation && window.Navigation.guardPage) {
      window.Navigation.guardPage();
    } else {
      go('login.html');
    }
    return;
  }
  if (State.isLoggedIn && (page === 'login.html' || page === 'signup.html')) { go('index.html'); }
})();

// ===================== API HELPER =====================
// The canonical apiFetch is defined in ONE place: js/api.js. config.js installs
// a thin delegate that forwards to it once js/api.js is loaded (detected via
// window.__CANONICAL_API_FETCH). Nothing here reassigns window.apiFetch — that
// would break the single-implementation contract.

// ===================== UTILS =====================
function togglePasswordVisibility(id) {
  const el = document.getElementById(id);
  if (el) el.type = el.type === 'password' ? 'text' : 'password';
}
window.togglePasswordVisibility = togglePasswordVisibility;

// ===================== PREMIUM UI =====================
// Reads State.isPremium / State.isAdmin — both prefer the server-authoritative
// Session DTO entitlement (from /api/auth/me) over the cached localStorage user.
function applyPremiumUI() {
  const user = State.user;
  if (!user) return;
  if (State.isPremium || State.isAdmin) {
    document.getElementById('premium-badge')?.style.setProperty('display','inline-flex');
    document.querySelectorAll('.upgrade-prompt').forEach(el => el.style.display = 'none');
  }
  if (State.isAdmin) {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'block');
    document.getElementById('admin-dashboard-link')?.style.setProperty('display','flex');
  }
}

// ===================== HOME PAGE =====================
let heroAnime = [];
let currentHeroIdx = 0;

// De-duplicate a candidate list against already-rendered anime ids so a single
// title does not appear in every homepage section.
function dedupeAgainst(seen, list) {
  const out = [];
  for (const a of list) {
    if (!a || a.id == null) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

async function loadHomeContent() {
  if (!document.getElementById('trending-row')) return;

  // FIX 2: Load Continue Watching first
  loadContinueWatching();

  // Helper: coerce a rating to a number (MySQL DECIMAL may come back as a
  // string; NULL/NaN must not break sorting).
  const numRating = a => Number(a && a.rating) || 0;

  // Render a row from a section array (slice to 8, guard against non-arrays).
  const renderSection = (rowId, list) => {
    if (!Array.isArray(list)) return;
    renderRow(rowId, list.slice(0, 8));
  };

  try {
    // PRIMARY: the backend section engine. One call returns all four ranked
    // rows (trending/popular/newReleases/classics), each guaranteed >= 10.
    // apiFetch returns the envelope { ok, status, data }.
    const { data: sections } = await apiFetch('/api/home/sections');

    if (sections && Array.isArray(sections.trending)) {
      // Hero slider from featured (fall back to top-rated trending).
      heroAnime = (sections.trending.filter(a => a.is_featured).slice(0,5));
      if (!heroAnime.length) heroAnime = [...sections.trending].sort((a,b) => numRating(b) - numRating(a)).slice(0,5);
      setupHeroSlider();

      renderSection('trending-row',  sections.trending);
      renderSection('popular-row',   sections.popular);
      renderSection('new-row',       sections.newReleases);
      renderSection('classics-row',  sections.classics);
      return;
    }

    // FALLBACK: only when /api/home/sections fails. Re-partition the raw
    // catalogue, but WITHOUT cross-row dedupe starvation — each row slices to
    // 8 before any dedupe, and rows are allowed to overlap (the server does).
    const { data: trending } = await apiFetch('/api/anime/trending');
    if (!Array.isArray(trending)) {
      showCatalogError('Could not connect to the server. The catalog data is currently unavailable.');
      return;
    }

    heroAnime = (trending.filter(a => a.is_featured).slice(0,5));
    if (!heroAnime.length) heroAnime = [...trending].sort((a,b) => numRating(b) - numRating(a)).slice(0,5);
    setupHeroSlider();

    // Popular — highest-rated catalogue.
    renderSection('popular-row', [...trending].sort((a,b) => numRating(b) - numRating(a)));

    // Trending Now — engagement-based: airing OR high view/daily_views.
    const trendingNow = trending
      .filter(a => a.status === 'airing' || (Number(a.daily_views) || 0) > 0 || (Number(a.view_count) || 0) > 0)
      .sort((a,b) => (Number(b.daily_views) || 0) - (Number(a.daily_views) || 0) || (Number(b.view_count) || 0) - (Number(a.view_count) || 0));
    renderSection('trending-row', trendingNow);

    // New Releases — latest uploads endpoint (independent of rating/status).
    try {
      const { data: latest } = await apiFetch('/api/anime/latest?limit=12');
      renderSection('new-row', Array.isArray(latest) ? latest : trending.filter(a => (a.year||0) >= 2020));
    } catch(e) {
      renderSection('new-row', trending.filter(a => (a.year||0) >= 2020));
    }

    // Classics — original year <= 2010 (matches the backend definition).
    renderSection('classics-row', trending.filter(a => (a.year||9999) <= 2010));
  } catch(e) {
    console.error('Home load error:', e);
    showCatalogError('Could not connect to the server. The catalog data is currently unavailable.');
  }
}

// FIX 2 + FIX 4 (Phase 3): Continue Watching rail
// Uses canonical field names: animeId, title, poster, episodeNumber,
// positionSec, durationSec, percent, resumeUrl.
async function loadContinueWatching() {
  try {
    // apiFetch returns the envelope. Real route is /api/watch/continue-watching.
    const { ok, data } = await apiFetch('/api/watch/continue-watching');
    if (!ok || !Array.isArray(data) || !data.length) return;

    const section = document.getElementById('continue-section');
    const row     = document.getElementById('continue-row');
    if (!section || !row) return;

    section.style.display = 'block';
    row.innerHTML = data.map(item => {
      const title = item.title || 'Unknown';
      const imgSrc = (item.poster && item.poster.trim())
        ? item.poster
        : makeFallbackImg(title);
      const pct = item.durationSec > 0
        ? Math.min(100, Math.max(2, ((item.positionSec || 0) / item.durationSec) * 100)).toFixed(0)
        : 0;
      const resumeUrl = item.resumeUrl || ('watch.html?id=' + item.animeId + '&ep=' + (item.episodeNumber || 1));
      return `
      <div class="card" onclick="location.href='${resumeUrl}'">
        <div class="card-img-wrap">
          <img src="${imgSrc}" alt="${window._escapeHTML(title)}" loading="lazy"
               onerror="cardImgError(this,'${_escapeHTML((title||'').replace(/'/g,"\\'"))}')">
          <span class="card-badge">▶ ${item.episodeNumber ? 'Ep ' + item.episodeNumber : ''}</span>
          <div style="position:absolute;bottom:0;left:0;right:0;height:3px;background:rgba(255,255,255,0.2);">
            <div style="height:100%;background:var(--purple);width:${pct}%"></div>
          </div>
        </div>
        <div class="card-title">${_escapeHTML(title)}</div>
        <div class="card-sub">${pct}% · Resume</div>
      </div>`;
    }).join('');
  } catch(e) {}
}

function setupHeroSlider() {
  if (!heroAnime.length) return;
  const dotsEl = document.getElementById('hero-dots');
  if (dotsEl) {
    dotsEl.innerHTML = heroAnime.map((_,i) =>
      `<button class="hero-dot ${i===0?'active':''}" onclick="setHero(${i})"></button>`
    ).join('');
  }
  setHero(0);
  setInterval(() => setHero((currentHeroIdx + 1) % heroAnime.length), 5000);
}

function setHero(i) {
  currentHeroIdx = i;
  const a = heroAnime[i];
  if (!a) return;
  const hero = document.getElementById('hero');
  // Use banner_image if available, fall back to cover_image, then a dark gradient
  const bgImg = a.banner_image || a.cover_image || '';
  if (hero) {
    if (bgImg) {
      hero.style.backgroundImage =
        `linear-gradient(to bottom, rgba(13,13,15,0.2), rgba(13,13,15,0.8) 70%, #0d0d0f 100%), url('${bgImg}')`;
    } else {
      hero.style.backgroundImage =
        `linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)`;
    }
  }
  setText('hero-title',    a.title || '');
  setText('hero-rating',   `⭐ ${a.rating}`);
  setText('hero-year',     a.year || '');
  setText('hero-episodes', a.episodes?.length ? `${a.episodes.length} Episodes` : '');
  setText('hero-desc',     window._escapeHTML((a.description||'').substring(0,160) + '...'));

  const genresEl = document.getElementById('hero-genres');
  if (genresEl && a.genres) {
    genresEl.innerHTML = a.genres.slice(0,3).map(g=>`<span class="genre-pill">${window._escapeHTML(g)}</span>`).join('');
  }
  document.getElementById('hero-watch-btn')?.setAttribute('onclick', `location.href='watch.html?id=${a.id}&ep=1'`);
  document.getElementById('hero-info-btn')?.setAttribute('onclick',  `location.href='details.html?id=${a.id}'`);
  document.querySelectorAll('.hero-dot').forEach((d,j) => d.classList.toggle('active', j===i));
}
window.setHero = setHero;

// Issue 4 fix: renderRow now uses cover_image with a styled SVG fallback
// so random "dog/clock" picsum photos never appear instead of anime art.
// The public globals are exposed by config.js and resolved through the shared runtime.

function renderRow(containerId, list) {
  const el = document.getElementById(containerId);
  if (!el || !list) return;
  if (!list.length) {
    el.innerHTML = '<p style="color:var(--text-muted);padding:10px;font-size:0.85rem;">Nothing here yet.</p>';
    return;
  }
  el.innerHTML = list.map(a => {
    const imgSrc = a.cover_image && a.cover_image.trim()
      ? a.cover_image
      : makeFallbackImg(a.title);
    return `
    <div class="card" onclick="location.href='details.html?id=${a.id}'">
      <div class="card-img-wrap">
        <img src="${imgSrc}" alt="${_escapeHTML(a.title)}" loading="lazy"
             onerror="cardImgError(this,'${_escapeHTML((a.title||'').replace(/'/g,"\\'"))}')">
        <span class="card-badge">⭐ ${a.rating || '?'}</span>
        ${a.is_premium ? '<span class="card-premium">👑</span>' : ''}
      </div>
      <div class="card-title">${_escapeHTML(a.title)}</div>
      <div class="card-sub">${_escapeHTML(a.year || '')} · ${_escapeHTML(a.status || '')}</div>
    </div>`;
  }).join('');
}

// ===================== ERROR UI & CATALOG RELOAD =====================
/**
 * Injects or shows an error banner on the home page with a reload button.
 * This provides visual feedback when the catalog fails to load.
 */
function showCatalogError(message) {
  // Remove any existing error banner
  hideCatalogError();

  // Find the main content container
  const main = document.querySelector('main.content') || document.querySelector('main') || document.body;
  if (!main) return;

  const errorDiv = document.createElement('div');
  errorDiv.id = 'catalog-error-banner';
  errorDiv.style.cssText = `
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    padding:40px 20px; text-align:center; gap:12px;
    background:var(--card-bg); border:1px solid var(--border);
    border-radius:12px; margin:20px auto; max-width:420px;
  `;
  errorDiv.innerHTML = `
    <div style="font-size:3rem;line-height:1;">⚠️</div>
    <h3 style="margin:0;font-size:1.05rem;font-weight:600;color:var(--text);">
      Could not load catalog
    </h3>
    <p style="margin:0;color:var(--text-muted);font-size:0.88rem;max-width:300px;">
      ${window._escapeHTML(message || 'Check your connection and try again.')}
    </p>
    <button id="catalog-reload-btn" onclick="reloadCatalog()"
      style="
        background:var(--purple); color:#fff; border:0; border-radius:8px;
        padding:10px 28px; font-size:0.92rem; font-weight:600; cursor:pointer;
        display:inline-flex; align-items:center; gap:8px;
        transition:opacity 0.2s;
      "
      onmouseover="this.style.opacity='0.85'"
      onmouseout="this.style.opacity='1'"
    >
      <span id="reload-btn-icon">↻</span>
      <span id="reload-btn-text">Reload Catalog</span>
    </button>
  `;

  // Insert at the top of main content (after the first child)
  const firstChild = main.firstChild;
  if (firstChild) {
    main.insertBefore(errorDiv, firstChild);
  } else {
    main.appendChild(errorDiv);
  }
}

function hideCatalogError() {
  const existing = document.getElementById('catalog-error-banner');
  if (existing) existing.remove();
}

/**
 * Reload catalog — clears caches and re-fetches all data.
 * Implements a retry loop with exponential backoff.
 * Called by the reload button in the error UI.
 */
async function reloadCatalog() {
  const btnIcon = document.getElementById('reload-btn-icon');
  const btnText = document.getElementById('reload-btn-text');
  const btn = document.getElementById('catalog-reload-btn');

  // Visual feedback: spinning icon
  if (btnIcon) btnIcon.textContent = '⏳';
  if (btnText) btnText.textContent = 'Loading...';
  if (btn) {
    btn.style.opacity = '0.7';
    btn.disabled = true;
  }

  // Clear existing content to show loading state
  const rows = ['trending-row', 'popular-row', 'new-row', 'classics-row'];
  rows.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div style="color:var(--text-muted);padding:10px;font-size:0.85rem;">⟳ Reloading...</div>';
  });

  // Hide any existing error banner
  hideCatalogError();

  // Retry loop with exponential backoff
  const MAX_RETRIES = 3;
  const BASE_DELAY = 1000; // 1 second

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Process the retry loop: a successful trending call does not guarantee
      // the /latest call also succeeds, so delegate to the single shared render
      // path (loadHomeContent) to avoid the duplicate render loop that used to
      // exist between loadHomeContent and reloadCatalog.
      await loadHomeContent();

      // Reset button
      if (btnIcon) btnIcon.textContent = '✓';
      if (btnText) btnText.textContent = 'Loaded!';
      if (btn) {
        btn.style.opacity = '1';
        btn.disabled = false;
      }

      showToast('Catalog refreshed successfully!');
      setTimeout(() => {
        if (btnIcon) btnIcon.textContent = '↻';
        if (btnText) btnText.textContent = 'Reload Catalog';
      }, 2000);

      return; // Success — exit
    } catch (err) {
      console.warn(`[Reload] Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);

      if (attempt < MAX_RETRIES) {
        // Wait with exponential backoff before retrying
        const delay = BASE_DELAY * Math.pow(2, attempt - 1);
        if (btnText) btnText.textContent = `Retrying in ${delay/1000}s...`;
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // All attempts exhausted — show error
        if (btnIcon) btnIcon.textContent = '⚠️';
        if (btnText) btnText.textContent = 'Try Again';
        if (btn) {
          btn.style.opacity = '1';
          btn.disabled = false;
        }
        showCatalogError('Could not reach the server after multiple attempts. Please check your connection.');
        showToast('Failed to load catalog. Please try again.', 'error');
      }
    }
  }
}
window.reloadCatalog = reloadCatalog;

// ===================== WATCHLIST =====================
async function addToWatchlist(animeId) {
  if (!State.isLoggedIn) { alert('Please log in first!'); return; }
  // apiFetch returns the envelope. Real route is POST /api/watchlist (there is
  // no /api/watchlist/add).
  const { data } = await apiFetch('/api/watchlist', {
    method: 'POST', body: JSON.stringify({ animeId })
  });
  // Toast notification instead of alert
  showToast((data && data.message) || 'Added to watchlist!');
}
window.addToWatchlist = addToWatchlist;

// ===================== TOAST NOTIFICATION =====================

// ===================== NAVBAR SCROLL =====================
window.addEventListener('scroll', () => {
  document.getElementById('navbar')?.classList.toggle('scrolled', window.scrollY > 20);
});

// ===================== INIT =====================
document.addEventListener('DOMContentLoaded', () => {
  applyPremiumUI();

  const user = State.user;
  if (user) {
    document.querySelectorAll('.profile-name').forEach(el => el.textContent  = user.name  || '');
    document.querySelectorAll('.profile-email').forEach(el => el.textContent = user.email || '');
    // NOTE: #profile-avatar is intentionally NOT overwritten here. The shared
    // Avatar module (js/avatar.js) owns avatar rendering and hydrates from
    // Session.refresh(), so an unconditional initials overwrite here would
    // clobber a freshly uploaded avatar. (Issue 1 fix.)
  }

  if (localStorage.getItem('isFirstVisit') === 'true') {
    const popup = document.getElementById('welcome-popup');
    if (popup) { popup.style.display = 'flex'; localStorage.removeItem('isFirstVisit'); }
  }

  loadHomeContent();
});

// ===================== AD SYSTEM (non-premium) =====================
// Shows a 15s interstitial every 10 min for logged-in non-premium, non-admin users.
(function(){
  function injectAdStyles(){
    if (document.getElementById('ad-overlay-style')) return;
    const s = document.createElement('style');
    s.id = 'ad-overlay-style';
    s.textContent = `
      .ad-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.92); z-index:99999;
        display:flex; align-items:center; justify-content:center; padding:20px; }
      .ad-card { background:#13131a; border:1px solid #2a2a35; border-radius:14px;
        max-width:420px; width:100%; padding:24px; text-align:center; color:#fff;
        box-shadow:0 20px 60px rgba(0,0,0,0.6); }
      .ad-card h3 { margin:0 0 8px; font-size:1.1rem; color:#a78bfa; }
      .ad-card p  { color:#a1a1aa; font-size:0.9rem; margin:8px 0 18px; }
      .ad-card .ad-banner { background:linear-gradient(135deg,#7c3aed,#3b82f6);
        border-radius:10px; padding:30px 16px; margin:14px 0;
        font-weight:700; font-size:1.05rem; }
      .ad-card .ad-row { display:flex; gap:8px; justify-content:center; margin-top:12px; }
      .ad-card button { border:0; border-radius:8px; padding:10px 16px; cursor:pointer;
        font-weight:600; font-size:0.9rem; }
      .ad-card .ad-skip { background:#27272f; color:#fff; }
      .ad-card .ad-skip[disabled] { opacity:0.5; cursor:not-allowed; }
      .ad-card .ad-upgrade { background:linear-gradient(135deg,#7c3aed,#a78bfa); color:#fff; }
    `;
    document.head.appendChild(s);
  }

  function showAd(){
    // NEVER show the interstitial on the watch page — it must not interrupt
    // active video playback. (The player has its own separate ad tracking.)
    const page = (window.location.pathname.split('/').pop() || 'index.html');
    if (page === 'watch.html') return;
    if (document.querySelector('.ad-overlay')) return;
    injectAdStyles();
    const overlay = document.createElement('div');
    overlay.className = 'ad-overlay';
    overlay.innerHTML = `
      <div class="ad-card">
        <h3>Sponsored</h3>
        <div class="ad-banner">🎬 Enjoying AniStrim?<br>Go ad-free with Premium</div>
        <p>AniStrim is free thanks to partners like you.</p>
        <div class="ad-row">
          <button class="ad-skip" id="ad-skip-btn" disabled>Skip in 15s</button>
          <button class="ad-upgrade" onclick="location.href='upgrade.html'">Go Premium</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // IMPORTANT: Do NOT pause any videos. Ads must never unexpectedly pause or
    // interfere with video playback. The overlay is non-blocking for media.
    let left = 15;
    const cd  = overlay.querySelector('#ad-countdown');
    const btn = overlay.querySelector('#ad-skip-btn');
    const tick = setInterval(() => {
      left--;
      if (cd)  cd.textContent  = Math.max(0, left);
      if (btn) btn.textContent = left > 0 ? `Skip in ${left}s` : 'Skip Ad';
      if (left <= 0) {
        clearInterval(tick);
        if (btn) { btn.disabled = false; btn.onclick = close; }
      }
    }, 1000);

    function close(){
      clearInterval(tick);
      overlay.remove();
    }
  }

  function startAdsIfEligible(){
    if (!State.isLoggedIn) return;
    if (State.isPremium || State.isAdmin) return;
    // Skip the watch page entirely so ads never interrupt playback.
    const page = (window.location.pathname.split('/').pop() || 'index.html');
    if (page === 'watch.html') return;
    // First ad after 10 min, then every 10 min
    setInterval(showAd, 10 * 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', startAdsIfEligible);
  // Expose for manual testing in console
  window.__showAdNow = showAd;
})();
