// browse.js — FIX 1: Search + Genre + Status filters all working
// Issue 4 fix: default view renders a bounded slice of trending (perPage=10),
// and search queries the server (debounced) instead of filtering the in-memory
// array. Results are only shown once the user types a query.
let allAnime = [];
let currentGenre  = 'All';
let currentStatus = 'all';
let currentSearch = '';
let searchTimer = null;

async function initBrowse() {
  try {
    // The backend supports page & perPage on /trending; request a bounded
    // default so the browse grid no longer dumps the whole catalogue.
    const { data, ok } = await apiFetch('/api/anime/trending?perPage=10');
    allAnime = Array.isArray(data) ? data : [];
    if (!ok || !allAnime.length) throw new Error('Empty or invalid response');
    applyFilters();
    // Hide any existing error banner
    hideBrowseError();
  } catch(e) {
    console.error('Browse init error:', e.message);
    showBrowseError('Could not load anime catalog. Please check your connection.');
  }
}
// Search — Issue 4 fix: debounce + server-side query. Empty query restores
// the trending default; results appear only once the user types.
function handleSearch(query) {
  clearTimeout(searchTimer);
  const q = (query || '').toString();
  const trimmed = q.trim();
  searchTimer = setTimeout(async () => {
    currentSearch = trimmed.toLowerCase();
    if (!trimmed) {
      // Restore the trending default view.
      await reloadBrowse();
      return;
    }
    try {
      const { data, ok } = await apiFetch('/api/anime/search/advanced?query=' + encodeURIComponent(trimmed) + '&perPage=15');
      if (!ok) throw new Error('Search failed');
      // Normalize provider results to the shapes renderBrowseGrid expects.
      const list = Array.isArray(data) ? data : (Array.isArray(data.results) ? data.results : (Array.isArray(data.data) ? data.data : []));
      renderSearchResults(list);
      hideBrowseError();
    } catch(e) {
      console.error('Browse search error:', e.message);
      // Fall back to local filtering of the loaded page so search still works
      // if the provider search endpoint is down.
      applyFilters();
    }
  }, 350);
}
window.handleSearch = handleSearch;

// Issue 4 fix: render server search results (or empty state) into the grid.
function renderSearchResults(list) {
  const grid = document.getElementById('browse-grid');
  const countEl = document.getElementById('results-count');
  const noResult = document.getElementById('no-results');
  if (!grid) return;
  if (countEl) countEl.textContent = `${list.length} result${list.length !== 1 ? 's' : ''}`;
  if (!list.length) {
    grid.innerHTML = '';
    if (noResult) noResult.style.display = 'block';
    return;
  }
  if (noResult) noResult.style.display = 'none';
  grid.innerHTML = list.map(a => {
    const cover = a.cover_image || a.coverImage || a.image || '';
    const title = a.title || a.name || 'Unknown';
    const year = a.year || a.releaseYear || a.releaseDate || '';
    const rating = a.rating || a.averageScore || '?';
    const status = a.status || '';
    const id = a.id != null ? a.id : (a.malId || (a.animeId != null ? a.animeId : ''));
    return `
    <div class="browse-card" onclick="location.href='details.html?id=${id}'">
      <div class="browse-card-img">
        <img src="${cover}" alt="${window._escapeHTML(title)}" loading="lazy"
             onerror="cardImgError(this, '${window._escapeHTML((title || '').replace(/'/g, "\\'"))}')">
        <span class="browse-card-badge">⭐ ${rating}</span>
        ${a.is_premium ? '<span class="browse-card-premium">👑 Premium</span>' : ''}
      </div>
      <div class="browse-card-title">${window._escapeHTML(title)}</div>
      <div class="browse-card-sub">${window._escapeHTML(String(year))} · ${window._escapeHTML(status)}</div>
    </div>`;
  }).join('');
}

// ── Browse Error UI & Reload ─────────────────────────
function showBrowseError(message) {
  hideBrowseError();
  const grid = document.getElementById('browse-grid');
  if (!grid) return;
  grid.innerHTML = `
    <div id="browse-error-banner" style="
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      padding:60px 20px; text-align:center; gap:14px; grid-column:1/-1;
    ">
      <div style="font-size:3rem;line-height:1;">⚠️</div>
      <h3 style="margin:0;font-size:1.05rem;font-weight:600;color:var(--text);">
        Could not load catalog
      </h3>
      <p style="margin:0;color:var(--text-muted);font-size:0.88rem;max-width:300px;">
        ${window._escapeHTML(message || 'Check your connection and try again.')}
      </p>
      <button id="browse-reload-btn" onclick="reloadBrowse()"
        style="
          background:#8b5cf6; color:#fff; border:0; border-radius:8px;
          padding:10px 28px; font-size:0.92rem; font-weight:600; cursor:pointer;
          display:inline-flex; align-items:center; gap:8px;
        "
      >
        <span id="browse-reload-icon">↻</span>
        <span id="browse-reload-text">Reload</span>
      </button>
    </div>`;
}

function hideBrowseError() {
  const el = document.getElementById('browse-error-banner');
  if (el) el.remove();
}

/**
 * Reload browse catalog with retry logic and exponential backoff.
 */
async function reloadBrowse() {
  const btn = document.getElementById('browse-reload-btn');
  const icon = document.getElementById('browse-reload-icon');
  const text = document.getElementById('browse-reload-text');

  if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; }
  if (icon) icon.textContent = '⏳';
  if (text) text.textContent = 'Loading...';
  hideBrowseError();

  const MAX_RETRIES = 3;
  const BASE_DELAY = 1000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data, ok } = await apiFetch('/api/anime/trending?perPage=10');
      if (!ok || !Array.isArray(data)) throw new Error('Invalid response');
      allAnime = data;
      applyFilters();
      if (icon) icon.textContent = '✓';
      if (text) text.textContent = 'Loaded!';
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
      setTimeout(() => {
        if (icon) icon.textContent = '↻';
        if (text) text.textContent = 'Reload';
      }, 2000);
      return;
    } catch (err) {
      console.warn(`[Browse Reload] Attempt ${attempt}/${MAX_RETRIES}:`, err.message);
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, attempt - 1);
        if (text) text.textContent = `Retrying in ${delay/1000}s...`;
        await new Promise(r => setTimeout(r, delay));
      } else {
        if (icon) icon.textContent = '⚠️';
        if (text) text.textContent = 'Try Again';
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        showBrowseError('Could not reach server after multiple attempts. Please check your connection.');
      }
    }
  }
}
window.reloadBrowse = reloadBrowse;

// Genre filter
function filterByGenre(genre, el) {
  currentGenre = genre;
  document.querySelectorAll('.genre-filters .genre-tag-btn').forEach(b => {
    if (['All','Action','Adventure','Drama','Comedy','Mystery','Sci-Fi','Supernatural'].includes(b.textContent.trim())) {
      b.classList.remove('active');
    }
  });
  if (el) el.classList.add('active');
  applyFilters();
}
window.filterByGenre = filterByGenre;

// Status filter
function filterByStatus(status, el) {
  currentStatus = status;
  document.querySelectorAll('.genre-filters .genre-tag-btn').forEach(b => {
    if (['All Status','🟢 Airing','✅ Completed','🔜 Upcoming'].includes(b.textContent.trim())) {
      b.classList.remove('active');
    }
  });
  if (el) el.classList.add('active');
  applyFilters();
}
window.filterByStatus = filterByStatus;

// Master filter function
function applyFilters() {
  let filtered = allAnime;

  if (currentGenre !== 'All') {
    filtered = filtered.filter(a =>
      a.category === currentGenre ||
      (a.genres && a.genres.some(g => g.toLowerCase() === currentGenre.toLowerCase()))
    );
  }
  if (currentStatus !== 'all') {
    filtered = filtered.filter(a => a.status === currentStatus);
  }
  if (currentSearch) {
    filtered = filtered.filter(a =>
      a.title.toLowerCase().includes(currentSearch) ||
      (a.description && a.description.toLowerCase().includes(currentSearch))
    );
  }
  renderBrowseGrid(filtered);
}

function renderBrowseGrid(list) {
  const grid     = document.getElementById('browse-grid');
  const countEl  = document.getElementById('results-count');
  const noResult = document.getElementById('no-results');
  if (!grid) return;

  if (countEl) countEl.textContent = `${list.length} result${list.length !== 1 ? 's' : ''}`;

  if (!list.length) {
    grid.innerHTML = '';
    if (noResult) noResult.style.display = 'block';
    return;
  }
  if (noResult) noResult.style.display = 'none';

  grid.innerHTML = list.map(a => `
    <div class="browse-card" onclick="location.href='details.html?id=${a.id}'">
      <div class="browse-card-img">
        <img src="${a.cover_image}" alt="${window._escapeHTML(a.title)}" loading="lazy"
             onerror="cardImgError(this, '${window._escapeHTML((a.title || '').replace(/'/g, "\\'"))}')">
        <span class="browse-card-badge">⭐ ${a.rating}</span>
        ${a.is_premium ? '<span class="browse-card-premium">👑 Premium</span>' : ''}
      </div>
      <div class="browse-card-title">${window._escapeHTML(a.title)}</div>
      <div class="browse-card-sub">${window._escapeHTML(a.year || '')} · ${window._escapeHTML(a.status || '')}</div>
    </div>
  `).join('');
}

document.addEventListener('DOMContentLoaded', initBrowse);
