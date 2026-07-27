async function initAds() {
    const tbody = document.querySelector('#ads-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading ads...</td></tr>';

    try {
        const ads = await window.apiRequest('/api/admin/ads');
        tbody.innerHTML = '';
        ads.forEach(ad => {
            tbody.innerHTML += `
                <tr>
                    <td>${ad.title}</td>
                    <td>${ad.type}</td>
                    <td>${ad.is_active ? 'Yes' : 'No'}</td>
                    <td>
                        <button class="action-btn delete-btn" onclick="deleteAd(${ad.id})">Delete</button>
                    </td>
                </tr>
            `;
        });
    } catch (error) {
        console.error('[Ads] Failed to load ads:', error);
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--danger);">Error loading ads. Check console.</td></tr>`;
    }
}

document.getElementById('add-ad-btn').onclick = () => {
    // Simple implementation: prompt for info or show modal (skipping full modal UI for brevity but functional)
    const title = prompt('Ad Title:');
    if (!title) return;
    window.apiRequest('/api/admin/ads', {
        method: 'POST',
        body: { title, type: 'banner', is_active: 1, target_free_only: 1, frequency: 1 }
    }).then(initAds).catch(error => {
        console.error('[Ads] Failed to add ad:', error);
        alert(`Failed to add ad: ${error.message}`);
    });
};

async function deleteAd(id) {
    if (!confirm('Delete ad?')) return;
    try {
        await window.apiRequest(`/api/admin/ads/${id}`, { method: 'DELETE' });
        initAds();
    } catch (error) {
        console.error(`[Ads] Failed to delete ad ${id}:`, error);
        alert(`Failed to delete ad: ${error.message}`);
    }
}

window.initAds = initAds;
window.deleteAd = deleteAd;
