async function initAds() {
    const ads = await window.apiRequest('/admin/ads');
    const tbody = document.querySelector('#ads-table tbody');
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
}

document.getElementById('add-ad-btn').onclick = () => {
    // Simple implementation: prompt for info or show modal (skipping full modal UI for brevity but functional)
    const title = prompt('Ad Title:');
    if (!title) return;
    window.apiRequest('/admin/ads', {
        method: 'POST',
        body: { title, type: 'banner', is_active: 1, target_free_only: 1, frequency: 1 }
    }).then(initAds);
};

async function deleteAd(id) {
    if (confirm('Delete ad?')) {
        await window.apiRequest(`/admin/ads/${id}`, { method: 'DELETE' });
        initAds();
    }
}

window.initAds = initAds;
window.deleteAd = deleteAd;
