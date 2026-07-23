// profile.js
document.addEventListener('DOMContentLoaded', async () => {
  const user = State.user;
  if (!user) return;

  const avatarEl = document.getElementById('profile-avatar');
  if (avatarEl) avatarEl.textContent = (user.name || 'U').charAt(0).toUpperCase();

  document.querySelectorAll('.profile-name').forEach(el => el.textContent = user.name || '');
  document.querySelectorAll('.profile-email').forEach(el => el.textContent = user.email || '');

  const badge = document.getElementById('premium-badge');
  if (badge) badge.style.display = user.isPremium ? 'inline-flex' : 'none';

  const adminLink = document.getElementById('admin-dashboard-link');
  if (adminLink) adminLink.style.display = user.isAdmin ? 'flex' : 'none';

  // Fetch fresh data from server
  try {
    const { ok, data } = await apiFetch('/api/auth/me');
    if (ok) {
      document.querySelectorAll('.profile-name').forEach(el => el.textContent = data.name);
      document.querySelectorAll('.profile-email').forEach(el => el.textContent = data.email);
      if (badge) badge.style.display = data.is_premium ? 'inline-flex' : 'none';
    }
  } catch(e) {}
});

// ── helper: show an image URL/blob in the avatar slot ───────────────────
function _showAvatar(src) {
  const img = document.getElementById('profile-avatar-img');
  const letter = document.getElementById('profile-avatar');
  if (img) { img.src = src; img.style.display = 'block'; }
  if (letter) letter.style.display = 'none';
}

// ── Avatar upload ─────────────────────────────────────────────────────
async function uploadAvatar(file) {
  if (!file) return;
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) { alert('Only JPG, PNG, or WebP allowed.'); return; }
  if (file.size > 15 * 1024 * 1024) { alert('Image too large. Max 15 MB.'); return; }

  // 1. Instant local preview using a blob URL — page never goes blank
  const localUrl = URL.createObjectURL(file);
  _showAvatar(localUrl);

  // 2. Upload to backend
  const fd = new FormData();
  fd.append('avatar', file);
  try {
    const token = (window.State && State.token) || localStorage.getItem('token') || sessionStorage.getItem('token') || '';
    if (!token) throw new Error('Not authenticated. Please log in again.');

    const res  = await fetch(`${API}/api/auth/avatar`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
      body:    fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Upload failed');

    // 3. Swap to the persistent server URL, then revoke the blob
    const uploadedAvatar = data.avatar_url || data.avatarUrl || data.avatar || data.imageUrl || data.image_url || data.url || data.path;
    if (!uploadedAvatar) throw new Error('Upload succeeded but server returned no avatar URL.');
    const finalUrl = uploadedAvatar.startsWith('http')
      ? uploadedAvatar
      : API + uploadedAvatar;
    _showAvatar(finalUrl);
    setTimeout(() => URL.revokeObjectURL(localUrl), 1000);

    // 4. Cache on the user object
    const user = State.user;
    if (user) {
      user.avatar = uploadedAvatar;
      user.avatar_url = uploadedAvatar;
      State.save(token, user);
    }
    if (typeof showToast === 'function') showToast('Profile picture updated!');
  } catch(e) {
    URL.revokeObjectURL(localUrl);
    alert(e.message || 'Upload failed. Please try again.');
  }
}
window.uploadAvatar = uploadAvatar;

// ── Live watchlist stats ──────────────────────────────────────────────
async function loadProfileStats() {
  try {
    const { ok, data: s } = await apiFetch('/api/watchlist/stats');
    if (!ok) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('stat-watching',  s.watching     || 0);
    set('stat-completed', s.completed    || 0);
    set('stat-planned',   s.plan_to_watch || 0);
    const wl = document.getElementById('wl-tracked');
    if (wl) wl.textContent = `${s.total || 0} anime tracked`;
  } catch(e) {}
}

// ── Load avatar from server ───────────────────────────────────────────
async function loadProfileAvatar() {
  try {
    const { ok, data } = await apiFetch('/api/auth/me');
    if (!ok || !data?.avatar_url) return;
    const url = data.avatar_url.startsWith('http') ? data.avatar_url : API + data.avatar_url;
    _showAvatar(url);
  } catch(e) {}
}

// Run on load
document.addEventListener('DOMContentLoaded', () => {
  loadProfileStats();
  loadProfileAvatar();
});
