async function initSettings() {
    const form = document.getElementById('settings-form');
    if (!form) return;

    try {
        const data = await window.apiRequest('/api/admin/settings');
        Object.keys(data).forEach(key => {
            const input = form.querySelector(`[name="${key}"]`);
            if (input) {
                if (input.type === 'checkbox') input.checked = data[key] === '1' || data[key] === true;
                else input.value = data[key];
            }
        });
    } catch (error) {
        console.error('[Settings] Failed to load settings:', error);
        window.showToast(`Failed to load settings: ${window._escapeHTML(error.message)}`, 'error');
    }
}

document.getElementById('settings-form').onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const body = {};
    formData.forEach((value, key) => {
        body[key] = value;
    });
    // Handle checkboxes (maintenance_mode)
    if (!body.maintenance_mode) body.maintenance_mode = '0';

    try {
        await window.apiRequest('/api/admin/settings', { method: 'PUT', body });
        window.showToast('Settings saved!');
    } catch (error) {
        console.error('[Settings] Failed to save settings:', error);
        window.showToast(`Failed to save settings: ${window._escapeHTML(error.message)}`, 'error');
    }
};

window.initSettings = initSettings;
