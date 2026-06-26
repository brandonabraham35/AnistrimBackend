const API_BASE = 'https://anistrimbackend.onrender.com/api';

async function apiRequest(endpoint, options = {}) {
    const token = localStorage.getItem('admin_token');
    const headers = {
        'Accept': 'application/json',
        ...options.headers
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.body && !(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers
    });

    const data = response.status !== 204 ? await response.json() : null;
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            localStorage.removeItem('admin_token');
            if (!window.location.pathname.endsWith('index.html') && window.location.pathname !== '/AdminDashboard/') {
                window.location.href = 'index.html';
            }
        }
        throw new Error(data.message || 'API Request failed');
    }

    return data;
}

window.apiRequest = apiRequest;
