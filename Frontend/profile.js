// profile.js — Phase 2 profile page with sections:
// Account · Subscription · Devices · Preferences · My List · Watch History · Danger zone

// ── Helpers ────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function setText(id, val) { const el = $(id); if (el) el.textContent = val || ''; }
function setHtml(id, val) { const el = $(id); if (el) el.innerHTML = val || ''; }

// ── Canonical apiFetch wrapper ─────────────────────────────
// js/api.js returns the envelope { ok, status, data }. This page's code uses
// the same { ok, status, data } shape, so apiOk is now a thin pass-through
// that keeps the catch fallback for the 429 RATE_LIMITED throw path (Bug 11).
async function apiOk(path, options) {
  try {
    const res = await window.apiFetch(path, options);
    // Envelope already carries ok/status/data. Normalize a missing status.
    return { ok: !!res.ok, status: res.status || (res.ok ? 200 : 0), data: res.data || {} };
  } catch (e) {
    // 429 RATE_LIMITED still throws ApiError (with .retryAfter).
    return {
      ok: false,
      status: (e && e.status) || 0,
      data: (e && e.data) || { message: (e && e.message) || 'Request failed' },
    };
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (e) { return iso; }
}

// ── Render avatar everywhere via the shared module ─────────
function renderAvatars(user) {
  if (!window.Avatar) return;
  const url = (user && (user.avatarUrl || user.avatar || user.avatar_url)) || null;
  const name = (user && (user.displayName || user.name)) || 'U';
  window.Avatar.renderAvatarEverywhere(url, name);
}

// ── Main load ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadProfile();
});

async function loadProfile() {
  try {
    const { ok, status, data } = await apiOk('/api/auth/me');
    if (!ok) {
      // Surface auth/API failures instead of silently rendering a blank page.
      if (status === 401) { window.location.replace('login.html'); return; }
      const msg = (data && data.message) || 'Failed to load profile.';
      console.error('[Profile] /me failed:', status, msg);
      showProfileError(msg);
      return;
    }
    const user = data;

    // Basic info
    setText('profile-name', user.displayName || user.name || '');
    setText('profile-email', user.email || '');
    setText('profile-username', user.username ? '@' + user.username : '');
    setText('profile-created', formatDate(user.createdAt));
    setText('profile-provider', (user.authProvider || 'password').charAt(0).toUpperCase() + (user.authProvider || 'password').slice(1));

    // Plan
    const badge = $('premium-badge');
    if (badge) badge.style.display = user.entitlement?.isPremium ? 'inline-flex' : 'none';

    // Subscription section
    loadSubscription(user);

    // Devices
    loadDevices();

    // Preferences
    loadPreferences(user);

    // Watch history
    loadHistory();

    // My List
    loadMyList();

    renderAvatars(user);
    if (window.Session) window.Session.refresh();
  } catch (e) {
    console.error('[Profile] load error:', e);
    showProfileError('Failed to load profile data.');
  }
}

// ── Profile error banner (Bug 11) ──────────────────────────
function showProfileError(msg) {
  let el = document.getElementById('profile-error-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'profile-error-banner';
    el.style.cssText = 'background:rgba(239,68,68,0.12);color:#f87171;border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px 16px;font-size:0.85rem;margin-bottom:16px;text-align:center;';
    const main = document.querySelector('main.profile-page') || document.body;
    main.prepend(el);
  }
  el.textContent = msg || 'Something went wrong. Please try again.';
}

// ── Subscription ───────────────────────────────────────────
async function loadSubscription(user) {
  const plan = user.entitlement?.isPremium
    ? (user.entitlement.plan || 'Standard').toUpperCase()
    : 'FREE';
  setText('sub-plan', plan);
  setText('sub-expires', user.entitlement?.expiresAt ? formatDate(user.entitlement.expiresAt) : 'N/A');
  const manageBtn = $('sub-manage');
  if (manageBtn) manageBtn.href = 'upgrade.html';
}

// ── Devices ────────────────────────────────────────────────
async function loadDevices() {
  const container = $('devices-list');
  if (!container) return;
  try {
    const { ok, data } = await apiOk('/api/auth/sessions');
    if (!ok || !data?.sessions) return;
    container.innerHTML = data.sessions.map(s => {
      const isCurrent = s.current ? ' <span style="color:var(--purple,#6c2bd9);font-size:0.75rem;">(this device)</span>' : '';
      return `
        <div class="device-item" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border,#2a2a35);">
          <div>
            <strong>${window._escapeHTML(s.deviceName || s.platform || 'Device')}</strong>${isCurrent}
            <div style="font-size:0.8rem;color:var(--text-muted,#9ca3af);">${s.platform || ''} · Last seen ${formatDate(s.lastSeenAt)}</div>
          </div>
          ${!s.current ? `<button class="btn-prev" onclick="revokeDevice('${s.id}')" style="padding:6px 12px;font-size:0.8rem;">Revoke</button>` : ''}
        </div>`;
    }).join('') || '<p style="color:var(--text-muted,#9ca3af);font-size:0.85rem;">No sessions found.</p>';
  } catch (e) {}
}

async function revokeDevice(id) {
  if (!confirm('Revoke this device session?')) return;
  try {
    await apiOk('/api/auth/sessions/' + id, { method: 'DELETE' });
    loadDevices();
  } catch (e) { alert('Could not revoke device.'); }
}
window.revokeDevice = revokeDevice;

// ── Preferences ────────────────────────────────────────────
async function loadPreferences(user) {
  const prefs = user.preferences || {};
  const setCheck = (id, val) => { const el = $(id); if (el) el.checked = !!val; };
  const setSel = (id, val) => { const el = $(id); if (el && val) el.value = val; };

  setCheck('pref-autoplay', prefs.autoplayNext);
  setCheck('pref-subtitles', prefs.subtitlesOn);
  setCheck('pref-skip-intro', prefs.skipIntroAuto);
  setCheck('pref-reduce-motion', prefs.reduceMotion);
  setSel('pref-quality', prefs.defaultQuality);
  if ($('pref-countdown')) $('pref-countdown').value = prefs.autoplayCountdown ?? 10;
  if ($('pref-rate')) $('pref-rate').value = prefs.playbackRate ?? 1;

  // Render selected genre chips
  const genreChips = $('pref-genres');
  if (genreChips) {
    genreChips.innerHTML = (prefs.genres || []).map(g =>
      `<span style="background:var(--purple,#6c2bd9);color:#fff;padding:4px 10px;border-radius:12px;font-size:0.8rem;margin:2px;">${window._escapeHTML(g)}</span>`
    ).join('') || '<p style="color:var(--text-muted,#9ca3af);font-size:0.85rem;">No genres selected.</p>';
  }

  // FIX 8: render genre multi-select for editing
  loadGenreOptions(prefs.genres || []);
}

// FIX 8: load all available genres and render a multi-select picker.
async function loadGenreOptions(selectedGenres) {
  const container = $('pref-genre-options');
  if (!container) return;
  const selected = new Set(selectedGenres || []);
  try {
    const { data } = await window.apiFetch('/api/anime/genres');
    const list = Array.isArray(data)
      ? data.map(g => (typeof g === 'string' ? g : g && g.name)).filter(Boolean)
      : (data && Array.isArray(data.genres) ? data.genres.filter(g => typeof g === 'string') : []);
    if (!list.length) return;
    container.innerHTML = list.map(g => {
      const isSel = selected.has(g);
      return `<button type="button" class="pref-genre-chip${isSel ? ' selected' : ''}" data-genre="${window._escapeHTML(g)}" onclick="togglePrefGenre(this)">${window._escapeHTML(g)}</button>`;
    }).join('');
  } catch (e) {
    // Non-fatal — genre editing is optional.
  }
}

// FIX 8: toggle a genre chip in the profile preferences.
function togglePrefGenre(btn) {
  if (!btn) return;
  btn.classList.toggle('selected');
}

// Issue 3 fix: toggle the genre multi-select picker visibility so the profile
// only shows the user's selected genres by default (not the whole catalogue).
function toggleGenreOptions() {
  const container = document.getElementById('pref-genre-options');
  const btn = document.getElementById('pref-genre-toggle');
  if (!container) return;
  const show = container.style.display === 'none' || !container.style.display;
  container.style.display = show ? 'flex' : 'none';
  if (btn) btn.textContent = show ? 'Done' : '✏️ Edit genres';
}
window.toggleGenreOptions = toggleGenreOptions;

// FIX 8: collect the currently selected genre chips.
function getSelectedPrefGenres() {
  const container = $('pref-genre-options');
  if (!container) return [];
  return [...container.querySelectorAll('.pref-genre-chip.selected')]
    .map(el => el.getAttribute('data-genre'))
    .filter(Boolean);
}
window.togglePrefGenre = togglePrefGenre;

async function savePreferences() {
  const body = {
    autoplayNext: $('pref-autoplay')?.checked,
    subtitlesOn: $('pref-subtitles')?.checked,
    skipIntroAuto: $('pref-skip-intro')?.checked,
    reduceMotion: $('pref-reduce-motion')?.checked,
    defaultQuality: $('pref-quality')?.value,
    autoplayCountdown: parseInt($('pref-countdown')?.value || '10', 10),
    playbackRate: parseFloat($('pref-rate')?.value || '1'),
    genres: getSelectedPrefGenres(),
  };
  try {
    const { ok, data } = await apiOk('/api/profile/preferences', { method: 'PUT', body: JSON.stringify(body) });
    if (ok) { showToast('Preferences saved!'); loadProfile(); }
    else alert(data?.message || 'Could not save preferences.');
  } catch (e) { alert('Could not save preferences.'); }
}
window.savePreferences = savePreferences;

// ── Watch History ──────────────────────────────────────────
// FIX 5: use the canonical /api/watch/history endpoint (returns
// animeTitle / episodeNumber / positionSec / durationSec) instead of the
// legacy continue-watching alias whose mapper read non-existent fields.
async function loadHistory() {
  const container = $('history-list');
  if (!container) return;
  try {
    const { ok, data } = await apiOk('/api/watch/history?limit=10');
    if (!ok) {
      container.innerHTML = '<p style="color:var(--text-muted,#9ca3af);font-size:0.85rem;">Could not load watch history.</p>';
      return;
    }
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    if (!items.length) {
      container.innerHTML = '<p style="color:var(--text-muted,#9ca3af);font-size:0.85rem;">No watch history.</p>';
      return;
    }
    container.innerHTML = items.map(item => {
      const title = item.animeTitle || 'Unknown';
      const ep = item.episodeNumber || '';
      const mins = Math.round((item.positionSec || 0) / 60);
      return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border,#2a2a35);">
        <a href="details.html?id=${item.animeId}" style="color:var(--text,#fff);text-decoration:none;font-size:0.9rem;">${window._escapeHTML(title)}${ep ? ' — Ep ' + ep : ''}</a>
        <span style="font-size:0.8rem;color:var(--text-muted,#9ca3af);">${mins}m watched</span>
      </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<p style="color:var(--text-muted,#9ca3af);font-size:0.85rem;">Could not load watch history.</p>';
  }
}

async function clearHistory() {
  if (!confirm('Clear all watch history?')) return;
  try {
    const { ok } = await apiOk('/api/profile/history', { method: 'DELETE' });
    if (ok) { showToast('History cleared.'); loadHistory(); }
  } catch (e) { alert('Could not clear history.'); }
}
window.clearHistory = clearHistory;

// ── My List ────────────────────────────────────────────────
async function loadMyList() {
  const container = $('mylist-list');
  if (!container) return;
  try {
    const { ok, data } = await apiOk('/api/watchlist/stats');
    if (ok) {
      const list = [];
      if (data.watching) list.push({ label: 'Watching', count: data.watching });
      if (data.completed) list.push({ label: 'Completed', count: data.completed });
      if (data.plan_to_watch) list.push({ label: 'Planned', count: data.plan_to_watch });
      container.innerHTML = list.map(x =>
        `<div style="padding:8px 0;border-bottom:1px solid var(--border,#2a2a35);font-size:0.9rem;">
           ${x.label}: <strong>${x.count}</strong>
         </div>`).join('') || '<p style="color:var(--text-muted,#9ca3af);font-size:0.85rem;">Your list is empty.</p>';
    }
  } catch (e) {}
}

// ── Danger Zone ────────────────────────────────────────────
async function deactivateAccount() {
  if (!confirm('Deactivate your account? You can reactivate later by logging in.')) return;
  try {
    const { ok } = await apiOk('/api/auth/account/deactivate', { method: 'POST' });
    if (ok) {
      if (window.Auth) window.Auth.clear();
      window.location.replace('login.html');
    }
  } catch (e) { alert('Could not deactivate account.'); }
}
window.deactivateAccount = deactivateAccount;

// FIX 11: require password confirmation before account deletion.
async function deleteAccount() {
  const password = prompt('Enter your password to confirm account deletion. This action cannot be undone.');
  if (password === null) return; // cancelled
  if (!password) { alert('Password is required to delete your account.'); return; }
  try {
    const { ok, status, data } = await apiOk('/api/auth/account/delete', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    if (ok) {
      if (window.Auth) window.Auth.clear();
      window.location.replace('login.html');
    } else if (status === 401) {
      alert(data?.message || 'Incorrect password. Account deletion cancelled.');
    } else {
      alert(data?.message || 'Could not delete account.');
    }
  } catch (e) { alert('Could not delete account.'); }
}
window.deleteAccount = deleteAccount;

// ── Avatar upload live preview ─────────────────────────────
function uploadAvatarPreview(input) {
  const file = input.files?.[0];
  if (!file) return;
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) { alert('Only JPG, PNG, or WebP allowed.'); return; }
  if (file.size > 5 * 1024 * 1024) { alert('Image too large. Max 5 MB.'); return; }

  const fd = new FormData();
  fd.append('avatar', file);
  // Instant preview
  const preview = $('profile-avatar-img');
  if (preview) preview.src = URL.createObjectURL(file);

  apiOk('/api/auth/avatar', { method: 'POST', body: fd, skipAuthRedirect: true })
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data?.message || 'Upload failed');
      // Persist the fresh avatarUrl into the stored session object so the
      // avatar survives sign-out/sign-in and page navigations. (Bug 1 fix.)
      const avatarUrl = data && (data.avatar_url || data.avatarUrl || data.avatar);
      const current = (window.Session && window.Session.getUser()) || (window.Auth && window.Auth.getUser && window.Auth.getUser()) || {};
      const fresh = { ...current, avatarUrl: avatarUrl || current.avatarUrl || null };
      if (window.Auth && window.Auth.setUser) window.Auth.setUser(fresh);
      if (window.Session && window.Session.setUser) window.Session.setUser(fresh);
      // Re-render with a cache-buster so a replaced file at the same path is
      // not served from the browser cache.
      const busted = avatarUrl ? (avatarUrl + (avatarUrl.indexOf('?') >= 0 ? '&' : '?') + 'v=' + Date.now()) : null;
      renderAvatars({ ...fresh, avatarUrl: busted, avatar: busted, avatar_url: busted });
      if (typeof showToast === 'function') showToast('Profile picture updated!');
    })
    .catch((err) => alert(err.message || 'Upload failed.'));
}
window.uploadAvatarPreview = uploadAvatarPreview;