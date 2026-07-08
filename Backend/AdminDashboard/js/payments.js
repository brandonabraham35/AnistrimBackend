async function initPayments() {
    const data = await window.apiRequest('/payments/revenue');
    const tbody = document.querySelector('#payments-full-table tbody');
    tbody.innerHTML = '';
    data.recent.forEach(p => {
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
}

async function updatePaymentStatus(id, status) {
    await window.apiRequest(`/admin/payments/${id}`, { method: 'PUT', body: { status } });
    initPayments();
}

window.initPayments = initPayments;
window.updatePaymentStatus = updatePaymentStatus;
