// File Path: Frontend/js/auth.js

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const errorMsg = document.getElementById('error-message');

    const currentPath = window.location.pathname;
    const isLoginPage = currentPath.endsWith('index.html') || currentPath === '/' || currentPath.endsWith('/');

    if (localStorage.getItem('admin_token') && isLoginPage) {
        window.location.replace('dashboard.html');
        return;
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;
            const loginBtn = document.getElementById('login-btn');

            loginBtn.disabled = true;
            loginBtn.innerText = 'Logging in...';
            if (errorMsg) errorMsg.innerText = '';

            try {
                // Use the correct admin login endpoint and stringify the body
                const data = await window.apiRequest('/api/auth/login', {
                    method: 'POST',
                    body: JSON.stringify({ email, password })
                });

                const u = data?.user;
                // Simplified, robust check for admin status, handles various formats (boolean, number, buffer)
                const isAdmin = u && (u.isAdmin || u.is_admin == 1 || (u.is_admin?.data?.[0] === 1));

                if (data?.token && isAdmin) {
                    localStorage.setItem('admin_token', data.token);
                    localStorage.setItem('admin_user', JSON.stringify(u));
                    window.location.replace('dashboard.html');
                } else if (data?.token) {
                    if (errorMsg) errorMsg.innerText = 'Access denied. Account is not configured as an administrator.';
                    localStorage.removeItem('admin_token');
                } else {
                    if (errorMsg) errorMsg.innerText = 'Login failed.';
                }
            } catch (err) {
                localStorage.removeItem('admin_token');
                localStorage.removeItem('admin_user');
                if (errorMsg) errorMsg.innerText = err.message;
            } finally {
                loginBtn.disabled = false;
                loginBtn.innerText = 'Login';
            }
        });
    }
});

/**
 * Initiates the Google OAuth flow by redirecting to the backend endpoint.
 */
function googleLogin() {
    // Dynamically determine the base URL to support both local development and production,
    // matching the logic in api.js.
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    // For production, use the full absolute URL. For local, use the absolute path to the local backend.
    const baseUrl = isLocalhost ? 'http://localhost:5000' : 'https://anistrimbackend.onrender.com';
    // Redirect to the backend's Google OAuth endpoint. The backend will handle
    // the redirect to Google's consent screen.
    // We use the 'state' parameter to signal the origin of the request.
    // The backend will receive this back from Google and can use it to redirect correctly.
    const state = 'admin_dashboard';
    window.location.href = `${baseUrl}/api/auth/google?state=${encodeURIComponent(state)}`;
}

function logout() {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.replace('index.html');
}

window.googleLogin = googleLogin;
window.logout = logout;
