async function initSettings() {
    const data = await window.apiRequest('/admin/settings');
    const form = document.getElementById('settings-form');

    Object.keys(data).forEach(key => {
        const input = form.querySelector(`[name="${key}"]`);
        if (input) {
            if (input.type === 'checkbox') input.checked = data[key] === '1';
            else input.value = data[key];
        }
    });
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

    await window.apiRequest('/admin/settings', { method: 'PUT', body });
    alert('Settings saved!');
};

window.initSettings = initSettings;
