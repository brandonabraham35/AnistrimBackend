// File Path: Frontend/js/api.js

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

    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers
        });

        // A 401 means the credential is missing, expired, or invalid. A 403 means
        // the current authenticated account is not permitted for this one action;
        // clearing a valid token on 403 caused the observed dashboard login loop.
        if (response.status === 401) {
            localStorage.removeItem('admin_token');
            localStorage.removeItem('admin_user');
            
            const currentPath = window.location.pathname;
            if (!currentPath.endsWith('index.html') && currentPath !== '/' && !currentPath.endsWith('/')) {
                window.location.replace('index.html');
            }
            return null;
        }

        if (response.status === 204) return null;

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
            ? await response.json()
            : { message: await response.text() || `Request failed (${response.status})` };

        if (!response.ok) {
            throw new Error(data?.message || 'API Request failed');
        }

        return data;
    } catch (error) {
        console.error(`API Error [${endpoint}]:`, error);
        throw error;
    }
}

window.apiRequest = apiRequest;
