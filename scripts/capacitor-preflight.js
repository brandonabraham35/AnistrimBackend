/**
 * scripts/capacitor-preflight.js — Preflight gate for `npm run cap:sync`.
 *
 * Enforces the "build → cap copy → cap sync" ordering that Defect 2 requires,
 * adapted to this buildless vanilla-JS app. There is no bundler here: the
 * `Frontend/` directory IS the production output that Capacitor copies into the
 * native bundle. So the build step is a no-op, but we still refuse to sync when:
 *   1. The webDir is missing or incomplete.
 *   2. The native bundles have drifted from Frontend/ (stale content).
 *
 * Drift detection compares Frontend/ against:
 *   - android/app/src/main/assets/public/
 *   - ios/App/App/public/
 *
 * Native-only generated files (cordova.js, cordova_plugins.js, capacitor.js,
 * capacitor_plugins.js) are ignored during drift detection.
 *
 * Exit codes:
 *   0  → OK, safe to run `cap copy` + `cap sync`.
 *   1  → webDir missing / incomplete / drift detected — abort loudly.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB_DIR = process.env.CAPACITOR_WEB_DIR || 'Frontend';
const webDirPath = path.join(ROOT, WEB_DIR);

// Native bundle public directories to check for drift.
const NATIVE_BUNDLES = [
  { name: 'Android', path: path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public') },
  { name: 'iOS', path: path.join(ROOT, 'ios', 'App', 'App', 'public') },
];

// Files that MUST exist in the webDir before we sync. If any is missing, the
// native bundle would be broken (e.g. the unified admin dashboard absent).
const REQUIRED_FILES = [
  'index.html', 'admin.html', 'config.js', 'scrpt.js',
  'shared/client-contract/session.js',
];

// Native-only generated files that Capacitor injects. These will differ between
// Frontend/ and the native bundles and must be ignored during drift detection.
const NATIVE_ONLY_FILES = new Set([
  'cordova.js',
  'cordova_plugins.js',
  'capacitor.js',
  'capacitor_plugins.js',
]);

let failed = false;
let warnings = 0;

function fail(msg) {
  console.error('\u274c [capacitor-preflight] ' + msg);
  failed = true;
}

function warn(msg) {
  console.warn('\u26a0\ufe0f  [capacitor-preflight] ' + msg);
  warnings++;
}

// Recursively get all files relative to a root directory.
function getFilesRecursive(rootDir, prefix) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    const relativePath = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      results.push(...getFilesRecursive(fullPath, relativePath));
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }
  return results;
}

// Read file content safely (returns empty string on error).
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return '';
  }
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

// 4. Drift detection — compare Frontend/ against each native bundle.
//    Only runs if webDir is valid (no point checking drift if source is broken).
if (!failed) {
  const sourceFiles = getFilesRecursive(webDirPath, '');
  const sourceFileSet = new Set(sourceFiles);

  for (const bundle of NATIVE_BUNDLES) {
    if (!fs.existsSync(bundle.path)) {
      // Bundle directory doesn't exist yet — cap copy will create it.
      // Not a failure, just informational.
      console.log('   [drift] ' + bundle.name + ' bundle not present yet (will be created by cap copy).');
      continue;
    }

    const bundleFiles = getFilesRecursive(bundle.path, '');
    const bundleFileSet = new Set(bundleFiles);

    const drift = [];

    // Files missing from native bundle (exist in Frontend/ but not in bundle).
    for (const f of sourceFiles) {
      if (NATIVE_ONLY_FILES.has(f)) continue; // Skip native-only files
      if (!bundleFileSet.has(f)) {
        drift.push({ file: f, issue: 'missing from ' + bundle.name });
      }
    }

    // Files that differ in content (exist in both but content differs).
    for (const f of sourceFiles) {
      if (NATIVE_ONLY_FILES.has(f)) continue; // Skip native-only files
      if (bundleFileSet.has(f)) {
        const sourceContent = readFileSafe(path.join(webDirPath, f));
        const bundleContent = readFileSafe(path.join(bundle.path, f));
        if (sourceContent !== bundleContent) {
          drift.push({ file: f, issue: 'content differs in ' + bundle.name });
        }
      }
    }

    // Files in bundle that don't exist in Frontend/ (orphaned — except native-only).
    for (const f of bundleFiles) {
      if (NATIVE_ONLY_FILES.has(f)) continue; // Skip native-only files
      if (!sourceFileSet.has(f)) {
        drift.push({ file: f, issue: 'orphaned in ' + bundle.name + ' (not in Frontend/)' });
      }
    }

    if (drift.length > 0) {
      fail('Native mobile bundle is out of sync with Frontend/.');
      fail('  ' + bundle.name + ' drift detected (' + drift.length + ' file(s)):');
      for (const d of drift.slice(0, 20)) {
        fail('    - ' + d.file + ' (' + d.issue + ')');
      }
      if (drift.length > 20) {
        fail('    ... and ' + (drift.length - 20) + ' more file(s).');
      }
    } else {
      console.log('\u2705 [drift] ' + bundle.name + ' bundle is in sync with Frontend/.');
    }
  }
}

if (failed) {
  console.error('');
  console.error('\u26d4  [capacitor-preflight] Aborting cap sync. Fix the drift and re-run:');
  console.error('    npm run cap:sync');
  console.error('');
  console.error('   To force sync without drift check (not recommended):');
  console.error('    npm run cap:sync:force');
  process.exit(1);
}

console.log('');
console.log('\u2705 [capacitor-preflight] OK — webDir "' + WEB_DIR + '" is valid and complete.');
if (warnings > 0) {
  console.log('   ' + warnings + ' warning(s) — review above.');
}
console.log('   Proceeding with: cap copy && cap sync (Android + iOS)');
process.exit(0);