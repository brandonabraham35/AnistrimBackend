async function initUsers() {
    const q = document.getElementById('user-search').value;
    const tbody = document.querySelector('#users-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading users...</td></tr>';

    try {
        const url = q ? `/api/admin/users?q=${q}` : '/api/admin/users';
        const data = await window.apiRequest(url);
        tbody.innerHTML = '';
        // The API returns a flat array, not an object with a `users` property.
        data.forEach(u => {
            tbody.innerHTML += `
                <tr>
                    <td>${u.name}</td>
                    <td>${u.email}</td>
                    <td>${u.is_admin ? 'Admin' : 'User'}</td>
                    <td><span class="status-badge" style="background:${u.status === 'banned' ? '#ef4444' : '#10b981'}">${u.status}</span></td>
                    <td>${u.is_premium ? '💎' : 'Free'}</td>
                    <td>
                        <button class="action-btn edit-btn" onclick="updateUser(${u.id}, {is_admin: ${u.is_admin ? 0 : 1}})">Toggle Admin</button>
                        <button class="action-btn delete-btn" style="background:${u.status === 'banned' ? '#10b981' : '#ef4444'}" onclick="updateUser(${u.id}, {status: '${u.status === 'banned' ? 'active' : 'banned'}'})">${u.status === 'banned' ? 'Unban' : 'Ban'}</button>
                        <button class="action-btn edit-btn" style="background:#f59e0b" onclick="updateUser(${u.id}, {is_premium: ${u.is_premium ? 0 : 1}})">Toggle Premium</button>
                    </td>
                </tr>
            `;
        });
    } catch (error) {
        console.error('[Users] Failed to load users:', error);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">Error loading users. Check console.</td></tr>`;
    }
}

async function updateUser(id, body) {
    try {
        await window.apiRequest(`/api/admin/users/${id}`, { method: 'PUT', body });
        initUsers(); // Refresh on success
    } catch (error) {
        console.error(`[Users] Failed to update user ${id}:`, error);
        alert(`Failed to update user: ${error.message}`);
    }
}

document.getElementById('user-search').oninput = initUsers;
window.initUsers = initUsers;
window.updateUser = updateUser;
