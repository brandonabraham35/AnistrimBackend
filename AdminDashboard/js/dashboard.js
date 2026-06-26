async function initStats() {
    try {
        const data = await window.apiRequest('/admin/stats');

        document.getElementById('total-users').innerText = data.users.total;
        document.getElementById('premium-users').innerText = data.users.premium || 0;
        document.getElementById('total-anime').innerText = data.anime.total;
        document.getElementById('total-episodes').innerText = data.episodes || 0;
        document.getElementById('total-views').innerText = data.anime.totalViews || 0;
        document.getElementById('revenue-total').innerText = `UGX ${data.revenue.total.toLocaleString()}`;

        // Top Anime
        const topBody = document.querySelector('#top-anime-table tbody');
        topBody.innerHTML = '';
        data.topAnime.forEach(a => {
            topBody.innerHTML += `<tr><td>${a.title}</td><td>${a.view_count.toLocaleString()}</td></tr>`;
        });

        // Recent Payments
        const payBody = document.querySelector('#recent-payments-table tbody');
        payBody.innerHTML = '';
        data.recentPayments.forEach(p => {
            payBody.innerHTML += `<tr>
                <td>${p.name}</td>
                <td>UGX ${p.amount.toLocaleString()}</td>
                <td><span class="status-badge ${p.status}">${p.status}</span></td>
            </tr>`;
        });
    } catch (err) { console.error('Stats load failed:', err); }
}

window.initStats = initStats;
