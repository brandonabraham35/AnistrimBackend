// AdminDashboard/js/settings.js — Enhanced with validation, reset-to-defaults, category groups
// Uses shared.js for: _escapeHTML, showToast, _debounce, _confirm, SkeletonLoader, EmptyState, ErrorState

// ─── Settings Field Definitions with Categories ──────────────────────────────
const SETTINGS_FIELDS = [
  // General
  { key: 'site_name', label: 'Site Name', type: 'text', category: 'General', placeholder: 'AniStrim' },
  { key: 'announcement', label: 'Announcement', type: 'text', category: 'General', placeholder: 'Welcome to AniStrim!' },
  { key: 'contact_email', label: 'Contact Email', type: 'email', category: 'General', placeholder: 'admin@anistrim.com' },

  // Premium
  { key: 'premium_monthly_amount', label: 'Premium Monthly (UGX)', type: 'number', category: 'Premium', placeholder: '15000' },
  { key: 'premium_yearly_amount', label: 'Premium Yearly (UGX)', type: 'number', category: 'Premium', placeholder: '100000' },

  // Streaming
  { key: 'cloudinary_cloud_name', label: 'Cloudinary Cloud Name', type: 'text', category: 'Streaming', placeholder: 'your-cloud-name' },

  // Maintenance
  { key: 'maintenance_mode', label: 'Maintenance Mode', type: 'checkbox', category: 'Maintenance' },
];

const SETTINGS_DEFAULTS = {
  site_name: 'AniStrim',
  announcement: '',
  contact_email: '',
  premium_monthly_amount: '15000',
  premium_yearly_amount: '100000',
  cloudinary_cloud_name: '',
  maintenance_mode: '0',
};

// ─── State ──────────────────────────────────────────────────────────────────
let _originalSettings = {};

// ─── Initialization ─────────────────────────────────────────────────────────
async function initSettings() {
  const form = document.getElementById('settings-form');
  if (!form) return;

  // Build form with category groups
  if (!form.dataset.fieldsBuilt) {
    form.innerHTML = _buildSettingsForm();
    form.dataset.fieldsBuilt = 'true';
  }

  // Load current settings
  try {
    const data = await window.apiRequest('/api/admin/settings');
    _originalSettings = { ...data };
    _populateForm(data);
  } catch (error) {
    console.error('[Settings] Failed to load:', error);
    window.showToast?.('Failed to load settings: ' + error.message, 'error');
  }

  // Attach submit handler
  form.addEventListener('submit', _handleSubmit);

  // Attach reset button handler
  document.getElementById('settings-reset-btn')?.addEventListener('click', _handleReset);

  // Attach import/export
  document.getElementById('settings-import-btn')?.addEventListener('click', _handleImport);
  document.getElementById('settings-export-btn')?.addEventListener('click', _handleExport);

  // Real-time validation
  form.querySelectorAll('.settings-input').forEach(input => {
    input.addEventListener('blur', () => _validateField(input));
  });
}

// ─── Build Settings Form ────────────────────────────────────────────────────
function _buildSettingsForm() {
  const categories = {};
  SETTINGS_FIELDS.forEach(field => {
    if (!categories[field.category]) categories[field.category] = [];
    categories[field.category].push(field);
  });

  let html = '';
  for (const [category, fields] of Object.entries(categories)) {
    html += `
      <div class="settings-category" style="margin-bottom:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid #2a2c37;">
        <h4 style="margin-bottom:0.75rem;color:var(--primary);font-size:0.95rem;text-transform:uppercase;letter-spacing:0.05em;">
          <i class="fas fa-${_getCategoryIcon(category)}"></i> ${category}
        </h4>
        <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:1rem;">
          ${fields.map(field => _renderField(field)).join('')}
        </div>
      </div>
    `;
  }

  html += `
    <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1rem;">
      <button type="submit" class="btn"><i class="fas fa-save"></i> Save Settings</button>
      <button type="button" class="btn secondary" id="settings-reset-btn"><i class="fas fa-undo"></i> Reset to Defaults</button>
      <button type="button" class="btn secondary" id="settings-export-btn"><i class="fas fa-download"></i> Export Settings</button>
      <button type="button" class="btn secondary" id="settings-import-btn"><i class="fas fa-upload"></i> Import Settings</button>
    </div>
    <div id="settings-validation-errors" style="margin-top:0.75rem;color:var(--danger);font-size:0.85rem;display:none;"></div>
  `;

  return html;
}

function _getCategoryIcon(category) {
  const icons = {
    'General': 'cog',
    'Premium': 'crown',
    'Streaming': 'video',
    'Maintenance': 'wrench'
  };
  return icons[category] || 'gear';
}

function _renderField(field) {
  if (field.type === 'checkbox') {
    return `<label class="wide" style="grid-column:1/-1;"><input type="checkbox" name="${field.key}" id="settings-${field.key}" class="settings-input"> ${field.label}</label>`;
  }
  return `
    <label>
      ${field.label}
      <input type="${field.type}" name="${field.key}" id="settings-${field.key}" class="settings-input"
             placeholder="${field.placeholder || ''}" ${field.type === 'email' ? 'required' : ''}>
    </label>
  `;
}

// ─── Form Population ────────────────────────────────────────────────────────
function _populateForm(data) {
  Object.keys(data).forEach(key => {
    const input = document.getElementById(`settings-${key}`);
    if (input) {
      if (input.type === 'checkbox') input.checked = data[key] === '1' || data[key] === true;
      else input.value = data[key] || '';
    }
  });
}

// ─── Form Validation ────────────────────────────────────────────────────────
function _validateField(input) {
  const errors = document.getElementById('settings-validation-errors');
  if (!errors) return true;

  const field = SETTINGS_FIELDS.find(f => f.key === input.name);
  if (!field) return true;

  input.style.borderColor = '';

  // URL validation for cloudinary
  if (field.key === 'cloudinary_cloud_name' && input.value && !/^[a-zA-Z0-9_-]+$/.test(input.value)) {
    input.style.borderColor = '#f43f5e';
    return false;
  }

  // Email validation
  if (field.type === 'email' && input.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value)) {
    input.style.borderColor = '#f43f5e';
    return false;
  }

  // Number validation
  if (field.type === 'number' && input.value && isNaN(Number(input.value))) {
    input.style.borderColor = '#f43f5e';
    return false;
  }

  return true;
}

function _validateAll() {
  const errors = document.getElementById('settings-validation-errors');
  if (!errors) return true;

  let hasErrors = false;
  const messages = [];

  const emailInput = document.getElementById('settings-contact_email');
  if (emailInput && emailInput.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value)) {
    messages.push('Please enter a valid contact email address.');
    emailInput.style.borderColor = '#f43f5e';
    hasErrors = true;
  }

  const monthlyInput = document.getElementById('settings-premium_monthly_amount');
  if (monthlyInput && monthlyInput.value && (isNaN(Number(monthlyInput.value)) || Number(monthlyInput.value) < 0)) {
    messages.push('Premium monthly amount must be a positive number.');
    monthlyInput.style.borderColor = '#f43f5e';
    hasErrors = true;
  }

  const yearlyInput = document.getElementById('settings-premium_yearly_amount');
  if (yearlyInput && yearlyInput.value && (isNaN(Number(yearlyInput.value)) || Number(yearlyInput.value) < 0)) {
    messages.push('Premium yearly amount must be a positive number.');
    yearlyInput.style.borderColor = '#f43f5e';
    hasErrors = true;
  }

  if (hasErrors) {
    errors.innerHTML = messages.map(m => '<div>⚠️ ' + m + '</div>').join('');
    errors.style.display = 'block';
    return false;
  }

  errors.style.display = 'none';
  return true;
}

// ─── Submit Handler ─────────────────────────────────────────────────────────
async function _handleSubmit(e) {
  e.preventDefault();

  // Validate first
  if (!_validateAll()) {
    window.showToast?.('Please fix validation errors before saving.', 'error');
    return;
  }

  const form = e.target;
  const formData = new FormData(form);
  const body = {};
  formData.forEach((value, key) => { body[key] = value; });
  // Ensure checkboxes are sent
  if (!body.maintenance_mode) body.maintenance_mode = '0';

  try {
    await window.apiRequest('/api/admin/settings', { method: 'PUT', body });
    _originalSettings = { ...body };
    window.showToast?.('Settings saved successfully!', 'success');
  } catch (error) {
    console.error('[Settings] Failed to save:', error);
    window.showToast?.('Failed to save settings: ' + error.message, 'error');
  }
}

// ─── Reset Handler ──────────────────────────────────────────────────────────
async function _handleReset() {
  const confirmed = await window._confirm(
    'Reset Settings',
    'Reset all settings to their default values? This action cannot be undone.',
    'Reset',
    'Cancel'
  );
  if (!confirmed) return;

  _populateForm(SETTINGS_DEFAULTS);
  window.showToast?.('Settings have been reset to defaults. Click "Save Settings" to persist.', 'info');
}

// ─── Export Handler ─────────────────────────────────────────────────────────
async function _handleExport() {
  try {
    const data = await window.apiRequest('/api/admin/settings');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `anistrim-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    window.showToast?.('Settings exported successfully.', 'success');
  } catch (error) {
    window.showToast?.('Failed to export settings: ' + error.message, 'error');
  }
}

// ─── Import Handler ─────────────────────────────────────────────────────────
function _handleImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Validate structure
      if (typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Invalid settings file format.');
      }

      const confirmed = await window._confirm(
        'Import Settings',
        `Import settings from "${file.name}"? This will overwrite current values.`,
        'Import',
        'Cancel'
      );
      if (!confirmed) return;

      _populateForm(data);
      window.showToast?.('Settings loaded from file. Click "Save Settings" to persist.', 'info');
    } catch (error) {
      window.showToast?.('Failed to import settings: ' + error.message, 'error');
    }
  };
  input.click();
}

// ─── Global Exposure ────────────────────────────────────────────────────────
window.initializeSettingsSection = initSettings;
window.initSettings = initSettings;

document.addEventListener('DOMContentLoaded', () => {
  if (window.location.hash === '#settings') {
    initSettings();
  }
});
