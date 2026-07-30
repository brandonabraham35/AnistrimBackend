// AdminDashboard/js/genres.js — Enhanced with edit, search, pagination, shared components
// Uses shared.js for: _escapeHTML, showToast, _debounce, _confirm, ModalManager, SkeletonLoader, EmptyState, ErrorState, Badge

(function() {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  let _genres_all = [];
  let _genres_filtered = [];
  let _genres_currentPage = 1;
  const _genres_perPage = 25;
  let _genres_tbody = null;
  let _genres_pagination = null;
  let _genres_info = null;
  let _searchQuery = '';
  let _editGenreId = null;

  // ─── Initialization ─────────────────────────────────────────────────────
  function initializeGenresSection() {
    console.log('[Genres] Initializing...');

    _genres_tbody = document.querySelector('#genres-table tbody');
    _genres_pagination = document.getElementById('genres-pagination');
    _genres_info = document.getElementById('genres-table-info');

    _setupEventListeners();
    _loadGenres();
  }

  function _setupEventListeners() {
    // Search
    document.getElementById('genres-search')?.addEventListener('input', window._debounce(() => {
      _searchQuery = document.getElementById('genres-search').value.toLowerCase();
      _genres_currentPage = 1;
      _applyFilters();
      _renderGenres();
    }, 300));

    // Add genre form
    document.getElementById('genre-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('genre-name').value.trim();
      if (!name) return;

      try {
        const newGenre = await window.apiRequest('/api/admin/genres', { method: 'POST', body: { name } });
        document.getElementById('genre-name').value = '';
        _genres_all.push(newGenre);
        _applyFilters();
        _renderGenres();
        window.showToast?.('Genre added successfully.', 'success');
      } catch (error) {
        console.error('[Genres] Failed to add:', error);
        window.showToast?.(`Failed to add genre: ${error.message}`, 'error');
      }
    });

    // Table delegation (edit, delete)
    const table = document.querySelector('#genres-table');
    table?.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-action');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.classList.contains('edit')) {
        _openEditGenreModal(id);
      } else if (btn.classList.contains('delete')) {
        _deleteGenre(id);
      }
    });

    // Pagination
    _genres_pagination?.addEventListener('click', (e) => {
      const btn = e.target.closest('.pagination-btn');
      if (!btn) return;
      const page = btn.dataset.page;
      const totalPages = Math.ceil(_genres_filtered.length / _genres_perPage) || 1;
      if (page === 'prev') _genres_currentPage = Math.max(1, _genres_currentPage - 1);
      else if (page === 'next') _genres_currentPage = Math.min(totalPages, _genres_currentPage + 1);
      else _genres_currentPage = parseInt(page, 10);
      _renderGenres();
    });

    // Edit genre modal
    const editModal = document.getElementById('edit-genre-modal');
    if (editModal) {
      editModal.querySelector('#close-edit-genre-modal')?.addEventListener('click', () => _closeEditGenreModal());
      editModal.querySelector('#edit-genre-form')?.addEventListener('submit', _handleEditGenreSubmit);
      editModal.addEventListener('click', (e) => {
        if (e.target === editModal) _closeEditGenreModal();
      });
    }

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') _closeEditGenreModal();
    });
  }

  // ─── Data Fetching ──────────────────────────────────────────────────────
  async function _loadGenres() {
    if (!_genres_tbody) return;
    _genres_tbody.innerHTML = '<tr><td colspan="2">' + window.SkeletonLoader.table(3, 2) + '</td></tr>';

    try {
      _genres_all = await window.apiRequest('/api/admin/genres');
      _applyFilters();
      _renderGenres();
    } catch (error) {
      console.error('[Genres] Failed to load:', error);
      _genres_tbody.innerHTML = '<tr><td colspan="2">' + window.ErrorState.render({
        message: 'Failed to load genres',
        retryFn: () => _loadGenres()
      }) + '</td></tr>';
    }
  }

  // ─── Filtering ──────────────────────────────────────────────────────────
  function _applyFilters() {
    _genres_filtered = _genres_all.filter(g => {
      if (_searchQuery) {
        return g.name.toLowerCase().includes(_searchQuery);
      }
      return true;
    });
  }

  // ─── Rendering ──────────────────────────────────────────────────────────
  function _renderGenres() {
    if (!_genres_tbody) return;

    const start = (_genres_currentPage - 1) * _genres_perPage;
    const pageItems = _genres_filtered.slice(start, start + _genres_perPage);

    if (pageItems.length === 0) {
      _genres_tbody.innerHTML = '<tr><td colspan="2">' + window.EmptyState.render({
        icon: '🏷️',
        title: 'No Genres Found',
        description: _searchQuery ? 'Try adjusting your search.' : 'Start by adding a new genre above.'
      }) + '</td></tr>';
      _genres_pagination.innerHTML = '';
      if (_genres_info) _genres_info.textContent = '';
      return;
    }

    _genres_tbody.innerHTML = pageItems.map(g => `
      <tr>
        <td>${window._escapeHTML(g.name)}</td>
        <td style="white-space:nowrap;">
          <button class="btn-action edit" data-id="${g.id}" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn-action delete" data-id="${g.id}" title="Delete"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');

    _renderPagination();
  }

  function _renderPagination() {
    const totalPages = Math.ceil(_genres_filtered.length / _genres_perPage) || 1;
    if (_genres_info) {
      _genres_info.textContent = `${_genres_filtered.length} genres total · Page ${_genres_currentPage} of ${totalPages}`;
    }
    if (!_genres_pagination) return;
    if (totalPages <= 1) { _genres_pagination.innerHTML = ''; return; }

    let html = '';
    html += `<button class="pagination-btn" data-page="prev" ${_genres_currentPage <= 1 ? 'disabled' : ''}>&laquo; Prev</button>`;
    const start = Math.max(1, _genres_currentPage - 2);
    const end = Math.min(totalPages, _genres_currentPage + 2);
    if (start > 1) {
      html += `<button class="pagination-btn" data-page="1">1</button>`;
      if (start > 2) html += `<span style="color:var(--text-muted);padding:0 4px;">...</span>`;
    }
    for (let i = start; i <= end; i++) {
      html += `<button class="pagination-btn ${i === _genres_currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    if (end < totalPages) {
      if (end < totalPages - 1) html += `<span style="color:var(--text-muted);padding:0 4px;">...</span>`;
      html += `<button class="pagination-btn" data-page="${totalPages}">${totalPages}</button>`;
    }
    html += `<button class="pagination-btn" data-page="next" ${_genres_currentPage >= totalPages ? 'disabled' : ''}>Next &raquo;</button>`;
    _genres_pagination.innerHTML = html;
  }

  // ─── Edit Genre Modal ──────────────────────────────────────────────────
  function _openEditGenreModal(id) {
    _editGenreId = id;
    const genre = _genres_all.find(g => String(g.id) === String(id));
    if (!genre) {
      window.showToast?.('Genre not found.', 'error');
      return;
    }

    const modal = document.getElementById('edit-genre-modal');
    if (!modal) return;

    modal.querySelector('#edit-genre-name').value = genre.name;
    modal.querySelector('.modal-title').textContent = 'Edit Genre';
    modal.hidden = false;
  }

  function _closeEditGenreModal() {
    const modal = document.getElementById('edit-genre-modal');
    if (modal) modal.hidden = true;
    _editGenreId = null;
  }

  async function _handleEditGenreSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('edit-genre-name').value.trim();
    if (!name || !_editGenreId) return;

    try {
      await window.apiRequest(`/api/admin/genres/${_editGenreId}`, {
        method: 'PUT',
        body: { name }
      });
      const idx = _genres_all.findIndex(g => String(g.id) === String(_editGenreId));
      if (idx > -1) _genres_all[idx].name = name;
      _applyFilters();
      _renderGenres();
      _closeEditGenreModal();
      window.showToast?.('Genre updated successfully.', 'success');
    } catch (error) {
      window.showToast?.(`Failed to update genre: ${error.message}`, 'error');
    }
  }

  // ─── Delete Genre ──────────────────────────────────────────────────────
  async function _deleteGenre(id) {
    const genre = _genres_all.find(g => String(g.id) === String(id));
    const confirmed = await window._confirm(
      'Delete Genre',
      `Delete genre "${genre?.name || '#' + id}"? This action cannot be undone.`,
      'Delete',
      'Cancel'
    );
    if (!confirmed) return;

    try {
      await window.apiRequest(`/api/admin/genres/${id}`, { method: 'DELETE' });
      _genres_all = _genres_all.filter(g => String(g.id) !== String(id));
      _applyFilters();
      _renderGenres();
      window.showToast?.('Genre deleted successfully.', 'success');
    } catch (error) {
      window.showToast?.(`Failed to delete genre: ${error.message}`, 'error');
    }
  }

  // ─── Global Exposure ────────────────────────────────────────────────────
  window.initializeGenresSection = initializeGenresSection;

  document.addEventListener('DOMContentLoaded', () => {
    if (window.location.hash === '#genres') {
      initializeGenresSection();
    }
  });

})();
