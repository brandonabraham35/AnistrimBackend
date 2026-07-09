// File Path: Frontend/js/auth.js

document.addEventListener('DOMContentLoaded', () => {
    // 🚀 BYPASS: Automatically mock an admin user session and skip login completely
    const bypassUser = {
        id: 3,
        name: "Admin Brandon",
        email: "brandonabraham35@gmail.com",
        isAdmin: true,
        is_admin: 1,
        isPremium: true
    };

    localStorage.setItem('admin_token', 'MOCK_ADMIN_TOKEN_BYPASS');
    localStorage.setItem('admin_user', JSON.stringify(bypassUser));
    
    // Redirect instantly to the dashboard
    window.location.replace('dashboard.html');
});

function logout() {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.replace('index.html');
}

window.logout = logout;