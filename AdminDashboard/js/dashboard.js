// Verification Guard: Block dashboard execution immediately if local credentials are missing

// File Path: Frontend/js/dashboard.js

// Ensure the page guard accepts the bypass session
(function verifyDashboardAccess() {
    const token = localStorage.getItem('admin_token');
    const userJson = localStorage.getItem('admin_user');

    if (!token || !userJson) {
        window.location.replace('index.html');
        return;
    }
})();

// ... Keep your standard initStats() and layout rendering functions below exactly as they are ...


async function initStats() {
    try {
        const data = await window.apiRequest('/admin/dashboard/overview');
        if (!data) return;
        
        const { overview, recentAnime, recentEpisodes, topAnime, recentPayments, activityLogs, latestUsers } = data;

        // Header Stats
        document.getElementById('total-users').innerText = overview.users.total.toLocaleString();
        document.getElementById('premium-users').innerText = overview.users.premium || 0;
        document.getElementById('total-anime').innerText = overview.content.totalAnime.toLocaleString();
        document.getElementById('total-episodes').innerText = overview.content.totalEpisodes.toLocaleString();
        document.getElementById('total-views').innerText = overview.content.totalViews.toLocaleString();
        document.getElementById('revenue-total').innerText = `UGX ${overview.revenue.total.toLocaleString()}`;
        document.getElementById('revenue-monthly').innerText = `UGX ${overview.revenue.monthly.toLocaleString()}`;
        document.getElementById('revenue-today').innerText = `UGX ${overview.revenue.today.toLocaleString()}`;

        // Revenue Performance
        document.getElementById('active-users-today').innerText = overview.users.activeToday.toLocaleString();
        document.getElementById('banned-users').innerText = overview.users.banned.toLocaleString();
        const avgDaily = overview.revenue.total / 30; // Simple estimate
        document.getElementById('rev-avg-daily').innerText = `UGX ${Math.round(avgDaily).toLocaleString()}`;

        // Bunny Stats
        document.getElementById('bunny-ready').innerText = overview.bunny.ready;
        document.getElementById('bunny-processing').innerText = overview.bunny.processing;
        document.getElementById('bunny-failed').innerText = overview.bunny.failed;

        // Top Anime List
        const topList = document.getElementById('top-anime-list');
        topList.innerHTML = '';
        topAnime.forEach(a => {
            topList.innerHTML += `
                <div class="list-item">
                    <img src="${a.cover_image}" alt="" class="mini-thumb">
                    <div class="item-info">
                        <span class="item-title">${a.title}</span>
                        <span class="item-sub">${a.view_count.toLocaleString()} views</span>
                    </div>
                </div>`;
        });

        // Recent Uploads (Combined Anime + Episodes for "Live" feel)
        const uploadsList = document.getElementById('recent-uploads');
        uploadsList.innerHTML = '';
        recentEpisodes.forEach(ep => {
            uploadsList.innerHTML += `
                <div class="list-item">
                    <div class="item-icon upload"><i class="fas fa-play-circle"></i></div>
                    <div class="item-info">
                        <span class="item-title">${ep.anime_title} - Episode ${ep.episode_number}</span>
                        <span class="item-sub">${new Date(ep.created_at).toLocaleString()}</span>
                    </div>
                </div>`;
        });

        // Recent Payments
        const payBody = document.querySelector('#recent-payments-table tbody');
        if (payBody) {
            payBody.innerHTML = '';
            recentPayments.forEach(p => {
                payBody.innerHTML += `<tr>
                    <td>${p.name}</td>
                    <td>UGX ${p.amount.toLocaleString()}</td>
                    <td><span class="status-badge ${p.status}">${p.status}</span></td>
                </tr>`;
            });
        }

        // Activity Logs
        const activityList = document.getElementById('activity-logs');
        activityList.innerHTML = '';
        activityLogs.forEach(log => {
            activityList.innerHTML += `
                <div class="timeline-item">
                    <span class="time">${new Date(log.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                    <span class="action"><strong>${log.user_name || 'System'}</strong> ${log.action}</span>
                </div>`;
        });

        // New Registrations
        const usersList = document.getElementById('latest-users');
        usersList.innerHTML = '';
        latestUsers.forEach(u => {
            usersList.innerHTML += `
                <div class="list-item">
                    <div class="item-icon user"><i class="fas fa-user"></i></div>
                    <div class="item-info">
                        <span class="item-title">${u.name}</span>
                        <span class="item-sub">${u.email}</span>
                    </div>
                    ${u.is_premium ? '<span class="badge premium">VIP</span>' : ''}
                </div>`;
        });

    } catch (err) { 
        console.error('Stats load failed:', err); 
    }
}

// Initial script auto-invocation
document.addEventListener('DOMContentLoaded', () => {
    initStats();
    if (window.statsInterval) clearInterval(window.statsInterval);
    window.statsInterval = setInterval(initStats, 30000);
});

window.initStats = initStats;