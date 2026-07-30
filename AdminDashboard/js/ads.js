// AdminDashboard/js/ads.js — Enhanced with scheduling, placement management, shared components
// Uses shared.js for: _escapeHTML, showToast, _debounce, _confirm, ModalManager, SkeletonLoader, EmptyState, ErrorState, Badge

(function() {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  let _ads_all = [];
  let _ads_editId = null;
  let _ads_tbody = null;

  // ─── Initialization ─────────────────────────────────────────────────────
  function initializeAdsSection() {
    console.log('[Ads] Initializing...');

    _ads_tbody = document.querySelector('#ads-table tbody');
    _setupEventListeners();
    _loadAds();
  }

  function _setupEventListeners() {
    // Add ad button
    document.getElementById('add-ad-btn')?.addEventListener('click', () => _openAdModal(null));

    // Table delegation
    const table = document.querySelector('#ads-table');
    table?.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-action');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.classList.contains('edit')) {
        _openAdModal(id);
      } else if (btn.classList.contains('delete')) {
        _deleteAd(id);
      }
    });
    table?.addEventListener('change', (e) => {
      const toggle = e.target.closest('.status-toggle');
      if (toggle) {
        const id = toggle.dataset.id;
        const isActive = toggle.checked;
        _updateAd(id, { is_active: isActive });
      }
    });

    // Modal events
    const modal = document.getElementById('ad-modal');
    if (modal) {
      modal.querySelector('.close-modal-btn')?.addEventListener('click', () => _closeAdModal());
      modal.querySelector('#ad-form')?.addEventListener('submit', _handleFormSubmit);
      modal.addEventListener('click', (e) => { if (e.target === modal) _closeAdModal(); });
    }

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') _closeAdModal();
    });
  }

  // ─── Data Fetching ──────────────────────────────────────────────────────
  async function _loadAds() {
    if (!_ads_tbody) return;
    _ads_tbody.innerHTML = '<tr><td colspan="7">' + window.SkeletonLoader.table(3, 6) + '</td></tr>';

    try {
      _ads_all = await window.apiRequest('/api/admin/ads');
      _renderAds();
    } catch (error) {
      console.error('[Ads] Failed to load:', error);
      _ads_tbody.innerHTML = '<tr><td colspan="7">' + window.ErrorState.render({
        message: 'Failed to load ads',
        retryFn: () => _loadAds()
      }) + '</td></tr>';
    }
  }

  function _renderAds() {
    if (!_ads_tbody) return;

    if (_ads_all.length === 0) {
      _ads_tbody.innerHTML = '<tr><td colspan="7">' + window.EmptyState.render({
        icon: '📢',
        title: 'No Ads Created',
        description: 'Click "Add Ad" to create your first advertisement.'
      }) + '</td></tr>';
      return;
    }

    _ads_tbody.innerHTML = _ads_all.map(ad => {
      const scheduleInfo = ad.start_date || ad.end_date
        ? `${ad.start_date ? window._formatDate(ad.start_date) : 'Any'} → ${ad.end_date ? window._formatDate(ad.end_date) : 'Any'}`
        : 'Always';
      return `
      <tr>
        <td>
          <div class="ad-preview">
            ${ad.image_url ? `<img src="${ad.image_url}" alt="Ad Preview" style="width:60px;height:40px;object-fit:cover;border-radius:4px;">` : '<span style="color:var(--text-muted);font-size:0.78rem;">No Image</span>'}
          </div>
        </td>
        <td>${window._escapeHTML(ad.title || 'Untitled')}</td>
        <td>${ad.type || 'N/A'}</td>
        <td>
          <label class="switch">
            <input type="checkbox" class="status-toggle" data-id="${ad.id}" ${ad.is_active ? 'checked' : ''}>
            <span class="slider round"></span>
          </label>
        </td>
        <td>${ad.target_free_only ? 'Free Only' : 'All Users'}</td>
        <td style="font-size:0.78rem;color:var(--text-muted);">${scheduleInfo}</td>
        <td style="white-space:nowrap;">
          <button class="btn-action edit" data-id="${ad.id}" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn-action delete" data-id="${ad.id}" title="Delete"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
  }

  // ─── Form Submit ───────────────────────────────────────────────────────
  async function _handleFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    const body = Object.fromEntries(formData.entries());

    body.is_active = form.querySelector('#ad-is-active').checked ? '1' : '0';
    body.target_free_only = form.querySelector('#ad-target-free-only').checked ? '1' : '0';
    body.frequency = parseInt(body.frequency, 10) || 1;
    // Scheduling fields
    body.start_date = body.start_date || null;
    body.end_date = body.end_date || null;

    const endpoint = _ads_editId ? `/api/admin/ads/${_ads_editId}` : '/api/admin/ads';
    const method = _ads_editId ? 'PUT' : 'POST';

    try {
      await window.apiRequest(endpoint, { method, body });
      window.showToast?.(`Ad ${_ads_editId ? 'updated' : 'created'} successfully.`, 'success');
      _closeAdModal();
      await _loadAds();
    } catch (error) {
      window.showToast?.(`Failed to save ad: ${error.message}`, 'error');
    }
  }

  // ─── CRUD Operations ───────────────────────────────────────────────────
  async function _updateAd(id, partialBody) {
    try {
      await window.apiRequest(`/api/admin/ads/${id}`, { method: 'PUT', body: partialBody });
      const idx = _ads_all.findIndex(a => String(a.id) === String(id));
      if (idx > -1) _ads_all[idx] = { ..._ads_all[idx], ...partialBody };
      _renderAds();
    } catch (error) {
      window.showToast?.(`Failed to update ad: ${error.message}`, 'error');
      await _loadAds();
    }
  }

  async function _deleteAd(id) {
    const ad = _ads_all.find(a => String(a.id) === String(id));
    const confirmed = await window._confirm(
      'Delete Ad',
      `Delete ad "${ad?.title || '#' + id}"? This action cannot be undone.`,
      'Delete',
      'Cancel'
    );
    if (!confirmed) return;

    try {
      await window.apiRequest(`/api/admin/ads/${id}`, { method: 'DELETE' });
      _ads_all = _ads_all.filter(a => String(a.id) !== String(id));
      _renderAds();
      window.showToast?.('Ad deleted successfully.', 'success');
    } catch (error) {
      window.showToast?.(`Failed to delete ad: ${error.message}`, 'error');
    }
  }

  // ─── Modal Logic ───────────────────────────────────────────────────────
  function _openAdModal(adId) {
    _ads_editId = adId;
    const modal = document.getElementById('ad-modal');
    if (!modal) return;
    const title = modal.querySelector('.modal-title');
    const form = modal.querySelector('#ad-form');
    form.reset();

    if (adId) {
      title.textContent = 'Edit Ad';
      const ad = _ads_all.find(a => String(a.id) === String(adId));
      if (!ad) {
        window.showToast?.('Could not find ad data to edit.', 'error');
        return;
      }
      form.querySelector('#ad-title').value = ad.title || '';
      form.querySelector('#ad-type').value = ad.type || 'banner';
      form.querySelector('#ad-link').value = ad.target_url || '';
      form.querySelector('#ad-frequency').value = ad.frequency || 1;
      form.querySelector('#ad-is-active').checked = ad.is_active === 1 || ad.is_active === true;
      form.querySelector('#ad-target-free-only').checked = ad.target_free_only === 1 || ad.target_free_only === true;
      form.querySelector('#ad-start-date').value = ad.start_date ? ad.start_date.slice(0, 10) : '';
      form.querySelector('#ad-end-date').value = ad.end_date ? ad.end_date.slice(0, 10) : '';
    } else {
      title.textContent = 'Add New Ad';
    }

    modal.style.display = 'flex';
  }

  function _closeAdModal() {
    const modal = document.getElementById('ad-modal');
    if (modal) modal.style.display = 'none';
    _ads_editId = null;
  }

  // ─── Global Exposure ────────────────────────────────────────────────────
  window.initializeAdsSection = initializeAdsSection;

  document.addEventListener('DOMContentLoaded', () => {
    if (window.location.hash === '#ads-config') {
      initializeAdsSection();
    }
  });

})();
