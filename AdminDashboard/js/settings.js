// Dynamically generate settings form fields from backend config
const SETTINGS_FIELDS = [
    { key: 'site_name', label: 'Site Name', type: 'text' },
    { key: 'announcement', label: 'Announcement', type: 'text' },
    { key: 'maintenance_mode', label: 'Maintenance Mode', type: 'checkbox' },
    { key: 'premium_monthly_amount', label: 'Premium Monthly (UGX)', type: 'number' },
    { key: 'premium_yearly_amount', label: 'Premium Yearly (UGX)', type: 'number' },
    { key: 'contact_email', label: 'Contact Email', type: 'email' },
    { key: 'cloudinary_cloud_name', label: 'Cloudinary Cloud Name', type: 'text' }
];

async function initSettings() {
    const form = document.getElementById('settings-form');
    if (!form) return;

    // Dynamically build form fields
    if (!form.dataset.fieldsBuilt) {
        let html = '<div class="form-grid" style="grid-template-columns:1fr 1fr;gap:1rem;">';
        SETTINGS_FIELDS.forEach(field => {
            if (field.type === 'checkbox') {
                html += `<label class="wide" style="grid-column:1/-1;"><input type="checkbox" name="${field.key}" id="settings-${field.key}"> ${field.label}</label>`;
            } else {
                html += `<label>${field.label}<input type="${field.type}" name="${field.key}" id="settings-${field.key}" class="settings-input"></label>`;
            }
        });
        html += '</div><button type="submit" class="btn wide" style="margin-top:1rem;">Save Settings</button>';
        form.innerHTML = html;
        form.dataset.fieldsBuilt = 'true';
    }

    try {
        const data = await window.apiRequest('/api/admin/settings');
        Object.keys(data).forEach(key => {
            const input = form.querySelector(`[name="${key}"]`);
            if (input) {
                if (input.type === 'checkbox') input.checked = data[key] === '1' || data[key] === true;
                else input.value = data[key] || '';
            }
        });
    } catch (error) {
        console.error('[Settings] Failed to load settings:', error);
        window.showToast(`Failed to load settings: ${window._escapeHTML(error.message)}`, 'error');
    }

    // Remove any existing listener and attach via delegation
    form.removeEventListener('submit', _handleSettingsSubmit);
    form.addEventListener('submit', _handleSettingsSubmit);
}

async function _handleSettingsSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    const body = {};
    formData.forEach((value, key) => {
        body[key] = value;
    });
    // Handle checkboxes (maintenance_mode)
    if (!body.maintenance_mode) body.maintenance_mode = '0';

    try {
        await window.apiRequest('/api/admin/settings', { method: 'PUT', body });
        window.showToast('Settings saved successfully!');
    } catch (error) {
        console.error('[Settings] Failed to save settings:', error);
        window.showToast(`Failed to save settings: ${window._escapeHTML(error.message)}`, 'error');
    }
}

window.initSettings = initSettings;
