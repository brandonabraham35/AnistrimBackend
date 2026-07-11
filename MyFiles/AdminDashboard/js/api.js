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

    if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_user');
        
        // Only redirect to index if we aren't already on the login landing page
        const currentPath = window.location.pathname;
        if (!currentPath.endsWith('index.html') && currentPath !== '/' && !currentPath.endsWith('/')) {
            window.location.replace('index.html');
        }
        return;
    }

    const data = response.status !== 204 ? await response.json() : null;

    if (!response.ok) {
        throw new Error(data?.message || 'API Request failed');
    }

    return data;
}

window.apiRequest = apiRequest;