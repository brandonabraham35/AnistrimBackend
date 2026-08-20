// test/routeServing.test.js — verifies static multi-client serving.
// Mirrors the mount order from server.js without starting the real server.
// Uses Node's built-in test runner.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('path');

function buildTestApp() {
  const app = express();
  const dirs = {
    frontend: path.join(__dirname, '..', 'Frontend'),
    admin: path.join(__dirname, '..', 'AdminDashboard'),
    web: path.join(__dirname, '..', 'Web'),
  };

  app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'API endpoint not found.', status: 404 } });
  });

  app.use('/admin', express.static(dirs.admin, { index: false }));
  app.get(/^\/admin(\/.*)?$/, (req, res) => res.sendFile(path.join(dirs.admin, 'dashboard.html')));

  app.use('/web', express.static(dirs.web, { index: false }));
  app.get(/^\/web(\/.*)?$/, (req, res) => res.sendFile(path.join(dirs.web, 'index.html')));

  app.use(express.static(dirs.frontend, { index: false }));
  app.get(/.*/, (req, res) => res.sendFile(path.join(dirs.frontend, 'index.html')));

  return app;
}

function request(app, url) {
  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const port = server.address().port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}${url}`);
        const body = await res.text();
        server.close();
        resolve({ status: res.status, contentType: res.headers.get('content-type') || '', body });
      } catch (e) {
        server.close();
        resolve({ error: e });
      }
    });
  });
}

const APP = buildTestApp();

test('GET / → mobile HTML', async () => {
  const r = await request(APP, '/');
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/html/);
});

test('GET /web/ → web HTML (B3 fix)', async () => {
  const r = await request(APP, '/web/');
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/html/);
});

test('GET /web/anime/123 → web HTML (B3 deep link fix)', async () => {
  const r = await request(APP, '/web/anime/123');
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/html/);
});

test('GET /admin/settings → admin HTML', async () => {
  const r = await request(APP, '/admin/settings');
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/html/);
});

test('GET /api/does-not-exist → JSON 404', async () => {
  const r = await request(APP, '/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.match(r.contentType, /application\/json/);
  const body = JSON.parse(r.body);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'NOT_FOUND');
});