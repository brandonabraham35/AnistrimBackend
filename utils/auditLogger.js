// utils/auditLogger.js — Phase 5.3 (Item 24) unified admin audit logging.
//
// All mutating admin controllers call logAdminAction() so every write is
// recorded with before/after JSON for the read-only, filterable audit log.
// Never allow deletion of audit rows from the UI.
const crypto = require('crypto');
const db = require('../config/db');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function clientIp(req) {
  return (req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '')
    .toString().split(',')[0].trim() || null;
}

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const str = JSON.stringify(parsed);
    return str && str.length > 8000 ? str.slice(0, 8000) : parsed;
  } catch (e) {
    return String(value).slice(0, 8000);
  }
}

/**
 * Log an admin action to admin_logs.
 * @param {object} req - the Express request (for admin_id + ip)
 * @param {object} opts
 *   action: string (e.g. 'anime.update', 'user.suspend', 'episode.bulk_premium')
 *   entityType: string (e.g. 'anime', 'user', 'episode', 'payment')
 *   entityId: string|number
 *   before: any — JSON value before the change
 *   after: any — JSON value after the change
 */
async function logAdminAction(req, opts = {}) {
  const adminId = req?.user?.id ?? req?.user?.userId ?? null;
  const action = opts.action || 'admin.action';
  const entityType = opts.entityType || null;
  const entityId = opts.entityId ?? null;
  const before = safeJson(opts.before);
  const after = safeJson(opts.after);
  const ipHash = clientIp(req) ? sha256(clientIp(req)) : null;

  try {
    await db.query(
      `INSERT INTO admin_logs (admin_id, action, entity_type, entity_id, before_json, after_json, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [adminId, action, entityType, entityId != null ? String(entityId) : null, before, after, ipHash]
    );
  } catch (error) {
    // Audit logging must never turn a completed admin operation into a failure.
    console.warn('[AuditLogger] log failed (non-fatal):', error.message);
  }
}

module.exports = { logAdminAction, sha256 };