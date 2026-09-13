// utils/hasRole.js - authoritative, server-side role check (FAIL CLOSED).
//
// Roles live in the dedicated `user_roles` table (NOT on the profile/users row),
// and privileged authorization checks this table FRESH on every request instead
// of trusting a stale JWT claim.
//
// FAIL-CLOSED POLICY:
//   - Admin is granted ONLY when `user_roles` returns the 'admin' role.
//   - If the role lookup FAILS (DB error, missing table), the user is treated as
//     NOT privileged - we never fall back to users.is_admin on an error.
//   - The legacy `users.is_admin` flag is NOT consulted at runtime. Existing
//     admins must hold a user_roles row; migrations_v27_user_roles.sql and
//     `npm run admin:create` both populate it. This ensures a demoted or failed
//     role lookup can never re-grant admin.
const pool = require('../config/db');

/**
 * Resolve the roles a user currently holds from user_roles (authoritative).
 * Fail-closed: a DB error resolves to ['user']; is_admin is NEVER consulted.
 * @param {number|string} userId
 * @returns {Promise<string[]>} e.g. ['admin'] or ['user']
 */
async function rolesOf(userId) {
  if (userId === undefined || userId === null) return [];
  let rows;
  try {
    [rows] = await pool.query('SELECT role FROM user_roles WHERE user_id = ?', [userId]);
  } catch (e) {
    // Role lookup failed - deny, never fall back to users.is_admin.
    console.error('[HASROLE] role lookup failed (deny):', e.message);
    return ['user'];
  }
  const roles = rows.map(r => r.role).filter(Boolean);
  // Empty user_roles => no roles granted (fail closed; no is_admin fallback).
  return roles.length ? roles : ['user'];
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
