// Frontend/onboarding.js — 3-step onboarding flow (Phase 2, item 2.3).
//
// Step 1: display name + username (live uniqueness check)
// Step 2: avatar (skippable)
// Step 3: genre picker (min 3)
//
// On finish → POST /api/profile/onboarding → sets onboarded_at + preferences.
document.addEventListener('DOMContentLoaded', () => {
  if (!State.isLoggedIn) {
    window.location.replace('login.html');
    return;
  }

  let currentStep = 0;
  let selectedGenres = [];
  let usernameValid = false;
  let avatarUploaded = false;

  const steps = ['step-0', 'step-1', 'step-2'];
  const dots = ['dot-0', 'dot-1', 'dot-2'];
  const errorEl = document.getElementById('ob-error');

  function showError(msg) {
    if (errorEl) { errorEl.textContent = msg || ''; }
  }

  function goToStep(n) {
    currentStep = n;
    steps.forEach((id, i) => {
      document.getElementById(id)?.classList.toggle('active', i === n);
    });
    dots.forEach((id, i) => {
      document.getElementById(id)?.classList.toggle('active', i <= n);
    });
    showError('');
  }

// ── Step 1: username live check ─────────────────────────
  const usernameInput = document.getElementById('ob-username');
  const usernameStatus = document.getElementById('ob-username-status');

  async function checkUsername() {
    const u = (usernameInput?.value || '').trim().toLowerCase();
    if (!u) { usernameValid = false; if (usernameStatus) usernameStatus.innerHTML = ''; return; }
    if (u.length < 3 || u.length > 32 || !/^[a-z0-9_]+$/.test(u)) {
      usernameValid = false;
      if (usernameStatus) usernameStatus.innerHTML = '<div class="ob-invalid">3–32 lowercase letters, numbers, or underscores.</div>';
      return;
    }
    try {
      const { ok, data: res } = await apiFetch('/api/profile/username-available?u=' + encodeURIComponent(u), { skipAuthRedirect: true });
      if (ok && res && res.available === true) {
        usernameValid = true;
        if (usernameStatus) usernameStatus.innerHTML = '<div class="ob-valid">✓ Username available</div>';
      } else {
        usernameValid = false;
        if (usernameStatus) usernameStatus.innerHTML = '<div class="ob-invalid">Username taken. Try another.</div>';
      }
    } catch (e) {
      usernameValid = false;
      if (usernameStatus) usernameStatus.innerHTML = '<div class="ob-invalid">Could not check username.</div>';
    }
  }
  window.__checkOnboardUsername = checkUsername;

  let debounceTimer;
  usernameInput?.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkUsername, 400);
  });

  // ── Step 2: avatar ──────────────────────────────────────
  document.getElementById('ob-avatar-pick')?.addEventListener('click', () => {
    document.getElementById('ob-avatar-file')?.click();
  });

  document.getElementById('ob-avatar-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) { showError('Only JPG, PNG, or WebP allowed.'); return; }
    if (file.size > 5 * 1024 * 1024) { showError('Image too large. Max 5 MB.'); return; }

    // Local preview
    const img = document.getElementById('ob-avatar-img');
    if (img) img.src = URL.createObjectURL(file);

    // Upload — apiFetch returns the envelope { ok, status, data }.
    const fd = new FormData();
    fd.append('avatar', file);
    try {
      const { data } = await apiFetch('/api/auth/avatar', { method: 'POST', body: fd });
      avatarUploaded = true;
      await Session.refresh();
      if (window.Avatar) window.Avatar.renderAvatarEverywhere(data && data.avatar_url);
      showError('');
    } catch (err) {
      showError((err && err.message) || 'Avatar upload failed.');
    }
  });

  // ── Step 3: genres ──────────────────────────────────────
  const genreGrid = document.getElementById('ob-genre-grid');
  const genreCount = document.getElementById('ob-genre-count');
  const finishBtn = document.getElementById('ob-finish');

  // Primary source is the /api/anime/genres endpoint (Bug 3). The hard-coded
  // list is ONLY a last-resort offline fallback, never the primary source.
  const FALLBACK_GENRES = ['Action','Adventure','Comedy','Drama','Fantasy','Horror','Mystery','Romance','Sci-Fi','Slice of Life','Sports','Supernatural','Thriller','Psychological'];

  async function loadGenres() {
    try {
      const { data } = await apiFetch('/api/anime/genres');
      const list = Array.isArray(data)
        ? data.map(g => (typeof g === 'string' ? g : g && g.name)).filter(Boolean)
        : (data && Array.isArray(data.genres) ? data.genres.filter(g => typeof g === 'string') : null);
      renderGenres(list && list.length ? list : FALLBACK_GENRES);
    } catch (e) {
      renderGenres(FALLBACK_GENRES);
    }
  }

  function renderGenres(genres) {
    if (!genreGrid) return;
    genreGrid.innerHTML = genres.map(g => {
      const clean = window._escapeHTML ? window._escapeHTML(g) : g;
      return `<div class="genre-chip" data-genre="${clean}">${clean}</div>`;
    }).join('');

    genreGrid.querySelectorAll('.genre-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        const g = chip.getAttribute('data-genre');
        if (chip.classList.contains('selected')) {
          selectedGenres.push(g);
        } else {
          selectedGenres = selectedGenres.filter(x => x !== g);
        }
        updateGenreUI();
      });
    });
  }

  function updateGenreUI() {
    if (genreCount) genreCount.textContent = `${selectedGenres.length} selected (min 3)`;
    if (finishBtn) finishBtn.disabled = selectedGenres.length < 3;
  }

  // ── Navigation ──────────────────────────────────────────
  document.getElementById('ob-next-0')?.addEventListener('click', () => {
    const display = document.getElementById('ob-display')?.value?.trim();
    if (!display) { showError('Please enter a display name.'); return; }
    if (!usernameValid) { showError('Please choose an available username.'); return; }
    goToStep(1);
  });
  document.getElementById('ob-prev-1')?.addEventListener('click', () => goToStep(0));
  document.getElementById('ob-next-1')?.addEventListener('click', () => goToStep(2));
  document.getElementById('ob-prev-2')?.addEventListener('click', () => goToStep(1));
  document.getElementById('ob-avatar-skip')?.addEventListener('click', () => goToStep(2));

  // ── Finish ──────────────────────────────────────────────
  finishBtn?.addEventListener('click', async () => {
    if (selectedGenres.length < 3) { showError('Select at least 3 genres.'); return; }

    // Re-check username server-side just before submit to close the TOCTOU race.
    if (usernameInput?.value?.trim()) {
      await checkUsername();
      if (!usernameValid) { showError('Please choose an available username.'); return; }
    }

    const displayName = document.getElementById('ob-display')?.value?.trim();
    const username = usernameInput?.value?.trim().toLowerCase();

    // Disable the button while the request is in flight (prevents double-submit).
    const originalText = finishBtn.textContent;
    finishBtn.disabled = true;
    finishBtn.textContent = 'Saving...';
    try {
      const { ok } = await apiFetch('/api/profile/onboarding', {
        method: 'POST',
        body: JSON.stringify({ displayName, username, genres: selectedGenres })
      });
      if (!ok) {
        finishBtn.disabled = false;
        finishBtn.textContent = originalText;
        showError('Onboarding failed. Please try again.');
        return;
      }

      await Session.refresh();
      if (window.Navigation) window.Navigation.afterAuth(Session.getUser(), 'index.html');
      else window.location.replace('index.html');
    } catch (err) {
      finishBtn.disabled = false;
      finishBtn.textContent = originalText;
      showError((err && err.message) || 'Onboarding failed. Please try again.');
    }
  });

  // Init
  loadGenres();
  goToStep(0);
});