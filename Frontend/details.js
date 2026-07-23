// details.js — AniStrim (Updated: episodes now fetched from separate endpoint)
let currentAnime = null;

// ── Robust image helper ──────────────────────────────────
function safeImg(url, seed) {
  if (!url || url.trim() === '') return `https://picsum.photos/seed/${seed}/300/450`;
  return url;
}
function imgError(el, seed) {
  el.onerror = null;
  el.src = `https://picsum.photos/seed/${seed}/300/450`;
}
window.imgError = imgError;

// ── Main loader ──────────────────────────────────────────
async function loadDetails() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) { location.href = 'index.html'; return; }

  showLoadingState();

  // Hard timeout — if nothing resolves in 8s, try the backup
  const timeout = setTimeout(() => loadFromBackup(id), 8000);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);

    const res = await fetch(
      `https://anistrimbackend.onrender.com/api/anime/${id}`,
      {
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
          'Content-Type': 'application/json'
        }
      }
    );
    clearTimeout(timer);
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    // Guard: ensure we got a real anime object back
    if (!data || typeof data !== 'object' || !data.id) throw new Error('Invalid response shape');

    currentAnime = data;
    renderDetails(currentAnime);

    // Fetch episodes from the new dedicated endpoint
    fetchAndRenderEpisodes(data.id);
  } catch (e) {
    clearTimeout(timeout);
    console.warn('Primary fetch failed, trying backup:', e.message);
    loadFromBackup(id);
  }
}

// ── Backup: scan trending list ──────────────────────────
async function loadFromBackup(id) {
  try {
    const res = await fetch('https://anistrimbackend.onrender.com/api/anime/trending');
    if (!res.ok) throw new Error(`Trending HTTP ${res.status}`);
    const all = await res.json();
    const found = Array.isArray(all) ? all.find(a => String(a.id) === String(id)) : null;
    if (found) {
      currentAnime = { ...found, episodes: [] }; // episodes not in trending; show empty list
      renderDetails(currentAnime);
      // Even backup can try to fetch episodes
      fetchAndRenderEpisodes(id);
    } else {
      showErrorState(id);
    }
  } catch (err) {
    console.error('Backup fetch failed:', err);
    showErrorState(id);
  }
}

// ── Main render ─────────────────────────────────────────
function renderDetails(a) {
  document.title = `${a.title} | AniStrim`;

  // Cover image — Issue 2 fix
  const img = document.getElementById('details-img');
  if (img) {
    img.src = safeImg(a.cover_image, a.id);
    img.alt = a.title;
    img.onerror = () => imgError(img, a.id);
  }

  // Text fields — Issue 1 fix
  setText('details-title',    a.title || 'Unknown Title');
  setText('details-jp-title', a.title_japanese || '');
  setText('details-rating',   `⭐ ${a.rating || '0.0'}`);
  setText('details-desc',     a.description || 'No description available.');

  const yearEl = document.getElementById('details-year');
  if (yearEl) yearEl.innerHTML = `📅 ${a.year || 'N/A'}`;

  const epsEl = document.getElementById('details-eps');
  if (epsEl) epsEl.innerHTML = `📺 -- Episodes`;

  const studioEl = document.getElementById('details-studio');
  if (studioEl && a.studio) studioEl.innerHTML = `🏠 ${a.studio}`;

  const badge = document.getElementById('details-status-badge');
  if (badge) {
    badge.textContent = a.status || '';
    badge.className = `status-badge ${(a.status || '').toLowerCase()}`;
  }

  const genresEl = document.getElementById('details-genres');
  if (genresEl && Array.isArray(a.genres) && a.genres.length) {
    genresEl.innerHTML = a.genres.map(g => `<span class="genre-pill">${g}</span>`).join('');
  }
}

// ── Fetch & render episodes from dedicated endpoint ────
async function fetchAndRenderEpisodes(animeId) {
  const container = document.getElementById('episode-list');
  if (!container) return;

  // Show a loading spinner inside the episode area
  container.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;padding:12px 0;">Loading episodes...</p>';

  try {
    const { ok, data } = await apiFetch(`/api/anime/${animeId}/episodes`);

    if (!ok || !Array.isArray(data)) {
      throw new Error('Invalid episodes response');
    }

    const episodes = data;

    // Update episode count in meta bar
    const epsEl = document.getElementById('details-eps');
    if (epsEl) {
      epsEl.innerHTML = `📺 ${episodes.length} Episode${episodes.length !== 1 ? 's' : ''}`;
    }

    // Empty state
    if (!episodes.length) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;padding:12px 0;">No episodes available yet.</p>';
      return;
    }

    // ── Set "Start Watching" button to first unlocked episode ──
    const watchBtn = document.getElementById('start-watching-btn');
    if (watchBtn) {
      const firstUnlocked = episodes.find(ep => !ep.is_premium || State.isPremium || State.isAdmin);
      if (firstUnlocked) {
        watchBtn.onclick = () => {
          location.href = `watch.html?animeId=${animeId}&epId=${firstUnlocked.id}`;
        };
      } else {
        // All episodes are premium-locked for this user
        watchBtn.onclick = () => { location.href = 'upgrade.html'; };
        watchBtn.textContent = '👑 Upgrade to Watch';
      }
    }

    // ── Build episode rows ──
    container.innerHTML = episodes.map(ep => {
      const locked = ep.is_premium && !State.isPremium && !State.isAdmin;
      return `
        <div class="episode-row ${locked ? 'episode-locked' : ''}"
             onclick="${locked
                ? "location.href='upgrade.html'"
                : `location.href='watch.html?animeId=${animeId}&epId=${ep.id}'`}">
          <span class="ep-num-badge">${ep.episode_number}</span>
          <span class="ep-row-title">
            ${ep.title || 'Episode ' + ep.episode_number}
            ${ep.is_premium ? ' <span style="color:var(--orange);font-size:0.75rem;">👑</span>' : ''}
          </span>
          ${locked
            ? '<span class="ep-lock-badge">🔒</span>'
            : '<span class="ep-play-arrow">▶</span>'}
        </div>`;
    }).join('');

  } catch (e) {
    console.error('fetchAndRenderEpisodes error:', e);
    container.innerHTML = `
      <p style="color:var(--text-muted);font-size:0.88rem;padding:12px 0;">
        Could not load episodes.
        <button onclick="fetchAndRenderEpisodes('${animeId}')"
          style="background:none;border:1px solid var(--border);color:var(--purple);padding:4px 12px;border-radius:6px;cursor:pointer;margin-left:8px;font-size:0.82rem;">
          ↺ Retry
        </button>
      </p>`;
  }
}
window.fetchAndRenderEpisodes = fetchAndRenderEpisodes;

// ── Watchlist ────────────────────────────────────────────
async function addToListFromDetails() {
  if (!currentAnime) return;
  if (!localStorage.getItem('token')) { location.href = 'login.html'; return; }
  try {
    const res = await fetch(
      'https://anistrimbackend.onrender.com/api/watchlist/add',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ animeId: currentAnime.id })
      }
    );
    const data = await res.json();
    if (typeof showToast === 'function') showToast(data.message || 'Added to list!');
    else alert(data.message || 'Added to list!');
  } catch (e) { console.error('Watchlist error:', e); }
}
window.addToListFromDetails = addToListFromDetails;

// ── UI state helpers ─────────────────────────────────────
function showLoadingState() {
  setText('details-title', 'Loading...');
  setText('details-desc',  'Loading description...');
  const img = document.getElementById('details-img');
  if (img) img.src = '';
}

function showErrorState(id) {
  setText('details-title', 'Could Not Load Anime');
  setText('details-desc',  'Something went wrong fetching this title. Check your connection and try again.');
  document.getElementById('start-watching-btn')?.remove();

  // Show a retry button
  const btns = document.querySelector('.details-btns');
  if (btns && id) {
    btns.innerHTML = `
      <button class="btn-primary" onclick="location.reload()">↺ Retry</button>
      <button class="btn-secondary" onclick="location.href='index.html'">← Home</button>`;
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

document.addEventListener('DOMContentLoaded', loadDetails);
