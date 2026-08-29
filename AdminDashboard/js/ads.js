// AdminDashboard/js/ads.js — Enhanced with scheduling, placement management, shared components
// Uses shared.js for: _escapeHTML, showToast, _debounce, _confirm, ModalManager, SkeletonLoader, EmptyState, ErrorState, Badge
//
// Two ad systems:
//   1. Ads Policy (ads_config) — the REAL policy source the player reads via
//      GET/PUT /api/ads/config. This is the primary admin surface.
//   2. Legacy /api/admin/ads CRUD — DEPRECATED. Kept only for backward
//      compatibility; the UI marks it as such so admins don't mistake it for
//      the policy source.

(function() {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  let _ads_all = [];
  let _ads_editId = null;
  let _ads_tbody = null;

  // ─── Ads Policy (ads_config) helpers ────────────────────────────────────
  // Only http(s) URLs are allowed for ad image_url (stored-XSS guard).
  function isHttpUrl(value) {
    if (!value) return false;
    try {
      const u = new URL(String(value));
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  // Load the current ads_config policy into the form.
  async function loadAdsPolicy() {
    const statusEl = document.getElementById('ads-config-status');
    try {
      const cfg = await window.apiRequest('/api/ads/config');
      setCheckbox('ads-policy-banner-enabled', cfg.bannerEnabled);
      setValue('ads-policy-banner-unit-id', cfg.bannerUnitId || '');
      setCheckbox('ads-policy-interstitial-enabled', cfg.interstitialEnabled);
      setValue('ads-policy-interstitial-clicks-between', cfg.interstitialClicksBetween);
      setValue('ads-policy-interstitial-frequency-cap', cfg.interstitialFrequencyCap);
      setValue('ads-policy-interstitial-every-n-episodes', cfg.interstitialEveryNEpisodes);
      setCheckbox('ads-policy-preroll-enabled', cfg.preRollEnabled);
      setValue('ads-policy-preroll-unit-id', cfg.preRollUnitId || '');
      setValue('ads-policy-preroll-frequency-cap', cfg.preRollFrequencyCap);
      setValue('ads-policy-preroll-skippable-after', cfg.preRollSkippableAfterSec);
      setValue('ads-policy-preroll-max-duration', cfg.preRollMaxDurationSec);
      if (statusEl) { statusEl.style.display = 'none'; }
    } catch (err) {
      if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = 'Failed to load ads policy: ' + (err && err.message ? err.message : 'unknown error');
        statusEl.style.color = 'var(--danger,#e74c3c)';
      }
    }
  }

  function setCheckbox(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = !!value;
  }
  function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value === null || value === undefined ? '' : String(value);
  }

  // Save the ads_config policy via PUT /api/ads/config.
  async function saveAdsPolicy() {
    const statusEl = document.getElementById('ads-config-status');
    const body = {
      bannerEnabled: getCheckbox('ads-policy-banner-enabled'),
      bannerUnitId: getValue('ads-policy-banner-unit-id'),
      interstitialEnabled: getCheckbox('ads-policy-interstitial-enabled'),
      interstitialClicksBetween: getInt('ads-policy-interstitial-clicks-between'),
      interstitialFrequencyCap: getInt('ads-policy-interstitial-frequency-cap'),
      interstitialEveryNEpisodes: getInt('ads-policy-interstitial-every-n-episodes'),
      preRollEnabled: getCheckbox('ads-policy-preroll-enabled'),
      preRollUnitId: getValue('ads-policy-preroll-unit-id'),
      preRollFrequencyCap: getInt('ads-policy-preroll-frequency-cap'),
      preRollSkippableAfterSec: getInt('ads-policy-preroll-skippable-after'),
      preRollMaxDurationSec: getInt('ads-policy-preroll-max-duration'),
    };
    try {
      const saved = await window.apiRequest('/api/ads/config', { method: 'PUT', body });
      if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = 'Ads policy saved successfully.';
        statusEl.style.color = 'var(--success,#27ae60)';
      }
      // Re-populate from the server response (authoritative).
      setCheckbox('ads-policy-banner-enabled', saved.bannerEnabled);
      setValue('ads-policy-banner-unit-id', saved.bannerUnitId || '');
      setCheckbox('ads-policy-interstitial-enabled', saved.interstitialEnabled);
      setValue('ads-policy-interstitial-clicks-between', saved.interstitialClicksBetween);
      setValue('ads-policy-interstitial-frequency-cap', saved.interstitialFrequencyCap);
      setValue('ads-policy-interstitial-every-n-episodes', saved.interstitialEveryNEpisodes);
      setCheckbox('ads-policy-preroll-enabled', saved.preRollEnabled);
      setValue('ads-policy-preroll-unit-id', saved.preRollUnitId || '');
      setValue('ads-policy-preroll-frequency-cap', saved.preRollFrequencyCap);
      setValue('ads-policy-preroll-skippable-after', saved.preRollSkippableAfterSec);
      setValue('ads-policy-preroll-max-duration', saved.preRollMaxDurationSec);
    } catch (err) {
      if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = 'Failed to save ads policy: ' + (err && err.message ? err.message : 'unknown error');
        statusEl.style.color = 'var(--danger,#e74c3c)';
      }
    }
  }

  function getCheckbox(id) {
    const el = document.getElementById(id);
    return el ? el.checked : false;
  }
  function getValue(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }
  function getInt(id) {
    const el = document.getElementById(id);
    const n = el ? parseInt(el.value, 10) : NaN;
    return Number.isNaN(n) ? null : n;
  }

  // ─── saveAdsConfig() — referenced by dashboard.html:606 ─────────────────
  // The header "Save Changes" button now saves the real ads_config policy.
  window.saveAdsConfig = function() {
    saveAdsPolicy();
  };

  // ─── Initialization ─────────────────────────────────────────────────────
  function initializeAdsSection() {
    console.log('[Ads] Initializing...');

    _ads_tbody = document.querySelector('#ads-table tbody');
    _setupEventListeners();
    _loadAds();
    loadAdsPolicy();
  }

  function _setupEventListeners() {
    // Add ad button (legacy CRUD)
    document.getElementById('add-ad-btn')?.addEventListener('click', () => _openAdModal(null));

    // Ads Policy form buttons
    document.getElementById('save-ads-policy-btn')?.addEventListener('click', saveAdsPolicy);
    document.getElementById('reload-ads-policy-btn')?.addEventListener('click', loadAdsPolicy);

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

  // ─── Data Fetching (legacy CRUD) ────────────────────────────────────────
  async function _loadAds() {
    if (!_ads_tbody) return;
    _ads_tbody.innerHTML = '<tr><td colspan="7">' + window.SkeletonLoader.table(3, 6) + '</td></tr>';

    try {
      const resp = await window.apiRequest('/api/admin/ads');
      // unwrapAdminEnvelope exposes .items/.rows for array responses
      _ads_all = Array.isArray(resp) ? resp : (resp.items || resp.rows || []);
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
      // XSS guard: only render http(s) image URLs, and escape the value.
      const safeImage = isHttpUrl(ad.image_url) ? window._escapeHTML(ad.image_url) : '';
      return `
      <tr>
        <td>
          <div class="ad-preview">
            ${safeImage ? `<img src="${safeImage}" alt="Ad Preview" style="width:60px;height:40px;object-fit:cover;border-radius:4px;">` : '<span style="color:var(--text-muted);font-size:0.78rem;">No Image</span>'}
          </div>
        </td>
        <td>${window._escapeHTML(ad.title || 'Untitled')}</td>
        <td>${window._escapeHTML(ad.type || 'N/A')}</td>
        <td>
          <label class="switch">
            <input type="checkbox" class="status-toggle" data-id="${ad.id}" ${ad.is_active ? 'checked' : ''}>
            <span class="slider round"></span>
          </label>
        </td>
        <td>${ad.target_free_only ? 'Free Only' : 'All Users'}</td>
        <td style="font-size:0.78rem;color:var(--text-muted);">${window._escapeHTML(scheduleInfo)}</td>
        <td style="white-space:nowrap;">
          <button class="btn-action edit" data-id="${ad.id}" title="Edit Ad" aria-label="Edit Ad"><i class="fas fa-edit"></i></button>
          <button class="btn-action delete" data-id="${ad.id}" title="Delete Ad" aria-label="Delete Ad"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
  }

  // ─── Form Submit (legacy CRUD) ─────────────────────────────────────────
  async function _handleFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    const body = Object.fromEntries(formData.entries());

    // Reject non-http(s) image URLs (stored-XSS guard).
    if (body.image_url && !isHttpUrl(body.image_url)) {
      window.showToast?.('Image URL must be http(s).', 'error');
      return;
    }

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

  // ─── CRUD Operations (legacy) ──────────────────────────────────────────
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

  // ─── Modal Logic (legacy) ──────────────────────────────────────────────
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