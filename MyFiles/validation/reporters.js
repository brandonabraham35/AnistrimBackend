'use strict';

/**
 * validation/reporters.js
 *
 * Report writing helpers for the Nightly Validation Suite.
 *
 * LAYOUT
 *   reports/
 *     <YYYY-MM-DD>/            <- date-stamped run
 *     latest/                  <- symlink/copy of the newest run
 *
 * Each validator writes a JSON artifact (e.g. stream-validation.json) into the
 * active run directory. readify() aggregates those into a single Markdown file.
 */

const fs = require('fs');
const path = require('path');

const REPORTS_ROOT = path.join(__dirname, '..', 'reports');

function todayStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve/create the active run directory for a given run id.
 * @param {string} [runId] - e.g. '2026-08-04'; defaults to today
 * @returns {string} absolute path to the run directory
 */
function resolveRunDir(runId) {
  const stamp = runId || todayStamp();
  const dir = path.join(REPORTS_ROOT, stamp);
  ensureDir(dir);
  return dir;
}

/**
 * Write a JSON artifact into the active run directory.
 * @param {string} name    - filename without extension, e.g. 'stream-validation'
 * @param {object} data    - serializable payload
 * @param {string} [runId] - run directory id
 * @returns {string} absolute path written
 */
function writeJson(name, data, runId) {
  const dir = resolveRunDir(runId);
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/**
 * Write a Markdown report into the active run directory and mirror it to latest/.
 * @param {string} name    - filename without extension
 * @param {string} content - markdown body
 * @param {string} [runId] - run directory id
 * @returns {string} absolute path written
 */
function writeMarkdown(name, content, runId) {
  const dir = resolveRunDir(runId);
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, content);

  // Mirror into latest/ so consumers have a stable path.
  const latest = ensureDir(path.join(REPORTS_ROOT, 'latest'));
  fs.writeFileSync(path.join(latest, `${name}.md`), content);
  return file;
}

/**
 * Read a JSON artifact from a run directory (or latest/).
 * @param {string} name - filename without extension
 * @param {string} [runId] - run directory id; if omitted uses latest/
 * @returns {object|null}
 */
function readJson(name, runId) {
  const dir = runId ? resolveRunDir(runId) : ensureDir(path.join(REPORTS_ROOT, 'latest'));
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * List all run directories (date-stamped) sorted oldest -> newest.
 * @returns {Array<string>} run ids
 */
function listRuns() {
  if (!fs.existsSync(REPORTS_ROOT)) return [];
  return fs.readdirSync(REPORTS_ROOT)
    .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort();
}

/**
 * Read the previous run's JSON artifact for trend comparison.
 * @param {string} name     - artifact base name
 * @param {string} [currentRunId]
 * @returns {object|null} previous artifact or null
 */
function readPreviousJson(name, currentRunId) {
  const runs = listRuns().filter(r => r !== currentRunId);
  if (!runs.length) return null;
  const prev = runs[runs.length - 1];
  return readJson(name, prev);
}

module.exports = {
  REPORTS_ROOT,
  todayStamp,
  resolveRunDir,
  writeJson,
  writeMarkdown,
  readJson,
  readPreviousJson,
  listRuns,
  ensureDir,
};
