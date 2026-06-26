async function loadStats() {
    try {
        const data = await window.apiRequest('/admin/stats');

        document.getElementById('total-users').innerText = data.users.total;
        document.getElementById('premium-users').innerText = data.users.premium || 0;
        document.getElementById('total-anime').innerText = data.anime.total;
        document.getElementById('total-views').innerText = data.anime.totalViews || 0;
        document.getElementById('revenue-today').innerText = `UGX ${data.revenue.today.toLocaleString()}`;
        document.getElementById('revenue-total').innerText = `UGX ${data.revenue.total.toLocaleString()}`;

        // Top Anime
        const topAnimeBody = document.querySelector('#top-anime-table tbody');
        topAnimeBody.innerHTML = '';
        data.topAnime.forEach(anime => {
            const row = `<tr><td>${anime.title}</td><td>${anime.view_count}</td></tr>`;
            topAnimeBody.innerHTML += row;
        });

        // Recent Users
        const recentUsersBody = document.querySelector('#recent-users-table tbody');
        recentUsersBody.innerHTML = '';
        data.recentUsers.forEach(user => {
            const row = `<tr><td>${user.name}</td><td>${user.email}</td></tr>`;
            recentUsersBody.innerHTML += row;
        });
    } catch (err) {
        console.error('Failed to load stats:', err);
    }
}

window.loadStats = loadStats;
