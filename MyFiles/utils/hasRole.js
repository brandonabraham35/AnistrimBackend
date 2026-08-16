// utils/hasRole.js — authoritative, server-side role check (P1 / Defect 6).
//
// Roles live in the dedicated `user_roles` table (NOT on the profile/users row),
// and admin authorization checks this table FRESH on every request instead of
// trusting a stale JWT `isAdmin` claim. MySQL has no Postgres RLS / SECURITY
// DEFINER, so the enforcement point is here, consumed by middleware/auth.js
// `adminOnly` and any other write path that must verify a role.
const pool = require('../config/db');

/**
 * Resolve the roles a user currently holds from user_roles (authoritative).
 * Falls back to the legacy `users.is_admin` flag so the migration is safe even
 * before user_roles has been backfilled (defensive; normal path reads the table).
 * @param {number|string} userId
 * @returns {Promise<string[]>} e.g. ['admin'] or ['user']
 */
async function rolesOf(userId) {
  if (userId === undefined || userId === null) return [];
  try {
    const [rows] = await pool.query(
      'SELECT role FROM user_roles WHERE user_id = ?',
      [userId]
    );
    const roles = rows.map(r => r.role);
    if (roles.length) return roles;
    // Backfill safety: if the table is empty for this user (pre-migration),
    // honor the legacy profile flag so we don't accidentally lock everyone out.
    const [u] = await pool.query('SELECT is_admin FROM users WHERE id = ?', [userId]);
    if (u.length && u[0].is_admin) return ['admin'];
    return ['user'];
  } catch (e) {
    // If the table doesn't exist yet (migration not run), fall back to the flag.
    try {
      const [u] = await pool.query('SELECT is_admin FROM users WHERE id = ?', [userId]);
      if (u.length && u[0].is_admin) return ['admin'];
    } catch (_) { /* ignore */ }
    return ['user'];
  }
}

/**
 * Does this user hold the given role right now (server-authoritative)?
 */
async function hasRole(userId, role = 'admin') {
  const roles = await rolesOf(userId);
  return roles.includes(role);
}

/**
 * Convenience: ensure a user holds a role (grant). Returns true if changed.
 */
async function grantRole(userId, role = 'admin') {
  if (userId === undefined || userId === null) return false;
  const [r] = await pool.query(
    'INSERT IGNORE INTO user_roles (user_id, role) VALUES (?, ?)',
    [userId, role]
  );
  return r.affectedRows > 0;
}

/**
 * Convenience: remove a role (revoke). Returns true if changed.
 */
async function revokeRole(userId, role = 'admin') {
  if (userId === undefined || userId === null) return false;
  const [r] = await pool.query(
    'DELETE FROM user_roles WHERE user_id = ? AND role = ?',
    [userId, role]
  );
  return r.affectedRows > 0;
}

module.exports = { rolesOf, hasRole, grantRole, revokeRole };