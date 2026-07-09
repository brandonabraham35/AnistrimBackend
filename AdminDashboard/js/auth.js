document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const errorMsg = document.getElementById('error-message');

    // Check if already logged in (only redirect if on login page)
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

            if (!email || !password) {
                if (errorMsg) errorMsg.innerText = 'Please fill out all fields.';
                return;
            }

            loginBtn.disabled = true;
            loginBtn.innerText = 'Logging in...';
            if (errorMsg) errorMsg.innerText = '';

            try {
                const data = await window.apiRequest('/auth/login', {
                    method: 'POST',
                    body: { email, password }
                });

                // 🚨 ====== EMERGENCY DEBUG LOGS ====== 🚨
                console.log("=== RAW SERVER RESPONSE DATA ===", data);
                alert("Server raw response: " + JSON.stringify(data));
                
                if (data && data.user) {
                    console.log("=== USER OBJECT ===", data.user);
                    console.log("data.user.isAdmin value:", data.user.isAdmin);
                    console.log("data.user.is_admin value:", data.user.is_admin);
                    alert("isAdmin: " + data.user.isAdmin + " | is_admin: " + data.user.is_admin);
                } else {
                    alert("Server responded, but 'data.user' is completely missing!");
                }
                // 🚨 ================================== 🚨

                // Lax fallback condition to try and force you through while testing
                if (data && data.user && (data.user.isAdmin === true || data.user.is_admin == 1 || data.user.is_admin === true)) {
                    localStorage.setItem('admin_token', data.token);
                    localStorage.setItem('admin_user', JSON.stringify(data.user));
                    window.location.replace('dashboard.html');
                } else {
                    if (errorMsg) errorMsg.innerText = 'Access denied. Admin only.';
                    localStorage.removeItem('admin_token');
                    localStorage.removeItem('admin_user');
                }
            } catch (err) {
                if (errorMsg) errorMsg.innerText = err.message;
            } finally {
                loginBtn.disabled = false;
                loginBtn.innerText = 'Login';
            }
        });
    }
});

function logout() {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.replace('index.html');
}

window.logout = logout;