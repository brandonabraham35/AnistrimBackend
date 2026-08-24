// scripts/verify-schema.js — Production schema integrity verification.
// Run after migrations to confirm the database matches application expectations.
// Exits with code 0 on success, 1 on failure.
//
// Usage:
//   node scripts/verify-schema.js
//
// Does NOT modify data or credentials.

'use strict';

const pool = require('../config/db');

const REQUIRED_COLUMNS = {
  subscriptions: [
    'user_id', 'reference', 'amount', 'currency', 'status', 'plan',
    'order_tracking_id', 'plan_id', 'starts_at', 'ends_at', 'state',
    'source', 'auto_renew', 'paid_at', 'expires_at', 'created_at',
  ],
  plans: ['code', 'name', 'tier', 'period', 'amount', 'currency', 'is_active'],
};

const CANONICAL_STATE_ENUM = [
  'pending', 'trialing', 'active', 'grace', 'expired', 'cancelled', 'refunded',
];

async function verify() {
  const errors = [];

  // 1. Verify tables exist
  const [tables] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('subscriptions', 'plans')`
  );
  const existingTables = new Set(tables.map(r => r.TABLE_NAME));
  for (const t of ['subscriptions', 'plans']) {
    if (!existingTables.has(t)) errors.push(`Missing table: ${t}`);
  }

  // 2. Verify columns exist for each table
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    if (!existingTables.has(table)) continue;
    const [colRows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    const existingCols = new Set(colRows.map(r => r.COLUMN_NAME));
    for (const col of cols) {
      if (!existingCols.has(col)) errors.push(`Missing column: ${table}.${col}`);
    }
  }

  // 3. Verify subscriptions.state ENUM contains all canonical values
  if (existingTables.has('subscriptions')) {
    const [colInfo] = await pool.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND COLUMN_NAME = 'state'`
    );
    if (colInfo.length) {
      const colType = String(colInfo[0].COLUMN_TYPE || '');
      for (const val of CANONICAL_STATE_ENUM) {
        if (!colType.includes(`'${val}'`)) {
          errors.push(`subscriptions.state ENUM missing value: '${val}'`);
        }
      }
    } else {
      errors.push('subscriptions.state column does not exist');
    }
  }

  // 4. Verify plan amounts
  if (existingTables.has('plans')) {
    const [plans] = await pool.query(
      `SELECT code, amount, currency FROM plans WHERE code IN ('premium-monthly', 'premium-annual')`
    );
    const planMap = {};
    for (const p of plans) planMap[p.code] = p;
    if (!planMap['premium-monthly']) {
      errors.push('Missing plan: premium-monthly');
    } else if (Number(planMap['premium-monthly'].amount) !== 15000) {
      errors.push(`premium-monthly amount is ${planMap['premium-monthly'].amount}, expected 15000`);
    }
    if (!planMap['premium-annual']) {
      errors.push('Missing plan: premium-annual');
    } else if (Number(planMap['premium-annual'].amount) !== 180000) {
      errors.push(`premium-annual amount is ${planMap['premium-annual'].amount}, expected 180000`);
    }
  }

  if (errors.length) {
    console.error('❌ Schema verification FAILED:');
    for (const e of errors) console.error('  -', e);
    process.exit(1);
  }

  console.log('✅ Schema verification passed.');
  console.log(`  Tables: ${['subscriptions', 'plans'].filter(t => existingTables.has(t)).join(', ')}`);
  console.log(`  subscriptions.state ENUM complete (${CANONICAL_STATE_ENUM.length} values)`);
  console.log('  plan amounts correct (premium-monthly=15000, premium-annual=180000)');
  process.exit(0);
}

verify().catch(err => {
  console.error('❌ Schema verification error:', err.message);
  process.exit(1);
});