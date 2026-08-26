// AdminDashboard/js/payments.js — Enhanced with search, filters, pagination, CSV export, shared components
// Uses shared.js for: _escapeHTML, showToast, _debounce, _confirm, ModalManager, SkeletonLoader, EmptyState, ErrorState, Badge, _formatNumber, _formatDate

(function() {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  let _payments_all = [];
  let _payments_filtered = [];
  let _payments_currentPage = 1;
  const _payments_perPage = 25;
  let _payments_tbody = null;
  let _payments_pagination = null;
  let _payments_info = null;
  let _searchQuery = '';
  let _statusFilter = '';
  let _dateFrom = '';
  let _dateTo = '';

  // ─── Initialization ─────────────────────────────────────────────────────
  function initializePaymentsSection() {
    console.log('[Payments] Initializing...');

    _payments_tbody = document.querySelector('#payments-table tbody');
    _payments_pagination = document.getElementById('payments-pagination');
    _payments_info = document.getElementById('payments-table-info');

    _setupEventListeners();
    _loadPayments();
  }

  function _setupEventListeners() {
    // Search
    document.getElementById('payments-search')?.addEventListener('input', window._debounce(() => {
      _searchQuery = document.getElementById('payments-search').value;
      _payments_currentPage = 1;
      _applyFilters();
      _renderPayments();
    }, 300));

    // Status filter
    document.getElementById('payments-filter-status')?.addEventListener('change', () => {
      _statusFilter = document.getElementById('payments-filter-status').value;
      _payments_currentPage = 1;
      _applyFilters();
      _renderPayments();
    });

    // Date range
    document.getElementById('payments-date-from')?.addEventListener('change', () => {
      _dateFrom = document.getElementById('payments-date-from').value;
      _payments_currentPage = 1;
      _applyFilters();
      _renderPayments();
    });
    document.getElementById('payments-date-to')?.addEventListener('change', () => {
      _dateTo = document.getElementById('payments-date-to').value;
      _payments_currentPage = 1;
      _applyFilters();
      _renderPayments();
    });

    // Export CSV
    document.getElementById('payments-export-csv')?.addEventListener('click', _exportCSV);

    // Pagination
    _payments_pagination?.addEventListener('click', (e) => {
      const btn = e.target.closest('.pagination-btn');
      if (!btn) return;
      const page = btn.dataset.page;
      const totalPages = Math.ceil(_payments_filtered.length / _payments_perPage) || 1;
      if (page === 'prev') _payments_currentPage = Math.max(1, _payments_currentPage - 1);
      else if (page === 'next') _payments_currentPage = Math.min(totalPages, _payments_currentPage + 1);
      else _payments_currentPage = parseInt(page, 10);
      _renderPayments();
    });

    // Table delegation for status changes and row click for details
    const table = document.querySelector('#payments-table');
    table?.addEventListener('change', (e) => {
      const select = e.target.closest('.payment-status-select');
      if (select) {
        const id = select.dataset.id;
        const status = select.value;
        _updatePaymentStatus(id, status);
      }
    });
    table?.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-id]');
      if (row && !e.target.closest('select') && !e.target.closest('button')) {
        _showPaymentDetails(row.dataset.id);
      }
    });
  }

  // ─── Data Fetching ──────────────────────────────────────────────────────
  async function _loadPayments() {
    if (!_payments_tbody) return;
    _payments_tbody.innerHTML = '<tr><td colspan="6">' + window.SkeletonLoader.table(5, 6) + '</td></tr>';

    try {
      const data = await window.apiRequest('/api/admin/payments');
      // unwrapAdminEnvelope exposes .items/.rows for paginated responses
      _payments_all = data.items || data.rows || data || [];
      _applyFilters();
      _renderPayments();
    } catch (error) {
      console.error('[Payments] Failed to load:', error);
      _payments_tbody.innerHTML = '<tr><td colspan="6">' + window.ErrorState.render({
        message: 'Failed to load payments',
        retryFn: () => _loadPayments()
      }) + '</td></tr>';
    }
  }

  // ─── Filtering ──────────────────────────────────────────────────────────
  function _applyFilters() {
    _payments_filtered = _payments_all.filter(p => {
      // Search
      if (_searchQuery) {
        const q = _searchQuery.toLowerCase();
        const haystack = (p.name + ' ' + p.email + ' ' + (p.reference || '') + ' ' + (p.flw_tx_ref || '')).toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      // Status filter
      if (_statusFilter && p.status !== _statusFilter) return false;
      // Date range
      if (_dateFrom) {
        const d = new Date(p.paid_at || p.created_at);
        if (d < new Date(_dateFrom)) return false;
      }
      if (_dateTo) {
        const d = new Date(p.paid_at || p.created_at);
        const end = new Date(_dateTo);
        end.setHours(23, 59, 59, 999);
        if (d > end) return false;
      }
      return true;
    });
  }

  // ─── Rendering ──────────────────────────────────────────────────────────
  function _renderPayments() {
    if (!_payments_tbody) return;

    const start = (_payments_currentPage - 1) * _payments_perPage;
    const pageItems = _payments_filtered.slice(start, start + _payments_perPage);

    if (pageItems.length === 0) {
      _payments_tbody.innerHTML = '<tr><td colspan="6">' + window.EmptyState.render({
        icon: '💰',
        title: 'No Payments Found',
        description: _searchQuery || _statusFilter || _dateFrom ? 'Try adjusting your search or filters.' : 'No payments recorded yet.'
      }) + '</td></tr>';
      _payments_pagination.innerHTML = '';
      if (_payments_info) _payments_info.textContent = '';
      return;
    }

    _payments_tbody.innerHTML = pageItems.map(p => `
      <tr data-id="${p.id}" style="cursor:pointer;">
        <td>${window._escapeHTML(p.name)}<br><small style="color:var(--text-muted);">${window._escapeHTML(p.email)}</small></td>
        <td style="font-weight:600;">UGX ${window._formatNumber(p.amount)}</td>
        <td>${window._escapeHTML(p.plan || '—')}</td>
        <td>
          <select class="payment-status-select" data-id="${p.id}" style="background:#0f172a;color:#f8fafc;border:1px solid #475569;border-radius:6px;padding:0.3rem 0.5rem;font-size:0.78rem;">
            <option value="pending" ${p.status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="successful" ${p.status === 'successful' ? 'selected' : ''}>Successful</option>
            <option value="failed" ${p.status === 'failed' ? 'selected' : ''}>Failed</option>
            <option value="refunded" ${p.status === 'refunded' ? 'selected' : ''}>Refunded</option>
          </select>
        </td>
        <td>${window._formatDate(p.paid_at || p.created_at)}</td>
        <td style="font-size:0.78rem;color:var(--text-muted);">${window._escapeHTML(p.reference || p.flw_tx_ref || '—')}</td>
      </tr>
    `).join('');

    _renderPagination();
  }

  function _renderPagination() {
    const totalPages = Math.ceil(_payments_filtered.length / _payments_perPage) || 1;
    if (_payments_info) {
      _payments_info.textContent = `${_payments_filtered.length} payments total · Page ${_payments_currentPage} of ${totalPages}`;
    }
    if (!_payments_pagination) return;
    if (totalPages <= 1) { _payments_pagination.innerHTML = ''; return; }

    let html = '';
    html += `<button class="pagination-btn" data-page="prev" ${_payments_currentPage <= 1 ? 'disabled' : ''}>&laquo; Prev</button>`;
    const start = Math.max(1, _payments_currentPage - 2);
    const end = Math.min(totalPages, _payments_currentPage + 2);
    if (start > 1) {
      html += `<button class="pagination-btn" data-page="1">1</button>`;
      if (start > 2) html += `<span style="color:var(--text-muted);padding:0 4px;">...</span>`;
    }
    for (let i = start; i <= end; i++) {
      html += `<button class="pagination-btn ${i === _payments_currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    if (end < totalPages) {
      if (end < totalPages - 1) html += `<span style="color:var(--text-muted);padding:0 4px;">...</span>`;
      html += `<button class="pagination-btn" data-page="${totalPages}">${totalPages}</button>`;
    }
    html += `<button class="pagination-btn" data-page="next" ${_payments_currentPage >= totalPages ? 'disabled' : ''}>Next &raquo;</button>`;
    _payments_pagination.innerHTML = html;
  }

  // ─── Status Update ──────────────────────────────────────────────────────
  async function _updatePaymentStatus(id, status) {
    try {
      await window.apiRequest(`/api/admin/payments/${id}`, { method: 'PUT', body: { status } });
      window.showToast?.('Payment status updated.', 'success');
      const idx = _payments_all.findIndex(p => String(p.id) === String(id));
      if (idx > -1) _payments_all[idx].status = status;
      _applyFilters();
      _renderPayments();
    } catch (error) {
      window.showToast?.(`Failed to update status: ${error.message}`, 'error');
      _loadPayments(); // Revert on failure
    }
  }

  // ─── Payment Details Modal ──────────────────────────────────────────────
  function _showPaymentDetails(id) {
    const payment = _payments_all.find(p => String(p.id) === String(id));
    if (!payment) return;

    const body = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
        <div><strong>Name:</strong><br>${window._escapeHTML(payment.name)}</div>
        <div><strong>Email:</strong><br>${window._escapeHTML(payment.email)}</div>
        <div><strong>Amount:</strong><br>UGX ${window._formatNumber(payment.amount)}</div>
        <div><strong>Plan:</strong><br>${window._escapeHTML(payment.plan || '—')}</div>
        <div><strong>Status:</strong><br>${window.Badge.status(payment.status)}</div>
        <div><strong>Reference:</strong><br>${window._escapeHTML(payment.reference || payment.flw_tx_ref || '—')}</div>
        <div><strong>Date:</strong><br>${window._formatDate(payment.paid_at || payment.created_at)}</div>
        <div><strong>Payment ID:</strong><br>#${payment.id}</div>
      </div>
    `;

    window.ModalManager.open({
      title: `Payment #${payment.id}`,
      body: body,
      dialogClass: 'shared-confirm-dialog'
    });
  }

  // ─── CSV Export ─────────────────────────────────────────────────────────
  function _exportCSV() {
    const data = _payments_filtered.length > 0 ? _payments_filtered : _payments_all;
    if (data.length === 0) {
      window.showToast?.('No payments to export.', 'warning');
      return;
    }

    const headers = ['Name', 'Email', 'Amount', 'Plan', 'Status', 'Reference', 'Date'];
    const rows = data.map(p => [
      `"${(p.name || '').replace(/"/g, '""')}"`,
      `"${(p.email || '').replace(/"/g, '""')}"`,
      p.amount || 0,
      `"${(p.plan || '').replace(/"/g, '""')}"`,
      p.status || '',
      `"${(p.reference || p.flw_tx_ref || '').replace(/"/g, '""')}"`,
      new Date(p.paid_at || p.created_at).toLocaleDateString()
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payments-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    window.showToast?.(`Exported ${data.length} payments.`, 'success');
  }

  // ─── Global Exposure ────────────────────────────────────────────────────
  window.initializePaymentsSection = initializePaymentsSection;

  document.addEventListener('DOMContentLoaded', () => {
    if (window.location.hash === '#payments') {
      initializePaymentsSection();
    }
  });

})();
