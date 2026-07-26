// watchlist.js
let watchlistData = [];
let currentFilter = 'All';

async function loadWatchlist() {
  try {
    const { ok, data } = await apiFetch('/api/watchlist');
    if (!ok) { renderEmpty(); return; }

    watchlistData = data.map(a => ({
      ...a,
      id: a.anime_id,
      watchStatus: a.watch_status,
      watchedEps:  a.episodes_watched,
      episodes:    a.total_episodes
    }));
    renderWatchlist(watchlistData);
  } catch(e) { renderEmpty(); }
}

function filterWL(status, el) {
  currentFilter = status;
  document.querySelectorAll('.wl-tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  const map = { 'Watching':'watching', 'Plan to Watch':'plan_to_watch', 'Completed':'completed', 'Dropped':'dropped' };
  const filtered = currentFilter === 'All' ? watchlistData : watchlistData.filter(a => a.watch_status === map[currentFilter]);
  renderWatchlist(filtered);
}
window.filterWL = filterWL;

function renderWatchlist(list) {
  const container = document.getElementById('watchlist-list');
  const countEl   = document.getElementById('wl-count');
  if (!container) return;
  if (countEl) countEl.textContent = `${watchlistData.length} anime in your collection`;
  if (!list.length) { renderEmpty(); return; }

  const statusLabel = { watching:'Watching', plan_to_watch:'Plan to Watch', completed:'Completed', dropped:'Dropped' };
  container.innerHTML = list.map(a => `
    <div class="wl-item" onclick="location.href='details.html?id=${a.id}'">
      <div class="wl-thumb">
        <img src="${a.cover_image}" alt="${a.title}" onerror="this.style.opacity='0'">
      </div>
      <div class="wl-info">
        <div class="wl-title">${a.title}</div>
        <span class="wl-status-badge">${statusLabel[a.watch_status] || 'Plan to Watch'}</span>
        <div class="wl-progress">Ep ${a.episodes_watched || 0} / ${a.total_episodes || '?'}</div>
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
