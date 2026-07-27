// AdminDashboard/js/ads.js

// --- State ---
let _ads_all = [];
let _ads_editId = null; // null for 'Add' mode, ad.id for 'Edit' mode
let _ads_tbody = null; // Cached tbody element

/**
 * Initializes the Ads management section, fetches data, and sets up event listeners.
 */
function initializeAdsSection() {
    _diag_ads('Initializing Ads management section...');

    // Initial data load
    _loadAds();

    // Cache DOM elements
    _ads_tbody = document.querySelector('#ads-table tbody');

    // Setup event listeners
    const section = document.getElementById('ads-config'); // ID from dashboard.js
    if (!section) return;

    // Main actions
    section.querySelector('#add-ad-btn')?.addEventListener('click', () => _openAdModal(null));

    // Table interaction (delegated)
    const table = section.querySelector('#ads-table');
    if (table) {
        table.addEventListener('click', _handleTableClick);
        table.addEventListener('change', _handleTableChange);
    }

    // Modal interaction - assuming a modal with ID 'ad-modal' exists in the HTML
    const modal = document.getElementById('ad-modal');
    if (modal) {
        modal.querySelector('.close-modal-btn')?.addEventListener('click', () => _closeAdModal());
        modal.addEventListener('click', (e) => { if (e.target === modal) _closeAdModal(); });
        modal.querySelector('#ad-form')?.addEventListener('submit', _handleFormSubmit);
    }
}

/**
 * Diagnostic logger for the Ads module.
 */
function _diag_ads(...args) {
    console.log('[Ads]', ...args);
}

// --- Data Fetching & Rendering ---

/**
 * Fetches all ads from the API and triggers a re-render.
 */
async function _loadAds() {
    if (!_ads_tbody) return;
    _ads_tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading ads...</td></tr>';

    try {
        _ads_all = await window.apiRequest('/api/admin/ads');
        _renderAds();
    } catch (error) {
        _diag_ads('Failed to load ads:', error);
        _ads_tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">Error loading ads. Check console.</td></tr>`;
    }
}

/**
 * Renders the list of ads into the table.
 */
function _renderAds() {
    if (!_ads_tbody) return;

    if (_ads_all.length === 0) {
        _ads_tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No ads have been created yet.</td></tr>';
        return;
    }

    _ads_tbody.innerHTML = _ads_all.map(ad => `
        <tr>
            <td>
                <div class="ad-preview">
                    ${ad.image_url ? `<img src="${ad.image_url}" alt="Ad Preview">` : '<span>No Image</span>'}
                </div>
            </td>
            <td>${window._escapeHTML(ad.title || 'Untitled Ad')}</td>
            <td>${ad.type || 'N/A'}</td>
            <td>
                <label class="switch">
                    <input type="checkbox" class="status-toggle" data-id="${ad.id}" ${ad.is_active ? 'checked' : ''}>
                    <span class="slider round"></span>
                </label>
            </td>
            <td>${ad.target_free_only ? 'Free Only' : 'All Users'}</td>
            <td>
                <button class="btn-action edit" data-id="${ad.id}" title="Edit">✏️</button>
                <button class="btn-action delete" data-id="${ad.id}" title="Delete">🗑️</button>
            </td>
        </tr>
    `).join('');
}

// --- Event Handlers ---

/**
 * Handles delegated click events on the ads table for edit and delete actions.
 */
function _handleTableClick(e) {
    const target = e.target.closest('.btn-action');
    if (!target) return;

    const id = target.dataset.id;
    if (target.classList.contains('edit')) {
        _openAdModal(id);
    } else if (target.classList.contains('delete')) {
        deleteAd(id);
    }
}

/**
 * Handles delegated change events on the ads table, specifically for the status toggle.
 */
function _handleTableChange(e) {
    const target = e.target;
    if (target.matches('.status-toggle')) {
        const id = target.dataset.id;
        const isActive = target.checked;
        _updateAd(id, { is_active: isActive });
    }
}

/**
 * Handles the submission of the add/edit ad form.
 */
async function _handleFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    const body = Object.fromEntries(formData.entries());

    // Ensure checkbox values are correctly represented as booleans/numbers for the API
    body.is_active = form.querySelector('#ad-is-active').checked;
    body.target_free_only = form.querySelector('#ad-target-free-only').checked;
    body.frequency = parseInt(body.frequency, 10) || 1;

    const endpoint = _ads_editId ? `/api/admin/ads/${_ads_editId}` : '/api/admin/ads';
    const method = _ads_editId ? 'PUT' : 'POST';

    try {
        await window.apiRequest(endpoint, { method, body });
        _diag_ads(`Successfully ${_ads_editId ? 'updated' : 'created'} ad.`);
        _closeAdModal();
        await _loadAds(); // Re-fetch and re-render to ensure data consistency and sort order
    } catch (error) {
        _diag_ads('Failed to save ad:', error);
        alert(`Failed to save ad: ${error.message}`);
    }
}

// --- CRUD & Modal Logic ---

/**
 * Sends a PUT request to update an ad's properties.
 * Used for quick actions like toggling status.
 */
async function _updateAd(id, partialBody) {
    try {
        await window.apiRequest(`/api/admin/ads/${id}`, { method: 'PUT', body: partialBody });
        _diag_ads(`Successfully updated ad ${id}.`);
        const adIndex = _ads_all.findIndex(a => String(a.id) === String(id));
        if (adIndex > -1) {
            _ads_all[adIndex] = { ..._ads_all[adIndex], ...partialBody };
        }
        _renderAds(); // Re-render from local cache
    } catch (error) {
        _diag_ads(`Failed to update ad ${id}:`, error);
        alert(`Failed to update ad: ${error.message}`);
        await _loadAds(); // Revert UI on failure
    }
}

/**
 * Deletes an ad after confirmation.
 * @param {number|string} id The ID of the ad to delete.
 */
async function deleteAd(id) {
    if (!confirm('Are you sure you want to delete this ad? This action cannot be undone.')) return;
    try {
        await window.apiRequest(`/api/admin/ads/${id}`, { method: 'DELETE' });
        _diag_ads(`Successfully deleted ad ${id}`);
        _ads_all = _ads_all.filter(ad => String(ad.id) !== String(id));
        _renderAds(); // Re-render from local cache
    } catch (error) {
        console.error(`[Ads] Failed to delete ad ${id}:`, error);
        alert(`Failed to delete ad: ${error.message}`);
    }
}

/**
 * Opens the ad modal for either adding a new ad or editing an existing one.
 * @param {number|string|null} adId The ID of the ad to edit, or null to add a new one.
 */
async function _openAdModal(adId) {
    _ads_editId = adId;
    const modal = document.getElementById('ad-modal');
    if (!modal) {
        _diag_ads('Ad modal could not be found in the DOM.');
        return;
    }
    const title = modal.querySelector('.modal-title');
    const form = modal.querySelector('#ad-form');

    form.reset();
    if (window.refreshImagePreviews) {
        window.refreshImagePreviews();
    }

    if (adId) {
        // --- Edit Mode ---
        title.textContent = 'Edit Ad';
        const ad = _ads_all.find(a => String(a.id) === String(adId));
        if (!ad) {
            alert('Could not find ad data to edit.');
            return;
        }
        // Populate form fields from the ad object
        form.querySelector('#ad-title').value = ad.title || '';
        form.querySelector('#ad-type').value = ad.type || 'banner';
        form.querySelector('#ad-link').value = ad.link || '';
        form.querySelector('#ad-frequency').value = ad.frequency || 1;
        form.querySelector('#ad-is-active').checked = ad.is_active;
        form.querySelector('#ad-target-free-only').checked = ad.target_free_only;

        // Hydrate the image uploader with the existing image URL
        const uploader = form.querySelector('#ad-image-uploader');
        if (uploader && uploader._iuSet) {
            uploader._iuSet(ad.image_url || '');
        }

    } else {
        // --- Add Mode ---
        title.textContent = 'Add New Ad';
    }

    modal.style.display = 'flex';
}

/**
 * Closes the ad modal and resets the edit state.
 */
function _closeAdModal() {
    const modal = document.getElementById('ad-modal');
    if (modal) modal.style.display = 'none';
    _ads_editId = null;
}

// --- Global Exposure ---
document.addEventListener('DOMContentLoaded', () => {
    // Expose the initialization function for the main dashboard script
    window.initializeAdsSection = initializeAdsSection;
    
    // Expose deleteAd globally to preserve any existing onclick handlers, though delegation is preferred
    window.deleteAd = deleteAd;

    // Initialize if the hash matches on page load
    if (window.location.hash === '#ads-config') {
        initializeAdsSection();
    }
});
