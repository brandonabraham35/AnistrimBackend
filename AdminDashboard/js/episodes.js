// AdminDashboard/js/episodes.js — Complete rewrite
// Uses shared.js for: _escapeHTML, showToast, _debounce, _confirm, ModalManager, SkeletonLoader, EmptyState, ErrorState, Badge, DataTable

(function() {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  let _currentAnimeId = null;
  let _currentAnimeTitle = '';
  let _episodesEditId = null;
  let _episodesData = [];
  let _animeList = [];

  // ─── DOM Cache ──────────────────────────────────────────────────────────
  function _$el(id) { return document.getElementById(id); }

  // ─── Initialization ─────────────────────────────────────────────────────
  function initializeEpisodesSection() {
    console.log('[Episodes] Initializing...');

    _setupEventListeners();
    _loadAnimeList();
    _loadAllEpisodes();

    // Expose manageEpisodes for anime.js to call
    window.manageEpisodes = function(animeId, animeTitle) {
      _currentAnimeId = animeId;
      _currentAnimeTitle = animeTitle || '';
      const titleEl = document.getElementById('current-anime-title');
      if (titleEl) titleEl.textContent = animeTitle ? `Episodes: ${window._escapeHTML(animeTitle)}` : 'All Episodes';
      _loadAllEpisodes();
    };
  }

  // ─── Event Listeners ────────────────────────────────────────────────────
  function _setupEventListeners() {
    // Add Episode button
    _$el('add-episode-button')?.addEventListener('click', () => _openEpisodeModal(null));

    // Bulk delete
    _$el('bulkDeleteBtn-episodes')?.addEventListener('click', _handleBulkDelete);

    // Select all
    _$el('selectAll-episodes')?.addEventListener('change', (e) => {
      const checked = e.target.checked;
      document.querySelectorAll('.episode-select-checkbox').forEach(cb => {
        cb.checked = checked;
      });
      _updateBulkDeleteButton();
    });

    // Table delegation (edit, delete, checkbox)
    _$el('episodes-table')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-action');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.classList.contains('edit')) {
        _openEpisodeModal(id);
      } else if (btn.classList.contains('delete')) {
        _deleteEpisode(id);
      }
    });

    _$el('episodes-table')?.addEventListener('change', (e) => {
      if (e.target.closest('.episode-select-checkbox')) {
        _updateBulkDeleteButton();
      }
    });

    // Episode Modal events
    _$el('close-episode-modal')?.addEventListener('click', _closeEpisodeModal);
    _$el('episode-modal')?.addEventListener('click', (e) => {
      if (e.target === _$el('episode-modal')) _closeEpisodeModal();
    });
    _$el('episode-form')?.addEventListener('submit', _handleFormSubmit);

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') _closeEpisodeModal();
    });
  }

  // ─── Data Loading ───────────────────────────────────────────────────────
  async function _loadAnimeList() {
    try {
      const data = await window.apiRequest('/api/admin/anime?limit=1000');
      // unwrapAdminEnvelope exposes .items/.rows for paginated responses
      _animeList = data.items || data.rows || data || [];
    } catch (e) {
      console.warn('[Episodes] Could not load anime list:', e.message);
    }
  }

  async function _loadAllEpisodes() {
    const tbody = _$el('episodes-table')?.querySelector('tbody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="7">' + window.SkeletonLoader.table(5, 7) + '</td></tr>';

    try {
      let data;
      if (_currentAnimeId) {
        data = await window.apiRequest(`/api/admin/anime/${_currentAnimeId}/episodes`);
      } else {
        data = await window.apiRequest('/api/admin/episodes');
      }
      // unwrapAdminEnvelope exposes .items/.rows for array responses
      _episodesData = Array.isArray(data) ? data : (data.items || data.rows || []);
      _renderEpisodes(tbody);
    } catch (error) {
      console.error('[Episodes] Failed to load:', error);
      tbody.innerHTML = '<tr><td colspan="7">' + window.ErrorState.render({
        message: 'Failed to load episodes',
        retryFn: () => _loadAllEpisodes()
      }) + '</td></tr>';
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────
  function _renderEpisodes(tbody) {
    if (!tbody) tbody = _$el('episodes-table')?.querySelector('tbody');
    if (!tbody) return;

    if (_episodesData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7">' + window.EmptyState.render({
        icon: '🎬',
        title: 'No Episodes Found',
        description: _currentAnimeId ? 'This anime has no episodes yet.' : 'No episodes in the database.',
        actionText: '+ Add Episode',
        actionFn: () => _openEpisodeModal(null)
      }) + '</td></tr>';
      return;
    }

    tbody.innerHTML = _episodesData.map(ep => {
      const thumbnail = ep.thumbnail_url
        ? `<img src="${ep.thumbnail_url}" alt="" style="width:60px;height:40px;object-fit:cover;border-radius:4px;" loading="lazy">`
        : '<span style="color:var(--text-muted);font-size:0.75rem;">No thumb</span>';
      return `<tr>
        <td><input type="checkbox" class="episode-select-checkbox" data-id="${ep.id}"></td>
        <td>${window._escapeHTML(ep.anime_title || '—')}</td>
        <td>${ep.episode_number || '-'}</td>
        <td>${thumbnail}</td>
        <td>${window._escapeHTML(ep.title || 'Untitled')}</td>
        <td>${ep.duration_sec ? Math.floor(ep.duration_sec / 60) + 'm ' + (ep.duration_sec % 60) + 's' : '—'}</td>
        <td>${window.Badge.premium(ep.is_premium)}</td>
        <td>${(ep.view_count || 0).toLocaleString()}</td>
        <td style="white-space:nowrap;">
          <button class="btn-action edit" data-id="${ep.id}" title="Edit Episode"><i class="fas fa-edit"></i></button>
          <button class="btn-action delete" data-id="${ep.id}" title="Delete Episode"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');

    _updateBulkDeleteButton();
  }

  function _updateBulkDeleteButton() {
    const selected = document.querySelectorAll('.episode-select-checkbox:checked');
    const btn = _$el('bulkDeleteBtn-episodes');
    const countEl = _$el('selectedCount-episodes');
    if (btn && countEl) {
      if (selected.length > 0) {
        btn.style.display = 'inline-block';
        countEl.textContent = selected.length;
      } else {
        btn.style.display = 'none';
      }
    }
  }

  // ─── Episode Modal ──────────────────────────────────────────────────────
  function _openEpisodeModal(id) {
    _episodesEditId = id;
    const modal = _$el('episode-modal');
    const title = modal?.querySelector('.modal-title');
    const form = _$el('episode-form');

    if (!modal || !form) {
      window.showToast?.('Episode modal is not available in the HTML.', 'error');
      return;
    }

    form.reset();

    // P2: ensure the Access + Premium-duration controls exist (added once).
    _ensureAccessControls(form);

    // Populate anime dropdown
    const animeSelect = form.querySelector('#ep-anime-id');
    if (animeSelect) {
      animeSelect.innerHTML = '<option value="">Select Anime</option>' +
        _animeList.map(a => `<option value="${a.id}">${window._escapeHTML(a.title)}</option>`).join('');
      if (_currentAnimeId) animeSelect.value = _currentAnimeId;
    }

    if (id) {
      // Edit mode
      title.textContent = 'Edit Episode';
      const ep = _episodesData.find(e => String(e.id) === String(id));
      if (!ep) {
        window.showToast?.('Episode not found.', 'error');
        return;
      }
      form.querySelector('#ep-number').value = ep.episode_number || '';
      form.querySelector('#ep-title').value = ep.title || '';
      form.querySelector('#ep-description').value = ep.description || '';
      form.querySelector('#ep-duration').value = ep.duration_sec || '';
      form.querySelector('#ep-video-url').value = ep.video_url || '';
      form.querySelector('#ep-thumbnail-url').value = ep.thumbnail_url || '';
      form.querySelector('#ep-is-premium').checked = !!ep.is_premium;
      const tierSel = form.querySelector('#ep-access-tier');
      if (tierSel && ep.access_tier) tierSel.value = ['inherit','free','premium'].includes(ep.access_tier) ? ep.access_tier : 'inherit';
      if (animeSelect) animeSelect.value = ep.anime_id || _currentAnimeId;
    } else {
      title.textContent = 'Add Episode';
    }

    modal.hidden = false;
  }

  function _closeEpisodeModal() {
    const modal = _$el('episode-modal');
    if (modal) modal.hidden = true;
    _episodesEditId = null;
  }

  // ─── Form Submit ────────────────────────────────────────────────────────
  async function _handleFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const episodeNumber = parseInt(form.querySelector('#ep-number').value, 10);
    const animeId = form.querySelector('#ep-anime-id')?.value || _currentAnimeId;

    if (!animeId) {
      window.showToast?.('Please select an anime.', 'error');
      return;
    }
    if (!episodeNumber || isNaN(episodeNumber)) {
      window.showToast?.('Episode number is required.', 'error');
      return;
    }

    const body = {
      episode_number: episodeNumber,
      title: form.querySelector('#ep-title').value || null,
      description: form.querySelector('#ep-description').value || null,
      duration_sec: parseInt(form.querySelector('#ep-duration').value, 10) || null,
      video_url: form.querySelector('#ep-video-url').value || null,
      thumbnail_url: form.querySelector('#ep-thumbnail-url').value || null,
      is_premium: form.querySelector('#ep-is-premium').checked ? '1' : '0',
      access_tier: form.querySelector('#ep-access-tier')?.value || 'inherit',
      premium_duration: form.querySelector('#ep-premium-duration')?.value || 'permanent',
    };

    try {
      if (_episodesEditId) {
        await window.apiRequest(`/api/admin/episodes/${_episodesEditId}`, { method: 'PUT', body });
        window.showToast?.('Episode updated.', 'success');
      } else {
        await window.apiRequest(`/api/admin/anime/${animeId}/episodes`, { method: 'POST', body });
        window.showToast?.('Episode created.', 'success');
      }
      _closeEpisodeModal();
      await _loadAllEpisodes();
    } catch (error) {
      window.showToast?.(`Failed to save episode: ${error.message}`, 'error');
    }
  }

  // P2: one-step publish access controls (Access + Premium duration). Injected
  // into the episode form once so the existing modal markup needs no editing.
  function _ensureAccessControls(form) {
    if (form.querySelector('#ep-access-tier')) return;
    const container = form.querySelector('#ep-is-premium')?.closest('.form-group, div') ||
                      form.querySelector('.modal-body, .modal-content') || form;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;margin:10px 0;';
    row.innerHTML =
      '<div><label>Access</label>' +
      '<select id="ep-access-tier" style="padding:8px;border-radius:6px;border:1px solid var(--border,#333);background:var(--bg,#121218);color:#fff;">' +
      '<option value="inherit">Inherit from Anime</option>' +
      '<option value="free">Free</option>' +
      '<option value="premium">Premium</option>' +
      '</select></div>' +
      '<div><label>Premium duration</label>' +
      '<select id="ep-premium-duration" style="padding:8px;border-radius:6px;border:1px solid var(--border,#333);background:var(--bg,#121218);color:#fff;">' +
      '<option value="permanent">Permanent</option>' +
      '<option value="24h">24 hours</option>' +
      '<option value="48h">48 hours</option>' +
      '<option value="72h">72 hours</option>' +
      '<option value="7d">7 days</option>' +
      '</select></div>';
    container.parentNode ? container.parentNode.insertBefore(row, container.nextSibling) : container.appendChild(row);
  }

  // ─── Delete Episode ─────────────────────────────────────────────────────
  async function _deleteEpisode(id) {
    const ep = _episodesData.find(e => String(e.id) === String(id));
    const confirmed = await window._confirm(
      'Delete Episode',
      `Delete episode "${ep?.title || '#' + id}"? This cannot be undone.`,
      'Delete',
      'Cancel'
    );
    if (!confirmed) return;

    try {
      await window.apiRequest(`/api/admin/episodes/${id}`, { method: 'DELETE' });
      _episodesData = _episodesData.filter(e => String(e.id) !== String(id));
      _renderEpisodes();
      window.showToast?.('Episode deleted.', 'success');
    } catch (error) {
      window.showToast?.(`Delete failed: ${error.message}`, 'error');
    }
  }

  // ─── Bulk Delete ────────────────────────────────────────────────────────
  async function _handleBulkDelete() {
    const selected = document.querySelectorAll('.episode-select-checkbox:checked');
    const ids = Array.from(selected).map(cb => cb.dataset.id);
    if (ids.length === 0) return;

    const confirmed = await window._confirm(
      'Delete Episodes',
      `Delete ${ids.length} episodes? This cannot be undone.`,
      'Delete',
      'Cancel'
    );
    if (!confirmed) return;

    try {
      await window.apiRequest('/api/admin/episodes/bulk-delete', { method: 'POST', body: { ids } });
      _episodesData = _episodesData.filter(e => !ids.includes(String(e.id)));
      _renderEpisodes();
      window.showToast?.(`${ids.length} episodes deleted.`, 'success');
    } catch (error) {
      window.showToast?.(`Bulk delete failed: ${error.message}`, 'error');
    }
  }

  // ─── Global Exposure ────────────────────────────────────────────────────
  window.initializeEpisodesSection = initializeEpisodesSection;

  document.addEventListener('DOMContentLoaded', () => {
    if (window.location.hash === '#episodes') {
      initializeEpisodesSection();
    }
  });

})();

