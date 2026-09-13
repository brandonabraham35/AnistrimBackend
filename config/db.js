// config/db.js - MySQL connection pool using mysql2
//
// IMPORTANT: Importing this module is intentionally SIDE-EFFECT FREE with
// respect to the database. It only builds a lazy connection pool. It does NOT
// connect, create/promote administrators, run migrations, or write anything.
//
// All schema changes and admin creation are explicit, opt-in commands:
//   npm run db:bootstrap   (fresh database bootstrap)
//   npm run migrate       (apply pending migrations)
//   npm run admin:create  (create/promote an admin account)
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'anistrim2',
  waitForConnections: true,
  connectionLimit:    3,
  queueLimit:         0,
  charset:            'utf8mb4',
  idleTimeout:        10000,
});

/**
 * Read-only connectivity check. Never writes to the database.
 * @returns {Promise<boolean>} true if the server is reachable.
 */
async function testConnection() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
    return true;
  } finally {
    conn.release();
  }
}

module.exports = pool;
module.exports.testConnection = testConnection;
