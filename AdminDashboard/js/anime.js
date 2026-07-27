// AdminDashboard/js/anime.js

// This module handles the "Anime List" section of the admin dashboard.

// --- State ---
let _anime_all = [];
let _anime_filtered = [];
let _anime_currentPage = 1;
const _anime_itemsPerPage = 15;
let _anime_tableBody = null; // Cached tbody element
let _anime_paginationContainer = null; // Cached pagination container
let _anime_editId = null; // null for 'Add' mode, anime.id for 'Edit' mode

// --- Initialization ---
function initializeAnimeSection() {
    _diag_anime('Initializing Anime management section...');

    // Cache DOM elements before the first fetch. Previously the request was
    // skipped because _fetchAllAnime correctly returns when this is null.
    _anime_tableBody = document.querySelector('#anime-table tbody');
    _anime_paginationContainer = document.getElementById('anime-pagination');

    // Initial data load
    _fetchAllAnime();

    // Setup event listeners
    const section = document.getElementById('anime');
    if (!section) return;

    // Search and Filter
    section.querySelector('#anime-search')?.addEventListener('input', _debounce(_handleFilterChange, 300));
    section.querySelector('#anime-filter-status')?.addEventListener('change', _handleFilterChange);

    // Main actions
    section.querySelector('#add-anime-button')?.addEventListener('click', () => _openAnimeModal(null));
    
    // Table interaction (delegated)
    const table = section.querySelector('#anime-table');
    table?.addEventListener('click', _handleTableClick);

    // Bulk actions
    section.querySelector('#selectAll-anime')?.addEventListener('change', _handleSelectAll);
    section.querySelector('#bulkDeleteBtn-anime')?.addEventListener('click', _handleBulkDelete);

    // Modal interaction
    const modal = document.getElementById('add-anime-modal');
    if (modal) {
        modal.querySelector('#close-add-anime-modal')?.addEventListener('click', () => _closeAnimeModal());
        modal.addEventListener('click', (e) => { if (e.target === modal) _closeAnimeModal(); }); // Close on overlay click
        
        // Tab switching
        modal.querySelector('.anime-import-tabs')?.addEventListener('click', _handleModalTabClick);

        // Forms
        modal.querySelector('#kitsu-search-form')?.addEventListener('submit', _handleKitsuSearch);
        modal.querySelector('#manual-add-anime-form')?.addEventListener('submit', _handleManualFormSubmit);
        modal.querySelector('#kitsu-search-results')?.addEventListener('click', _handleKitsuResultClick);
    }
    
    // Pagination (using cached element)
    _anime_paginationContainer?.addEventListener('click', _handlePaginationClick);
}

function _diag_anime(...args) {
    console.log('[Anime]', ...args);
}

function _debounce(func, delay) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

/**
 * Handles the Escape key press to close the modal.
 */
function _handleEscKeyForAnimeModal(e) {
    if (e.key === 'Escape') _closeAnimeModal();
}

// --- Data Fetching & Rendering ---

async function _fetchAllAnime() {
    if (!_anime_tableBody) return;
    _anime_tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading anime...</td></tr>';

    try {
        _anime_all = await window.apiRequest(`/api/admin/anime`);
        _handleFilterChange(); // Initial render
    } catch (error) {
        _diag_anime('Failed to load anime:', error);
        _anime_tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--danger);">Error loading anime. Check console.</td></tr>`;
    }
}

function _renderAnimePage() {
    if (!_anime_tableBody) return;

    const startIndex = (_anime_currentPage - 1) * _anime_itemsPerPage;
    const endIndex = startIndex + _anime_itemsPerPage;
    const pageItems = _anime_filtered.slice(startIndex, endIndex);

    if (pageItems.length === 0) {
        _anime_tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No anime found.</td></tr>';
    } else {
        _anime_tableBody.innerHTML = pageItems.map(anime => `
            <tr>
                <td><input type="checkbox" class="anime-select-checkbox" data-id="${anime.id}"></td>
                <td><img src="${anime.cover_image || 'img/placeholder.png'}" alt="${anime.title}" style="width:40px; height:60px; object-fit:cover; border-radius:4px;"></td>
                <td>${window._escapeHTML(anime.title)}</td>
                <td><span class="status-badge ${anime.status}">${anime.status}</span></td>
                <td>${anime.is_premium ? 'Yes' : 'No'}</td>
                <td>${anime.is_featured ? 'Yes' : 'No'}</td>
                <td>
                    <button class="btn-action edit" data-id="${anime.id}" title="Edit">✏️</button>
                    <button class="btn-action delete" data-id="${anime.id}" title="Delete">🗑️</button>
                </td>
            </tr>
        `).join('');
    }
    
    _renderPagination();
    _updateBulkDeleteButton();
}

function _handleFilterChange() {
    const query = document.getElementById('anime-search')?.value.toLowerCase() || '';
    const status = document.getElementById('anime-filter-status')?.value || '';

    _anime_filtered = _anime_all.filter(anime => {
        const matchesQuery = !query || anime.title.toLowerCase().includes(query);
        const matchesStatus = !status || anime.status === status;
        return matchesQuery && matchesStatus;
    });
    
    _anime_currentPage = 1;
    _renderAnimePage();
}

// --- Pagination ---
function _renderPagination() {
    if (!_anime_paginationContainer) return;

    const totalPages = Math.ceil(_anime_filtered.length / _anime_itemsPerPage);
    if (totalPages <= 1) {
        _anime_paginationContainer.innerHTML = '';
        return;
    }

    let html = '';
    html += `<button class="pagination-btn" data-page="prev" ${_anime_currentPage === 1 ? 'disabled' : ''}>&laquo; Prev</button>`;
    
    // Simplified pagination links for brevity
    for (let i = 1; i <= totalPages; i++) {
        html += `<button class="pagination-btn ${i === _anime_currentPage ? 'active' : ''}" data-page="${i}">${window._escapeHTML(i)}</button>`;
    }

    _anime_paginationContainer.innerHTML = html;
    _anime_paginationContainer.querySelector(`[data-page="prev"]`).disabled = _anime_currentPage === 1;
    _anime_paginationContainer.querySelector(`[data-page="next"]`).disabled = _anime_currentPage === totalPages;
}

function _handlePaginationClick(e) {
    const target = e.target.closest('.pagination-btn');
    if (!target) return;

    const page = target.dataset.page;
    const totalPages = Math.ceil(_anime_filtered.length / _anime_itemsPerPage);

    if (page === 'prev') {
        _anime_currentPage = Math.max(1, _anime_currentPage - 1);
    } else if (page === 'next') {
        _anime_currentPage = Math.min(totalPages, _anime_currentPage + 1);
    } else {
        _anime_currentPage = parseInt(page, 10);
    }
    _renderAnimePage();
}

// --- Event Handlers (Delegated) ---
function _handleTableClick(e) {
    const target = e.target;
    const id = target.closest('tr')?.querySelector('.anime-select-checkbox')?.dataset.id;

    if (target.matches('.btn-action.delete')) {
        handleDeleteAnime(id);
    } else if (target.matches('.btn-action.edit')) {
        _openAnimeModal(id);
    } else if (target.matches('.anime-select-checkbox')) {
        _updateBulkDeleteButton();
    }
}

// --- CRUD Operations ---
async function handleDeleteAnime(id) {
    if (!confirm(`Are you sure you want to delete anime ID: ${id}? This cannot be undone.`)) {
        return;
    }
    try {
        await window.apiRequest(`/api/admin/anime/${id}`, { method: 'DELETE' });
        _diag_anime(`Successfully deleted anime ${id}`);
        _anime_all = _anime_all.filter(anime => String(anime.id) !== String(id));
        _handleFilterChange(); // Re-render from local cache
    } catch (error) {
        _diag_anime(`Failed to delete anime ${id}:`, error);
        window.showToast(`Failed to delete anime: ${error.message}`, 'error');
    }
}

async function _handleManualFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    // The API client is designed to handle FormData directly for file uploads.
    // We just need to ensure checkbox values are correctly represented.
    formData.set('is_premium', form.querySelector('#manual-is-premium').checked ? '1' : '0');
    formData.set('is_featured', form.querySelector('#manual-is-featured').checked ? '1' : '0');
    
    const apiRequest = _anime_editId
        ? window.apiRequest(`/api/admin/anime/${_anime_editId}`, { method: 'PUT', body: formData })
        : window.apiRequest(`/api/admin/anime`, { method: 'POST', body: formData });

    try {
        await apiRequest;
        _diag_anime(`Successfully ${ _anime_editId ? 'updated' : 'created' } anime.`);
        _closeAnimeModal();
        await _fetchAllAnime(); // Re-fetch all to ensure new data is included and sorted correctly
    } catch (error) {
        _diag_anime(`Failed to save anime:`, error);
        window.showToast(`Failed to save anime: ${error.message}`, 'error');
    }
}

// --- Bulk Actions ---
function _getSelectedIds() {
    return Array.from(document.querySelectorAll('.anime-select-checkbox:checked')).map(cb => cb.dataset.id);
}

function _updateBulkDeleteButton() {
    const selectedIds = _getSelectedIds();
    const btn = document.getElementById('bulkDeleteBtn-anime');
    const countSpan = document.getElementById('selectedCount-anime');
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
    document.querySelectorAll('.anime-select-checkbox').forEach(cb => {
        cb.checked = isChecked;
    });
    _updateBulkDeleteButton();
}

async function _handleBulkDelete() {
    const ids = _getSelectedIds();
    if (ids.length === 0) return;

    if (!confirm(`Are you sure you want to delete ${ids.length} anime? This cannot be undone.`)) {
        return;
    }

    try {
        await window.apiRequest(`/api/admin/anime/bulk-delete`, {
            method: 'POST',
            body: { ids }
        });
        _diag_anime(`Successfully bulk deleted ${ids.length} anime.`);
        _anime_all = _anime_all.filter(anime => !ids.includes(String(anime.id)));
        _handleFilterChange(); // Re-render from local cache
    } catch (error) {
        _diag_anime('Failed to bulk delete anime:', error);
        window.showToast(`Failed to bulk delete: ${error.message}`, 'error');
    }
}

// --- Modal ---
async function _openAnimeModal(animeId) {
    _anime_editId = animeId;
    const modal = document.getElementById('add-anime-modal');
    const title = modal.querySelector('#add-anime-modal-title');
    const form = modal.querySelector('#manual-add-anime-form');

    // Reset form
    form.reset();
    _resetModalTabs();
    if (window.refreshImagePreviews) window.refreshImagePreviews();

    if (animeId) {
        // Edit mode
        title.textContent = 'Edit Anime';
        const anime = _anime_all.find(a => String(a.id) === String(animeId));
        if (!anime) {
            window.showToast('Could not find anime data to edit.', 'error');
            return;
        }
        // Populate form
        for (const key in anime) {
            const input = form.querySelector(`[name="${key}"]`);
            if (input) {
                if (input.type === 'checkbox') {
                    input.checked = !!anime[key];
                } else {
                    input.value = anime[key] || '';
                }
            }
        }
        // The backend `genres` field is a comma-separated string, so this works.
        const genresInput = form.querySelector('[name="genres"]');
        if (genresInput) genresInput.value = anime.genres || '';

        // Hydrate image previews
        if (window.refreshImagePreviews) window.refreshImagePreviews();

        // Switch to manual tab for editing
        _showModalTab('manual');

    } else {
        // Add mode
        title.textContent = 'Add Anime';
    }

    modal.hidden = false;
    document.addEventListener('keydown', _handleEscKeyForAnimeModal);
}

function _closeAnimeModal() {
    const modal = document.getElementById('add-anime-modal');
    if (modal) modal.hidden = true;
    _anime_editId = null;
    document.removeEventListener('keydown', _handleEscKeyForAnimeModal);
}

function _resetModalTabs() {
    document.querySelectorAll('[data-anime-tab]').forEach(tab => tab.setAttribute('aria-selected', 'false'));
    document.querySelectorAll('[data-anime-panel]').forEach(panel => panel.hidden = true);
    const defaultTab = document.querySelector('[data-anime-tab="kitsu"]');
    const defaultPanel = document.querySelector('[data-anime-panel="kitsu"]');
    if (defaultTab) defaultTab.setAttribute('aria-selected', 'true');
    if (defaultPanel) defaultPanel.hidden = false;
    document.getElementById('kitsu-search-results').innerHTML = '';
    document.getElementById('kitsu-search-input').value = '';
}

function _showModalTab(tabName) {
    document.querySelectorAll('[data-anime-tab]').forEach(tab => {
        tab.setAttribute('aria-selected', tab.dataset.animeTab === tabName);
    });
    document.querySelectorAll('[data-anime-panel]').forEach(panel => {
        panel.hidden = panel.dataset.animePanel !== tabName;
    });
}

function _handleModalTabClick(e) {
    const tab = e.target.closest('[data-anime-tab]');
    if (tab) {
        _showModalTab(tab.dataset.animeTab);
    }
}

// --- Kitsu Import ---
async function _handleKitsuSearch(e) {
    e.preventDefault();
    const input = document.getElementById('kitsu-search-input');
    const query = input.value.trim();
    if (!query) return;

    const resultsContainer = document.getElementById('kitsu-search-results');
    resultsContainer.innerHTML = '<p>Searching...</p>';

    try {
        const results = await window.apiRequest(`/api/anime/search?q=${encodeURIComponent(query)}`);
        if (!results || results.length === 0) {
            resultsContainer.innerHTML = '<p>No results found on Kitsu.</p>';
            return;
        }
        resultsContainer.innerHTML = results.map(item => `
            <div class="kitsu-result-item" data-kitsu-id="${item.id}">
                <img src="${item.cover_image}" alt="${item.title}">
                <div class="kitsu-result-info">
                    <strong>${window._escapeHTML(item.title)}</strong>
                    <small>${item.year}</small>
                </div>
            </div>
        `).join('');
    } catch (error) {
        _diag_anime('Kitsu search failed:', error);
        resultsContainer.innerHTML = `<p style="color: var(--danger);">Search failed: ${error.message}</p>`;
    }
}

async function _handleKitsuResultClick(e) {
    const item = e.target.closest('.kitsu-result-item');
    const kitsuId = item?.dataset.kitsuId;
    if (!kitsuId) return;

    if (!confirm(`Import "${item.querySelector('strong').textContent}"? This will fetch metadata and episodes.`)) {
        return;
    }

    item.innerHTML += ' <small>Importing...</small>';
    item.style.pointerEvents = 'none';
    item.style.opacity = '0.7';

    try {
        await window.apiRequest('/api/admin/import-anime', {
            method: 'POST',
            body: { kitsuId }
        });
        _diag_anime(`Successfully imported anime from Kitsu ID ${kitsuId}`);
        _closeAnimeModal();
        await _fetchAllAnime(); // Re-fetch all to ensure new data is included and sorted correctly
    } catch (error) {
        _diag_anime('Kitsu import failed:', error);
        window.showToast(`Import failed: ${error.message}`, 'error');
        item.innerHTML = 'Import Failed. Try again.';
        item.style.pointerEvents = 'auto';
        item.style.opacity = '1';
    }
}


// --- Final Setup ---
document.addEventListener('DOMContentLoaded', () => {
    // The main dashboard script now handles section initialization.
    // This script is loaded, but we need to expose the init function.
    window.initializeAnimeSection = initializeAnimeSection;

    // If the anime section is already active on load (e.g. from hash), initialize it.
    if (window.location.hash === '#anime') {
        initializeAnimeSection();
    }
});
