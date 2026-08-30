/**
 * scripts/capacitor-preflight.js - Preflight gate for `npm run cap:sync`.
 *
 * Enforces that native platform bundles (Android + iOS) are in sync with
 * Frontend/ before allowing `cap copy` + `cap sync` to proceed.
 *
 * This is a buildless vanilla-JS app: `Frontend/` IS the production output.
 * The "build" step is a no-op, but we still refuse to sync when:
 *   1. The webDir is missing or incomplete.
 *   2. The native bundles have drifted from Frontend/ (stale content).
 *
 * Drift detection compares Frontend/ against:
 *   - android/app/src/main/assets/public/
 *   - ios/App/App/public/
 *
 * Known native-only generated files (cordova.js, cordova_plugins.js, etc.)
 * are ignored during drift detection so they do not produce false positives.
 *
 * Exit codes:
 *   0  -> OK, safe to run `cap copy && cap sync` for both platforms.
 *   1  -> webDir missing / incomplete / drift detected - abort loudly.
 */

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var WEB_DIR = process.env.CAPACITOR_WEB_DIR || "Frontend";
var webDirPath = path.join(ROOT, WEB_DIR);

var NATIVE_BUNDLES = [
  { name: "Android", path: path.join(ROOT, "android", "app", "src", "main", "assets", "public") },
  { name: "iOS",     path: path.join(ROOT, "ios", "App", "App", "public") },
];

var REQUIRED_FILES = [
  "index.html", "admin.html", "config.js", "scrpt.js",
  "shared/client-contract/session.js",
];

var NATIVE_ONLY_FILES = new Set([
  "cordova.js",
  "cordova_plugins.js",
  "capacitor.js",
  "capacitor_plugins.js",
]);

var failed = false;
var warnings = 0;
var platformDrift = {};

function fail(msg) {
  console.error("\u274c [capacitor-preflight] " + msg);
  failed = true;
}

function warn(msg) {
  console.warn("\u26a0\ufe0f  [capacitor-preflight] " + msg);
  warnings++;
}

function getFilesRecursive(rootDir, prefix) {
  var results = [];
  var entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    return results;
  }
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var relativePath = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      results.push.apply(results, getFilesRecursive(path.join(rootDir, entry.name), relativePath));
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }
  return results;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return "";
  }
}


// ---- 1. webDir must exist. ----
if (!fs.existsSync(webDirPath)) {
  fail('webDir "' + WEB_DIR + '" does not exist at ' + webDirPath + '. Nothing to sync.');
} else {
  for (var i = 0; i < REQUIRED_FILES.length; i++) {
    var f = REQUIRED_FILES[i];
    if (!fs.existsSync(path.join(webDirPath, f))) {
      fail('Required file "' + WEB_DIR + '/' + f + '" is missing. The native bundle would be incomplete.');
    }
  }
  try {
    var entries = fs.readdirSync(webDirPath);
    if (entries.length === 0) {
      fail('webDir "' + WEB_DIR + '" is empty. Nothing to sync.');
    }
  } catch (err) {
    fail('Could not read webDir "' + WEB_DIR + '": ' + err.message);
  }
}

// ---- 2. Drift detection: compare Frontend/ against each native bundle. ----
if (!failed) {
  var sourceFiles = getFilesRecursive(webDirPath, '');
  var sourceFileSet = new Set(sourceFiles);

  for (var bi = 0; bi < NATIVE_BUNDLES.length; bi++) {
    var bundle = NATIVE_BUNDLES[bi];

    if (!fs.existsSync(bundle.path)) {
      console.log('   [drift] ' + bundle.name + ' bundle not present yet (will be created by cap copy).');
      continue;
    }

    var bundleFiles = getFilesRecursive(bundle.path, '');
    var bundleFileSet = new Set(bundleFiles);
    var drift = [];

    // Files missing from native bundle
    for (var si = 0; si < sourceFiles.length; si++) {
      var sf = sourceFiles[si];
      if (NATIVE_ONLY_FILES.has(sf)) continue;
      if (!bundleFileSet.has(sf)) {
        drift.push({ file: sf, issue: 'missing from ' + bundle.name });
      }
    }

    // Files whose content differs
    for (var si = 0; si < sourceFiles.length; si++) {
      var sf = sourceFiles[si];
      if (NATIVE_ONLY_FILES.has(sf)) continue;
      if (bundleFileSet.has(sf)) {
        var srcContent = readFileSafe(path.join(webDirPath, sf));
        var bdlContent = readFileSafe(path.join(bundle.path, sf));
        if (srcContent !== bdlContent) {
          drift.push({ file: sf, issue: 'content differs in ' + bundle.name });
        }
      }
    }

    // Orphaned files in bundle (not in Frontend/)
    for (var bj = 0; bj < bundleFiles.length; bj++) {
      var bf = bundleFiles[bj];
      if (NATIVE_ONLY_FILES.has(bf)) continue;
      if (!sourceFileSet.has(bf)) {
        drift.push({ file: bf, issue: 'orphaned in ' + bundle.name + ' (not in Frontend/)' });
      }
    }

    if (drift.length > 0) {
      platformDrift[bundle.name] = drift;
    } else {
      console.log('\u2705 [drift] ' + bundle.name + ' bundle is in sync with Frontend/.');
    }
  }
}

// ---- 3. Report consolidated failure if drift detected. ----
var platformNames = Object.keys(platformDrift);
if (platformNames.length > 0) {
  fail('Native mobile bundle is out of sync with Frontend/.');
  console.error('');
  for (var pi = 0; pi < platformNames.length; pi++) {
    var plat = platformNames[pi];
    var d = platformDrift[plat];
    fail('  ' + plat + ' drift detected (' + d.length + ' file(s)):');
    for (var di = 0; di < Math.min(d.length, 20); di++) {
      fail('    - ' + d[di].file + ' (' + d[di].issue + ')');
    }
    if (d.length > 20) {
      fail('    ... and ' + (d.length - 20) + ' more file(s).');
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
console.log('\u2705 [capacitor-preflight] OK \u2014 webDir "' + WEB_DIR + '" is valid and in sync with all native bundles.');
if (warnings > 0) {
  console.log('   ' + warnings + ' warning(s) \u2014 review above.');
}
console.log('   Proceeding with: cap copy android / cap sync android / cap copy ios / cap sync ios');
process.exit(0);
