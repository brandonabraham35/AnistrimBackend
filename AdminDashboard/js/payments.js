async function initPayments() {
    const tbody = document.querySelector('#payments-full-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading payments...</td></tr>';

    try {
        const data = await window.apiRequest('/api/payments/revenue');
        tbody.innerHTML = '';
        (data.recent || []).forEach(p => {
            tbody.innerHTML += `
                <tr>
                    <td>${p.name}<br><small>${p.email}</small></td>
                    <td>UGX ${p.amount.toLocaleString()}</td>
                        <td>
                            <select onchange="updatePaymentStatus(${p.id}, this.value)" class="status-select ${p.status}">
                                <option value="pending" ${p.status === 'pending' ? 'selected' : ''}>Pending</option>
                                <option value="successful" ${p.status === 'successful' ? 'selected' : ''}>Successful</option>
                                <option value="failed" ${p.status === 'failed' ? 'selected' : ''}>Failed</option>
                            </select>
                        </td>
                    <td>${new Date(p.paid_at || p.created_at).toLocaleDateString()}</td>
                </tr>
            `;
        });
    } catch (error) {
        console.error('[Payments] Failed to load payments:', error);
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--danger);">Error loading payments. Check console.</td></tr>`;
    }
}

async function updatePaymentStatus(id, status) {
    try {
        await window.apiRequest(`/api/admin/payments/${id}`, { method: 'PUT', body: { status } });
        initPayments();
    } catch (error) {
        console.error(`[Payments] Failed to update payment status for ${id}:`, error);
        alert(`Failed to update payment status: ${error.message}`);
    }
}

window.initPayments = initPayments;
window.updatePaymentStatus = updatePaymentStatus;
