// AdminDashboard/js/payments.js

function initializePaymentsSection() {
    _diag_payments('Initializing Payments management section...');
    _loadPayments();

    const table = document.querySelector('#payments-table');
    if (table) {
        // Use event delegation for status changes
        table.addEventListener('change', _handleTableChange);
    }
}

async function _loadPayments() {
    const tbody = document.querySelector('#payments-table tbody'); // Corrected ID
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading payments...</td></tr>'; // Corrected colspan

    try {
        const data = await window.apiRequest('/api/payments/revenue');
        tbody.innerHTML = '';
        (data.recent || []).forEach(p => {
            tbody.innerHTML += `
                <tr>
                    <td>${p.name}<br><small>${p.email}</small></td>
                    <td>UGX ${p.amount.toLocaleString()}</td>
                    <td>${p.plan}</td>
                        <td>
                            <select class="payment-status-select" data-id="${p.id}">
                                <option value="pending" ${p.status === 'pending' ? 'selected' : ''}>Pending</option>
                                <option value="successful" ${p.status === 'successful' ? 'selected' : ''}>Successful</option>
                                <option value="failed" ${p.status === 'failed' ? 'selected' : ''}>Failed</option>
                                <option value="refunded" ${p.status === 'refunded' ? 'selected' : ''}>Refunded</option>
                            </select>
                        </td>
                    <td>${new Date(p.paid_at || p.created_at).toLocaleDateString()}</td>
                    <td>${p.reference || p.flw_tx_ref || '-'}</td>
                </tr>
            `;
        });
    } catch (error) {
        _diag_payments('Failed to load payments:', error);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">Error loading payments. Check console.</td></tr>`; // Corrected colspan
    }
}

function _handleTableChange(e) {
    const target = e.target;
    if (target.matches('.payment-status-select')) {
        const id = target.dataset.id;
        const status = target.value;
        _updatePaymentStatus(id, status);
    }
}

async function _updatePaymentStatus(id, status) {
    try {
        await window.apiRequest(`/api/admin/payments/${id}`, { method: 'PUT', body: { status } });
        _diag_payments(`Payment ${id} status updated to ${status}`);
        _loadPayments(); // Refresh on success
    } catch (error) {
        _diag_payments(`Failed to update payment status for ${id}:`, error);
        alert(`Failed to update payment status: ${error.message}`);
    }
}

function _diag_payments(...args) {
    console.log('[Payments]', ...args);
}

// Expose the initialization function globally for dashboard.js
document.addEventListener('DOMContentLoaded', () => {
    window.initializePaymentsSection = initializePaymentsSection;
    if (window.location.hash === '#payments') {
        initializePaymentsSection();
    }
});
