// details.js — AniStrim (Updated: episodes now fetched from separate endpoint)
let currentAnime = null;

// ── Robust image helper ──────────────────────────────────
// Uses the shared fallback implementation from the consolidated frontend runtime
function safeImg(url, seed, title) {
  if (!url || url.trim() === '' || url === 'undefined') return window.AniStrimShared.makeFallbackImg(title || seed);
  return url;
}
function imgError(el, title) {
  return window.AniStrimShared.cardImgError(el, title || '?');
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
    const signalTimeout = setTimeout(() => controller.abort(), 7000);

    // Use the centralized apiFetch helper from scrpt.js
    const { ok, data } = await apiFetch(`/api/anime/${id}`, { signal: controller.signal });

    clearTimeout(signalTimeout);
    clearTimeout(timeout);

    if (!ok) throw new Error('API fetch failed');
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
    // Use the centralized apiFetch helper
    const { ok, data: all } = await apiFetch('/api/anime/trending');
    if (!ok) throw new Error('Trending fetch failed');

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

  // Use setText for year and episodes count for consistency and safety
  setText('details-year', `📅 ${a.year || 'N/A'}`);
  setText('details-eps', `📺 -- Episodes`);

  const studioEl = document.getElementById('details-studio');
  if (studioEl && a.studio) studioEl.innerHTML = `🏠 ${a.studio}`;

  const badge = document.getElementById('details-status-badge');
  if (badge) {
    badge.textContent = a.status || '';
    badge.className = `status-badge ${(a.status || '').toLowerCase()}`;
  }

  const genresEl = document.getElementById('details-genres');
  if (genresEl && Array.isArray(a.genres) && a.genres.length) {
    genresEl.innerHTML = a.genres.map(g => `<span class="genre-pill">${window._escapeHTML(g)}</span>`).join('');
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
    // CANONICAL URL: watch.html?id=<animeId>&ep=<episodeNumber>
    const watchBtn = document.getElementById('start-watching-btn');
    if (watchBtn) {
      const firstUnlocked = episodes.find(ep => !ep.is_premium || State.isPremium || State.isAdmin);
      if (firstUnlocked) {
        const epNum = firstUnlocked.episode_number || firstUnlocked.number;
        watchBtn.onclick = () => {
          location.href = `watch.html?id=${animeId}&ep=${epNum}`;
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
      const epNum = ep.number || ep.episode_number;
      return `
        <div class="episode-row ${locked ? 'episode-locked' : ''}" 
             data-locked="${locked}" data-anime-id="${animeId}" data-ep-id="${ep.id}">
          <span class="ep-num-badge">${epNum}</span>
          <span class="ep-row-title">
            ${window._escapeHTML(ep.title || 'Episode ' + epNum)}
            ${ep.is_premium ? ' <span style="color:var(--orange);font-size:0.75rem;">👑</span>' : ''}
          </span>
          ${locked ? '<span class="ep-lock-badge">🔒</span>' : '<span class="ep-play-arrow">▶</span>'}
        </div>`;
    }).join('');

    // Add a single, delegated event listener for all episode rows
    container.addEventListener('click', handleEpisodeClick);

  } catch (e) {
    console.error('fetchAndRenderEpisodes error:', e);
    container.innerHTML = `
      <p style="color:var(--text-muted);font-size:0.88rem;padding:12px 0;">
        ${window._escapeHTML('Could not load episodes.')}
        <button onclick="fetchAndRenderEpisodes('${animeId}')"
          style="background:none;border:1px solid var(--border);color:var(--purple);padding:4px 12px;border-radius:6px;cursor:pointer;margin-left:8px;font-size:0.82rem;">
          ↺ Retry
        </button>
      </p>`;
  }
}
window.fetchAndRenderEpisodes = fetchAndRenderEpisodes;

function handleEpisodeClick(event) {
  const row = event.target.closest('.episode-row');
  if (!row) return;

  const isLocked = row.dataset.locked === 'true';
  if (isLocked) {
    location.href = 'upgrade.html';
    return;
  }

  const animeId = row.dataset.animeId;
  // We need to find the episode_number from the DOM since data attribute only stores DB id
  // The episode number is displayed in .ep-num-badge
  const epNumEl = row.querySelector('.ep-num-badge');
  const epNum = epNumEl ? parseInt(epNumEl.textContent, 10) : 1;
  location.href = `watch.html?id=${animeId}&ep=${epNum}`;
}

// ── Watchlist ────────────────────────────────────────────
async function addToListFromDetails() {
  if (!currentAnime) return;
  if (!localStorage.getItem('token')) { location.href = 'login.html'; return; }
  try {
    // Use the centralized apiFetch helper
    const { ok, data } = await apiFetch('/api/watchlist/add', {
      method: 'POST',
      body: { animeId: currentAnime.id }
    });

    if (ok && typeof showToast === 'function') showToast(data.message || 'Added to list!');
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
  setText('details-desc', window._escapeHTML('Something went wrong fetching this title. Check your connection and try again.'));
  document.getElementById('start-watching-btn')?.remove();

  // Show a retry button
  const btns = document.querySelector('.details-btns');
  if (btns && id) {
    btns.innerHTML = `
      <button class="btn-primary" onclick="location.reload()">↺ Retry</button>
      <button class="btn-secondary" onclick="location.href='index.html'">← Home</button>`;
  }
}

document.addEventListener('DOMContentLoaded', loadDetails);
