/**
 * ─────────────────────────────────────────────
 *  shared.js — Admin Dashboard Component Library
 *  Single source of truth for reusable UI
 * ─────────────────────────────────────────────
 */

(function() {
  'use strict';

  // ─── 1. UTILITY FUNCTIONS ──────────────────────────────────────────────

  /** XSS-safe string escaping */
  window._escapeHTML = function(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"')
      .replace(/'/g, '&#039;');
  };

  /** Debounce utility */
  window._debounce = function(fn, delay) {
    let timer;
    return function(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  };

  /** Throttle utility */
  window._throttle = function(fn, limit) {
    let inThrottle = false;
    return function(...args) {
      if (!inThrottle) {
        fn.apply(this, args);
        inThrottle = true;
        setTimeout(() => { inThrottle = false; }, limit);
      }
    };
  };

  /** Format number with commas */
  window._formatNumber = function(n) {
    if (n === null || n === undefined) return '0';
    return Number(n).toLocaleString();
  };

  /** Format date to locale string */
  window._formatDate = function(date, options) {
    if (!date) return '—';
    try {
      return new Date(date).toLocaleDateString('en-US', options || {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    } catch (e) {
      return String(date);
    }
  };

  /** Format datetime with time */
  window._formatDateTime = function(date) {
    if (!date) return '—';
    try {
      return new Date(date).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return String(date);
    }
  };

  /** Format relative time (e.g. "2 hours ago") */
  window._timeAgo = function(date) {
    if (!date) return '—';
    const now = Date.now();
    const then = new Date(date).getTime();
    const diff = Math.max(0, now - then);
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 30) return `${days}d ago`;
    return window._formatDate(date);
  };

  /** Clean image URL (strip null/undefined) */
  window._cleanImg = function(v) {
    if (v === undefined || v === null) return '';
    const t = String(v).trim();
    if (!t || t.toLowerCase() === 'undefined' || t.toLowerCase() === 'null') return '';
    return t;
  };

  /** Generate a unique ID */
  window._uid = (function() {
    let counter = 0;
    return function(prefix) {
      return (prefix || 'ui') + '-' + (++counter) + '-' + Date.now().toString(36);
    };
  })();

  // ─── 2. TOAST NOTIFICATION SYSTEM ─────────────────────────────────────

  /** Show a toast notification */
  window.showToast = function(msg, type) {
    if (type === undefined) type = 'success';
    let toast = document.getElementById('admin-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'admin-toast';
      toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #11131b;
        border: 1px solid #2a2c37;
        color: #f8fafc;
        padding: 12px 20px;
        border-radius: 8px;
        font-family: 'Inter', system-ui, sans-serif;
        font-size: 0.9rem;
        font-weight: 500;
        z-index: 10000;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        transition: opacity 0.3s, transform 0.3s;
        transform: translateY(20px);
        opacity: 0;
        pointer-events: none;
        max-width: 420px;
        word-break: break-word;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = window._escapeHTML(msg);
    const borderColor = type === 'error' ? '#f43f5e'
                      : type === 'warning' ? '#f59e0b'
                      : '#dc2626';
    toast.style.borderColor = borderColor;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
    }, 4000);
  };

  // ─── 3. CONFIRMATION DIALOG (Promise-based) ───────────────────────────

  /** Show a confirmation dialog. Returns a Promise<boolean>. */
  window._confirm = function(title, message, confirmText, cancelText) {
    return new Promise((resolve) => {
      const id = window._uid('confirm');
      const overlay = document.createElement('div');
      overlay.id = id;
      overlay.className = 'shared-modal-overlay';
      overlay.innerHTML = `
        <div class="shared-modal-dialog shared-confirm-dialog">
          <div class="shared-modal-header">
            <h3>${window._escapeHTML(title || 'Confirm')}</h3>
          </div>
          <div class="shared-modal-body">
            <p>${window._escapeHTML(message || 'Are you sure?')}</p>
          </div>
          <div class="shared-modal-footer">
            <button type="button" class="btn secondary shared-confirm-cancel">${window._escapeHTML(cancelText || 'Cancel')}</button>
            <button type="button" class="btn danger shared-confirm-ok">${window._escapeHTML(confirmText || 'Confirm')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = (result) => {
        overlay.remove();
        resolve(result);
      };
      overlay.querySelector('.shared-confirm-cancel').addEventListener('click', () => close(false));
      overlay.querySelector('.shared-confirm-ok').addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });
      document.addEventListener('keydown', function handler(e) {
        if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', handler); }
      });
    });
  };

  // ─── 4. MODAL MANAGER ─────────────────────────────────────────────────

  window.ModalManager = {
    /** Open a modal with specified content */
    open: function(options) {
      const id = options.id || window._uid('modal');
      let modal = document.getElementById(id);
      if (!modal) {
        modal = document.createElement('div');
        modal.id = id;
        modal.className = 'shared-modal-overlay';
        modal.innerHTML = `
          <div class="shared-modal-dialog ${options.dialogClass || ''}">
            <div class="shared-modal-header">
              <h3 class="shared-modal-title">${window._escapeHTML(options.title || '')}</h3>
              <button type="button" class="shared-modal-close" aria-label="Close">&times;</button>
            </div>
            <div class="shared-modal-body">${options.body || ''}</div>
            ${options.footer ? `<div class="shared-modal-footer">${options.footer}</div>` : ''}
          </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.shared-modal-close').addEventListener('click', () => this.close(id));
        modal.addEventListener('click', (e) => {
          if (e.target === modal) this.close(id);
        });
        document.addEventListener('keydown', function handler(e) {
          if (e.key === 'Escape') { document.getElementById(id)?.remove(); document.removeEventListener('keydown', handler); }
        });
      }
      modal.style.display = '';
      return id;
    },

    /** Close a modal by ID */
    close: function(id) {
      const modal = document.getElementById(id);
      if (modal) modal.remove();
    },

    /** Close all open modals */
    closeAll: function() {
      document.querySelectorAll('.shared-modal-overlay').forEach(m => m.remove());
    }
  };

  // ─── 5. SKELETON LOADER ───────────────────────────────────────────────

  window.SkeletonLoader = {
    /** Create a table skeleton with specified rows/cols */
    table: function(rows, cols) {
      rows = rows || 5;
      cols = cols || 6;
      let html = '<div class="skeleton-table">';
      // Header skeleton
      html += '<div class="skeleton-row skeleton-header-row">';
      for (let c = 0; c < cols; c++) {
        html += `<div class="skeleton-cell"><div class="skeleton-box" style="height:16px;width:${60 + Math.random() * 30}%"></div></div>`;
      }
      html += '</div>';
      // Body skeletons
      for (let r = 0; r < rows; r++) {
        html += '<div class="skeleton-row">';
        for (let c = 0; c < cols; c++) {
          const w = c === 0 ? '40px' : `${50 + Math.random() * 40}%`;
          html += `<div class="skeleton-cell"><div class="skeleton-box" style="height:${c === 0 ? '40px' : '14px'};width:${w};${c === 0 ? 'border-radius:4px;' : ''}"></div></div>`;
        }
        html += '</div>';
      }
      html += '</div>';
      return html;
    },

    /** Create stat card skeletons */
    stats: function(count) {
      count = count || 4;
      let html = '<div class="skeleton-stats-grid">';
      for (let i = 0; i < count; i++) {
        html += `
          <div class="skeleton-stat-card">
            <div class="skeleton-box" style="height:12px;width:60%;margin-bottom:12px;"></div>
            <div class="skeleton-box" style="height:28px;width:40%;margin-bottom:8px;"></div>
            <div class="skeleton-box" style="height:12px;width:50%;"></div>
          </div>
        `;
      }
      html += '</div>';
      return html;
    },

    /** Create card skeletons (for anime cards, etc.) */
    cards: function(count) {
      count = count || 6;
      let html = '<div class="skeleton-cards-grid">';
      for (let i = 0; i < count; i++) {
        html += `
          <div class="skeleton-card">
            <div class="skeleton-box" style="height:140px;width:100%;border-radius:8px;margin-bottom:10px;"></div>
            <div class="skeleton-box" style="height:16px;width:70%;margin-bottom:8px;"></div>
            <div class="skeleton-box" style="height:12px;width:50%;"></div>
          </div>
        `;
      }
      html += '</div>';
      return html;
    },

    /** Create chart skeleton */
    chart: function() {
      return `
        <div class="skeleton-chart">
          <div class="skeleton-box" style="height:100%;width:100%;border-radius:8px;"></div>
        </div>
      `;
    },

    /** Create form skeleton with specified number of fields */
    form: function(fields) {
      fields = fields || 4;
      let html = '<div class="skeleton-form">';
      for (let i = 0; i < fields; i++) {
        html += `
          <div style="margin-bottom:16px;">
            <div class="skeleton-box" style="height:12px;width:30%;margin-bottom:6px;"></div>
            <div class="skeleton-box" style="height:38px;width:100%;border-radius:6px;"></div>
          </div>
        `;
      }
      html += '</div>';
      return html;
    },

    /** Show skeleton in a container */
    show: function(container, type, count) {
      if (typeof container === 'string') container = document.querySelector(container);
      if (!container) return;
      container.dataset.skeletonOriginal = container.innerHTML;
      const renderers = {
        table: () => this.table(count, 6),
        stats: () => this.stats(count || 4),
        cards: () => this.cards(count || 6),
        chart: () => this.chart(),
        form: () => this.form(count || 4)
      };
      container.innerHTML = (renderers[type] || renderers.table)();
    },

    /** Hide skeleton and restore original content */
    hide: function(container) {
      if (typeof container === 'string') container = document.querySelector(container);
      if (!container) return;
      if (container.dataset.skeletonOriginal) {
        container.innerHTML = container.dataset.skeletonOriginal;
        delete container.dataset.skeletonOriginal;
      }
    }
  };

  // ─── 6. EMPTY STATE COMPONENT ─────────────────────────────────────────

  window.EmptyState = {
    /** Render an empty state with icon, title, description, and optional action */
    render: function(options) {
      const icon = options.icon || '📦';
      const title = options.title || 'No data found';
      const description = options.description || '';
      const actionText = options.actionText || '';
      const actionFn = options.actionFn || null;
      const container = options.container || null;

      const html = `
        <div class="shared-empty-state">
          <div class="shared-empty-icon">${icon}</div>
          <h3 class="shared-empty-title">${window._escapeHTML(title)}</h3>
          ${description ? `<p class="shared-empty-desc">${window._escapeHTML(description)}</p>` : ''}
          ${actionText ? `<button type="button" class="btn shared-empty-action">${window._escapeHTML(actionText)}</button>` : ''}
        </div>
      `;

      if (container) {
        container.innerHTML = html;
        if (actionFn) {
          container.querySelector('.shared-empty-action')?.addEventListener('click', actionFn);
        }
      }
      return html;
    }
  };

  // ─── 7. ERROR STATE COMPONENT ─────────────────────────────────────────

  window.ErrorState = {
    /** Render an error state with message and retry button */
    render: function(options) {
      const message = options.message || 'Something went wrong';
      const details = options.details || '';
      const retryFn = options.retryFn || null;
      const container = options.container || null;

      const html = `
        <div class="shared-error-state">
          <div class="shared-error-icon">⚠️</div>
          <h3 class="shared-error-title">${window._escapeHTML(message)}</h3>
          ${details ? `<p class="shared-error-desc">${window._escapeHTML(details)}</p>` : ''}
          ${retryFn ? `<button type="button" class="btn shared-error-retry">↻ Retry</button>` : ''}
        </div>
      `;

      if (container) {
        container.innerHTML = html;
        if (retryFn) {
          container.querySelector('.shared-error-retry')?.addEventListener('click', retryFn);
        }
      }
      return html;
    }
  };

  // ─── 8. BADGE UTILITIES ───────────────────────────────────────────────

  window.Badge = {
    /** Premium badge */
    premium: function(isPremium) {
      if (isPremium) return '<span class="shared-badge shared-badge-premium">Premium</span>';
      return '<span class="shared-badge shared-badge-free">Free</span>';
    },

    /** Status badge (airing, completed, upcoming, unknown) */
    status: function(status) {
      const map = {
        airing: { class: 'shared-badge-airing', label: 'Airing' },
        completed: { class: 'shared-badge-completed', label: 'Completed' },
        upcoming: { class: 'shared-badge-upcoming', label: 'Upcoming' },
        publishing: { class: 'shared-badge-airing', label: 'Publishing' },
        finished: { class: 'shared-badge-completed', label: 'Finished' },
        cancelled: { class: 'shared-badge-error', label: 'Cancelled' },
        hiatus: { class: 'shared-badge-warning', label: 'Hiatus' }
      };
      const s = status ? status.toLowerCase() : 'unknown';
      const config = map[s] || { class: 'shared-badge-unknown', label: status || 'Unknown' };
      return `<span class="shared-badge ${config.class}">${window._escapeHTML(config.label)}</span>`;
    },

    /** Boolean badge (Yes/No) */
    bool: function(value, yesLabel, noLabel) {
      if (value) return `<span class="shared-badge shared-badge-success">${window._escapeHTML(yesLabel || 'Yes')}</span>`;
      return `<span class="shared-badge shared-badge-muted">${window._escapeHTML(noLabel || 'No')}</span>`;
    },

    /** Role badge */
    role: function(isAdmin) {
      if (isAdmin) return '<span class="shared-badge shared-badge-admin">Admin</span>';
      return '<span class="shared-badge shared-badge-user">User</span>';
    },

    /** Featured badge */
    featured: function(isFeatured) {
      if (isFeatured) return '<span class="shared-badge shared-badge-featured">Featured</span>';
      return '';
    }
  };

  // ─── 9. LOADING OVERLAY ───────────────────────────────────────────────

  window._showLoading = function(container) {
    if (typeof container === 'string') container = document.querySelector(container);
    if (!container) return;
    const overlay = document.createElement('div');
    overlay.className = 'shared-loading-overlay';
    overlay.innerHTML = '<div class="shared-loading-spinner"></div>';
    container.style.position = 'relative';
    container.appendChild(overlay);
    return overlay;
  };

  window._hideLoading = function(overlay) {
    if (overlay) overlay.remove();
  };

  // ─── 10. DATATABLE CLASS ─────────────────────────────────────────────

  /**
   * Reusable DataTable component.
   * Usage:
   *   const table = new DataTable({
   *     container: '#my-table-container',
   *     columns: [
   *       { key: 'title', label: 'Title', sortable: true },
   *       { key: 'status', label: 'Status', render: (v) => Badge.status(v) }
   *     ],
   *     fetchFn: async () => { return [...]; }
   *   });
   *   table.init();
   */
  window.DataTable = class {
    constructor(config) {
      this.config = config;
      this.container = typeof config.container === 'string'
        ? document.querySelector(config.container)
        : config.container;
      this.columns = config.columns || [];
      this.fetchFn = config.fetchFn;
      this.rowIdKey = config.rowIdKey || 'id';
      this.selectable = config.selectable !== false;
      this.pageSize = config.pageSize || 25;
      this.searchable = config.searchable !== false;
      this.filters = config.filters || {};
      this.bulkActions = config.bulkActions || [];

      // State
      this._allData = [];
      this._filteredData = [];
      this._selected = new Set();
      this._currentPage = 1;
      this._sortField = config.defaultSort || '';
      this._sortOrder = config.defaultSortOrder || 'desc';
      this._isLoading = false;
    }

    /** Initialize the DataTable */
    async init() {
      if (!this.container) return;
      this._renderLayout();
      this._bindEvents();
      await this.refresh();
    }

    /** Refresh data from fetchFn */
    async refresh() {
      if (!this.fetchFn) return;
      this._isLoading = true;
      this._showSkeleton();

      try {
        this._allData = await this.fetchFn();
        this._applyFilters();
        this._sort();
        this._render();
      } catch (error) {
        console.error('[DataTable] Fetch error:', error);
        ErrorState.render({
          container: this._bodyContainer,
          message: 'Failed to load data',
          details: error.message,
          retryFn: () => this.refresh()
        });
      } finally {
        this._isLoading = false;
      }
    }

    /** Reload from existing data without fetching */
    reload() {
      this._applyFilters();
      this._sort();
      this._render();
    }

    /** Get currently visible page items */
    getPageItems() {
      const start = (this._currentPage - 1) * this.pageSize;
      return this._filteredData.slice(start, start + this.pageSize);
    }

    /** Get selected IDs */
    getSelected() {
      return [...this._selected];
    }

    /** Clear selection */
    clearSelection() {
      this._selected.clear();
      this._render();
    }

    /** Get all filtered data (for CSV export, etc.) */
    getAllFiltered() {
      return this._filteredData;
    }

    // ─── Private Methods ──────────────────────────────────────────────────

    _renderLayout() {
      this.container.innerHTML = `
        <div class="datatable-wrapper">
          ${this.searchable ? `
            <div class="datatable-toolbar">
              <div class="datatable-search">
                <i class="fas fa-search"></i>
                <input type="search" class="datatable-search-input" placeholder="Search..." aria-label="Search">
              </div>
              <div class="datatable-filters"></div>
            </div>
          ` : ''}
          <div class="datatable-bulk-toolbar" style="display:none;">
            <span class="datatable-bulk-count"><span class="datatable-bulk-count-num">0</span> selected</span>
            <div class="datatable-bulk-actions"></div>
            <button type="button" class="btn secondary datatable-bulk-cancel" style="font-size:0.78rem;">✕ Cancel</button>
          </div>
          <div class="datatable-table-container">
            <div class="datatable-skeleton-placeholder"></div>
            <div class="datatable-body"></div>
          </div>
          <div class="datatable-footer">
            <div class="datatable-info"></div>
            <div class="datatable-pagination"></div>
          </div>
        </div>
      `;

      this._searchInput = this.container.querySelector('.datatable-search-input');
      this._filtersContainer = this.container.querySelector('.datatable-filters');
      this._tbodyContainer = this.container.querySelector('.datatable-body');
      this._skeletonPlaceholder = this.container.querySelector('.datatable-skeleton-placeholder');
      this._paginationContainer = this.container.querySelector('.datatable-pagination');
      this._infoContainer = this.container.querySelector('.datatable-info');
      this._bulkToolbar = this.container.querySelector('.datatable-bulk-toolbar');
      this._bulkCount = this.container.querySelector('.datatable-bulk-count-num');
      this._bulkActionsContainer = this.container.querySelector('.datatable-bulk-actions');

      // Build filter controls
      if (this.filters && Object.keys(this.filters).length > 0) {
        for (const [key, filter] of Object.entries(this.filters)) {
          const select = document.createElement('select');
          select.className = 'datatable-filter-select';
          select.dataset.filterKey = key;
          select.innerHTML = `<option value="">${window._escapeHTML(filter.label || key)}</option>`;
          if (filter.options) {
            for (const opt of filter.options) {
              const val = typeof opt === 'object' ? opt.value : opt;
              const lbl = typeof opt === 'object' ? opt.label : opt;
              select.innerHTML += `<option value="${window._escapeHTML(String(val))}">${window._escapeHTML(String(lbl))}</option>`;
            }
          }
          this._filtersContainer.appendChild(select);
        }
      }

      // Build bulk action buttons
      if (this.bulkActions.length > 0) {
        for (const action of this.bulkActions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `btn ${action.danger ? 'danger' : ''} datatable-bulk-btn`;
          btn.dataset.bulkAction = action.key;
          btn.textContent = action.label;
          this._bulkActionsContainer.appendChild(btn);
        }
      }
    }

    _bindEvents() {
      // Search
      this._searchInput?.addEventListener('input', window._debounce(() => {
        this._searchQuery = this._searchInput.value.toLowerCase();
        this._currentPage = 1;
        this._applyFilters();
        this._render();
      }, 300));

      // Filters
      this._filtersContainer?.addEventListener('change', (e) => {
        const select = e.target.closest('.datatable-filter-select');
        if (!select) return;
        const key = select.dataset.filterKey;
        const value = select.value;
        this._activeFilters = this._activeFilters || {};
        this._activeFilters[key] = value;
        this._currentPage = 1;
        this._applyFilters();
        this._render();
      });

      // Pagination
      this._paginationContainer?.addEventListener('click', (e) => {
        const btn = e.target.closest('.pagination-btn');
        if (!btn) return;
        const page = btn.dataset.page;
        const totalPages = Math.ceil(this._filteredData.length / this.pageSize) || 1;
        if (page === 'prev') this._currentPage = Math.max(1, this._currentPage - 1);
        else if (page === 'next') this._currentPage = Math.min(totalPages, this._currentPage + 1);
        else this._currentPage = parseInt(page, 10);
        this._render();
      });

      // Sort on header click
      this._tbodyContainer?.addEventListener('click', (e) => {
        const th = e.target.closest('.datatable-th-sortable');
        if (!th) return;
        const key = th.dataset.sortKey;
        if (!key) return;
        if (this._sortField === key) {
          this._sortOrder = this._sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
          this._sortField = key;
          this._sortOrder = 'desc';
        }
        this._sort();
        this._render();
      });

      // Select all
      this._tbodyContainer?.addEventListener('change', (e) => {
        if (e.target.closest('.datatable-select-all')) {
          const checked = e.target.checked;
          this.getPageItems().forEach(item => {
            const id = String(item[this.rowIdKey]);
            if (checked) this._selected.add(id);
            else this._selected.delete(id);
          });
          this._updateUI();
        }
      });

      // Individual select
      this._tbodyContainer?.addEventListener('change', (e) => {
        const cb = e.target.closest('.datatable-select-item');
        if (!cb) return;
        const id = cb.dataset.id;
        if (cb.checked) this._selected.add(id);
        else this._selected.delete(id);
        this._updateUI();
      });

      // Bulk cancel
      this.container.querySelector('.datatable-bulk-cancel')?.addEventListener('click', () => {
        this._selected.clear();
        this._render();
      });
    }

    _applyFilters() {
      this._filteredData = this._allData.filter(item => {
        // Search filter
        if (this._searchQuery) {
          const haystack = Object.values(item).join(' ').toLowerCase();
          if (!haystack.includes(this._searchQuery)) return false;
        }
        // Custom filters
        if (this._activeFilters) {
          for (const [key, value] of Object.entries(this._activeFilters)) {
            if (!value) continue;
            const itemVal = String(item[key] || '').toLowerCase();
            if (itemVal !== value.toLowerCase() && itemVal !== String(value)) return false;
          }
        }
        return true;
      });
    }

    _sort() {
      if (!this._sortField) return;
      this._filteredData.sort((a, b) => {
        const aVal = a[this._sortField];
        const bVal = b[this._sortField];
        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;
        let cmp = 0;
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          cmp = aVal - bVal;
        } else {
          cmp = String(aVal).localeCompare(String(bVal));
        }
        return this._sortOrder === 'asc' ? cmp : -cmp;
      });
    }

    _showSkeleton() {
      this._skeletonPlaceholder.style.display = '';
      this._tbodyContainer.style.display = 'none';
      this._skeletonPlaceholder.innerHTML = SkeletonLoader.table();
    }

    _render() {
      this._skeletonPlaceholder.style.display = 'none';
      this._tbodyContainer.style.display = '';

      // Build table
      const pageItems = this.getPageItems();
      if (pageItems.length === 0) {
        EmptyState.render({
          container: this._tbodyContainer,
          icon: this.config.emptyIcon || '📦',
          title: this.config.emptyTitle || 'No data found',
          description: this._searchQuery ? 'Try adjusting your search or filters.' : '',
          actionText: this.config.emptyActionText || '',
          actionFn: this.config.emptyActionFn || null
        });
        this._paginationContainer.innerHTML = '';
        this._infoContainer.textContent = '';
        return;
      }

      let html = '<table class="datatable-table"><thead><tr>';
      if (this.selectable) {
        const allOnPageSelected = pageItems.every(item => this._selected.has(String(item[this.rowIdKey])));
        html += `<th style="width:40px;"><input type="checkbox" class="datatable-select-all" ${allOnPageSelected ? 'checked' : ''}></th>`;
      }
      for (const col of this.columns) {
        const sortable = col.sortable ? ` class="datatable-th-sortable" data-sort-key="${col.key}"` : '';
        const sortIcon = this._sortField === col.key
          ? ` <i class="fas fa-sort-${this._sortOrder === 'asc' ? 'up' : 'down'}"></i>`
          : (sortable ? ' <i class="fas fa-sort"></i>' : '');
        html += `<th${sortable} style="${col.width ? `width:${col.width};` : ''}">${window._escapeHTML(col.label)}${sortIcon}</th>`;
      }
      html += '</tr></thead><tbody>';

      for (const item of pageItems) {
        const id = String(item[this.rowIdKey]);
        const isSelected = this._selected.has(id);
        html += `<tr class="${isSelected ? 'datatable-row-selected' : ''}" data-id="${id}">`;
        if (this.selectable) {
          html += `<td><input type="checkbox" class="datatable-select-item" data-id="${id}" ${isSelected ? 'checked' : ''}></td>`;
        }
        for (const col of this.columns) {
          let value = item[col.key];
          if (col.render) {
            value = col.render(value, item);
          } else {
            value = window._escapeHTML(value !== null && value !== undefined ? String(value) : '—');
          }
          html += `<td>${value}</td>`;
        }
        html += '</tr>';
      }

      html += '</tbody></table>';
      this._tbodyContainer.innerHTML = html;

      // Pagination
      this._renderPagination();
      this._updateUI();
    }

    _renderPagination() {
      const totalPages = Math.ceil(this._filteredData.length / this.pageSize) || 1;
      this._infoContainer.textContent = `${this._filteredData.length} items total · Page ${this._currentPage} of ${totalPages}`;

      if (totalPages <= 1) {
        this._paginationContainer.innerHTML = '';
        return;
      }

      let html = '';
      html += `<button class="pagination-btn" data-page="prev" ${this._currentPage <= 1 ? 'disabled' : ''}>« Prev</button>`;
      const start = Math.max(1, this._currentPage - 2);
      const end = Math.min(totalPages, this._currentPage + 2);
      if (start > 1) {
        html += `<button class="pagination-btn" data-page="1">1</button>`;
        if (start > 2) html += `<span style="color:var(--text-muted);padding:0 4px;">...</span>`;
      }
      for (let i = start; i <= end; i++) {
        html += `<button class="pagination-btn ${i === this._currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
      }
      if (end < totalPages) {
        if (end < totalPages - 1) html += `<span style="color:var(--text-muted);padding:0 4px;">...</span>`;
        html += `<button class="pagination-btn" data-page="${totalPages}">${totalPages}</button>`;
      }
      html += `<button class="pagination-btn" data-page="next" ${this._currentPage >= totalPages ? 'disabled' : ''}>Next »</button>`;
      this._paginationContainer.innerHTML = html;
    }

    _updateUI() {
      const count = this._selected.size;
      if (this._bulkToolbar) {
        this._bulkToolbar.style.display = count > 0 ? 'flex' : 'none';
      }
      if (this._bulkCount) this._bulkCount.textContent = count;

      // Update row highlighting
      this._tbodyContainer?.querySelectorAll('tr').forEach(tr => {
        const cb = tr.querySelector('.datatable-select-item');
        if (cb) {
          tr.classList.toggle('datatable-row-selected', cb.checked);
        }
      });

      // Update select-all checkbox state
      const pageItems = this.getPageItems();
      const selectAll = this._tbodyContainer?.querySelector('.datatable-select-all');
      if (selectAll && pageItems.length > 0) {
        const allOnPage = pageItems.every(item => this._selected.has(String(item[this.rowIdKey])));
        selectAll.checked = allOnPage;
        selectAll.indeterminate = !allOnPage && pageItems.some(item => this._selected.has(String(item[this.rowIdKey])));
      }
    }
  };

  // ─── 11. FORM VALIDATION ──────────────────────────────────────────────

  window._validateForm = function(formEl) {
    const errors = [];
    const required = formEl.querySelectorAll('[required]');
    required.forEach(field => {
      if (!field.value.trim()) {
        const label = formEl.querySelector(`[for="${field.id}"]`)?.textContent || field.placeholder || 'Field';
        errors.push(`${label} is required`);
        field.style.borderColor = '#f43f5e';
        field.addEventListener('input', function clearError() {
          field.style.borderColor = '';
          field.removeEventListener('input', clearError);
        }, { once: true });
      }
    });
    return errors;
  };

  // ─── 12. INIT ON DOM READY ────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function() {
    // Add shared CSS if not already present
    if (!document.getElementById('shared-css')) {
      const link = document.createElement('link');
      link.id = 'shared-css';
      link.rel = 'stylesheet';
      link.href = 'css/shared.css';
      document.head.appendChild(link);
    }
  });

})();

