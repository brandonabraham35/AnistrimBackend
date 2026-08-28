/**
 * scripts/capacitor-preflight.js — Preflight gate for `npm run cap:sync`.
 *
 * Enforces the "build → cap copy → cap sync" ordering that Defect 2 requires,
 * adapted to this buildless vanilla-JS app. There is no bundler here: the
 * `Frontend/` directory IS the production output that Capacitor copies into the
 * native bundle. So the build step is a no-op, but we still refuse to sync when
 * the webDir is missing or when it would ship stale content that lacks the
 * admin dashboard file the unified admin must be reachable from.
 *
 * Exit codes:
 *   0  → OK, safe to run `cap copy` + `cap sync`.
 *   1  → webDir missing / incomplete — abort loudly.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB_DIR = process.env.CAPACITOR_WEB_DIR || 'Frontend';
const webDirPath = path.join(ROOT, WEB_DIR);

// Files that MUST exist in the webDir before we sync. If any is missing, the
// native bundle would be broken (e.g. the unified admin dashboard absent).
const REQUIRED_FILES = [
  'index.html', 'admin.html', 'config.js', 'scrpt.js',
  'shared/client-contract/session.js',
];

let failed = false;

function fail(msg) {
  console.error('\u274c [capacitor-preflight] ' + msg);
  failed = true;
}

// 1. webDir must exist.
if (!fs.existsSync(webDirPath)) {
  fail(`webDir "${WEB_DIR}" does not exist at ${webDirPath}. Nothing to sync.`);
} else {
  // 2. Required entry files must exist (a missing admin.html is exactly the
  //    bug that shipped an admin dashboard that couldn't be reached).
  for (const f of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(webDirPath, f))) {
      fail(`Required file "${WEB_DIR}/${f}" is missing. The native bundle would be incomplete.`);
    }
  }

  // 3. Non-empty (an empty webDir would copy a shell with no content).
  try {
    const entries = fs.readdirSync(webDirPath);
    if (entries.length === 0) {
      fail(`webDir "${WEB_DIR}" is empty. Nothing to sync.`);
    }
  } catch (err) {
    fail(`Could not read webDir "${WEB_DIR}": ${err.message}`);
  }
}

if (failed) {
  console.error('\u26d4  [capacitor-preflight] Aborting cap sync. Fix the webDir and re-run:');
  console.error('    npm run cap:sync');
  process.exit(1);
}

console.log('\u2705 [capacitor-preflight] OK — webDir "' + WEB_DIR + '" is valid and complete.');
console.log('   Proceeding with: cap copy android && cap sync android');
process.exit(0);