// config/db.js — MySQL connection pool using mysql2
const mysql = require('mysql2/promise');
require('dotenv').config();
const bcrypt = require('bcryptjs');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'anistrim2',
  waitForConnections: true,
  connectionLimit:    3,  // Never exceed your host's limit of 5 — 3 is safe headroom
  queueLimit:         0,  // Unlimited queuing (requests wait for a free connection)
  charset:            'utf8mb4',
  // Destroy connections that have been idle for 10s to free up pool slots
  idleTimeout:        10000,
});

/**
 * Ensures that a default admin user exists and has the correct password hash.
 * This runs on server startup to prevent login issues in any environment.
 */
async function ensureAdminUser() {
  let connection;
  try {
    connection = await pool.getConnection();
    console.log('🔑 Verifying default admin user...');

    const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@anistrim.com';
    const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(adminPassword, salt);

    // Check if the user exists
    const [rows] = await connection.query('SELECT id FROM users WHERE email = ?', [adminEmail]);

    if (rows.length > 0) {
      // User exists, ensure they are an admin and the password is correct
      const user = rows[0];
      await connection.query('UPDATE users SET password_hash = ?, is_admin = 1 WHERE id = ?', [passwordHash, user.id]);
      console.log(`✅ Admin user '${adminEmail}' verified and password reset.`);
    } else {
      // User does not exist, create them.
      // Check whether the Phase-1 `status` column exists yet (migrations may not
      // have run on a fresh DB). If it does, set status='active'; otherwise omit
      // it so the INSERT does not crash with "Unknown column 'status'".
      const [colRows] = await connection.query(
        `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'status'`
      );
      const hasStatus = Number(colRows[0]?.c) > 0;
      if (hasStatus) {
        await connection.query(
          "INSERT INTO users (name, email, password_hash, is_admin, is_premium, is_verified, status) VALUES (?, ?, ?, 1, 1, 1, 'active')",
          ['Default Admin', adminEmail, passwordHash]
        );
      } else {
        await connection.query(
          "INSERT INTO users (name, email, password_hash, is_admin, is_premium, is_verified) VALUES (?, ?, ?, 1, 1, 1)",
          ['Default Admin', adminEmail, passwordHash]
        );
      }
      console.log(`✅ Admin user '${adminEmail}' created successfully.`);
    }
  } catch (error) {
    console.error('❌ Failed to ensure admin user:', error.message);
  } finally {
    if (connection) connection.release();
  }
}

// Test connection on startup
pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL connected to:', process.env.DB_NAME);
    conn.release();
    // After successful connection, ensure the admin user is configured
    ensureAdminUser();
  })
  .catch(err => {
    console.error('❌ MySQL connection failed:', err.message);
    console.error('   Check your .env DB_HOST / DB_USER / DB_PASSWORD / DB_NAME');
  });

module.exports = pool;
