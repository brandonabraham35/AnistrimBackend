// watchlist.js
let watchlistData = [];
let currentFilter = 'All';

async function loadWatchlist() {
  try {
    // FIX 8 (Phase 3): apiFetch returns raw data (canonical client).
    // The server now returns camelCase: animeId, title, poster, status,
    // episodesWatched, totalEpisodes.
    const data = await window.apiFetch('/api/watchlist');
    if (!Array.isArray(data)) { renderEmpty(); return; }

    watchlistData = data.map(a => ({
      ...a,
      id: a.animeId,
      watchStatus: a.status,
      watchedEps:  a.episodesWatched,
      episodes:    a.totalEpisodes
    }));
    renderWatchlist(watchlistData);
  } catch(e) { renderEmpty(); }
}

function filterWL(status, el) {
  currentFilter = status;
  document.querySelectorAll('.wl-tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  const map = { 'Watching':'WATCHING', 'Plan to Watch':'PLAN_TO_WATCH', 'Completed':'COMPLETED', 'Dropped':'DROPPED' };
  const filtered = currentFilter === 'All' ? watchlistData : watchlistData.filter(a => a.watchStatus === map[currentFilter]);
  renderWatchlist(filtered);
}
window.filterWL = filterWL;

function renderWatchlist(list) {
  const container = document.getElementById('watchlist-list');
  const countEl   = document.getElementById('wl-count');
  if (!container) return;
  if (countEl) countEl.textContent = `${watchlistData.length} anime in your collection`;
  if (!list.length) { renderEmpty(); return; }

  const statusLabel = { WATCHING:'Watching', PLAN_TO_WATCH:'Plan to Watch', COMPLETED:'Completed', DROPPED:'Dropped', ON_HOLD:'On Hold' };
  container.innerHTML = list.map(a => `
    <div class="wl-item" onclick="location.href='details.html?id=${a.id}'">
      <div class="wl-thumb">
        <img src="${window._escapeHTML(a.poster || '')}" alt="${window._escapeHTML(a.title || '')}" onerror="this.style.opacity='0'">
      </div>
      <div class="wl-info">
        <div class="wl-title">${window._escapeHTML(a.title || '')}</div>
        <span class="wl-status-badge">${window._escapeHTML(statusLabel[a.watchStatus] || 'Plan to Watch')}</span>
        <div class="wl-progress">Ep ${a.watchedEps || 0} / ${a.episodes || '?'}</div>
      </div>
      <span class="wl-play">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </span>
    </div>
  `).join('');
}

function renderEmpty() {
  const container = document.getElementById('watchlist-list');
  const countEl   = document.getElementById('wl-count');
  if (countEl) countEl.textContent = '0 anime in your collection';
  if (container) container.innerHTML = `
    <div class="wl-empty">
      <div class="wl-empty-icon">📋</div>
      <h3>Your watchlist is empty</h3>
      <p>Start adding anime from the browse page!</p>
    </div>`;
}

document.addEventListener('DOMContentLoaded', loadWatchlist);