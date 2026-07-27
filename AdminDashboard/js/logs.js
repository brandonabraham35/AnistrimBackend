async function initLogs() {
    const tbody = document.querySelector('#logs-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading logs...</td></tr>';

    try {
        const logs = await window.apiRequest('/api/admin/logs');
        tbody.innerHTML = '';
        logs.forEach(l => {
            tbody.innerHTML += `
                <tr>
                    <td>${l.user_name || 'System'}</td>
                    <td>${l.action}</td>
                    <td>${l.target_type || '-'} ${l.target_id || ''}</td>
                    <td>${new Date(l.created_at).toLocaleString()}</td>
                </tr>
            `;
        });
    } catch (error) {
        console.error('[Logs] Failed to load logs:', error);
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--danger);">Error loading logs. Check console.</td></tr>`;
    }
}
window.initLogs = initLogs;
