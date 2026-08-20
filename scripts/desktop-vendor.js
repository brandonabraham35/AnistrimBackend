/**
 * scripts/desktop-vendor.js
 * Stages the shared client-contract + local hls.js into Desktop/vendor/ before
 * `npm run desktop:dev` or electron-builder runs. This guarantees the packaged
 * Electron app (which only ships Desktop/**) has every runtime script it needs
 * without referencing ../ outside the app root.
 *
 * Safe to run repeatedly (idempotent). Skips missing sources with a warning
 * instead of failing the build (e.g. hls not yet downloaded).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'Desktop');

function stageDir(src, dest) {
  try {
    fs.cpSync(src, dest, { recursive: true });
    console.log('[desktop-vendor] staged', path.relative(ROOT, dest));
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn('[desktop-vendor] skip (not found):', path.relative(ROOT, src));
    } else {
      console.error('[desktop-vendor] failed', path.relative(ROOT, src), '->', e.message);
    }
  }
}

function stageFile(src, dest) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log('[desktop-vendor] staged', path.relative(ROOT, dest));
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn('[desktop-vendor] skip (not found):', path.relative(ROOT, src));
    } else {
      console.error('[desktop-vendor] failed', path.relative(ROOT, src), '->', e.message);
    }
  }
}

// shared/client-contract/*.js -> Desktop/vendor/shared/
stageDir(
  path.join(ROOT, 'shared', 'client-contract'),
  path.join(DESKTOP, 'vendor', 'shared')
);

// local hls.js (Web/js/vendor/hls.min.js) -> Desktop/vendor/hls.min.js
stageFile(
  path.join(ROOT, 'Web', 'js', 'vendor', 'hls.min.js'),
  path.join(DESKTOP, 'vendor', 'hls.min.js')
);

console.log('[desktop-vendor] done.');
