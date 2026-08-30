// ─── AdminDashboard/js/anime.js ───
// Complete Anime List CMS — bulk management table with full CRUD, filtering, sorting, pagination
// Uses shared.js for: _escapeHTML, showToast, _debounce, _confirm, ModalManager, SkeletonLoader, EmptyState, ErrorState, Badge, DataTable

// ─── State ────────────────────────────────────────────────────────────────────
let _allAnime = [];
let _filteredAnime = [];
let _selectedIds = new Set();
let _currentPage = 1;
let _perPage = 25;
let _sortField = 'newest';
let _sortOrder = 'desc';
let _filters = { q: '', status: '', premium: '', featured: '', media_type: '', year: '', genre: '' };
let _editId = null;
let _importResults = [];
let _genreList = [];
let _isLoading = false;
let _totalPages = 1;

// ─── DOM Cache ────────────────────────────────────────────────────────────────
function _$el(id) { return document.getElementById(id); }
function _q(sel, parent) { return (parent || document).querySelector(sel); }
function _qa(sel, parent) { return Array.from((parent || document).querySelectorAll(sel)); }

let _tableBody, _pagination, _tableInfo, _mobileCards, _bulkToolbar, _selectedCountEl;

// ─── Initialization ───────────────────────────────────────────────────────────
function initializeAnimeSection() {
  console.log('[Anime CMS] Initializing...');

  _tableBody = _$el('anime-table-body');
  _pagination = _$el('anime-pagination');
  _tableInfo = _$el('anime-table-info');
  _mobileCards = _$el('anime-mobile-cards');
  _bulkToolbar = _$el('anime-bulk-toolbar');
  _selectedCountEl = _$el('anime-selected-count');

  _loadGenres();
  _fetchAnime();
  _setupEventListeners();
  _handleResponsive();
  window.addEventListener('resize', _handleResponsive);
  window.animeRefresh = () => _fetchAnime();
}

function _setupEventListeners() {
// Search (debounced)
  _$el('anime-search')?.addEventListener('input', window._debounce(() => {
    _filters.q = _$el('anime-search').value;
    _currentPage = 1;
    _fetchAnime();
  }, 350));

  // Filter selects
  ['anime-filter-status', 'anime-filter-premium', 'anime-filter-featured', 'anime-filter-media-type', 'anime-filter-genre', 'anime-sort', 'anime-per-page'].forEach(id => {
    _$el(id)?.addEventListener('change', () => {
      const el = _$el(id);
      if (id === 'anime-sort') {
        _sortField = el.value;
        _sortOrder = (_sortField === 'oldest' || _sortField === 'title' || _sortField === 'alphabetical') ? 'asc' : 'desc';
      } else if (id === 'anime-per-page') {
        _perPage = Number(el.value);
      } else {
        const key = id.replace('anime-filter-', '');
        _filters[key] = el.value;
      }
      _currentPage = 1;
      _fetchAnime();
    });
  });

  // Year filter (debounced)
  _$el('anime-filter-year')?.addEventListener('input', window._debounce(() => {
    _filters.year = _$el('anime-filter-year').value;
    _currentPage = 1;
    _fetchAnime();
  }, 400));

  // Select All
  _$el('selectAll-anime')?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    const pageItems = _getPageItems();
    pageItems.forEach(a => {
      if (checked) _selectedIds.add(String(a.id));
      else _selectedIds.delete(String(a.id));
    });
    _updateUI();
  });

  // Bulk actions (delegated)
  _bulkToolbar?.addEventListener('click', (e) => {
    const btn = e.target.closest('.bulk-action-btn, #anime-bulk-cancel, #anime-bulk-export');
    if (!btn) return;
    if (btn.id === 'anime-bulk-cancel') { _selectedIds.clear(); _updateUI(); return; }
    if (btn.id === 'anime-bulk-export') { _exportCSV(); return; }
    const action = btn.dataset.action;
    if (action) _handleBulkAction(action, btn);
  });

  // Table events (delegated)
  _$el('anime-table')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const cb = tr.querySelector('.anime-select-checkbox');
    const id = cb?.dataset?.id;
    if (e.target.closest('.anime-select-checkbox') || e.target.closest('#selectAll-anime')) return;
    const actionBtn = e.target.closest('.btn-action');
    if (actionBtn) {
      e.preventDefault();
      const action = actionBtn.classList.contains('episodes') ? 'episodes' :
                     actionBtn.classList.contains('delete') ? 'delete' :
                     actionBtn.classList.contains('edit') ? 'edit' :
                     actionBtn.classList.contains('sync') ? 'sync' :
                     actionBtn.classList.contains('ah-sync') ? 'ah-sync' :
                     actionBtn.classList.contains('ah-import-now') ? 'ah-import-now' :
                     actionBtn.classList.contains('ah-check') ? 'ah-check' :
actionBtn.classList.contains('sync-streams') ? 'sync-streams' :
                     actionBtn.classList.contains('details') ? 'details' : null;
      if (action) { window.animeAction?.(action, id, actionBtn) || _handleRowAction(action, id, actionBtn); }
      return;
    }
    if (id) {
      const checked = !cb.checked;
      cb.checked = checked;
      if (checked) _selectedIds.add(id); else _selectedIds.delete(id);
      _updateUI();
    }
  });

  _$el('anime-table')?.addEventListener('change', (e) => {
    const cb = e.target.closest('.anime-select-checkbox');
    if (!cb) return;
    if (cb.checked) _selectedIds.add(cb.dataset.id); else _selectedIds.delete(cb.dataset.id);
    _updateUI();
  });

  _mobileCards?.addEventListener('change', (e) => {
    const cb = e.target.closest('.anime-select-checkbox');
    if (!cb) return;
    if (cb.checked) _selectedIds.add(cb.dataset.id); else _selectedIds.delete(cb.dataset.id);
    _updateUI();
  });

  // Mobile cards — checkbox changes (delegated)
  _mobileCards?.addEventListener('change', (e) => {
    const cb = e.target.closest('.anime-select-checkbox');
    if (!cb) return;
    if (cb.checked) _selectedIds.add(cb.dataset.id);
    else _selectedIds.delete(cb.dataset.id);
    _updateUI();
  });

  // Mobile cards — action buttons (delegated)
  _mobileCards?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-action');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.classList.contains('delete') ? 'delete' :
                   btn.classList.contains('edit') ? 'edit' :
                   btn.classList.contains('details') ? 'details' : null;
    if (action) _handleRowAction(action, id, btn);
  });

  // Sortable headers
  _$el('anime-table')?.addEventListener('click', (e) => {
    const th = e.target.closest('.sortable');
    if (!th) return;
    const sortVal = th.dataset.sort;
    if (!sortVal) return;
    if (_sortField === sortVal) {
      _sortOrder = _sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
      _sortField = sortVal;
      _sortOrder = (sortVal === 'title' || sortVal === 'alphabetical') ? 'asc' : 'desc';
    }
    _$el('anime-sort').value = _sortField;
    _currentPage = 1;
    _fetchAnime();
  });

  // Pagination
  _pagination?.addEventListener('click', (e) => {
    const btn = e.target.closest('.pagination-btn');
    if (!btn) return;
    const page = btn.dataset.page;
    if (page === 'prev') _currentPage = Math.max(1, _currentPage - 1);
    else if (page === 'next') _currentPage = Math.min(_totalPages, _currentPage + 1);
    else _currentPage = Math.min(_totalPages, Math.max(1, parseInt(page, 10)));
    _fetchAnime();
  });

  // Add Anime button
  _$el('add-anime-button')?.addEventListener('click', () => _openAnimeModal(null));

  // Modal close buttons
  _$el('close-add-anime-modal')?.addEventListener('click', _closeAnimeModal);
  _$el('close-anime-details-modal')?.addEventListener('click', () => {
    _$el('anime-details-modal').hidden = true;
  });

  // Confirm modal
  _$el('confirm-modal-cancel')?.addEventListener('click', _closeConfirmModal);
  _$el('confirm-modal-confirm')?.addEventListener('click', () => {
    if (_confirmCallback) _confirmCallback();
    _closeConfirmModal();
  });

  // Click outside modals
  document.querySelectorAll('.anime-import-modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.hidden = true;
    });
  });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      _closeAnimeModal();
      _$el('anime-details-modal').hidden = true;
      _closeConfirmModal();
    }
  });

  // Existing modal tabs
  const modal = _$el('add-anime-modal');
  modal?.querySelector('.anime-import-tabs')?.addEventListener('click', _handleModalTabClick);
  modal?.querySelector('#kitsu-search-form')?.addEventListener('submit', _handleKitsuSearch);
  modal?.querySelector('#manual-add-anime-form')?.addEventListener('submit', _handleManualFormSubmit);
  modal?.querySelector('#kitsu-search-results')?.addEventListener('click', _handleKitsuResultClick);

  // AnimeHeaven import tab (Phase 6)
  modal?.querySelector('#animeheaven-search-form')?.addEventListener('submit', _handleAnimeHeavenSearch);
  modal?.querySelector('#animeheaven-search-results')?.addEventListener('click', _handleAnimeHeavenResultClick);
}

// ─── Data Fetching ────────────────────────────────────────────────────────────
async function _fetchAnime() {
  if (_isLoading) return;
  _isLoading = true;
  _renderLoading();

  try {
    const params = new URLSearchParams();
    if (_filters.q) params.set('q', _filters.q);
    if (_filters.status) params.set('status', _filters.status);
    if (_filters.premium !== '') params.set('premium', _filters.premium);
    if (_filters.featured !== '') params.set('featured', _filters.featured);
    if (_filters.media_type) params.set('media_type', _filters.media_type);
    if (_filters.year) params.set('year', _filters.year);
    if (_filters.genre) params.set('genre', _filters.genre);
    params.set('sort', _sortField);
    params.set('order', _sortOrder);
    params.set('page', String(_currentPage));
    params.set('limit', String(_perPage));

    const response = await window.apiRequest(`/api/admin/anime?${params.toString()}`);

    // unwrapAdminEnvelope transforms { success:true, data:[...], meta:{...} }
    // into { items:[...], rows:[...], pagination:{...} }. Support all shapes.
    if (Array.isArray(response)) {
      _allAnime = response;
      _totalPages = Math.ceil(_allAnime.length / _perPage) || 1;
      // For client-side (array) mode, slice the current page into _filteredAnime
      const start = (_currentPage - 1) * _perPage;
      _filteredAnime = _allAnime.slice(start, start + _perPage);
      _renderPage();
      _renderPaginationSimple();
    } else if (response.items || response.rows) {
      // After envelope unwrap: paginated responses expose .items and .rows
      _allAnime = response.items || response.rows || [];
      _filteredAnime = _allAnime;
      _totalPages = response.pagination?.totalPages || 1;
      _currentPage = response.pagination?.page || 1;
      _renderPage();
      _renderPagination(response.pagination);
    } else if (response.data) {
      // Legacy shape (pre-unwrap compatibility)
      _allAnime = response.data || [];
      _filteredAnime = _allAnime;
      _totalPages = response.pagination?.totalPages || 1;
      _currentPage = response.pagination?.page || 1;
      _renderPage();
      _renderPagination(response.pagination);
    } else {
      _allAnime = [];
      _filteredAnime = [];
      _renderPage();
    }
  } catch (error) {
    console.error('[Anime CMS] Fetch failed:', error);
    _showError('Failed to load anime. Please try again.');
  } finally {
    _isLoading = false;
  }
}

async function _loadGenres() {
  try {
    const genres = await window.apiRequest('/api/admin/genres');
    _genreList = Array.isArray(genres) ? genres : [];
    const select = _$el('anime-filter-genre');
    if (select) {
      select.innerHTML = '<option value="">All Genres</option>' +
        _genreList.map(g => `<option value="${g.name}">${g.name}</option>`).join('');
    }
  } catch (e) {
    console.warn('[Anime CMS] Could not load genres:', e);
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function _renderPage() {
  _selectedIds = new Set([..._selectedIds].filter(id => _filteredAnime.some(a => String(a.id) === id)));
  const pageItems = _getPageItems();

  if (_filteredAnime.length === 0) {
    _renderEmpty();
    return;
  }

  // Check if we're on mobile
  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    _renderMobileCards(pageItems);
  } else {
    _renderTableRows(pageItems);
  }

  _updateUI();
}

function _renderTableRows(items) {
  if (!_tableBody) return;
  _tableBody.innerHTML = items.map(anime => {
    const isSelected = _selectedIds.has(String(anime.id));
    const genres = Array.isArray(anime.genres) ? anime.genres.slice(0, 3).join(', ') : '';
    const hasMoreGenres = Array.isArray(anime.genres) && anime.genres.length > 3;
    // AnimeHeaven status: show slug, episode count, last sync.
    const ahSlug = anime.animeheaven_slug || null;
    const ahImported = !!ahSlug;
    const ahLastSync = anime.animeheaven_last_synced_at || anime.updated_at || '';
    const ahStatus = ahImported
      ? `<span class="shared-badge shared-badge-success" title="${window._escapeHTML(ahSlug)}">✓ AnimeHeaven</span>`
      : '<span class="shared-badge shared-badge-muted">—</span>';
    const ahMeta = ahImported
      ? `<small style="color:var(--text-muted);font-size:0.68rem;">${anime.episode_count || 0} eps · ${ahLastSync ? new Date(ahLastSync).toLocaleDateString() : 'never'}</small>`
      : '';
    // Playback Ready indicator — shows whether the anime has the provider
    // metadata needed for immediate playback (slug + episode keys).
    const playbackReady = ahImported && (anime.episode_count || 0) > 0;
    const playbackBadge = playbackReady
      ? '<span class="shared-badge shared-badge-success" title="All episodes have provider identifiers">▶ Playback Ready</span>'
      : (ahImported ? '<span class="shared-badge shared-badge-warning" title="Missing provider episode identifiers">⚠ Check</span>' : '');
    return `
      <tr class="${isSelected ? 'selected-row' : ''}" data-id="${anime.id}">
        <td><input type="checkbox" class="anime-select-checkbox" data-id="${anime.id}" ${isSelected ? 'checked' : ''}></td>
        <td><img src="${anime.cover_image || 'img/placeholder.png'}" alt="${anime.title}" style="width:40px;height:56px;object-fit:cover;border-radius:4px;" loading="lazy"></td>
        <td><strong>${window._escapeHTML(anime.title)}</strong>${anime.title_japanese ? `<br><small style="color:var(--text-muted);font-size:0.7rem;">${window._escapeHTML(anime.title_japanese)}</small>` : ''}</td>
        <td style="font-size:0.78rem;">${genres}${hasMoreGenres ? '...' : ''}</td>
        <td>${window.Badge.status(anime.status)}</td>
        <td>${window.Badge.premium(anime.is_premium)}</td>
        <td>${anime.is_featured ? window.Badge.featured(true) : '<span class="shared-badge shared-badge-muted">No</span>'}</td>
        <td>${anime.episode_count || 0}</td>
        <td>${(anime.view_count || 0).toLocaleString()}</td>
        <td style="text-align:center;">${ahStatus}${ahMeta}<br>${playbackBadge}</td>
        <td style="white-space:nowrap;">
          <button class="btn-action episodes" data-id="${anime.id}" title="Manage Episodes" aria-label="Manage Episodes"><i class="fas fa-video"></i></button>
          <button class="btn-action ah-sync" data-id="${anime.id}" title="Sync from AnimeHeaven" aria-label="Sync from AnimeHeaven" ${ahImported ? '' : 'disabled'}><i class="fas fa-sync"></i></button>
          <button class="btn-action ah-import-now" data-id="${anime.id}" title="Import from AnimeHeaven" aria-label="Import from AnimeHeaven"><i class="fas fa-download"></i></button>
          <button class="btn-action ah-check" data-id="${anime.id}" title="Check Playback Readiness" aria-label="Check Playback Readiness"><i class="fas fa-check-circle"></i></button>
          <button class="btn-action sync-streams" data-id="${anime.id}" title="Synchronize Streams — check all cached CDN URLs for this anime" aria-label="Synchronize Streams"><i class="fas fa-shield-alt"></i><span style="font-size:0.6rem;display:block;">SYNC</span></button>
          <button class="btn-action details" data-id="${anime.id}" title="View Details" aria-label="View Details"><i class="fas fa-eye"></i></button>
          <button class="btn-action edit" data-id="${anime.id}" title="Edit Anime" aria-label="Edit Anime"><i class="fas fa-edit"></i></button>
          <button class="btn-action delete" data-id="${anime.id}" title="Delete Anime" aria-label="Delete Anime"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `;
  }).join('');
}

function _renderMobileCards(items) {
  if (!_mobileCards) return;
  _mobileCards.innerHTML = items.map(anime => {
    const isSelected = _selectedIds.has(String(anime.id));
    const genres = Array.isArray(anime.genres) ? anime.genres : [];
    return `
      <div class="anime-card ${isSelected ? 'selected' : ''}">
        <div class="card-checkbox">
          <input type="checkbox" class="anime-select-checkbox" data-id="${anime.id}" ${isSelected ? 'checked' : ''}>
        </div>
        <img src="${anime.cover_image || 'img/placeholder.png'}" alt="${anime.title}" loading="lazy">
        <div class="card-body">
          <div class="card-title">${window._escapeHTML(anime.title)}</div>
          <div class="card-meta">
            ${window.Badge.status(anime.status)}
            ${window.Badge.premium(anime.is_premium)}
            <span>${anime.episode_count || 0} eps</span>
            <span>${(anime.view_count || 0).toLocaleString()} views</span>
          </div>
          <div class="card-genres">${genres.map(g => `<span>${g}</span>`).join('')}</div>
          <div class="card-actions">
            <button class="btn-action details" data-id="${anime.id}" title="View Details" aria-label="View Details"><i class="fas fa-eye"></i> Details</button>
            <button class="btn-action edit" data-id="${anime.id}" title="Edit Anime" aria-label="Edit Anime"><i class="fas fa-edit"></i> Edit</button>
            <button class="btn-action delete" data-id="${anime.id}" title="Delete Anime" aria-label="Delete Anime"><i class="fas fa-trash"></i> Delete</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function _renderEmpty() {
  if (_tableBody) {
    _tableBody.innerHTML = '<tr><td colspan="10">' + window.EmptyState.render({
      icon: '🎬',
      title: 'No Anime Found',
      description: _filters.q ? 'Try adjusting your search or filters.' : 'Start building your catalogue.',
      actionText: _filters.q ? '' : '+ Add Anime',
      actionFn: _filters.q ? null : () => { document.getElementById('add-anime-button')?.click(); }
    }) + '</td></tr>';
  }
  if (_mobileCards) _mobileCards.innerHTML = '';
  if (_pagination) _pagination.innerHTML = '';
  if (_tableInfo) _tableInfo.textContent = '';
}

function _renderLoading() {
  if (_tableBody) {
    _tableBody.innerHTML = '<tr><td colspan="10">' + window.SkeletonLoader.table(5, 10) + '</td></tr>';
  }
}

function _showError(msg) {
  if (_tableBody) {
    _tableBody.innerHTML = '<tr><td colspan="10">' + window.ErrorState.render({
      message: msg,
      retryFn: () => _fetchAnime()
    }) + '</td></tr>';
  }
}

// ─── Pagination ───────────────────────────────────────────────────────────────
function _getPageItems() {
  // _filteredAnime already contains exactly the current page's items
  // (set by _fetchAnime for server-paginated mode, or sliced for array mode).
  return _filteredAnime;
}

function _renderPagination(pagination) {
  if (!_pagination) return;
  if (!pagination || pagination.totalPages <= 1) {
    _pagination.innerHTML = '';
    if (_tableInfo) _tableInfo.textContent = pagination ? `${pagination.totalItems || pagination.total || ''} anime total` : '';
    return;
  }
  const { page, totalPages } = pagination;
  const total = pagination.totalItems || pagination.total || _filteredAnime.length;
  if (_tableInfo) _tableInfo.textContent = `${total} anime total · Page ${page} of ${totalPages}`;
  _pagination.innerHTML = _buildPaginationHTML(page, totalPages);
}

function _renderPaginationSimple() {
  if (!_pagination) return;
  if (_totalPages <= 1) {
    _pagination.innerHTML = '';
    if (_tableInfo) _tableInfo.textContent = `${_allAnime.length} anime total`;
    return;
  }
  if (_tableInfo) _tableInfo.textContent = `${_allAnime.length} anime total · Page ${_currentPage} of ${_totalPages}`;
  _pagination.innerHTML = _buildPaginationHTML(_currentPage, _totalPages);
}

function _buildPaginationHTML(current, total) {
  let html = '';
  html += `<button class="pagination-btn" data-page="prev" ${current <= 1 ? 'disabled' : ''}>« Prev</button>`;
  const start = Math.max(1, current - 2);
  const end = Math.min(total, current + 2);
  if (start > 1) { html += `<button class="pagination-btn" data-page="1">1</button>`; if (start > 2) html += `<span style="color:var(--text-muted);padding:0 4px;">...</span>`; }
  for (let i = start; i <= end; i++) {
    html += `<button class="pagination-btn ${i === current ? 'active' : ''}" data-page="${i}">${i}</button>`;
  }
  if (end < total) { if (end < total - 1) html += `<span style="color:var(--text-muted);padding:0 4px;">...</span>`; html += `<button class="pagination-btn" data-page="${total}">${total}</button>`; }
  html += `<button class="pagination-btn" data-page="next" ${current >= total ? 'disabled' : ''}>Next »</button>`;
  return html;
}

// ─── UI State Update ─────────────────────────────────────────────────────────
function _updateUI() {
  // Update select-all checkbox state
  const selectAll = _$el('selectAll-anime');
  const pageItems = _getPageItems();
  const pageIds = new Set(pageItems.map(a => String(a.id)));
  const selectedOnPage = [..._selectedIds].filter(id => pageIds.has(id)).length;

  if (selectAll) {
    if (selectedOnPage === 0) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
    } else if (selectedOnPage === pageItems.length) {
      selectAll.checked = true;
      selectAll.indeterminate = false;
    } else {
      selectAll.checked = false;
      selectAll.indeterminate = true;
    }
  }

  // Update selected row backgrounds
  _qa('#anime-table tbody tr').forEach(tr => {
    const cb = tr.querySelector('.anime-select-checkbox');
    if (cb) {
      tr.classList.toggle('selected-row', _selectedIds.has(cb.dataset.id));
    }
  });

  // Update mobile card selections
  _qa('#anime-mobile-cards .anime-card').forEach(card => {
    const cb = card.querySelector('.anime-select-checkbox');
    if (cb) {
      card.classList.toggle('selected', _selectedIds.has(cb.dataset.id));
    }
  });

  // Update mobile card checkbox state
  _qa('#anime-mobile-cards .anime-select-checkbox').forEach(cb => {
    cb.checked = _selectedIds.has(cb.dataset.id);
  });

  // Show/hide bulk toolbar
  const count = _selectedIds.size;
  if (_bulkToolbar) {
    _bulkToolbar.style.display = count > 0 ? 'flex' : 'none';
  }
  if (_selectedCountEl) _selectedCountEl.textContent = count;

  // Update sort indicators
  _qa('th.sortable').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === _sortField) {
      th.classList.add(_sortOrder === 'asc' ? 'sorted-asc' : 'sorted-desc');
      th.querySelector('i').className = _sortOrder === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down';
    } else {
      const icon = th.querySelector('i');
      if (icon) icon.className = 'fas fa-sort';
    }
  });
}

function _handleResponsive() {
  const isMobile = window.innerWidth <= 768;
  const table = _$el('anime-table');
  const cards = _mobileCards;
  if (table) table.style.display = isMobile ? 'none' : '';
  if (cards) cards.style.display = isMobile ? 'grid' : 'none';
  if (!_isLoading && _filteredAnime.length > 0) _renderPage();
}

// ─── Row Actions ──────────────────────────────────────────────────────────────
async function _handleRowAction(action, id, button) {
  switch (action) {
    case 'episodes':
      const anime = _allAnime.find(a => String(a.id) === String(id));
      window.manageEpisodes?.(id, anime?.title || '');
      break;
    case 'delete':
      await _handleSingleDelete(id);
      break;
    case 'edit':
      _openAnimeModal(id);
      break;
    case 'sync':
      await _handleSync(id, button);
      break;
    case 'ah-sync':
      await _handleAnimeHeavenRowSync(id, button);
      break;
    case 'ah-import-now':
      await _handleAnimeHeavenRowImport(id, button);
      break;
    case 'ah-check':
      await _handleAnimeHeavenPlaybackCheck(id, button);
      break;
    case 'sync-streams':
      await _handleSyncStreams(id, button);
      break;
    case 'details':
      await _showDetails(id);
      break;
  }
}

// ── AnimeHeaven row actions (Catalog Service) ──────────────
async function _handleAnimeHeavenRowSync(id, button) {
  const anime = _allAnime.find(a => String(a.id) === String(id));
  if (!anime?.animeheaven_slug) {
    window.showToast?.('This anime has no AnimeHeaven slug. Import it first.', 'error');
    return;
  }
  if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
  try {
    const res = await window.apiRequest(`/api/admin/animeheaven/sync/${id}`, { method: 'POST' });
    window.showToast?.(res?.message || 'AnimeHeaven sync complete.', 'success');
    await _fetchAnime();
  } catch (error) {
    window.showToast?.(`AnimeHeaven sync failed: ${error.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-sync"></i>'; }
  }
}

async function _handleAnimeHeavenPlaybackCheck(id, button) {
  if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
  try {
    const readiness = await window.apiRequest(`/api/admin/animeheaven/playback-ready/${id}`);
    if (!readiness) {
      window.showToast?.('Could not check playback readiness.', 'error');
      return;
    }
    if (readiness.playbackReady) {
      window.showToast?.(`"${readiness.title}" is Playback Ready (${readiness.totalEpisodes} eps, all with provider keys).`, 'success');
    } else {
      const missing = readiness.missingEpisodeNumbers?.length || 0;
      window.showToast?.(
        `"${readiness.title}" is NOT Playback Ready. ${readiness.totalEpisodes || 0} eps, ${readiness.episodesWithKeys || 0} with keys, ${missing} missing.`,
        'error'
      );
    }
  } catch (error) {
    window.showToast?.(`Playback check failed: ${error.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-check-circle"></i>'; }
  }
}

async function _handleAnimeHeavenRowImport(id, button) {
  const anime = _allAnime.find(a => String(a.id) === String(id));
  if (!anime?.animeheaven_slug) {
    window.showToast?.('This anime has no AnimeHeaven record to import.', 'error');
    return;
  }
  if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
  try {
    const res = await window.apiRequest('/api/admin/animeheaven/import', {
      method: 'POST',
      body: { identifier: anime.animeheaven_slug },
    });
    window.showToast?.(res?.message || 'AnimeHeaven import complete.', 'success');
    await _fetchAnime();
  } catch (error) {
    window.showToast?.(`AnimeHeaven import failed: ${error.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-download"></i>'; }
  }
}

// Expose for potential override
window.animeAction = null;

async function _handleSingleDelete(id) {
  const anime = _allAnime.find(a => String(a.id) === String(id));
  const confirmed = await _showConfirm(
    'Delete Anime',
    `Delete "${anime?.title || 'this anime'}"? This action cannot be undone.`
  );
  if (!confirmed) return;

  try {
    const btn = _q(`.btn-action.delete[data-id="${id}"]`);
    if (btn) btn.classList.add('loading');
    await window.apiRequest(`/api/admin/anime/${id}`, { method: 'DELETE' });
    _selectedIds.delete(String(id));
    await _fetchAnime();
    window.showToast?.('Anime deleted successfully.', 'success');
  } catch (error) {
    window.showToast?.(`Delete failed: ${error.message}`, 'error');
  } finally {
    _qa('.btn-action.delete.loading').forEach(b => b.classList.remove('loading'));
  }
}

async function _handleSync(id, button) {
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  }
  try {
    await window.apiRequest(`/api/admin/anime/${id}/sync`, { method: 'PUT' });
    await _fetchAnime();
    window.showToast?.('Anime synced from Consumet.', 'success');
  } catch (error) {
    window.showToast?.(`Sync failed: ${error.message}`, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = '<i class="fas fa-sync"></i>';
    }
  }
}

// ─── Bulk Actions ─────────────────────────────────────────────────────────────
async function _handleBulkAction(action, button) {
  const ids = [..._selectedIds];
  if (ids.length === 0) return;

  if (action === 'delete') {
    const confirmed = await _showConfirm(
      'Delete Anime',
      `Delete ${ids.length} anime? This action cannot be undone.\n\nAll episodes and associated media will be permanently removed.`
    );
    if (!confirmed) return;
  }

  button?.classList.add('loading');

  try {
    let endpoint, method, body;
    if (action === 'delete') {
      endpoint = '/api/admin/anime/bulk-delete';
      method = 'POST';
      body = { ids };
    } else {
      endpoint = '/api/admin/anime/bulk';
      method = 'PUT';
      body = { ids, action };
    }

    await window.apiRequest(endpoint, { method, body });
    _selectedIds.clear();
    await _fetchAnime();
    const actionLabels = {
      delete: 'deleted', mark_premium: 'marked as premium', remove_premium: 'removed premium',
      feature: 'featured', unfeature: 'unfeatured', publish: 'published', unpublish: 'unpublished'
    };
    window.showToast?.(`${ids.length} anime ${actionLabels[action] || 'updated'} successfully.`, 'success');
  } catch (error) {
    window.showToast?.(`Bulk action failed: ${error.message}`, 'error');
  } finally {
    _qa('.bulk-action-btn.loading').forEach(b => b.classList.remove('loading'));
  }
}

// ─── Export CSV ───────────────────────────────────────────────────────────────
function _exportCSV() {
  const selected = _allAnime.filter(a => _selectedIds.has(String(a.id)));
  const data = selected.length > 0 ? selected : _filteredAnime;

  const headers = ['ID', 'Title', 'Japanese Title', 'Status', 'Media Type', 'Year', 'Studio', 'Premium', 'Featured', 'Episodes', 'Views', 'Rating', 'Genres', 'Created'];
  const rows = data.map(a => [
    a.id, `"${(a.title || '').replace(/"/g, '""')}"`, `"${(a.title_japanese || '').replace(/"/g, '""')}"`,
    a.status || '', a.media_type || '', a.year || '', `"${(a.studio || '').replace(/"/g, '""')}"`,
    a.is_premium ? 'Yes' : 'No', a.is_featured ? 'Yes' : 'No',
    a.episode_count || 0, a.view_count || 0, a.rating || '',
    `"${(Array.isArray(a.genres) ? a.genres.join('; ') : '').replace(/"/g, '""')}"`,
    a.created_at ? new Date(a.created_at).toLocaleDateString() : ''
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `anime-export-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  window.showToast?.(`Exported ${data.length} anime to CSV.`, 'success');
  if (selected.length > 0) {
    _selectedIds.clear();
    _updateUI();
  }
}

// ─── Details Modal ────────────────────────────────────────────────────────────
async function _showDetails(id) {
  const modal = _$el('anime-details-modal');
  const titleEl = _$el('anime-details-title');
  titleEl.textContent = 'Loading...';
  modal.hidden = false;

  try {
    // Try to get from local cache first for instant display
    let anime = _allAnime.find(a => String(a.id) === String(id));

    // Fetch full details from API
    const full = await window.apiRequest(`/api/admin/anime/${id}`);
    if (full) anime = full;

    if (!anime) {
      window.showToast?.('Anime not found.', 'error');
      modal.hidden = true;
      return;
    }

    titleEl.textContent = anime.title || `Anime #${id}`;
    const poster = _$el('details-poster');
    poster.src = anime.cover_image || 'img/placeholder.png';
    const banner = _$el('details-banner');
    if (anime.banner_image) {
      banner.src = anime.banner_image;
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
    _$el('details-title').textContent = anime.title || 'N/A';
    _$el('details-title-japanese').textContent = anime.title_japanese || 'N/A';
    const statusEl = _$el('details-status');
    statusEl.textContent = anime.status || 'N/A';
    statusEl.className = `status-badge ${anime.status || 'unknown'}`;
    _$el('details-media-type').textContent = anime.media_type || 'N/A';
    _$el('details-year').textContent = anime.year || 'N/A';
    _$el('details-studio').textContent = anime.studio || 'N/A';
    _$el('details-season').textContent = anime.season || 'N/A';
    _$el('details-episodes').textContent = anime.episode_count || 0;
    _$el('details-rating').textContent = anime.rating ? `${anime.rating}/10` : 'N/A';
    _$el('details-views').textContent = (anime.view_count || 0).toLocaleString();
    _$el('details-premium').textContent = anime.is_premium ? 'Yes' : 'No';
    _$el('details-featured').textContent = anime.is_featured ? 'Yes' : 'No';
    _$el('details-genres').textContent = Array.isArray(anime.genres) ? anime.genres.join(', ') : 'N/A';
    _$el('details-id').textContent = anime.id;
    _$el('details-created').textContent = anime.created_at ? new Date(anime.created_at).toLocaleString() : 'N/A';
    _$el('details-updated').textContent = anime.updated_at ? new Date(anime.updated_at).toLocaleString() : 'N/A';
    _$el('details-video-source').textContent = anime.video_source || 'N/A';
    _$el('details-cloudinary').textContent = anime.cloudinary_status || 'N/A';
    _$el('details-synopsis').textContent = anime.description || 'No synopsis available.';
    _$el('details-tags').textContent = anime.tags || 'None';

  } catch (error) {
    console.error('[Anime CMS] Details fetch failed:', error);
    const anime = _allAnime.find(a => String(a.id) === String(id));
    if (anime) {
      titleEl.textContent = anime.title || `Anime #${id}`;
      _$el('details-title').textContent = anime.title || 'N/A';
      _$el('details-status').textContent = anime.status || 'N/A';
      _$el('details-synopsis').textContent = anime.description || 'No synopsis available.';
    }
    window.showToast?.('Could not load full details.', 'error');
  }
}

// ─── Confirmation Modal
// Using shared _confirm() from shared.js
let _confirmCallback = null;

function _showConfirm(title, message) {
  return _confirm(
    title,
    message.replace(/\n/g, ' '),
    'Confirm',
    'Cancel'
  );
}

function _closeConfirmModal() {
  _confirmCallback = null;
}

// ─── Add/Edit Modal ───────────────────────────────────────────────────────────
function _openAnimeModal(animeId) {
  _editId = animeId;
  const modal = _$el('add-anime-modal');
  const title = _$el('add-anime-modal-title');
  const form = _$el('manual-add-anime-form');

  form.reset();
  _resetModalTabs();
  if (window.refreshImagePreviews) window.refreshImagePreviews();

  if (animeId) {
    title.textContent = 'Edit Anime';
    const anime = _allAnime.find(a => String(a.id) === String(animeId));
    if (!anime) {
      window.showToast?.('Could not find anime data to edit.', 'error');
      return;
    }
    for (const key in anime) {
      const input = form.querySelector(`[name="${key}"]`);
      if (input) {
        if (input.type === 'checkbox') input.checked = !!anime[key];
        else input.value = anime[key] || '';
      }
    }
    if (window.refreshImagePreviews) window.refreshImagePreviews();
    _showModalTab('manual');
  } else {
    title.textContent = 'Add Anime';
  }

  modal.hidden = false;
}

function _closeAnimeModal() {
  _$el('add-anime-modal').hidden = true;
  _editId = null;
}

function _resetModalTabs() {
  _qa('[data-anime-tab]').forEach(tab => tab.setAttribute('aria-selected', 'false'));
  _qa('[data-anime-panel]').forEach(panel => panel.hidden = true);
  const defaultTab = _q('[data-anime-tab="kitsu"]');
  const defaultPanel = _q('[data-anime-panel="kitsu"]');
  if (defaultTab) defaultTab.setAttribute('aria-selected', 'true');
  if (defaultPanel) defaultPanel.hidden = false;
  _importResults = [];
  const results = _$el('kitsu-search-results');
  if (results) results.innerHTML = '';
  const input = _$el('kitsu-search-input');
  if (input) input.value = '';
}

function _showModalTab(tabName) {
  _qa('[data-anime-tab]').forEach(tab => {
    tab.setAttribute('aria-selected', tab.dataset.animeTab === tabName);
  });
  _qa('[data-anime-panel]').forEach(panel => {
    panel.hidden = panel.dataset.animePanel !== tabName;
  });
}

function _handleModalTabClick(e) {
  const tab = e.target.closest('[data-anime-tab]');
  if (tab) _showModalTab(tab.dataset.animeTab);
}

async function _handleManualFormSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const formData = new FormData(form);
  const premium = form.querySelector('#manual-is-premium').checked;
  formData.set('is_premium', premium ? '1' : '0');
  // Keep the backend access authority (anime.access_tier) consistent with the
  // display flag (is_premium) so inheriting episodes resolve correctly.
  formData.set('access_tier', premium ? 'premium' : 'free');
  formData.set('is_featured', form.querySelector('#manual-is-featured').checked ? '1' : '0');

  const apiRequest = _editId
    ? window.apiRequest(`/api/admin/anime/${_editId}`, { method: 'PUT', body: formData })
    : window.apiRequest('/api/admin/anime', { method: 'POST', body: formData });

  try {
    await apiRequest;
    window.showToast?.(`Anime ${_editId ? 'updated' : 'created'} successfully.`, 'success');
    _closeAnimeModal();
    await _fetchAnime();
  } catch (error) {
    window.showToast?.(`Failed to save anime: ${error.message}`, 'error');
  }
}

// ─── Kitsu Import ─────────────────────────────────────────────────────────────
async function _handleKitsuSearch(e) {
  e.preventDefault();
  const input = _$el('kitsu-search-input');
  const query = input?.value.trim();
  if (!query) return;

  const resultsContainer = _$el('kitsu-search-results');
  resultsContainer.innerHTML = '<p>Searching...</p>';

  try {
    const results = await window.apiRequest(`/api/admin/anime/import/search?q=${encodeURIComponent(query)}`);
    // unwrapAdminEnvelope returns { items, rows, ...meta } for array payloads.
    const items = Array.isArray(results) ? results : (results?.items || results?.rows || []);
    if (!items || items.length === 0) {
      resultsContainer.innerHTML = '<p>No results found on Consumet.</p>';
      return;
    }
    _importResults = items;
    resultsContainer.innerHTML = `
      <div class="universal-import-bar">
        <span>${items.length} matching title${items.length === 1 ? '' : 's'}</span>
        <button type="button" class="btn universal-import-btn">Universal Import</button>
      </div>
    ` + items.map(item => `
      <div class="kitsu-result-item" data-kitsu-id="${item.id}">
        <img src="${item.cover_image}" alt="${item.title}" loading="lazy">
        <div class="kitsu-result-info">
          <strong>${window._escapeHTML(item.title)}</strong>
          <small>${item.year || 'Year unknown'} ${item.episodes ? ` · ${item.episodes} episodes` : ''}</small>
          <small>${window._escapeHTML((item.description || '').slice(0, 120))}</small>
        </div>
        <button type="button" class="btn import-consumet-btn">Import</button>
      </div>
    `).join('');
  } catch (error) {
    console.error('[Anime CMS] Kitsu search failed:', error);
    resultsContainer.innerHTML = `<p style="color: var(--danger);">Search failed: ${error.message}</p>`;
  }
}

async function _handleKitsuResultClick(e) {
  const universalButton = e.target.closest('.universal-import-btn');
  if (universalButton) {
    await _importAllSearchResults(universalButton);
    return;
  }
  const importButton = e.target.closest('.import-consumet-btn');
  if (!importButton) return;
  const item = importButton.closest('.kitsu-result-item');
  const kitsuId = item?.dataset.kitsuId;
  if (!kitsuId) return;

  if (!await _confirm('Import Anime', `Import "${item.querySelector('strong').textContent}"? This will fetch metadata and episodes.`)) return;

  if (await _importProviderAnime(kitsuId, item, importButton)) {
    _closeAnimeModal();
    await _fetchAnime();
    window.showToast?.('Anime imported successfully.', 'success');
  }
}

async function _importProviderAnime(providerId, item, button) {
  const originalMarkup = item?.innerHTML;
  if (button) { button.disabled = true; button.textContent = '...'; }
  if (item) { item.style.pointerEvents = 'none'; item.style.opacity = '0.7'; }
  try {
    await window.apiRequest('/api/admin/anime/import', { method: 'POST', body: { providerId } });
    return true;
  } catch (error) {
    console.error('[Anime CMS] Import failed:', error);
    if (item) {
      item.innerHTML = originalMarkup || 'Import failed. Try again.';
      item.style.pointerEvents = 'auto';
      item.style.opacity = '1';
    }
    window.showToast?.(`Import failed: ${error.message}`, 'error');
    return false;
  }
}

async function _importAllSearchResults(button) {
  if (!_importResults.length) return;
  if (!await _confirm('Import All', `Import all ${_importResults.length} search results? They will be processed one at a time.`)) return;
  button.disabled = true;
  let completed = 0;
  for (const result of _importResults) {
    button.textContent = `Importing ${completed + 1}/${_importResults.length}...`;
    const item = _qa('.kitsu-result-item').find(el => el.dataset.kitsuId === String(result.id));
    if (await _importProviderAnime(result.id, item, null)) completed++;
  }
  await _fetchAnime();
  button.textContent = `Imported ${completed}/${_importResults.length}`;
  window.showToast?.(`${completed} anime imported successfully.`, 'success');
  if (completed === _importResults.length) _closeAnimeModal();
}

// ─── AnimeHeaven Import (Phase 6) ─────────────────────────────────────────────
// AnimeHeaven is the PRIMARY metadata + stream provider. This tab lets the
// admin search AnimeHeaven, preview the anime + episodes, and import it.
// The import stores animeheaven_slug + animeheaven_episode_key so playback
// never needs to re-run AnimeHeaven search.

async function _handleAnimeHeavenSearch(e) {
  e.preventDefault();
  const input = _$el('animeheaven-search-input');
  const query = input?.value.trim();
  if (!query) return;

  const resultsContainer = _$el('animeheaven-search-results');
  resultsContainer.innerHTML = '<p>Searching AnimeHeaven...</p>';

  try {
    const results = await window.apiRequest(`/api/admin/animeheaven/search?q=${encodeURIComponent(query)}`);
    // unwrapAdminEnvelope returns { items, rows, ...meta } for array payloads.
    const items = Array.isArray(results) ? results : (results?.items || results?.rows || []);
    if (!items || items.length === 0) {
      resultsContainer.innerHTML = '<p>No results found on AnimeHeaven.</p>';
      return;
    }
    // Store the full search results for the "Import All" action.
    _ahSearchResults = items;
    resultsContainer.innerHTML = `
      <div class="universal-import-bar">
        <span>${items.length} matching title${items.length === 1 ? '' : 's'}</span>
        <button type="button" class="btn universal-import-btn" id="ah-import-all-btn">Import All</button>
      </div>
    ` + items.map(item => `
      <div class="kitsu-result-item" data-ah-id="${item.identifier || item.id}">
        <img src="${item.image || item.cover || 'img/placeholder.png'}" alt="${item.title}" loading="lazy">
        <div class="kitsu-result-info">
          <strong>${window._escapeHTML(item.title)}</strong>
          <small>AnimeHeaven · ${item.identifier || item.id}</small>
        </div>
        <button type="button" class="btn ah-preview-btn">Preview</button>
        <button type="button" class="btn ah-import-btn">Import</button>
      </div>
    `).join('');
  } catch (error) {
    console.error('[Anime CMS] AnimeHeaven search failed:', error);
    resultsContainer.innerHTML = `<p style="color: var(--danger);">Search failed: ${error.message}</p>`;
  }
}

async function _handleAnimeHeavenResultClick(e) {
  // "Import All" button for the AnimeHeaven search results.
  const importAllButton = e.target.closest('#ah-import-all-btn');
  if (importAllButton) {
    await _importAllAnimeHeavenResults(importAllButton);
    return;
  }

  const previewButton = e.target.closest('.ah-preview-btn');
  const importButton = e.target.closest('.ah-import-btn');
  if (!previewButton && !importButton) return;

  const item = (previewButton || importButton).closest('.kitsu-result-item');
  const identifier = item?.dataset.ahId;
  if (!identifier) return;

  if (previewButton) {
    await _previewAnimeHeaven(identifier, item);
    return;
  }

  const title = item.querySelector('strong')?.textContent || 'this anime';
  if (!await _confirm('Import Anime', `Import "${title}" from AnimeHeaven? This will fetch metadata and episodes.`)) return;

  if (await _importAnimeHeaven(identifier, item, importButton)) {
    _closeAnimeModal();
    await _fetchAnime();
    window.showToast?.('Anime imported from AnimeHeaven successfully.', 'success');
  }
}

async function _previewAnimeHeaven(identifier, item) {
  const infoEl = item?.querySelector('.kitsu-result-info');
  const original = infoEl?.innerHTML;
  if (infoEl) infoEl.innerHTML = '<small>Loading preview...</small>';
  try {
    const preview = await window.apiRequest(`/api/admin/animeheaven/preview/${encodeURIComponent(identifier)}`);
    if (!preview) {
      if (infoEl) infoEl.innerHTML = original || '';
      window.showToast?.('Preview failed.', 'error');
      return;
    }
    if (infoEl) {
      infoEl.innerHTML = `
        <strong>${window._escapeHTML(preview.title)}</strong>
        <small>${preview.year || 'Year unknown'} · ${preview.episodeCount} episodes · ${preview.media_type || 'TV'}</small>
        <small>${window._escapeHTML((preview.description || '').slice(0, 120))}</small>
        <small style="color:var(--accent);">Slug: ${window._escapeHTML(preview.animeheaven_slug)}</small>
      `;
    }
  } catch (error) {
    if (infoEl) infoEl.innerHTML = original || '';
    window.showToast?.(`Preview failed: ${error.message}`, 'error');
  }
}

async function _importAnimeHeaven(identifier, item, button) {
  const originalMarkup = item?.innerHTML;
  if (button) { button.disabled = true; button.textContent = '...'; }
  if (item) { item.style.pointerEvents = 'none'; item.style.opacity = '0.7'; }
  try {
    await window.apiRequest('/api/admin/animeheaven/import', { method: 'POST', body: { identifier } });
    return true;
  } catch (error) {
    console.error('[Anime CMS] AnimeHeaven import failed:', error);
    if (item) {
      item.innerHTML = originalMarkup || 'Import failed. Try again.';
      item.style.pointerEvents = 'auto';
      item.style.opacity = '1';
    }
    window.showToast?.(`Import failed: ${error.message}`, 'error');
    return false;
  }
}

// ── AnimeHeaven "Import All" (Universal Bulk Import) ────────
// Sends ALL search result identifiers to the backend in one request.
// The backend imports them with bounded concurrency and returns a summary.
let _ahSearchResults = [];

async function _importAllAnimeHeavenResults(button) {
  if (!_ahSearchResults.length) return;
  const total = _ahSearchResults.length;
  if (!await _confirm('Import All', `Import all ${total} AnimeHeaven search results? This will fetch metadata and episodes for each.`)) return;

  button.disabled = true;
  button.textContent = `Importing 0/${total}...`;

  try {
    const identifiers = _ahSearchResults.map(r => r.identifier || r.id).filter(Boolean);
    const res = await window.apiRequest('/api/admin/animeheaven/bulk-import', {
      method: 'POST',
      body: { identifiers },
    });

    const summary = res || {};
    const imported = summary.imported || 0;
    const alreadyExists = summary.alreadyExists || 0;
    const failed = summary.failed || 0;

    button.textContent = `${total} processed · ${imported} imported · ${alreadyExists} existed · ${failed} failed`;

    // Show a detailed summary toast.
    const parts = [];
    if (imported) parts.push(`${imported} imported`);
    if (alreadyExists) parts.push(`${alreadyExists} already existed`);
    if (failed) parts.push(`${failed} failed`);
    window.showToast?.(`Bulk import complete: ${parts.join(', ') || 'no changes'}.`, failed ? 'error' : 'success');

    // Refresh the anime table to show newly imported records.
    await _fetchAnime();
  } catch (error) {
    console.error('[Anime CMS] AnimeHeaven bulk import failed:', error);
    button.textContent = 'Import All';
    window.showToast?.(`Bulk import failed: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────
// Use shared _debounce from shared.js — no duplicate needed

// ─── Stream Sync ────────────────────────────────────────────────────────────
async function _handleSyncStreams(animeId, button) {
  if (!animeId) return;
  var anime = _allAnime.find(function(a) { return String(a.id) === String(animeId); });
  var title = anime ? anime.title : 'Anime #' + animeId;

  if (!await window._confirm('Synchronize Streams', 'Check all cached CDN URLs for "' + title + '"? This will observe each cached stream and refresh only confirmed-dead sources.')) return;

  var modal = window.ModalManager.open({
    title: 'Stream Sync: ' + window._escapeHTML(title),
    body: '<div style="text-align:center;padding:2rem;"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p style="margin-top:0.5rem;color:var(--text-muted);">Synchronizing streams...<br>This may take a moment.</p></div>',
    dialogClass: 'stream-sync-dialog',
  });

  try {
    var data = await window.apiRequest('/api/admin/streams/sync/' + animeId, { method: 'POST' });
    var report = data.report || data;

    var html = '<div style="min-width:400px;">';
    html += '<h3 style="margin-bottom:0.5rem;">Sync Complete</h3>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:1rem;">';
    html += '<div style="background:var(--bg-card,#1e1e2e);padding:0.75rem;border-radius:6px;text-align:center;"><strong style="font-size:1.5rem;">' + (report.episodesChecked || 0) + '</strong><br><small style="color:var(--text-muted);">Checked</small></div>';
    html += '<div style="background:var(--bg-card,#1e1e2e);padding:0.75rem;border-radius:6px;text-align:center;color:#4caf50;"><strong style="font-size:1.5rem;">' + (report.healthy || 0) + '</strong><br><small style="color:var(--text-muted);">Healthy</small></div>';
    html += '<div style="background:var(--bg-card,#1e1e2e);padding:0.75rem;border-radius:6px;text-align:center;color:#2196f3;"><strong style="font-size:1.5rem;">' + (report.refreshed || 0) + '</strong><br><small style="color:var(--text-muted);">Refreshed</small></div>';
    html += '<div style="background:var(--bg-card,#1e1e2e);padding:0.75rem;border-radius:6px;text-align:center;color:#f44336;"><strong style="font-size:1.5rem;">' + (report.dead || 0) + '</strong><br><small style="color:var(--text-muted);">Dead</small></div>';
    html += '<div style="background:var(--bg-card,#1e1e2e);padding:0.75rem;border-radius:6px;text-align:center;color:#ff9800;"><strong style="font-size:1.5rem;">' + (report.rotating || 0) + '</strong><br><small style="color:var(--text-muted);">Rotating</small></div>';
    html += '<div style="background:var(--bg-card,#1e1e2e);padding:0.75rem;border-radius:6px;text-align:center;color:#9e9e9e;"><strong style="font-size:1.5rem;">' + (report.longLived || 0) + '</strong><br><small style="color:var(--text-muted);">Long-Lived</small></div>';
    html += '<div style="background:var(--bg-card,#1e1e2e);padding:0.75rem;border-radius:6px;text-align:center;color:#ff9800;"><strong style="font-size:1.5rem;">' + (report.temporary || 0) + '</strong><br><small style="color:var(--text-muted);">Temporary</small></div>';
    html += '<div style="background:var(--bg-card,#1e1e2e);padding:0.75rem;border-radius:6px;text-align:center;color:#f44336;"><strong style="font-size:1.5rem;">' + (report.errors || 0) + '</strong><br><small style="color:var(--text-muted);">Errors</small></div>';
    html += '</div>';
    html += '<div style="margin-top:0.5rem;"><small style="color:var(--text-muted);">' + (report.episodesChecked || 0) + ' episodes checked. Refresh the page to see updated cache status.</small></div>';
    html += '</div>';
    window.ModalManager.update(modal, { body: html });
    window.showToast?.('Stream sync completed for ' + title, 'success');
  } catch (error) {
    window.ModalManager.update(modal, {
      body: '<div style="text-align:center;padding:2rem;color:var(--danger,#f44336);"><i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i><p style="margin-top:0.5rem;">' + window._escapeHTML(error.message) + '</p></div>',
    });
    window.showToast?.('Stream sync failed: ' + error.message, 'error');
  }
}
// ─── Setup ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window.initializeAnimeSection = initializeAnimeSection;
  if (window.location.hash === '#anime') {
    initializeAnimeSection();
  }
});

