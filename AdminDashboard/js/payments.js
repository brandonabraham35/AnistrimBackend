async function loadPayments() {
    try {
        const data = await window.apiRequest('/payments/revenue');
        const stats = data.stats;
        const recent = data.recent || [];

        document.getElementById('monthly-subs').innerText = stats.monthly_subs || 0;
        document.getElementById('yearly-subs').innerText = stats.yearly_subs || 0;
        document.getElementById('total-transactions').innerText = stats.total_transactions || 0;

        const tbody = document.querySelector('#payments-table tbody');
        tbody.innerHTML = '';

        recent.forEach(pay => {
            const tr = document.createElement('tr');
            const date = pay.paid_at ? new Date(pay.paid_at).toLocaleDateString() : 'Pending';
            tr.innerHTML = `
                <td>${pay.name}<br><small>${pay.email}</small></td>
                <td>${pay.plan}</td>
                <td>${pay.currency} ${pay.amount.toLocaleString()}</td>
                <td><span class="status-badge ${pay.status}">${pay.status}</span></td>
                <td>${date}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error('Failed to load payments:', err);
    }
}

window.loadPayments = loadPayments;
