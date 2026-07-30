// AdminDashboard/js/users.js — Enhanced with edit modal, premium management, shared components
// Uses shared.js for: _escapeHTML, showToast, _debounce, _confirm, ModalManager, SkeletonLoader, EmptyState, ErrorState, Badge

(function() {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  let _users_all = [];
  let _users_filtered = [];
  let _users_currentPage = 1;
  const _users_itemsPerPage = 15;
  let _users_tableBody = null;
  let _users_paginationContainer = null;
  let _editUserId = null;

  // ─── Initialization ─────────────────────────────────────────────────────
  function initializeUsersSection() {
    console.log('[Users] Initializing...');

    _users_tableBody = document.querySelector('#users-table tbody');
    _users_paginationContainer = document.getElementById('users-pagination');

    _fetchAllUsers();
    _setupEventListeners();
  }

  function _setupEventListeners() {
    const section = document.getElementById('users');
    if (!section) return;

    // Search
    section.querySelector('#user-search')?.addEventListener('input', window._debounce(_handleFilterChange, 300));
    section.querySelector('#user-filter-role')?.addEventListener('change', _handleFilterChange);
    section.querySelector('#user-filter-plan')?.addEventListener('change', _handleFilterChange);

    // Table delegation
    const table = section.querySelector('#users-table');
    table?.addEventListener('click', _handleTableClick);

    // Bulk actions
    section.querySelector('#selectAll-users')?.addEventListener('change', _handleSelectAll);
    section.querySelector('#bulkDeleteBtn-users')?.addEventListener('click', _handleBulkDelete);

    // Pagination
    _users_paginationContainer?.addEventListener('click', _handlePaginationClick);

    // Edit User Modal events
    const modal = document.getElementById('edit-user-modal');
    if (modal) {
      modal.querySelector('#close-edit-user-modal')?.addEventListener('click', _closeEditUserModal);
      modal.addEventListener('click', (e) => { if (e.target === modal) _closeEditUserModal(); });
      modal.querySelector('#edit-user-form')?.addEventListener('submit', _handleEditUserSubmit);
    }
  }

  // ─── Data Fetching ──────────────────────────────────────────────────────
  async function _fetchAllUsers() {
    if (!_users_tableBody) return;
    _users_tableBody.innerHTML = '<tr><td colspan="7">' + window.SkeletonLoader.table(5, 7) + '</td></tr>';

    try {
      _users_all = await window.apiRequest('/api/admin/users');
      _handleFilterChange();
    } catch (error) {
      console.error('[Users] Failed to load:', error);
      _users_tableBody.innerHTML = '<tr><td colspan="7">' + window.ErrorState.render({
        message: 'Failed to load users',
        retryFn: () => _fetchAllUsers()
      }) + '</td></tr>';
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────
  function _renderUsersPage() {
    if (!_users_tableBody) return;

    const startIndex = (_users_currentPage - 1) * _users_itemsPerPage;
    const endIndex = startIndex + _users_itemsPerPage;
    const pageItems = _users_filtered.slice(startIndex, endIndex);

    if (pageItems.length === 0) {
      _users_tableBody.innerHTML = '<tr><td colspan="7">' + window.EmptyState.render({
        icon: '👤',
        title: 'No Users Found',
        description: _users_filtered.length === 0 && _users_all.length > 0 ? 'Try adjusting your search or filters.' : 'No users registered yet.'
      }) + '</td></tr>';
      return;
    }

    _users_tableBody.innerHTML = pageItems.map(user => {
      const premiumExpiry = user.premium_expires_at
        ? new Date(user.premium_expires_at).toLocaleDateString()
        : '—';
      return `<tr>
        <td><input type="checkbox" class="user-select-checkbox" data-id="${user.id}"></td>
        <td>${window._escapeHTML(user.name)}</td>
        <td>${window._escapeHTML(user.email)}</td>
        <td>${window.Badge.role(user.is_admin)}</td>
        <td>${window.Badge.premium(user.is_premium)}</td>
        <td>${window.Badge.status(user.status)}</td>
        <td style="font-size:0.78rem;color:var(--text-muted);">${premiumExpiry}</td>
        <td style="white-space:nowrap;">
          <button class="btn-action edit" data-id="${user.id}" title="Edit User"><i class="fas fa-edit"></i></button>
          <button class="btn-action ban" data-id="${user.id}" data-status="${user.status}" title="${user.status === 'banned' ? 'Unban' : 'Ban'}">
            ${user.status === 'banned' ? '<i class="fas fa-check-circle" style="color:var(--success);"></i>' : '<i class="fas fa-ban" style="color:var(--warning);"></i>'}
          </button>
          <button class="btn-action delete" data-id="${user.id}" title="Delete User"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');

    _renderPagination();
    _updateBulkDeleteButton();
  }

  function _handleFilterChange() {
    const query = document.getElementById('user-search')?.value.toLowerCase() || '';
    const role = document.getElementById('user-filter-role')?.value || '';
    const plan = document.getElementById('user-filter-plan')?.value || '';

    _users_filtered = _users_all.filter(user => {
      const matchesQuery = !query || user.name.toLowerCase().includes(query) || user.email.toLowerCase().includes(query);
      const matchesRole = !role || (role === 'admin' && user.is_admin) || (role === 'user' && !user.is_admin);
      const matchesPlan = !plan || (plan === 'premium' && user.is_premium) || (plan === 'free' && !user.is_premium);
      return matchesQuery && matchesRole && matchesPlan;
    });

    _users_currentPage = 1;
    _renderUsersPage();
  }

  // ─── Pagination ─────────────────────────────────────────────────────────
  function _renderPagination() {
    if (!_users_paginationContainer) return;
    const totalPages = Math.ceil(_users_filtered.length / _users_itemsPerPage);
    if (totalPages <= 1) { _users_paginationContainer.innerHTML = ''; return; }

    let html = '';
    html += `<button class="pagination-btn" data-page="prev" ${_users_currentPage === 1 ? 'disabled' : ''}>&laquo; Prev</button>`;
    for (let i = 1; i <= totalPages; i++) {
      html += `<button class="pagination-btn ${i === _users_currentPage ? 'active' : ''}" data-page="${i}">${window._escapeHTML(i)}</button>`;
    }
    html += `<button class="pagination-btn" data-page="next" ${_users_currentPage === totalPages ? 'disabled' : ''}>Next &raquo;</button>`;
    _users_paginationContainer.innerHTML = html;
  }

  function _handlePaginationClick(e) {
    const target = e.target.closest('.pagination-btn');
    if (!target) return;
    const page = target.dataset.page;
    const totalPages = Math.ceil(_users_filtered.length / _users_itemsPerPage);
    if (page === 'prev') _users_currentPage = Math.max(1, _users_currentPage - 1);
    else if (page === 'next') _users_currentPage = Math.min(totalPages, _users_currentPage + 1);
    else _users_currentPage = parseInt(page, 10);
    _renderUsersPage();
  }

  // ─── Event Handlers ─────────────────────────────────────────────────────
  function _handleTableClick(e) {
    const btn = e.target.closest('.btn-action');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.classList.contains('edit')) {
      _openEditUserModal(id);
    } else if (btn.classList.contains('delete')) {
      _handleDeleteUser(id);
    } else if (btn.classList.contains('ban')) {
      const newStatus = btn.dataset.status === 'banned' ? 'active' : 'banned';
      _updateUser(id, { status: newStatus });
    }
  }

  async function _updateUser(id, body) {
    try {
      await window.apiRequest(`/api/admin/users/${id}`, { method: 'PUT', body });
      window.showToast?.('User updated.', 'success');
      const idx = _users_all.findIndex(u => String(u.id) === String(id));
      if (idx > -1) _users_all[idx] = { ..._users_all[idx], ...body };
      _handleFilterChange();
    } catch (error) {
      window.showToast?.(`Update failed: ${error.message}`, 'error');
    }
  }

  async function _handleDeleteUser(id) {
    const user = _users_all.find(u => String(u.id) === String(id));
    const confirmed = await window._confirm('Delete User', `Delete user "${user?.name || '#' + id}"? This cannot be undone.`, 'Delete', 'Cancel');
    if (!confirmed) return;
    try {
      await window.apiRequest('/api/admin/users/bulk-delete', { method: 'POST', body: { ids: [id] } });
      _users_all = _users_all.filter(u => String(u.id) !== String(id));
      _handleFilterChange();
      window.showToast?.('User deleted.', 'success');
    } catch (error) {
      window.showToast?.(`Delete failed: ${error.message}`, 'error');
    }
  }

  // ─── Edit User Modal ────────────────────────────────────────────────────
  function _openEditUserModal(id) {
    _editUserId = id;
    const modal = document.getElementById('edit-user-modal');
    const title = modal?.querySelector('.modal-title');
    const form = document.getElementById('edit-user-form');
    if (!modal || !form) { window.showToast?.('Edit user modal is not available in the HTML.', 'error'); return; }

    form.reset();

    const user = _users_all.find(u => String(u.id) === String(id));
    if (!user) { window.showToast?.('User not found.', 'error'); return; }

    title.textContent = `Edit User: ${window._escapeHTML(user.name)}`;
    form.querySelector('#edit-user-name').value = user.name || '';
    form.querySelector('#edit-user-email').value = user.email || '';
    form.querySelector('#edit-user-is-admin').checked = !!user.is_admin;
    form.querySelector('#edit-user-is-premium').checked = !!user.is_premium;
    form.querySelector('#edit-user-status').value = user.status || 'active';
    if (user.premium_expires_at) {
      form.querySelector('#edit-user-premium-expiry').value = user.premium_expires_at.slice(0, 10);
    }

    modal.hidden = false;
  }

  function _closeEditUserModal() {
    const modal = document.getElementById('edit-user-modal');
    if (modal) modal.hidden = true;
    _editUserId = null;
  }

  async function _handleEditUserSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const body = {
      name: form.querySelector('#edit-user-name').value,
      email: form.querySelector('#edit-user-email').value,
      is_admin: form.querySelector('#edit-user-is-admin').checked ? '1' : '0',
      is_premium: form.querySelector('#edit-user-is-premium').checked ? '1' : '0',
      status: form.querySelector('#edit-user-status').value,
      premium_expires_at: form.querySelector('#edit-user-premium-expiry').value || null,
    };

    try {
      await window.apiRequest(`/api/admin/users/${_editUserId}`, { method: 'PUT', body });
      window.showToast?.('User updated.', 'success');
      _closeEditUserModal();
      await _fetchAllUsers();
    } catch (error) {
      window.showToast?.(`Failed to update user: ${error.message}`, 'error');
    }
  }

  // ─── Bulk Actions ───────────────────────────────────────────────────────
  function _getSelectedIds() {
    return Array.from(document.querySelectorAll('.user-select-checkbox:checked')).map(cb => cb.dataset.id);
  }

  function _updateBulkDeleteButton() {
    const ids = _getSelectedIds();
    const btn = document.getElementById('bulkDeleteBtn-users');
    const countSpan = document.getElementById('selectedCount-users');
    if (!btn || !countSpan) return;
    btn.style.display = ids.length > 0 ? 'inline-block' : 'none';
    countSpan.textContent = ids.length;
  }

  function _handleSelectAll(e) {
    document.querySelectorAll('.user-select-checkbox').forEach(cb => { cb.checked = e.target.checked; });
    _updateBulkDeleteButton();
  }

  async function _handleBulkDelete() {
    const ids = _getSelectedIds();
    if (ids.length === 0) return;
    const confirmed = await window._confirm('Delete Users', `Delete ${ids.length} users? This cannot be undone.`, 'Delete', 'Cancel');
    if (!confirmed) return;
    try {
      await window.apiRequest('/api/admin/users/bulk-delete', { method: 'POST', body: { ids } });
      _users_all = _users_all.filter(u => !ids.includes(String(u.id)));
      _handleFilterChange();
      window.showToast?.(`${ids.length} users deleted.`, 'success');
    } catch (error) {
      window.showToast?.(`Bulk delete failed: ${error.message}`, 'error');
    }
  }

  // ─── Global Exposure ────────────────────────────────────────────────────
  window.initializeUsersSection = initializeUsersSection;

  document.addEventListener('DOMContentLoaded', () => {
    if (window.location.hash === '#users') {
      initializeUsersSection();
    }
  });

})();

