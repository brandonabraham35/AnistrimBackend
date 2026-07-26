async function initLogs() {
    const logs = await window.apiRequest('/admin/logs');
    const tbody = document.querySelector('#logs-table tbody');
    tbody.innerHTML = '';
    logs.forEach(l => {
        tbody.innerHTML += `
            <tr>
                <td>${l.admin_name}</td>
                <td>${l.action}</td>
                <td>${l.target_type || '-'} ${l.target_id || ''}</td>
                <td>${new Date(l.created_at).toLocaleString()}</td>
            </tr>
        `;
    });
}
window.initLogs = initLogs;
