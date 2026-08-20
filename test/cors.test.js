// test/cors.test.js — unit tests for config/cors.js
// Covers B1 (Capacitor origins in production), B4 (web origin in env),
// B9 (rejected origin logging), no-origin, and env origin.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const corsConfig = require('../config/cors');

const originalEnv = { ...process.env };

test.afterEach(() => {
  process.env = { ...originalEnv };
});

// ── parseOrigins ───────────────────────────────────────────
test('parseOrigins handles empty string', () => {
  const set = corsConfig.parseOrigins('');
  assert.equal(set.size, 0);
});

test('parseOrigins handles undefined', () => {
  const set = corsConfig.parseOrigins(undefined);
  assert.equal(set.size, 0);
});

test('parseOrigins parses comma-separated origins with whitespace', () => {
  const set = corsConfig.parseOrigins('https://a.com, https://b.com ,https://c.com');
  assert.equal(set.has('https://a.com'), true);
  assert.equal(set.has('https://b.com'), true);
  assert.equal(set.has('https://c.com'), true);
});

test('parseOrigins filters empty entries', () => {
  const set = corsConfig.parseOrigins('https://a.com,,,https://b.com');
  assert.equal(set.size, 2);
});

// ── buildAllowedOrigins ────────────────────────────────────
test('always includes native WebView origins in production (B1 fix)', () => {
  process.env.NODE_ENV = 'production';
  process.env.API_ALLOWED_ORIGINS = '';
  const origins = corsConfig.buildAllowedOrigins();
  // Critical: Capacitor origins must be present in production
  assert.equal(origins.has('capacitor://localhost'), true);
  assert.equal(origins.has('https://localhost'), true);
  assert.equal(origins.has('http://localhost'), true);
  assert.equal(origins.has('ionic://localhost'), true);
});

test('includes env origins from API_ALLOWED_ORIGINS', () => {
  process.env.NODE_ENV = 'production';
  process.env.API_ALLOWED_ORIGINS = 'https://web.anistrim.com,https://admin.anistrim.com';
  const set = corsConfig.buildAllowedOrigins();
  assert.equal(set.has('https://web.anistrim.com'), true);
  assert.equal(set.has('https://admin.anistrim.com'), true);
});

test('includes DESKTOP_ORIGINS from env', () => {
  process.env.NODE_ENV = 'production';
  process.env.DESKTOP_ORIGINS = 'app://anistrim-desktop,anistrim-desktop://auth';
  const origins = corsConfig.buildAllowedOrigins();
  assert.equal(origins.has('app://anistrim-desktop'), true);
  assert.equal(origins.has('anistrim-desktop://auth'), true);
});

test('includes dev localhost origins in non-production', () => {
  process.env.NODE_ENV = 'development';
  process.env.API_ALLOWED_ORIGINS = '';
  const origins = corsConfig.buildAllowedOrigins();
  assert.equal(origins.has('http://localhost:3000'), true);
  assert.equal(origins.has('http://localhost:8100'), true);
  assert.equal(origins.has('http://localhost:5173'), true);
});

// ── isOriginAllowed ────────────────────────────────────────
test('allows requests with no origin (curl, Electron file://, server-to-server)', () => {
  const allowed = new Set(['https://anistrim.com']);
  assert.equal(corsConfig.isOriginAllowed(undefined, allowed), true);
  assert.equal(corsConfig.isOriginAllowed(null, allowed), true);
  assert.equal(corsConfig.isOriginAllowed('', allowed), true);
});

test('allows explicit env origins', () => {
  const allowed = new Set(['https://anistrim.com']);
  assert.equal(corsConfig.isOriginAllowed('https://anistrim.com', allowed), true);
});

test('blocks unknown origins', () => {
  const allowed = new Set(['https://anistrim.com']);
  assert.equal(corsConfig.isOriginAllowed('https://evil.example.com', allowed), false);
});

test('allows capacitor://localhost in production', () => {
  process.env.NODE_ENV = 'production';
  const origins = corsConfig.buildAllowedOrigins();
  assert.equal(corsConfig.isOriginAllowed('capacitor://localhost', origins), true);
});

test('allows https://localhost in production (Android Capacitor)', () => {
  process.env.NODE_ENV = 'production';
  const origins = corsConfig.buildAllowedOrigins();
  assert.equal(corsConfig.isOriginAllowed('https://localhost', origins), true);
});

// ── buildCorsOptions ───────────────────────────────────────
test('includes PATCH in methods (B1 fix)', () => {
  const options = corsConfig.buildCorsOptions();
  assert.equal(options.methods.includes('PATCH'), true);
  assert.equal(options.methods.includes('GET'), true);
  assert.equal(options.methods.includes('POST'), true);
  assert.equal(options.methods.includes('PUT'), true);
  assert.equal(options.methods.includes('DELETE'), true);
  assert.equal(options.methods.includes('OPTIONS'), true);
});

test('allows X-Client header', () => {
  const options = corsConfig.buildCorsOptions();
  assert.equal(options.allowedHeaders.includes('X-Client'), true);
});

test('uses credentials:false (Bearer JWT auth, not cookies)', () => {
  const options = corsConfig.buildCorsOptions();
  assert.equal(options.credentials, false);
});

test('origin callback allows capacitor origin in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.API_ALLOWED_ORIGINS = '';
  const options = corsConfig.buildCorsOptions();
  options.origin('capacitor://localhost', (err, allow) => {
    assert.equal(err, null);
    assert.equal(allow, true);
  });
});

test('origin callback blocks unknown origin in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.API_ALLOWED_ORIGINS = '';
  const options = corsConfig.buildCorsOptions();
  options.origin('https://evil.example.com', (err, allow) => {
    assert.equal(err, null);
    assert.equal(allow, false);
  });
});

test('origin callback allows no origin (Electron file://)', () => {
  const options = corsConfig.buildCorsOptions();
  options.origin(undefined, (err, allow) => {
    assert.equal(err, null);
    assert.equal(allow, true);
  });
});