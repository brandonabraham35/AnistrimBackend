const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt =jsonwebtoken');

// Helper to add a consistent prefix to our debug logs
const log = (message) => console.log(`[AUTH_DEBUG] ${message}`);

exports.login = async (req, res) => {
    const { email, password } = req.body;

    log('--- New Login Attempt ---');
    log(`Received email: ${email}`);
    log(`DB Host: ${process.env.DB_HOST || 'default'}, DB Name: ${process.env.DB_NAME || 'default'}`);

    try {
        const [rows] = await pool.query('SELECT id, name, email, password_hash, is_admin, is_premium FROM users WHERE email = ?', [email]);

        if (rows.length === 0) {
            log('User Check: User record NOT FOUND in database.');
            log('--> Returning HTTP 401 (User not found).');
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        const user = rows[0];
        log('User Check: User record FOUND.');
        log(`User ID: ${user.id}, Is Admin: ${user.is_admin}`);

        // IMPORTANT: Never log the raw password or the full hash in production.
        log('Password Check: Comparing provided password with stored hash...');
        const match = await bcrypt.compare(password, user.password_hash);

        if (!match) {
            log('Password Check: bcrypt.compare() returned FALSE. Passwords do not match.');
            log('--> Returning HTTP 401 (Password mismatch).');
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        log('Password Check: bcrypt.compare() returned TRUE. Passwords match.');
        log('Authentication successful. Generating JWT.');

        const payload = {
            id: user.id,
            name: user.name,
            isAdmin: !!user.is_admin,
            isPremium: !!user.is_premium
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                isAdmin: !!user.is_admin,
                isPremium: !!user.is_premium
            }
        });

    } catch (error) {
        log(`CRITICAL ERROR during login: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error during authentication.' });
    }
};

// NOTE: Other exports like 'signup' and 'getMe' would go here.