document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const errorMsg = document.getElementById('error-message');

    // Check if already logged in
    if (localStorage.getItem('admin_token')) {
        window.location.href = 'dashboard.html';
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const loginBtn = document.getElementById('login-btn');

            loginBtn.disabled = true;
            loginBtn.innerText = 'Logging in...';
            errorMsg.innerText = '';

            try {
                const data = await window.apiRequest('/auth/login', {
                    method: 'POST',
                    body: { email, password }
                });

                if (data.user && (data.user.isAdmin || data.user.is_admin)) {
                    localStorage.setItem('admin_token', data.token);
                    localStorage.setItem('admin_user', JSON.stringify(data.user));
                    window.location.replace('dashboard.html');
                } else {
                    errorMsg.innerText = 'Access denied. Admin only.';
                    localStorage.removeItem('admin_token');
                }
            } catch (err) {
                errorMsg.innerText = err.message;
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
    window.location.href = 'index.html';
}

window.logout = logout;
