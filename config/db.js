// config/db.js — MySQL connection pool using mysql2
const mysql = require('mysql2/promise');
require('dotenv').config();

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
  // If a connection is acquired for > 60s, log a warning (helps catch leaks)
  acquireTimeout:     60000,
});

// Test connection on startup
pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL connected to:', process.env.DB_NAME);
    conn.release();
  })
  .catch(err => {
    console.error('❌ MySQL connection failed:', err.message);
    console.error('   Check your .env DB_HOST / DB_USER / DB_PASSWORD / DB_NAME');
  });

module.exports = pool;
