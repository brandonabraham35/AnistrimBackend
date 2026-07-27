// AdminDashboard/js/logs.js

// --- State ---
let _logs_all = [];
let _logs_tbody = null; // Cached tbody element

/**
 * Initializes the Logs management section and fetches data.
 */
async function initLogs() {
    _logs_tbody = document.querySelector('#logs-table tbody'); // Cache tbody
    if (!_logs_tbody) return;
    _logs_tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading logs...</td></tr>';

    try {
        _logs_all = await window.apiRequest('/api/admin/logs');
        _renderLogs();
    } catch (error) {
        console.error('[Logs] Failed to load logs:', error);
        _logs_tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--danger);">Error loading logs. Check console.</td></tr>`;
    }
}

/**
 * Renders the list of logs into the table.
 */
function _renderLogs() {
    if (!_logs_tbody) return;

    _logs_tbody.innerHTML = _logs_all.map(l => `
        <tr>
            <td>${window._escapeHTML(l.user_name || 'System')}</td>
            <td>${window._escapeHTML(l.action)}</td>
            <td>${window._escapeHTML(l.target_type || '-')} ${l.target_id || ''}</td>
            <td>${new Date(l.created_at).toLocaleString()}</td>
        </tr>
    `).join('');
}

// Expose the initialization function globally for dashboard.js
document.addEventListener('DOMContentLoaded', () => {
    window.initializeLogsSection = initLogs;
    if (window.location.hash === '#logs') {
        initLogs();
    }
});
