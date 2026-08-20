const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const migratedGroups = {
  auth: [
    'controllers/authController.js',
    'controllers/googleAuthController.js',
    'controllers/googleVerifyController.js',
    'routes/authRoutes.js',
    'routes/avatarRoutes.js',
  ],
  profile: ['controllers/profileController.js'],
  anime: ['controllers/animeController.js', 'controllers/catalogueController.js', 'routes/animeRoutes.js'],
  watch: ['controllers/watchController.js'],
  watchlist: ['controllers/watchlistController.js'],
  stream: ['controllers/streamController.js'],
  payments: ['controllers/paymentController.js'],
  home: ['controllers/homeShelfController.js', 'controllers/recommendationController.js'],
  reports: ['controllers/reportController.js'],
  download: ['routes/downloadRoutes.js'],
  admin: [
    'controllers/adminController.js',
    'controllers/adminImportController.js',
    'controllers/bunnyStreamController.js',
    'routes/uploadRoutes.js',
  ],
};

function readLines(relativePath) {
  const absolutePath = path.join(root, relativePath);
  return fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
}

function findRawSuccessJson(relativePath) {
  return readLines(relativePath)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => !line.startsWith('//'))
    .filter(({ line }) => {
      const directJson = /\bres\.json\s*\(/.test(line);
      const explicitSuccessStatus = /\bres\.status\s*\(\s*(?:200|201)\s*\)\s*\.json\s*\(/.test(line);
      return directJson || explicitSuccessStatus;
    })
    .filter(({ line }) => !line.includes('success: false'));
}

for (const [group, files] of Object.entries(migratedGroups)) {
  test(`success route contract: /api/${group} uses response helpers`, () => {
    const violations = files.flatMap(relativePath =>
      findRawSuccessJson(relativePath).map(hit => `${relativePath}:${hit.lineNumber} ${hit.line}`)
    );

    assert.deepEqual(violations, []);
  });
}

test('success route contract: all priority groups are represented', () => {
  assert.deepEqual(Object.keys(migratedGroups), [
    'auth',
    'profile',
    'anime',
    'watch',
    'watchlist',
    'stream',
    'payments',
    'home',
    'reports',
    'download',
    'admin',
  ]);
});
