async function loadUsers() {
    try {
        const data = await window.apiRequest('/admin/users');
        const users = data.users || [];
        const tbody = document.querySelector('#users-table tbody');
        tbody.innerHTML = '';

        users.forEach(user => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${user.name}</td>
                <td>${user.email}</td>
                <td>${user.is_premium ? '⭐ Premium' : 'Free'}</td>
                <td>${new Date(user.created_at).toLocaleDateString()}</td>
                <td>
                    <button class="action-btn toggle-btn" onclick="togglePremium(${user.id}, ${!!user.is_premium})">
                        ${user.is_premium ? 'Revoke Premium' : 'Grant Premium'}
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error('Failed to load users:', err);
    }
}

async function togglePremium(userId, currentStatus) {
    try {
        await window.apiRequest(`/admin/users/${userId}/premium`, {
            method: 'PUT',
            body: { isPremium: !currentStatus }
        });
        loadUsers();
    } catch (err) {
        alert(err.message);
    }
}

window.loadUsers = loadUsers;
window.togglePremium = togglePremium;
