// AdminDashboard/js/users.js

// --- State ---
let _users_all = [];
let _users_filtered = [];
let _users_currentPage = 1;
const _users_itemsPerPage = 15;

// --- Initialization ---
function initializeUsersSection() {
    _diag_users('Initializing Users management section...');

    // Initial data load
    _fetchAllUsers();

    // Setup event listeners
    const section = document.getElementById('users');
    if (!section) return;

    // Search and Filters
    section.querySelector('#user-search')?.addEventListener('input', _debounce(_handleFilterChange, 300));
    section.querySelector('#user-filter-role')?.addEventListener('change', _handleFilterChange);
    section.querySelector('#user-filter-plan')?.addEventListener('change', _handleFilterChange);

    // Table interaction (delegated)
    const table = section.querySelector('#users-table');
    table?.addEventListener('click', _handleTableClick);

    // Bulk actions
    section.querySelector('#selectAll-users')?.addEventListener('change', _handleSelectAll);
    section.querySelector('#bulkDeleteBtn-users')?.addEventListener('click', _handleBulkDelete);

    // Pagination
    document.getElementById('users-pagination')?.addEventListener('click', _handlePaginationClick);
}

function _diag_users(...args) {
    console.log('[Users]', ...args);
}

function _debounce(func, delay) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

// --- Data Fetching & Rendering ---

async function _fetchAllUsers() {
    const tableBody = document.querySelector('#users-table tbody');
    if (!tableBody) return;
    tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading users...</td></tr>';

    try {
        _users_all = await window.apiRequest(`/api/admin/users`);
        _handleFilterChange(); // Initial render
    } catch (error) {
        _diag_users('Failed to load users:', error);
        tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--danger);">Error loading users. Check console.</td></tr>`;
    }
}

function _renderUsersPage() {
    const tableBody = document.querySelector('#users-table tbody');
    if (!tableBody) return;

    const startIndex = (_users_currentPage - 1) * _users_itemsPerPage;
    const endIndex = startIndex + _users_itemsPerPage;
    const pageItems = _users_filtered.slice(startIndex, endIndex);

    if (pageItems.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No users found.</td></tr>';
    } else {
        tableBody.innerHTML = pageItems.map(user => `
            <tr>
                <td><input type="checkbox" class="user-select-checkbox" data-id="${user.id}"></td>
                <td>${user.name}</td>
                <td>${user.email}</td>
                <td>${user.is_admin ? 'Admin' : 'User'}</td>
                <td>${user.is_premium ? '💎 Premium' : 'Free'}</td>
                <td><span class="status-badge ${user.status}">${user.status}</span></td>
                <td>
                    <button class="btn-action ban" data-id="${user.id}" data-status="${user.status}" title="${user.status === 'banned' ? 'Unban' : 'Ban'}">${user.status === 'banned' ? '✅' : '🚫'}</button>
                    <button class="btn-action delete" data-id="${user.id}" title="Delete">🗑️</button>
                </td>
            </tr>
        `).join('');
    }

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

// --- Pagination ---
function _renderPagination() {
    const paginationContainer = document.getElementById('users-pagination');
    if (!paginationContainer) return;

    const totalPages = Math.ceil(_users_filtered.length / _users_itemsPerPage);
    if (totalPages <= 1) {
        paginationContainer.innerHTML = '';
        return;
    }

    let html = '';
    html += `<button class="pagination-btn" data-page="prev" ${_users_currentPage === 1 ? 'disabled' : ''}>&laquo; Prev</button>`;

    for (let i = 1; i <= totalPages; i++) {
        html += `<button class="pagination-btn ${i === _users_currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }

    html += `<button class="pagination-btn" data-page="next" ${_users_currentPage === totalPages ? 'disabled' : ''}>Next &raquo;</button>`;
    paginationContainer.innerHTML = html;
}

function _handlePaginationClick(e) {
    const target = e.target.closest('.pagination-btn');
    if (!target) return;

    const page = target.dataset.page;
    const totalPages = Math.ceil(_users_filtered.length / _users_itemsPerPage);

    if (page === 'prev') {
        _users_currentPage = Math.max(1, _users_currentPage - 1);
    } else if (page === 'next') {
        _users_currentPage = Math.min(totalPages, _users_currentPage + 1);
    } else {
        _users_currentPage = parseInt(page, 10);
    }
    _renderUsersPage();
}

// --- Event Handlers & Actions ---
function _handleTableClick(e) {
    const target = e.target;
    const id = target.closest('tr')?.querySelector('.user-select-checkbox')?.dataset.id;

    if (target.matches('.btn-action.delete')) {
        _handleDeleteUser(id);
    } else if (target.matches('.btn-action.ban')) {
        const newStatus = target.dataset.status === 'banned' ? 'active' : 'banned';
        _updateUser(id, { status: newStatus });
    } else if (target.matches('.user-select-checkbox')) {
        _updateBulkDeleteButton();
    }
}

async function _updateUser(id, body) {
    try {
        await window.apiRequest(`/api/admin/users/${id}`, { method: 'PUT', body });
        await _fetchAllUsers(); // Refresh on success
    } catch (error) {
        _diag_users(`Failed to update user ${id}:`, error);
        alert(`Failed to update user: ${error.message}`);
    }
}

async function _handleDeleteUser(id) {
    if (!confirm(`Are you sure you want to delete user ID: ${id}? This cannot be undone.`)) {
        return;
    }
    try {
        // Note: The backend doesn't have a single user delete, so we use bulk delete.
        await window.apiRequest(`/api/admin/users/bulk-delete`, {
            method: 'POST',
            body: { ids: [id] }
        });
        _diag_users(`Successfully deleted user ${id}`);
        await _fetchAllUsers();
    } catch (error) {
        _diag_users(`Failed to delete user ${id}:`, error);
        alert(`Failed to delete user: ${error.message}`);
    }
}

// --- Bulk Actions ---
function _getSelectedIds() {
    return Array.from(document.querySelectorAll('.user-select-checkbox:checked')).map(cb => cb.dataset.id);
}

function _updateBulkDeleteButton() {
    const selectedIds = _getSelectedIds();
    const btn = document.getElementById('bulkDeleteBtn-users');
    const countSpan = document.getElementById('selectedCount-users');
    if (!btn || !countSpan) return;

    if (selectedIds.length > 0) {
        btn.style.display = 'inline-block';
        countSpan.textContent = selectedIds.length;
    } else {
        btn.style.display = 'none';
    }
}

function _handleSelectAll(e) {
    const isChecked = e.target.checked;
    document.querySelectorAll('.user-select-checkbox').forEach(cb => {
        cb.checked = isChecked;
    });
    _updateBulkDeleteButton();
}

async function _handleBulkDelete() {
    const ids = _getSelectedIds();
    if (ids.length === 0) return;

    if (!confirm(`Are you sure you want to delete ${ids.length} users? This cannot be undone.`)) {
        return;
    }

    try {
        await window.apiRequest(`/api/admin/users/bulk-delete`, {
            method: 'POST',
            body: { ids }
        });
        _diag_users(`Successfully bulk deleted ${ids.length} users.`);
        await _fetchAllUsers();
    } catch (error) {
        _diag_users('Failed to bulk delete users:', error);
        alert(`Failed to bulk delete: ${error.message}`);
    }
}

// --- Final Setup ---
document.addEventListener('DOMContentLoaded', () => {
    window.initializeUsersSection = initializeUsersSection;

    if (window.location.hash === '#users') {
        initializeUsersSection();
    }
});
