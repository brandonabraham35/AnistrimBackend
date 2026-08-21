const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'sql', 'migrations_v45_subscriptions_reconcile.sql'),
  'utf8'
);

test('v45 reconciles the subscription columns used by payment code', () => {
  const requiredColumns = [
    'user_id', 'reference', 'amount', 'currency', 'status', 'plan',
    'order_tracking_id', 'plan_id', 'starts_at', 'ends_at', 'state',
    'source', 'auto_renew', 'paid_at', 'expires_at', 'created_at',
  ];

  for (const column of requiredColumns) {
    assert.match(migration, new RegExp(`\\b${column}\\b`, 'i'), `${column} must be reconciled`);
  }
  assert.match(migration, /ADD COLUMN plan ENUM/i, 'missing plan must be added');
  assert.doesNotMatch(migration, /\bDROP\b/i, 'reconciliation must not delete production data');
  assert.doesNotMatch(migration, /INT\s+NOT\s+NOT\s+NULL/i, 'fresh schema must be valid SQL');
});

test('checkout persists its pending subscription before submitting an external order', () => {
  const controller = fs.readFileSync(path.join(ROOT, 'controllers', 'paymentController.js'), 'utf8');
  const insertAt = controller.indexOf('INSERT INTO subscriptions');
  const submitAt = controller.indexOf('pesapal.submitOrder');
  assert.ok(insertAt >= 0 && submitAt >= 0 && insertAt < submitAt,
    'pending subscription must be inserted before Pesapal submission');
  assert.match(controller, /UPDATE subscriptions SET order_tracking_id = \? WHERE id = \?/,
    'tracking ID must be attached to the existing pending row');
});

test('startup asserts the subscription schema, not only the table', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate.js'), 'utf8');
  assert.match(runner, /CRITICAL_COLUMNS/, 'runner must declare critical columns');
  assert.match(runner, /Critical schema columns missing/, 'runner must fail on drift');
});
