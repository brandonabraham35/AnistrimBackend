// File Path: Frontend/js/auth.js

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

                // Diagnostic log trace to track type transformations inside DevTools
                console.log('LOGIN PAYLOAD:', JSON.stringify(data));

                const u = data?.user;
                const isAdmin =
                    u?.isAdmin === true ||
                    u?.is_admin === 1 ||
                    u?.is_admin === '1' ||
                    u?.is_admin === true ||
                    (u?.is_admin && typeof u.is_admin === 'object' && u.is_admin.data && u.is_admin.data[0] === 1);

                if (data?.token && isAdmin) {
                    localStorage.setItem('admin_token', data.token);
                    localStorage.setItem('admin_user', JSON.stringify(u));
                    window.location.replace('dashboard.html');
                } else if (data?.token) {
                    if (errorMsg) errorMsg.innerText = 'Logged in, but this account is not an admin.';
                    localStorage.removeItem('admin_token');
                } else {
                    if (errorMsg) errorMsg.innerText = 'Login failed.';
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