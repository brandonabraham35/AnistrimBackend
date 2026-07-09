// File Path: Frontend/js/api.js

const API_BASE = 'http://localhost:5000/api';

async function apiRequest(endpoint, options = {}) {
    const token = localStorage.getItem('admin_token');
    
    // 🚀 BYPASS: If we are using the mock bypass token, intercept the dashboard stats 
    // request and return fake data instantly so the backend never blocks us!
    if (token === 'MOCK_ADMIN_TOKEN_BYPASS') {
        if (endpoint.includes('/admin/dashboard/overview')) {
            return {
                overview: {
                    users: { total: 1250, premium: 340, activeToday: 88, banned: 2 },
                    content: { totalAnime: 145, totalEpisodes: 2400, totalViews: 458900 },
                    revenue: { total: 5400000, monthly: 1200000, today: 45000 },
                    bunny: { ready: 2380, processing: 18, failed: 2 }
                },
                recentAnime: [],
                recentEpisodes: [
                    { anime_title: "Naruto Shippuden", episode_number: 12, created_at: new Date() },
                    { anime_title: "One Piece", episode_number: 1084, created_at: new Date() }
                ],
                topAnime: [
                    { title: "Attack on Titan", view_count: 150000, cover_image: "https://via.placeholder.com/150" },
                    { title: "Demon Slayer", view_count: 124000, cover_image: "https://via.placeholder.com/150" }
                ],
                recentPayments: [
                    { name: "John Doe", amount: 15000, status: "completed" },
                    { name: "Jane Smith", amount: 180000, status: "completed" }
                ],
                activityLogs: [
                    { user_name: "Admin Brandon", action: "uploaded a new episode", created_at: new Date() }
                ],
                latestUsers: [
                    { name: "Alex Mukasa", email: "alex@gmail.com", is_premium: 1 },
                    { name: "Sarah Namubiru", email: "sarah@gmail.com", is_premium: 0 }
                ]
            };
        }
    }

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

        if (response.status === 401 || response.status === 403) {
            localStorage.removeItem('admin_token');
            localStorage.removeItem('admin_user');
            
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
    } catch (error) {
        console.error("API Network Error:", error);
        throw new Error("Cannot connect to backend server.");
    }
}

window.apiRequest = apiRequest;