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
  let _currentPage = 1;
  let _perPage = 20;
  let _totalEpisodes = 0;
  let _totalPages = 1;
  let _setupComplete = false;
  let _sectionActive = false;
  let _pendingLoadFromManage = false;

  // ─── DOM Cache ──────────────────────────────────────────────────────────
  function _$el(id) { return document.getElementById(id); }

  // ─── manageEpisodes (always available, lazy init if needed) ────────────
  window.manageEpisodes = function(animeId, animeTitle) {
    // Lazy setup if the Episodes section has never been initialized
    if (!_setupComplete) {
      _setupEventListeners();
      _setupComplete = true;
    }

    _currentAnimeId = animeId;
    _currentAnimeTitle = animeTitle || '';
    _currentPage = 1;
    _pendingLoadFromManage = true;
    const titleEl = document.getElementById('current-anime-title');
    if (titleEl) titleEl.textContent = animeTitle ? `Episodes: ${window._escapeHTML(animeTitle)}` : 'All Episodes';
    // Navigate to Episodes section — triggers hashchange + observer
    window.location.hash = '#episodes';
    // Load immediately; observer/hashchange handlers skip because _pendingLoadFromManage is set
    _loadAllEpisodes();
  };

  // ─── Initialization ─────────────────────────────────────────────────────
  function initializeEpisodesSection(fromAnimeId, fromAnimeTitle) {
    console.log('[Episodes] Initializing...');

    // One-time setup (event listeners only; manageEpisodes is already global)
    if (!_setupComplete) {
      _setupEventListeners();
      _setupComplete = true;
    }

    // Apply anime filter if this activation came with arguments
    if (fromAnimeId !== undefined) {
      _currentAnimeId = fromAnimeId;
      _currentAnimeTitle = fromAnimeTitle || '';
      _currentPage = 1;
      const titleEl = document.getElementById('current-anime-title');
      if (titleEl) titleEl.textContent = fromAnimeTitle ? `Episodes: ${window._escapeHTML(fromAnimeTitle)}` : 'All Episodes';
    }

    // If manageEpisodes already triggered a load, skip to avoid a duplicate API call
    if (_pendingLoadFromManage) {
      _pendingLoadFromManage = false;
      return;
    }

    _loadAnimeList();
    _loadAllEpisodes();
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

    // Table delegation (edit, delete, inspect, checkbox)
    _$el('episodes-table')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-action');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.classList.contains('edit')) {
        _openEpisodeModal(id);
      } else if (btn.classList.contains('delete')) {
        _deleteEpisode(id);
      } else if (btn.classList.contains('inspect-stream')) {
        _inspectStream(id);
      } else if (btn.classList.contains('obs-report')) {
        _showObservationReport(id);
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

    // Manual video upload button
    _$el('ep-upload-video-btn')?.addEventListener('click', () => {
      if (!_episodesEditId) {
        window.showToast?.('Save the episode first, then edit to upload a video.', 'warning');
        return;
      }
      _$el('ep-manual-video-file')?.click();
    });

    // Clear manual video URL button
    _$el('ep-clear-manual-video-btn')?.addEventListener('click', () => {
      _$el('ep-manual-video-url').value = '';
      _$el('ep-upload-status').textContent = '';
      window.showToast?.('Manual video URL cleared. Save the episode to confirm.', 'info');
    });

    // File input change → upload to Cloudinary via dedicated endpoint
    _$el('ep-manual-video-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!_episodesEditId) {
        window.showToast?.('Episode ID not available. Save the episode first.', 'error');
        return;
      }
      const statusEl = _$el('ep-upload-status');
      const uploadBtn = _$el('ep-upload-video-btn');
      if (statusEl) statusEl.textContent = 'Uploading video to Cloudinary...';
      if (uploadBtn) uploadBtn.disabled = true;
      try {
        const fd = new FormData();
        fd.append('video', file);
        const data = await window.apiRequest(`/api/admin/episodes/${_episodesEditId}/upload-video`, {
          method: 'POST',
          body: fd,
          headers: { 'X-Client': 'admin' },
        });
        const url = data.manual_video_url || data.url;
        if (url) {
          _$el('ep-manual-video-url').value = url;
          if (statusEl) statusEl.textContent = '✓ Video uploaded and linked!';
          window.showToast?.('Video uploaded and linked to episode.', 'success');
        } else {
          throw new Error('No URL returned from upload.');
        }
      } catch (error) {
        console.error('[Episodes] Manual video upload failed:', error);
        if (statusEl) statusEl.textContent = 'Upload failed: ' + error.message;
        window.showToast?.('Video upload failed: ' + error.message, 'error');
      } finally {
        if (uploadBtn) uploadBtn.disabled = false;
        e.target.value = ''; // clear file input for re-upload
      }
    });

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') _closeEpisodeModal();
    });

    // Pagination
    _$el('episode-pagination')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.pagination-btn');
      if (!btn) return;
      const page = btn.dataset.page;
      if (page === 'prev') _currentPage = Math.max(1, _currentPage - 1);
      else if (page === 'next') _currentPage = Math.min(_totalPages, _currentPage + 1);
      else _currentPage = Math.min(_totalPages, Math.max(1, parseInt(page, 10)));
      _loadAllEpisodes();
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

    tbody.innerHTML = '<tr><td colspan="8">' + window.SkeletonLoader.table(5, 7) + '</td></tr>';

    try {
      const params = '?page=' + _currentPage + '&limit=' + _perPage;
      let data;
      if (_currentAnimeId) {
        data = await window.apiRequest('/api/admin/anime/' + _currentAnimeId + '/episodes' + params);
      } else {
        data = await window.apiRequest('/api/admin/episodes' + params);
      }
      // unwrapAdminEnvelope exposes .items/.rows and .pagination
      _episodesData = Array.isArray(data) ? data : (data.items || data.rows || []);
      // Read pagination metadata from the backend response.
      _totalEpisodes = data.pagination?.totalItems || data.totalItems || _episodesData.length;
      _totalPages = data.pagination?.totalPages || data.totalPages || Math.max(1, Math.ceil(_totalEpisodes / _perPage));
      _renderEpisodes(tbody);
      _renderPagination();
    } catch (error) {
      console.error('[Episodes] Failed to load:', error);
      tbody.innerHTML = '<tr><td colspan="9">' + window.ErrorState.render({
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
      tbody.innerHTML = '<tr><td colspan="10">' + window.EmptyState.render({
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
        <td style="text-align:center;">${
          ep.manual_video_url
            ? '<span title=\"Manual video linked: ' + window._escapeHTML(ep.manual_video_url) + '\" style=\"color:var(--accent,#7c4dff);cursor:help;\"><i class=\"fas fa-cloud-upload-alt\"></i></span>'
            : '<span style=\"color:var(--text-muted,#555);\">—</span>'
        }</td>
        <td style="white-space:nowrap;">
          <button class="btn-action edit" data-id="${ep.id}" title="Edit Episode" aria-label="Edit Episode"><i class="fas fa-edit"></i> Edit</button>
          <button class="btn-action inspect-stream" data-id="${ep.id}" title="Inspect Stream" aria-label="Inspect Stream"><i class="fas fa-search"></i> Inspect</button>
          <button class="btn-action obs-report" data-id="${ep.id}" title="Stream Observation Report" aria-label="Stream Observation Report"><i class="fas fa-chart-bar"></i> Report</button>
          <button class="btn-action delete" data-id="${ep.id}" title="Delete Episode" aria-label="Delete Episode"><i class="fas fa-trash"></i> Delete</button>
        </td>
      </tr>`;
    }).join('');

    _updateBulkDeleteButton();
  }

  // ─── Stream Diagnostic ──────────────────────────────────────────────
  async function _inspectStream(episodeId) {
    const modal = window.ModalManager.open({
      title: 'Stream Diagnostic — Episode #' + episodeId,
      body: '<div style="text-align:center;padding:2rem;"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p style="margin-top:0.5rem;color:var(--text-muted);">Loading diagnostic...</p></div>',
      dialogClass: 'stream-diagnostic-dialog',
    });

    try {
      const data = await window.apiRequest('/api/admin/streams/' + episodeId + '/diagnostic');

      const val = (v, fallback) => v !== undefined && v !== null ? v : (fallback || '—');
      const bool = (v) => v ? '✅ Yes' : '❌ No';
      const time = (v) => v ? new Date(v).toLocaleString() : '—';

      // State badge
      const stateBadge = (state) => {
        const colors = { active: '#4caf50', expired: '#f44336', invalid: '#ff9800', unknown: '#9e9e9e' };
        return `<span class="shared-badge" style="background:${colors[state] || '#9e9e9e'};color:#fff;">${state || 'unknown'}</span>`;
      };

      // Verification badge
      const aliveBadge = (v) => v ? '<span class="shared-badge shared-badge-success">Alive</span>' : '<span class="shared-badge shared-badge-error">Dead</span>';

      const rows = [
        { label: 'Episode ID', value: val(data.episodeId) },
        { label: 'Episode Number', value: val(data.episodeNumber) },
        { label: 'Anime ID', value: val(data.animeId) },
        { label: 'Provider', value: val(data.provider) },
        { label: 'Cache Exists', value: bool(data.cacheExists) },
        { label: 'Cache State', value: stateBadge(data.cacheState) },
      ];

      if (data.cacheExists && data.cacheState) {
        rows.push(
          { label: 'Stream Type', value: val(data.streamType) },
          { label: 'Cache Expiry', value: time(data.expiresAt) },
          { label: 'Detected Expiry', value: time(data.detectedExpiresAt) },
          { label: 'Expiry Source', value: val(data.expirySource) },
          { label: 'Verification Status', value: stateBadge(data.verificationStatus) },
          { label: 'Last Verified', value: time(data.lastVerifiedAt) },
          { label: 'Last Used', value: time(data.lastUsedAt) },
          { label: 'Resolved At', value: time(data.resolvedAt) },
          { label: 'Redis Key', value: '<code style="font-size:0.7rem;word-break:break-all;">' + window._escapeHTML(data.redisKey || '') + '</code>' },
          { label: 'Cache TTL', value: val(data.cacheTtlMinutes, '360') + ' min' },
          { label: 'Source Count', value: val(data.sourceCount) },
          { label: 'Source Qualities', value: (data.sourceQualities || []).join(', ') || '—' },
          { label: 'CDN Host', value: window._escapeHTML(data.urlHost || '') || '—' },
          { label: 'CDN Path', value: window._escapeHTML(data.urlPath || '') || '—' },
          { label: 'Stream URL', value: '<code style="font-size:0.7rem;word-break:break-all;">' + window._escapeHTML(data.urlRedacted || '') + '</code>' },
        );

        if (data.verification) {
          rows.push(
            { label: 'HTTP Status', value: val(data.verification.status) },
            { label: 'Content Type', value: val(data.verification.contentType) },
            { label: 'Alive', value: aliveBadge(data.verification.alive) },
            { label: 'skipProxy', value: bool(data.verification.skipProxy) },
            { label: 'Thordata', value: bool(data.verification.thordataUsed) },
          );
        }
      }

      const html = '<table class="stream-diag-table" style="width:100%;border-collapse:collapse;">' +
        rows.map(r => '<tr><td style="padding:6px 10px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border,#2a2c37);white-space:nowrap;width:160px;">' +
          window._escapeHTML(r.label) + '</td><td style="padding:6px 10px;border-bottom:1px solid var(--border,#2a2c37);">' + r.value + '</td></tr>').join('') +
        '</table>';

      window.ModalManager.update(modal, { body: html });
    } catch (error) {
      window.ModalManager.update(modal, {
        body: '<div style="text-align:center;padding:2rem;color:var(--danger,#f44336);">' +
          '<i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i>' +
          '<p style="margin-top:0.5rem;">' + window._escapeHTML(error.message) + '</p></div>',
      });
    }
  }

function _renderPagination() {
    var infoEl = _$el('episode-table-info');
    if (infoEl) {
      infoEl.textContent = _totalEpisodes + ' episodes total' +
        (_totalPages > 1 ? ' · Page ' + _currentPage + ' of ' + _totalPages : '');
    }

    var pagEl = _$el('episode-pagination');
    if (!pagEl) return;
    if (_totalPages <= 1) {
      pagEl.innerHTML = '';
      return;
    }

    var html = '';
    var current = _currentPage;
    var total = _totalPages;

    html += '<button class="pagination-btn" data-page="prev"' + (current <= 1 ? ' disabled' : '') + '>« Prev</button>';
    var start = Math.max(1, current - 2);
    var end = Math.min(total, current + 2);
    if (start > 1) {
      html += '<button class="pagination-btn" data-page="1">1</button>';
      if (start > 2) html += '<span style="color:var(--text-muted);padding:0 4px;">...</span>';
    }
    for (var i = start; i <= end; i++) {
      html += '<button class="pagination-btn' + (i === current ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
    }
    if (end < total) {
      if (end < total - 1) html += '<span style="color:var(--text-muted);padding:0 4px;">...</span>';
      html += '<button class="pagination-btn" data-page="' + total + '">' + total + '</button>';
    }
    html += '<button class="pagination-btn" data-page="next"' + (current >= total ? ' disabled' : '') + '>Next »</button>';

    pagEl.innerHTML = html;
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
      form.querySelector('#ep-manual-video-url').value = ep.manual_video_url || '';
      form.querySelector('#ep-upload-status').textContent = ep.manual_video_url ? '✓ Manual video linked' : '';
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
      manual_video_url: form.querySelector('#ep-manual-video-url').value || null,
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

  // ─── Section-Activation Observer ───────────────────────────────────────
  // Detect whenever #episodes gains the `active` class (sidebar click,
  // hash change, popstate, direct load) and reload data.  This handles
  // re-entry (nav away → return) without modifying dashboard.js.
  (function _watchEpisodesSection() {
    const section = document.getElementById('episodes');
    if (!section) return;

    const observer = new MutationObserver(function(mutations) {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          const isActive = section.classList.contains('active');
          // Only react on transition to active (ignore deactivation)
          if (isActive && !_sectionActive) {
            _sectionActive = true;
            if (_setupComplete) {
              if (!_pendingLoadFromManage) {
                // Fresh entry (sidebar click, hash change, back/forward, direct load)
                // — reset filter and pagination for a clean "All Episodes" view.
                _currentAnimeId = null;
                _currentAnimeTitle = '';
                _currentPage = 1;
                const titleEl = document.getElementById('current-anime-title');
                if (titleEl) titleEl.textContent = 'All Episodes';
                _loadAnimeList();
                _loadAllEpisodes();
              }
              // Entry from manageEpisodes — filter is already set, skip the reload.
            }
            _pendingLoadFromManage = false;
          } else if (!isActive) {
            _sectionActive = false;
          }
        }
      }
    });

    // Defer observer start to avoid capturing the initial class toggle
    // that happens during dashboard.js `showSection()` on page load.
    // The initial data load is handled by initializeEpisodesSection() directly.
    setTimeout(function() {
      _sectionActive = section.classList.contains('active');
      observer.observe(section, { attributes: true, attributeFilter: ['class'] });
    }, 0);
  })();

  // Also listen for hashchange/popstate for extra coverage (browser nav)
  window.addEventListener('hashchange', _onHashChange);
  window.addEventListener('popstate', _onHashChange);

  function _onHashChange() {
    if (window.location.hash === '#episodes') {
      const section = document.getElementById('episodes');
      if (section && section.classList.contains('active') && !_sectionActive) {
        _sectionActive = true;
        if (_setupComplete) {
          if (!_pendingLoadFromManage) {
            _currentAnimeId = null;
            _currentAnimeTitle = '';
            _currentPage = 1;
            const titleEl = document.getElementById('current-anime-title');
            if (titleEl) titleEl.textContent = 'All Episodes';
            _loadAnimeList();
            _loadAllEpisodes();
          }
        }
        _pendingLoadFromManage = false;
      }
    }
// ─── Stream Observation Report ───────────────────────────────────────
  async function _showObservationReport(episodeId) {
    var modal = window.ModalManager.open({
      title: 'Observation Report — Episode #' + episodeId,
      body: '<div style="text-align:center;padding:2rem;"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p style="margin-top:0.5rem;color:var(--text-muted);">Loading observation data...</p></div>',
      dialogClass: 'obs-report-dialog',
    });

    try {
      var data = await window.apiRequest('/api/admin/streams/observation/' + episodeId);
      var r = data.report || data;

      var val = function(v, fb) { return v !== undefined && v !== null && v !== '' ? v : (fb || '—'); };
      var time = function(v) { return v ? new Date(v).toLocaleString() : '—'; };
      var clsBadge = function(cls) {
        var colors = { UNKNOWN: '#9e9e9e', LONG_LIVED: '#4caf50', TEMPORARY: '#ff9800', ROTATING: '#2196f3', DEAD: '#f44336', PERMANENT: '#9c27b0' };
        return '<span class="shared-badge" style="background:' + (colors[cls] || '#9e9e9e') + ';color:#fff;">' + (cls || 'UNKNOWN') + '</span>';
      };

      var rows = [
        { label: 'Episode ID', value: val(r.episodeId) },
        { label: 'Provider', value: val(r.provider) },
        { label: 'Classification', value: clsBadge(r.classification) },
        { label: 'Confidence', value: val(r.classificationConfidence) },
        { label: 'Reason', value: val(r.classificationReason) },
        { label: '', value: '' },
        { label: 'Current CDN Host', value: val(r.currentHost) },
        { label: 'Original CDN Host', value: val(r.originalHost) },
        { label: 'Host Changed At', value: time(r.hostChangedAt) },
        { label: 'Token Changed At', value: time(r.tokenChangedAt) },
        { label: 'Rotation Count', value: val(r.rotationCount) },
        { label: '', value: '' },
        { label: 'Last Direct Check', value: time(r.lastDirectCheckAt) },
        { label: 'Last Direct Status', value: val(r.lastDirectStatus) },
        { label: 'Last Proxy Check', value: time(r.lastProxyCheckAt) },
        { label: 'Last Proxy Status', value: val(r.lastProxyStatus) },
        { label: 'Last Check Path', value: val(r.lastCheckPath) },
        { label: 'Last Check Duration', value: r.lastCheckDurationMs ? r.lastCheckDurationMs + ' ms' : '—' },
        { label: '', value: '' },
        { label: 'Observed Lifetime', value: r.urlObservedLifetimeSeconds ? Math.round(r.urlObservedLifetimeSeconds / 3600) + ' hours' : 'Not enough data' },
        { label: 'First Failure', value: time(r.urlFirstFailureAt) },
        { label: 'Last Failure', value: time(r.urlLastFailureAt) },
        { label: 'Failure Count', value: val(r.urlFailureCount) },
        { label: '', value: '' },
        { label: 'Probe/Playback Matches', value: val(r.probePlaybackMatchCount) },
        { label: 'False Positives', value: val(r.probeFalsePositiveCount) },
        { label: 'False Negatives', value: val(r.probeFalseNegativeCount) },
        { label: '', value: '' },
        { label: 'Verification Status', value: val(r.verificationStatus) },
        { label: 'Last Verified', value: time(r.lastVerifiedAt) },
        { label: 'Last Failed', value: time(r.lastFailedAt) },
        { label: 'Last Check Content-Type', value: val(r.lastCheckContentType) },
      ];

      var html = '<table class="obs-report-table" style="width:100%;border-collapse:collapse;">' +
        rows.map(function(row) {
          if (row.label === '' && row.value === '') {
            return '<tr><td colspan="2" style="border-bottom:1px solid var(--border,#2a2c37);padding:2px;"></td></tr>';
          }
          return '<tr><td style="padding:5px 10px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border,#2a2c37);white-space:nowrap;width:180px;font-size:0.8rem;">' +
            window._escapeHTML(row.label) + '</td><td style="padding:5px 10px;border-bottom:1px solid var(--border,#2a2c37);font-size:0.8rem;">' + row.value + '</td></tr>';
        }).join('') +
        '</table>';

      window.ModalManager.update(modal, { body: html });
    } catch (error) {
      window.ModalManager.update(modal, {
        body: '<div style="text-align:center;padding:2rem;color:var(--danger,#f44336);">' +
          '<i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i>' +
          '<p style="margin-top:0.5rem;">' + window._escapeHTML(error.message) + '</p></div>',
      });
    }
  }
  }

})();

