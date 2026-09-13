// config/readiness.js — application readiness check.
//
// Readiness is separate from liveness. Liveness only means "the process is up";
// readiness means "the process can serve traffic" — i.e. the database is
// reachable and the required schema state exists. Optional external providers
// (e.g. AnimeHeaven) are deliberately NOT part of readiness: a provider outage
// must not mark the whole backend unavailable.
'use strict';

const pool = require('./db');
const { CRITICAL_TABLES } = require('../scripts/migrate');

/**
 * Check readiness. Pure read-only queries.
 * @param {object} [opts]
 * @param {object} [opts.db] - injectable pool/connection (for tests).
 * @param {string[]} [opts.requiredTables] - tables that must exist.
 * @returns {Promise<{ready:boolean, checks:{mysql:boolean, schema:boolean}, reason:string|null}>}
 */
async function checkReadiness({ db = pool, requiredTables = CRITICAL_TABLES } = {}) {
  const checks = { mysql: false, schema: false };

  if (!db || typeof db.query !== 'function') {
    return { ready: false, checks, reason: 'no-db' };
  }

  // 1. MySQL connectivity.
  try {
    await db.query('SELECT 1');
    checks.mysql = true;
  } catch (e) {
    return { ready: false, checks, reason: 'mysql-unreachable' };
  }

  // 2. Required schema state (critical tables present).
  try {
    const placeholders = requiredTables.map(() => '?').join(', ');
    const [rows] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN (${placeholders})`,
      requiredTables
    );
    const present = Number(rows && rows[0] && rows[0].c) || 0;
    checks.schema = present >= requiredTables.length;
  } catch (e) {
    return { ready: false, checks, reason: 'schema-check-failed' };
  }

  const ready = checks.mysql && checks.schema;
  return { ready, checks, reason: ready ? null : 'not-ready' };
}

module.exports = { checkReadiness };
