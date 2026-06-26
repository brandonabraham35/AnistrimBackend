async function initUsers() {
    const q = document.getElementById('user-search').value;
    const url = q ? `/admin/users?q=${q}` : '/admin/users';
    const data = await window.apiRequest(url);
    const tbody = document.querySelector('#users-table tbody');
    tbody.innerHTML = '';
    data.users.forEach(u => {
        tbody.innerHTML += `
            <tr>
                <td>${u.name}</td>
                <td>${u.email}</td>
                <td>${u.is_admin ? 'Admin' : 'User'}</td>
                <td><span class="status-badge" style="background:${u.status === 'banned' ? '#ef4444' : '#10b981'}">${u.status}</span></td>
                <td>${u.is_premium ? '💎' : 'Free'}</td>
                <td>
                    <button class="action-btn edit-btn" onclick="updateUser(${u.id}, {is_admin: ${u.is_admin ? 0 : 1}, status: '${u.status}', is_premium: ${u.is_premium}})">Toggle Admin</button>
                    <button class="action-btn delete-btn" style="background:${u.status === 'banned' ? '#10b981' : '#ef4444'}" onclick="updateUser(${u.id}, {is_admin: ${u.is_admin}, status: '${u.status === 'banned' ? 'active' : 'banned'}', is_premium: ${u.is_premium}})">${u.status === 'banned' ? 'Unban' : 'Ban'}</button>
                    <button class="action-btn edit-btn" style="background:#f59e0b" onclick="updateUser(${u.id}, {is_admin: ${u.is_admin}, status: '${u.status}', is_premium: ${u.is_premium ? 0 : 1}})">Toggle Premium</button>
                </td>
            </tr>
        `;
    });
}

async function updateUser(id, body) {
    await window.apiRequest(`/admin/users/${id}`, { method: 'PUT', body });
    initUsers();
}

document.getElementById('user-search').oninput = initUsers;
window.initUsers = initUsers;
window.updateUser = updateUser;
