// scrpt.js — AniStrim2 Global Script v2
 const API = 'https://anistrimbackend.onrender.com';
const BACKEND = API; // alias used by login.js, signup.js, google-auth-handler.js

// ===================== GLOBAL STATE =====================
const State = {
  get token()     { return localStorage.getItem('token'); },
  get user()      { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } },
  get isPremium() { return this.user?.isPremium === true; },
  get isAdmin()   { return this.user?.isAdmin   === true; },
  get isLoggedIn(){ return !!this.token; },
  save(token, user) {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
  },
  clear() { localStorage.clear(); }
};

// ===================== AUTH GATE =====================
(function() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  // Public pages: no login required (details.html is semi-public — show content, lock premium eps)
  const publicPages = [
    'login.html','signup.html','payment-callback.html',
    'reset-password.html','forgot-password.html',
    'details.html','browse.html',''
  ];
  if (!State.isLoggedIn && !publicPages.includes(page)) { window.location.href = 'login.html'; return; }
  if (State.isLoggedIn && (page === 'login.html' || page === 'signup.html')) { window.location.href = 'index.html'; }
})();

// ===================== API HELPER =====================
async function apiFetch(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (State.token) headers['Authorization'] = `Bearer ${State.token}`;
  try {
    const res  = await fetch(`${API}${endpoint}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { State.clear(); window.location.href = 'login.html'; }
    return { ok: res.ok, status: res.status, data };
  } catch(e) {
    console.error('API error:', endpoint, e.message);
    return { ok: false, data: {} };
  }
}

// ===================== UTILS =====================
function toggleMenu() {
  document.getElementById('side-menu')?.classList.toggle('active');
  document.getElementById('menu-overlay')?.classList.toggle('active');
}
window.toggleMenu = toggleMenu;

function handleSignOut() { State.clear(); window.location.href = 'login.html'; }
window.handleSignOut = handleSignOut;

function togglePasswordVisibility(id) {
  const el = document.getElementById(id);
  if (el) el.type = el.type === 'password' ? 'text' : 'password';
}
window.togglePasswordVisibility = togglePasswordVisibility;

function closePopup() {
  document.getElementById('welcome-popup')?.style.setProperty('display','none');
}
window.closePopup = closePopup;

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

// ===================== PREMIUM UI =====================
function applyPremiumUI() {
  const user = State.user;
  if (!user) return;
  if (user.isPremium || user.isAdmin) {
    document.getElementById('premium-badge')?.style.setProperty('display','inline-flex');
    document.querySelectorAll('.upgrade-prompt').forEach(el => el.style.display = 'none');
  }
  if (user.isAdmin) {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'block');
    document.getElementById('admin-dashboard-link')?.style.setProperty('display','flex');
  }
}

// ===================== HOME PAGE =====================
let heroAnime = [];
let currentHeroIdx = 0;

async function loadHomeContent() {
  if (!document.getElementById('trending-row')) return;

  // FIX 2: Load Continue Watching first
  loadContinueWatching();

  try {
    const { data: all } = await apiFetch('/api/anime/trending');
    if (!Array.isArray(all)) return;

    heroAnime = all.filter(a => a.is_featured).slice(0,5);
    if (!heroAnime.length) heroAnime = [...all].sort((a,b) => b.rating - a.rating).slice(0,5);
    setupHeroSlider();

    renderRow('trending-row', all.filter(a => a.status === 'airing').slice(0,8));
    renderRow('popular-row',  [...all].sort((a,b) => b.rating - a.rating).slice(0,8));
    renderRow('new-row',      all.filter(a => (a.year||0) >= 2020).slice(0,8));
    renderRow('classics-row', all.filter(a => (a.year||9999) < 2015).slice(0,8));
  } catch(e) { console.error('Home load error:', e); }
}

// FIX 2: Continue Watching
async function loadContinueWatching() {
  try {
    const { ok, data } = await apiFetch('/api/watchlist/continue');
    if (!ok || !data.length) return;

    const section = document.getElementById('continue-section');
    const row     = document.getElementById('continue-row');
    if (!section || !row) return;

    section.style.display = 'block';
    row.innerHTML = data.map(item => {
      const imgSrc = item.cover_image && item.cover_image.trim()
        ? item.cover_image
        : makeFallbackImg(item.title);
      return `
      <div class="card" onclick="location.href='watch.html?id=${item.anime_id}&ep=${item.episode_number}'">
        <div class="card-img-wrap">
          <img src="${imgSrc}" alt="${item.title}" loading="lazy"
               onerror="cardImgError(this,'${(item.title||'').replace(/'/g,"\\'")}')">
          <span class="card-badge">⭐ ${item.rating}</span>
          <div style="position:absolute;bottom:0;left:0;right:0;height:3px;background:rgba(255,255,255,0.2);">
            <div style="height:100%;background:var(--purple);width:${Math.min((item.progress_sec/(item.duration_sec||1440))*100,100).toFixed(0)}%"></div>
          </div>
        </div>
        <div class="card-title">${item.title}</div>
        <div class="card-sub">Ep ${item.episode_number} · Resume</div>
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
  setText('hero-title',    a.title);
  setText('hero-rating',   `⭐ ${a.rating}`);
  setText('hero-year',     a.year || '');
  setText('hero-episodes', a.episodes?.length ? `${a.episodes.length} Episodes` : '');
  setText('hero-desc',     (a.description||'').substring(0,160) + '...');

  const genresEl = document.getElementById('hero-genres');
  if (genresEl && a.genres) {
    genresEl.innerHTML = a.genres.slice(0,3).map(g=>`<span class="genre-pill">${g}</span>`).join('');
  }
  document.getElementById('hero-watch-btn')?.setAttribute('onclick', `location.href='watch.html?id=${a.id}&ep=1'`);
  document.getElementById('hero-info-btn')?.setAttribute('onclick',  `location.href='details.html?id=${a.id}'`);
  document.querySelectorAll('.hero-dot').forEach((d,j) => d.classList.toggle('active', j===i));
}
window.setHero = setHero;

// Issue 4 fix: renderRow now uses cover_image with a styled SVG fallback
// so random "dog/clock" picsum photos never appear instead of anime art.
function makeFallbackImg(title) {
  // Inline SVG data-URI — dark card with anime title initial
  const letter = (title || '?').charAt(0).toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='450'>
    <rect width='300' height='450' fill='%231a1a2e'/>
    <rect x='30' y='170' width='240' height='110' rx='8' fill='%23252540'/>
    <text x='150' y='240' font-family='sans-serif' font-size='64' fill='%238b5cf6'
          text-anchor='middle' dominant-baseline='middle'>${letter}</text>
  </svg>`;
  return `data:image/svg+xml,${svg}`;
}
window.makeFallbackImg = makeFallbackImg;

function cardImgError(el, title) {
  el.onerror = null;
  el.src = makeFallbackImg(title);
}
window.cardImgError = cardImgError;

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
        <img src="${imgSrc}" alt="${a.title}" loading="lazy"
             onerror="cardImgError(this,'${(a.title||'').replace(/'/g,"\\'")}')">
        <span class="card-badge">⭐ ${a.rating || '?'}</span>
        ${a.is_premium ? '<span class="card-premium">👑</span>' : ''}
      </div>
      <div class="card-title">${a.title}</div>
      <div class="card-sub">${a.year || ''} · ${a.status || ''}</div>
    </div>`;
  }).join('');
}

// ===================== WATCHLIST =====================
async function addToWatchlist(animeId) {
  if (!State.isLoggedIn) { alert('Please log in first!'); return; }
  const { data } = await apiFetch('/api/watchlist/add', {
    method: 'POST', body: JSON.stringify({ animeId })
  });
  // Toast notification instead of alert
  showToast(data.message || 'Added to watchlist!');
}
window.addToWatchlist = addToWatchlist;

// ===================== TOAST NOTIFICATION =====================
function showToast(msg, type = 'success') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `
      position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
      background:var(--card-bg); border:1px solid var(--border);
      color:var(--text); padding:10px 20px; border-radius:8px;
      font-family:'Outfit',sans-serif; font-size:0.88rem; font-weight:500;
      z-index:9999; box-shadow:0 4px 20px rgba(0,0,0,0.4);
      transition:opacity 0.3s; pointer-events:none;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  toast.style.borderColor = type === 'error' ? '#ef4444' : 'var(--purple)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}
window.showToast = showToast;

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
    const av = document.getElementById('profile-avatar');
    if (av) av.textContent = (user.name || 'U').charAt(0).toUpperCase();
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
    if (document.querySelector('.ad-overlay')) return;
    injectAdStyles();
    const overlay = document.createElement('div');
    overlay.className = 'ad-overlay';
    overlay.innerHTML = `
      <div class="ad-card">
        <h3>Sponsored</h3>
        <div class="ad-banner">🎬 Enjoying AniStrim?<br>Go ad-free with Premium</div>
        <p>Your video will resume in <span id="ad-countdown">15</span>s</p>
        <div class="ad-row">
          <button class="ad-skip" id="ad-skip-btn" disabled>Skip in 15s</button>
          <button class="ad-upgrade" onclick="location.href='upgrade.html'">Go Premium</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Pause any playing video so ads don't talk over the show
    const vids = Array.from(document.querySelectorAll('video'));
    const wasPlaying = vids.filter(v => !v.paused);
    wasPlaying.forEach(v => v.pause());

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
      wasPlaying.forEach(v => { try { v.play(); } catch(e){} });
    }
  }

  function startAdsIfEligible(){
    if (!State.isLoggedIn) return;
    if (State.isPremium || State.isAdmin) return;
    // First ad after 10 min, then every 10 min
    setInterval(showAd, 10 * 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', startAdsIfEligible);
  // Expose for manual testing in console
  window.__showAdNow = showAd;
})();
