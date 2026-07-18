// File Path: Frontend/js/dashboard.js

(function verifyDashboardAccess() {
    const token = localStorage.getItem('admin_token');
    const userJson = localStorage.getItem('admin_user');

    let user;
    try { user = userJson ? JSON.parse(userJson) : null; } catch (_) { user = null; }
    if (!token || !user || !user.isAdmin) {
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_user');
        window.location.replace('index.html');
    }
})();

const safeSetText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.innerText = text !== undefined && text !== null ? text.toLocaleString() : '0';
};

// ─── 1. CORE STATISTICS AGGREGATION ────────────────────────
async function loadDashboardOverview() {
    try {
        const data = await window.apiRequest('/admin/dashboard/overview');
        if (!data || !data.overview) return;

        const { overview, recentAnime, recentEpisodes, activityLogs, topAnime = [], latestUsers = [] } = data;

        // Statistics Widgets Binding
        safeSetText('total-anime', overview.content?.totalAnime);
        safeSetText('total-episodes', overview.content?.totalEpisodes);
        safeSetText('premium-users', overview.users?.premium);
        safeSetText('free-users', (overview.users?.total - overview.users?.premium) || 0);
        safeSetText('total-users', overview.users?.total);
        safeSetText('storage-usage', overview.storage?.usageGB ? `${overview.storage.usageGB} GB` : '0 GB');
        safeSetText('video-count', overview.storage?.videoCount);
        safeSetText('avg-rating', overview.content?.avgRating ? Number(overview.content.avgRating).toFixed(1) : '0.0');
        safeSetText('watch-count', overview.content?.totalViews);
        safeSetText('total-views', overview.content?.totalViews);
        safeSetText('bunny-ready', overview.bunny?.ready);
        safeSetText('bunny-processing', overview.bunny?.processing);
        safeSetText('bunny-failed', overview.bunny?.failed);
        safeSetText('active-users-today', overview.users?.activeToday);
        safeSetText('banned-users', overview.users?.banned);

        // Feed Traces Populator
        const animeFeed = document.getElementById('recent-anime-feed');
        if (animeFeed && recentAnime) {
            animeFeed.innerHTML = recentAnime.map(a => `
                <div class="list-item">
                    <img src="${a.cover_image || 'https://via.placeholder.com/150'}" class="mini-thumb">
                    <div class="item-info">
                        <span class="item-title">${a.title}</span>
                        <span class="item-sub">Year: ${a.release_year || 'N/A'} | Status: ${a.status}</span>
                    </div>
                </div>
            `).join('');
        }

        const epFeed = document.getElementById('recent-episodes-feed');
        if (epFeed && recentEpisodes) {
            epFeed.innerHTML = recentEpisodes.map(ep => `
                <div class="list-item">
                    <div class="item-icon"><i class="fas fa-play-circle"></i></div>
                    <div class="item-info">
                        <span class="item-title">${ep.anime_title} - Episode ${ep.episode_number}</span>
                        <span class="item-sub">${new Date(ep.created_at).toLocaleDateString()}</span>
                    </div>
                </div>
            `).join('');
        }

        const uploads = document.getElementById('recent-uploads');
        if (uploads) uploads.innerHTML = recentEpisodes.map(ep => `<div class="list-item"><div class="item-info"><span class="item-title">${ep.anime_title} · Episode ${ep.episode_number}</span><span class="item-sub">${ep.video_status || 'pending'}</span></div></div>`).join('') || '<div class="item-sub">No uploads yet.</div>';

        const topList = document.getElementById('top-anime-list');
        if (topList) topList.innerHTML = topAnime.map(anime => `<div class="list-item"><img src="${anime.cover_image || 'https://via.placeholder.com/150'}" class="mini-thumb"><div class="item-info"><span class="item-title">${anime.title}</span><span class="item-sub">${Number(anime.view_count || 0).toLocaleString()} views</span></div></div>`).join('') || '<div class="item-sub">No catalogue data yet.</div>';

        const latestUsersContainer = document.getElementById('latest-users');
        if (latestUsersContainer) latestUsersContainer.innerHTML = latestUsers.map(user => `<div class="list-item"><div class="item-info"><span class="item-title">${user.name}</span><span class="item-sub">Joined ${new Date(user.created_at).toLocaleDateString()}</span></div></div>`).join('') || '<div class="item-sub">No users yet.</div>';

        const logs = document.getElementById('activity-logs');
        if (logs) logs.innerHTML = activityLogs.map(log => `<div class="timeline-item"><span class="time">${new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="action"><strong>${log.user_name || 'System'}</strong> ${log.action}</span></div>`).join('') || '<div class="item-sub">No recorded activity yet.</div>';

        const revenueData = await window.apiRequest('/payments/revenue');
        const revenue = revenueData?.stats || {};
        const currency = revenueData?.recent?.[0]?.currency || 'UGX';
        const money = value => `${currency} ${Number(value || 0).toLocaleString()}`;
        safeSetText('revenue-total', money(revenue.total_revenue));
        safeSetText('revenue-today', money(revenue.revenue_today));
        safeSetText('revenue-monthly', 'Not configured');
        safeSetText('rev-avg-daily', money(Number(revenue.total_revenue || 0) / Math.max(1, new Date().getDate())));
        const payments = document.querySelector('#recent-payments-table tbody');
        if (payments) payments.innerHTML = (revenueData?.recent || []).slice(0, 5).map(payment => `<tr><td>${payment.name || payment.email}</td><td>${payment.currency || currency} ${Number(payment.amount || 0).toLocaleString()}</td><td>${payment.status}</td></tr>`).join('') || '<tr><td colspan="3">No payment records yet.</td></tr>';
    } catch (err) {
        console.error('Failed to parse remote dashboard metrics:', err);
    }
}

// ─── 2. ANIME CATALOGUE CRUD MANAGEMENT ─────────────────────
async function loadAnimeManagement() {
    const tableBody = document.querySelector('#anime-table tbody');
    if (!tableBody) return;

    try {
        const anime = await window.apiRequest('/admin/anime');
        if (!anime) return;

        tableBody.innerHTML = anime.map(a => `
            <tr>
                <td><img src="${a.cover_image || 'https://via.placeholder.com/150'}" class="mini-thumb"></td>
                <td><strong>${a.title}</strong></td>
                <td>${a.genres || 'Uncategorized'}</td>
                <td><span class="status-badge">${a.status}</span></td>
                <td>${a.release_year}</td>
                <td>${a.episode_count || 0}</td>
                <td>${new Date(a.created_at).toLocaleDateString()}</td>
                <td>
                    <button onclick="deleteAnime(${a.id})" class="btn-delete"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        console.error('Anime retrieval failed:', err);
    }
}

async function deleteAnime(id) {
    if (!confirm('Are you sure you want to delete this anime and all associated episodes from the production database?')) return;
    try {
        await window.apiRequest(`/admin/anime/${id}`, { method: 'DELETE' });
        loadAnimeManagement();
        loadDashboardOverview();
    } catch (err) {
        alert('Delete failed: ' + err.message);
    }
}

// ─── 3. EPISODE MANAGEMENT & BUNNY QUEUE ───────────────────
async function loadEpisodeManagement() {
    const tableBody = document.querySelector('#episodes-table tbody');
    if (!tableBody) return;

    try {
        const episodes = await window.apiRequest('/admin/episodes');
        if (!episodes) return;

        tableBody.innerHTML = episodes.map(ep => `
            <tr>
                <td><strong>#${ep.episode_number}</strong></td>
                <td>${ep.title || 'Untitled'}</td>
                <td>${ep.duration || 'N/A'} mins</td>
                <td>${ep.anime_title}</td>
                <td><img src="${ep.thumbnail_url || 'https://via.placeholder.com/150'}" class="mini-thumb"></td>
                <td><span class="status-badge ${ep.video_status}">${ep.video_status || 'Ready'}</span></td>
                <td><a href="${ep.video_url}" target="_blank" class="link-url">Playback Stream</a></td>
                <td>
                    <button onclick="deleteEpisode(${ep.id})" class="btn-delete"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        console.error('Episode retrieval failed:', err);
    }
}

async function deleteEpisode(id) {
    if (!confirm('Delete this episode track?')) return;
    try {
        await window.apiRequest(`/admin/episodes/${id}`, { method: 'DELETE' });
        loadEpisodeManagement();
    } catch (err) {
        alert(err.message);
    }
}

// ─── 4. USER & PREMIUM ACCOUNT RECORDS ──────────────────────
async function loadUserManagement() {
    const userBody = document.querySelector('#users-table tbody');
    const premiumBody = document.querySelector('#premium-users-table tbody');
    if (!userBody) return;

    try {
        const users = await window.apiRequest('/admin/users');
        if (!users) return;

        userBody.innerHTML = users.map(u => `
            <tr>
                <td><strong>${u.name}</strong></td>
                <td>${u.email}</td>
                <td>${u.is_premium ? '<span class="badge premium">VIP</span>' : '<span class="badge">Free</span>'}</td>
                <td>${u.is_admin ? 'Admin' : 'User'}</td>
                <td>${new Date(u.created_at).toLocaleDateString()}</td>
                <td><span class="status-badge ${u.status || 'active'}">${u.status || 'active'}</span></td>
                <td>
                    <button onclick="toggleUserBan(${u.id}, '${u.status}')" class="btn-ban">
                        ${u.status === 'banned' ? 'Unban' : 'Ban'}
                    </button>
                </td>
            </tr>
        `).join('');

        if (premiumBody) {
            const premiumUsers = users.filter(u => u.is_premium);
            premiumBody.innerHTML = premiumUsers.map(p => {
                const daysLeft = Math.max(0, Math.ceil((new Date(p.premium_expires_at) - new Date()) / (1000 * 60 * 60 * 24)));
                return `
                    <tr>
                        <td><strong>${p.name}</strong></td>
                        <td>${p.premium_expires_at ? new Date(p.premium_expires_at).toLocaleDateString() : 'Lifetime'}</td>
                        <td>${p.subscription_type || 'Monthly Tier'}</td>
                        <td><span class="status-badge completed">Verified</span></td>
                        <td><strong>${daysLeft || '0'} Days</strong></td>
                    </tr>
                `;
            }).join('');
        }
    } catch (err) {
        console.error('User profiles population failed:', err);
    }
}

async function toggleUserBan(id, currentStatus) {
    const nextStatus = currentStatus === 'banned' ? 'active' : 'banned';
    if (!confirm(`Change user account status to ${nextStatus}?`)) return;
    try {
        await window.apiRequest(`/admin/users/${id}`, {
            method: 'PUT',
            body: { status: nextStatus }
        });
        loadUserManagement();
    } catch (err) {
        alert(err.message);
    }
}

// ─── 5. SETTINGS FORM INTEGRATION ────────────────────────────
async function loadSystemSettings() {
    try {
        const settings = await window.apiRequest('/admin/settings');
        if (!settings) return;

        const populateField = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val ?? '';
        };

        populateField('site-name', settings.site_name);
        populateField('site-announcement', settings.announcement);
        populateField('maintenance-mode', settings.maintenance_mode ? 'true' : 'false');
        populateField('price-monthly', settings.premium_monthly_amount);
        populateField('price-yearly', settings.premium_yearly_amount);
        populateField('bunny-cdn-host', settings.bunny_cdn_hostname);
        populateField('contact-email', settings.contact_email);
    } catch (err) {
        console.error('System configurations setup error:', err);
    }
}

// ─── 6. ADVERTISEMENTS LAYER INTERFACE ───────────────────────
async function loadAdvertisements() {
    const tableBody = document.querySelector('#ads-table tbody');
    if (!tableBody) return;

    try {
        const ads = await window.apiRequest('/admin/ads');
        if (!ads) return;

        tableBody.innerHTML = ads.map(ad => `
            <tr>
                <td><img src="${ad.banner_url || 'https://via.placeholder.com/468x60'}" style="max-width: 140px; border-radius: 4px;"></td>
                <td>${ad.video_url ? 'Pre-Roll Video' : 'Static Banner'}</td>
                <td>Every ${ad.frequency_minutes || 5} mins</td>
                <td><span class="status-badge ${ad.is_active ? 'active' : 'inactive'}">${ad.is_active ? 'ENABLED' : 'DISABLED'}</span></td>
                <td><a href="${ad.target_url}" target="_blank" class="link-url">${ad.target_url}</a></td>
                <td>${ad.target_free_only ? 'Free Plan Only' : 'Global Population'}</td>
            </tr>
        `).join('');
    } catch (err) {
        console.error('Campaign records download failed:', err);
    }
}

// ─── 7. AUDIT TRAIL STREAM TRACKING ──────────────────────────
async function loadActivityLogs() {
    const logsTimeline = document.getElementById('activity-logs');
    if (!logsTimeline) return;

    try {
        const logs = await window.apiRequest('/admin/logs');
        if (!logs) return;

        logsTimeline.innerHTML = logs.map(log => `
            <div class="timeline-item">
                <span class="time" style="color: #3b82f6; font-weight: bold; min-width: 80px;">
                    ${new Date(log.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                </span>
                <span class="action">
                    <strong>${log.user_name || 'System Operator'}</strong> ${log.action} 
                    <span style="color: #64748b; font-size: 0.8rem;">(${log.ip_address || 'Internal IP'})</span>
                </span>
            </div>
        `).join('');
    } catch (err) {
        console.error('System operations log compilation failed:', err);
    }
}

// --- Dynamic Initialization Bootstrap Loop ---
document.addEventListener('DOMContentLoaded', () => {
    loadDashboardOverview();
    loadAnimeManagement();
    loadEpisodeManagement();
    loadUserManagement();
    loadSystemSettings();
    loadAdvertisements();
    loadActivityLogs();

    // Secure operational refresh cycle (runs every 30 seconds)
    if (window.statsInterval) clearInterval(window.statsInterval);
    window.statsInterval = setInterval(() => {
        loadDashboardOverview();
        loadActivityLogs();
    }, 30000);
});
