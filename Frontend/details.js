// details.js — AniStrim (Updated: episodes rendered from payload + refresh endpoint)
// Prompt 6: frontend gating is COSMETIC ONLY. The server is the boundary.
// The frontend reads ONLY the server-emitted fields effectiveTier / locked /
// availableAt / accessState — never is_premium, never localStorage, never a
// JWT claim.
let currentAnime = null;
let currentStatus = null; // last non-2xx status (for error reporting)

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

// ── Access-state helpers (server-authoritative) ──────────
// The server emits accessState per episode. The frontend maps it to a label
// and a lock decision. These helpers are the ONLY place the UI reads access.
function episodeIsLocked(ep) {
  // Server says locked — trust it. Fall back to effectiveTier for safety.
  if (ep && typeof ep.locked === 'boolean') return ep.locked;
  return !!(ep && ep.effectiveTier === 'premium');
}

function episodeAccessLabel(ep) {
  const state = (ep && ep.accessState) || (ep && ep.effectiveTier === 'premium' ? 'premium_required' : 'free');
  switch (state) {
    case 'free':            return 'Free';
    case 'premium':         return 'Premium';
    case 'in_grace':        return 'In grace period';
    case 'subscription_expired': return 'Subscription expired';
    case 'scheduled': {
      const d = ep && ep.availableAt ? new Date(ep.availableAt) : null;
      if (d && !isNaN(d.getTime())) {
        return 'Free on ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      }
      return 'Scheduled release';
    }
    case 'premium_required':
    default:                return 'Premium required';
  }
}

function episodeAccessClass(ep) {
  const state = (ep && ep.accessState) || (ep && ep.effectiveTier === 'premium' ? 'premium_required' : 'free');
  return 'access-' + state;
}

// ── Main loader ──────────────────────────────────────────
async function loadDetails() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) { location.href = 'index.html'; return; }

  showLoadingState();

  // Hard timeout — if nothing resolves in 10s, surface a network-error state
  // (does NOT mask real 4xx/5xx; it fires only when the fetch never resolves).
  const timeout = setTimeout(() => {
    if (!currentAnime) showErrorState(id, 0, 'Request timed out. Please check your connection.');
  }, 10000);

  try {
    const controller = new AbortController();
    const signalTimeout = setTimeout(() => controller.abort(), 7000);

    // Use the centralized apiFetch helper (returns envelope { ok, status, data })
    const res = await apiFetch(`/api/anime/${id}`, { signal: controller.signal });

    clearTimeout(signalTimeout);
    clearTimeout(timeout);

    if (res.timedOut) {
      // Real network timeout — surface it (status 0).
      console.error('[Details] Timed out loading anime', { id, status: res.status });
      showErrorState(id, 0, 'Timed out loading anime data. Please check your connection and retry.');
      return;
    }

    if (!res.ok) {
      // Real HTTP error — report status + server message, no trending fallback.
      currentStatus = res.status;
      const serverMsg = (res.data && res.data.error) || (res.data && res.data.message) || 'Could not load this title.';
      console.error('[Details] Failed to load anime', { id, status: res.status, data: res.data });
      showErrorState(id, res.status, serverMsg);
      return;
    }

    const data = res.data || {};
    // Guard: ensure we got a real anime object back
    if (!data || typeof data !== 'object' || !data.id) {
      showErrorState(id, 0, 'Invalid response shape from server.');
      return;
    }

    currentAnime = data;
    renderDetails(currentAnime);

    // Render episodes from the payload immediately (getById returns episodes[]),
    // then refine via the dedicated endpoint. A single endpoint failure must
    // NOT blank the episode section.
    const payloadEpisodes = Array.isArray(data.episodes) ? data.episodes : [];
    if (payloadEpisodes.length) {
      renderEpisodeRows(data.id, payloadEpisodes);
    }

    // Refresh / refine from the dedicated endpoint (best-effort).
    fetchAndRenderEpisodes(data.id);
  } catch (e) {
    clearTimeout(timeout);
    console.error('[Details] loadDetails error:', e);
    showErrorState(id, 0, 'Could not load anime data. Please check your connection and retry.');
  }
}

// ── No backup trending-scan fallback for HTTP errors ─────
// In FIX 2 we REMOVE the loadFromBackup trending-scan path entirely.
// The previous version hid real 404/500 responses behind a "backup" that
// re-scanned the trending list and silently failed to find the title, leaving
// a false "Could Not Load Anime". Now genuine network failures (status 0 /
// timeout) show a clear, retryable network-error state; real HTTP errors show
// their actual status + message.

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

  // ── Render the real episode count from the payload immediately ──
  // No hardcoded '-- Episodes'. getById returns episodes[], so we show the
  // real count now; fetchAndRenderEpisodes will refine it (and may add the
  // per-episode rows + Start Watching button).
  const epCount = Array.isArray(a.episodes) ? a.episodes.length : 0;
  setText('details-year', `📅 ${a.year || 'N/A'}`);
  setText('details-eps', `📺 ${epCount} Episode${epCount !== 1 ? 's' : ''}`);

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

// ── Render episode rows (shared by payload render + refresh) ──
// Extracted so both the initial payload render and the /episodes refresh use
// the exact same row-building + Start Watching logic.
function renderEpisodeRows(animeId, episodes) {
  const container = document.getElementById('episode-list');
  if (!container) return;

  const list = Array.isArray(episodes) ? episodes : [];

  // ── Set "Start Watching" button to first unlocked episode ──
  // CANONICAL URL: watch.html?id=<animeId>&ep=<episodeNumber>
  // Prompt 6: unlocked = server says NOT locked. Never read is_premium.
  const watchBtn = document.getElementById('start-watching-btn');
  if (watchBtn) {
    const firstUnlocked = list.find(ep => !episodeIsLocked(ep));
    if (firstUnlocked) {
      const epNum = firstUnlocked.episode_number || firstUnlocked.number;
      watchBtn.onclick = () => {
        location.href = `watch.html?id=${animeId}&ep=${epNum}`;
      };
    } else {
      // All episodes are locked for this user
      watchBtn.onclick = () => { location.href = 'upgrade.html'; };
      watchBtn.textContent = '👑 Upgrade to Watch';
    }
  }

  if (!list.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;padding:12px 0;">No episodes available yet.</p>';
    return;
  }

  // Update episode count in meta bar.
  const epsEl = document.getElementById('details-eps');
  if (epsEl) {
    epsEl.innerHTML = `📺 ${list.length} Episode${list.length !== 1 ? 's' : ''}`;
  }

  // ── Build episode rows ──
  container.innerHTML = list.map(ep => {
    const locked = episodeIsLocked(ep);
    const epNum = ep.number || ep.episode_number;
    const label = episodeAccessLabel(ep);
    const accessClass = episodeAccessClass(ep);
    const isPremiumTier = ep.effectiveTier === 'premium';
    return `
      <div class="episode-row ${locked ? 'episode-locked' : ''} ${accessClass}"
           data-locked="${locked}" data-anime-id="${animeId}" data-ep-id="${ep.id}">
        <span class="ep-num-badge">${epNum}</span>
        <span class="ep-row-title">
          ${window._escapeHTML(ep.title || 'Episode ' + epNum)}
          ${isPremiumTier ? ' <span style="color:var(--orange);font-size:0.75rem;">👑</span>' : ''}
        </span>
        <span class="ep-access-label">${window._escapeHTML(label)}</span>
        ${locked ? '<span class="ep-lock-badge">🔒</span>' : '<span class="ep-play-arrow">▶</span>'}
      </div>`;
  }).join('');

  // ── Attach the delegated click listener exactly ONCE ──
  // Guard with a data-bound flag so repeated renderEpisodeRows / Retry calls
  // never stack a second handleEpisodeClick (one tap = one navigation).
  if (!container.dataset.bound) {
    container.addEventListener('click', handleEpisodeClick);
    container.dataset.bound = '1';
  }
}

// ── Fetch & refine episodes from dedicated endpoint ────
// The payload already rendered rows; this endpoint is a REFRESH. A failure
// must NOT blank the section (it shows the inline error + Retry which
// re-runs just this refresh).
async function fetchAndRenderEpisodes(animeId) {
  const container = document.getElementById('episode-list');
  if (!container) return;

  // If we already rendered payload rows, keep them visible while we refresh.
  const hadRows = container.querySelector('.episode-row');
  if (!hadRows) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;padding:12px 0;">Loading episodes...</p>';
  }

  try {
    const res = await apiFetch(`/api/anime/${animeId}/episodes`);

    if (!res.ok) {
      console.error('[Details] Episode refresh failed', { animeId, status: res.status, data: res.data });
      // If we have payload rows, keep them — the refresh failure is non-fatal.
      if (hadRows) return;
      container.innerHTML = `
        <p style="color:var(--text-muted);font-size:0.88rem;padding:12px 0;">
          ${window._escapeHTML('Could not load episodes.')}
          <button onclick="fetchAndRenderEpisodes('${animeId}')"
            style="background:none;border:1px solid var(--border);color:var(--purple);padding:4px 12px;border-radius:6px;cursor:pointer;margin-left:8px;font-size:0.82rem;">
            ↺ Retry
          </button>
        </p>`;
      return;
    }

    const episodes = Array.isArray(res.data) ? res.data : [];
    renderEpisodeRows(animeId, episodes);
  } catch (e) {
    console.error('[Details] fetchAndRenderEpisodes error:', e);
    if (hadRows) return;
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
  if (!(window.Auth && window.Auth.token)) { location.href = 'login.html'; return; }
  try {
    // Use the centralized apiFetch helper (returns envelope)
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

function showErrorState(id, status, message) {
  currentStatus = status || 0;
  // Name the real signal: HTTP status + server message where available.
  const statusText = status
    ? ` (HTTP ${status})`
    : ' (network error)';
  setText('details-title', 'Could Not Load Anime');
  setText('details-desc', window._escapeHTML((message || 'Something went wrong fetching this title.') + statusText));
  document.getElementById('start-watching-btn')?.remove();

  // Show retry (re-runs the ORIGINAL load — now it can actually succeed).
  const btns = document.querySelector('.details-btns');
  if (btns && id) {
    btns.innerHTML = `
      <button class="btn-primary" onclick="location.reload()">↺ Retry</button>
      <button class="btn-secondary" onclick="location.href='index.html'">← Home</button>`;
  }
}

document.addEventListener('DOMContentLoaded', loadDetails);
