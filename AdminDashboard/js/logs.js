// AdminDashboard/js/logs.js — Complete rewrite with categories, search, date range, pagination, export
// Uses shared.js for: _escapeHTML, showToast, _debounce, _confirm, SkeletonLoader, EmptyState, ErrorState, Badge, _formatDate, _formatDateTime

(function() {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  let _logs_all = [];
  let _logs_filtered = [];
  let _logs_tbody = null;
  let _currentPage = 1;
  let _perPage = 25;
  let _filters = { category: '', search: '', from: '', to: '' };

  // ─── Initialization ─────────────────────────────────────────────────────
  function initializeLogsSection() {
    console.log('[Logs] Initializing...');
    _logs_tbody = document.querySelector('#logs-table tbody');
    _setupEventListeners();
    _loadLogs();
  }

  function _setupEventListeners() {
    // Search
    document.getElementById('logs-search')?.addEventListener('input', window._debounce(() => {
      _filters.search = document.getElementById('logs-search').value.toLowerCase();
      _currentPage = 1;
      _applyFilters();
      _renderLogs();
    }, 300));

    // Category filter
    document.getElementById('logs-filter-category')?.addEventListener('change', () => {
      _filters.category = document.getElementById('logs-filter-category').value;
      _currentPage = 1;
      _applyFilters();
      _renderLogs();
    });

    // Date range
    document.getElementById('logs-date-from')?.addEventListener('change', () => {
      _filters.from = document.getElementById('logs-date-from').value;
      _currentPage = 1;
      _applyFilters();
      _renderLogs();
    });
    document.getElementById('logs-date-to')?.addEventListener('change', () => {
      _filters.to = document.getElementById('logs-date-to').value;
      _currentPage = 1;
      _applyFilters();
      _renderLogs();
    });

    // Export
    document.getElementById('logs-export')?.addEventListener('click', _exportLogs);

    // Pagination
    document.getElementById('logs-pagination')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.pagination-btn');
      if (!btn) return;
      const page = btn.dataset.page;
      const totalPages = Math.ceil(_logs_filtered.length / _perPage) || 1;
      if (page === 'prev') _currentPage = Math.max(1, _currentPage - 1);
      else if (page === 'next') _currentPage = Math.min(totalPages, _currentPage + 1);
      else _currentPage = parseInt(page, 10);
      _renderLogs();
    });
  }

  // ─── Data Fetching ──────────────────────────────────────────────────────
  async function _loadLogs() {
    if (!_logs_tbody) return;
    _logs_tbody.innerHTML = '<tr><td colspan="5">' + window.SkeletonLoader.table(5, 5) + '</td></tr>';

    try {
      const resp = await window.apiRequest('/api/admin/logs');
      // unwrapAdminEnvelope exposes .items/.rows for array responses
      _logs_all = Array.isArray(resp) ? resp : (resp.items || resp.rows || []);
      _applyFilters();
      _renderLogs();
    } catch (error) {
      console.error('[Logs] Failed to load:', error);
      _logs_tbody.innerHTML = '<tr><td colspan="5">' + window.ErrorState.render({
        message: 'Failed to load logs',
        details: error.message,
        retryFn: () => _loadLogs()
      }) + '</td></tr>';
    }
  }

  function _applyFilters() {
    _logs_filtered = _logs_all.filter(log => {
      // Search
      if (_filters.search) {
        const haystack = (log.user_name || '') + ' ' + (log.action || '') + ' ' + (log.target_type || '');
        if (!haystack.toLowerCase().includes(_filters.search)) return false;
      }

      // Category filter
      if (_filters.category) {
        const cat = (log.target_type || log.action || '').toLowerCase();
        if (!cat.includes(_filters.category.toLowerCase())) return false;
      }

      // Date range
      if (_filters.from && log.created_at) {
        if (new Date(log.created_at) < new Date(_filters.from)) return false;
      }
      if (_filters.to && log.created_at) {
        const toDate = new Date(_filters.to);
        toDate.setDate(toDate.getDate() + 1); // Include the full "to" day
        if (new Date(log.created_at) > toDate) return false;
      }

      return true;
    });
  }

  // ─── Rendering ──────────────────────────────────────────────────────────
  function _renderLogs() {
    if (!_logs_tbody) return;

    if (_logs_filtered.length === 0) {
      _logs_tbody.innerHTML = '<tr><td colspan="5">' + window.EmptyState.render({
        icon: '📋',
        title: 'No Logs Found',
        description: _filters.search ? 'Try adjusting your search or filters.' : 'No activity logs recorded yet.'
      }) + '</td></tr>';
      _renderPagination();
      return;
    }

    const start = (_currentPage - 1) * _perPage;
    const pageItems = _logs_filtered.slice(start, start + _perPage);

    _logs_tbody.innerHTML = pageItems.map(log => `
      <tr>
        <td>${window._escapeHTML(log.user_name || 'System')}</td>
        <td><span class="shared-badge ${_getSeverityClass(log)}">${window._escapeHTML(log.action || '—')}</span></td>
        <td>${window._escapeHTML(log.target_type || '-')} ${log.target_id ? `#${window._escapeHTML(String(log.target_id))}` : ''}</td>
        <td>${log.details ? window._escapeHTML(String(log.details).slice(0, 60)) + (String(log.details).length > 60 ? '...' : '') : '-'}</td>
        <td style="white-space:nowrap;" title="${new Date(log.created_at).toLocaleString()}">${window._timeAgo(log.created_at)}</td>
      </tr>
    `).join('');

    _renderPagination();
  }

  function _getSeverityClass(log) {
    const action = (log.action || '').toLowerCase();
    if (action.includes('delete') || action.includes('ban')) return 'shared-badge-error';
    if (action.includes('create') || action.includes('import')) return 'shared-badge-completed';
    if (action.includes('update') || action.includes('edit')) return 'shared-badge-airing';
    if (action.includes('login') || action.includes('logout')) return 'shared-badge-user';
    return 'shared-badge-unknown';
  }

  // ─── Pagination ─────────────────────────────────────────────────────────
  function _renderPagination() {
    const container = document.getElementById('logs-pagination');
    const infoEl = document.getElementById('logs-table-info');
    if (!container) return;

    const totalPages = Math.ceil(_logs_filtered.length / _perPage) || 1;
    if (infoEl) {
      infoEl.textContent = `${_logs_filtered.length} log entries · Page ${_currentPage} of ${totalPages}`;
    }

    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    let html = '';
    html += `<button class="pagination-btn" data-page="prev" ${_currentPage <= 1 ? 'disabled' : ''}>« Prev</button>`;
    const start = Math.max(1, _currentPage - 2);
    const end = Math.min(totalPages, _currentPage + 2);
    if (start > 1) {
      html += `<button class="pagination-btn" data-page="1">1</button>`;
      if (start > 2) html += `<span style="color:var(--text-muted);padding:0 4px;">...</span>`;
    }
    for (let i = start; i <= end; i++) {
      html += `<button class="pagination-btn ${i === _currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    if (end < totalPages) {
      if (end < totalPages - 1) html += `<span style="color:var(--text-muted);padding:0 4px;">...</span>`;
      html += `<button class="pagination-btn" data-page="${totalPages}">${totalPages}</button>`;
    }
    html += `<button class="pagination-btn" data-page="next" ${_currentPage >= totalPages ? 'disabled' : ''}>Next »</button>`;
    container.innerHTML = html;
  }

  // ─── Export Logs ────────────────────────────────────────────────────────
  function _exportLogs() {
    const data = _logs_filtered.length > 0 ? _logs_filtered : _logs_all;
    if (data.length === 0) {
      window.showToast?.('No logs to export.', 'warning');
      return;
    }

    const headers = ['Admin', 'Action', 'Target Type', 'Target ID', 'Details', 'Timestamp'];
    const rows = data.map(log => [
      `"${(log.user_name || 'System').replace(/"/g, '""')}"`,
      `"${(log.action || '').replace(/"/g, '""')}"`,
      `"${(log.target_type || '').replace(/"/g, '""')}"`,
      log.target_id || '',
      `"${(log.details || '').replace(/"/g, '""')}"`,
      log.created_at ? new Date(log.created_at).toLocaleString() : ''
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `activity-logs-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    window.showToast?.(`Exported ${data.length} log entries to CSV.`, 'success');
  }

  // ─── Global Exposure ────────────────────────────────────────────────────
  window.initializeLogsSection = initializeLogsSection;

  document.addEventListener('DOMContentLoaded', () => {
    if (window.location.hash === '#logs') {
      initializeLogsSection();
    }
  });

})();
