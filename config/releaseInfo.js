// config/releaseInfo.js — safe release identification.
//
// Exposes a non-sensitive release identifier (git commit SHA, package version,
// deployment version, environment) for liveness/readiness and diagnostics.
// NEVER exposes secrets or internal environment details.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function getGitCommit() {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    // eslint-disable-next-line global-require
    const { execSync } = require('child_process');
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: ROOT }).trim() || null;
  } catch (e) {
    return null;
  }
}

function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch (e) {
    return null;
  }
}

/**
 * Build a safe release descriptor. Only non-secret identifiers are included.
 * @returns {{commit: string|null, version: string|null, deployVersion: string|null, environment: string}}
 */
function getReleaseInfo() {
  return {
    commit: getGitCommit(),
    version: getVersion(),
    deployVersion: process.env.DEPLOY_VERSION || null,
    environment: process.env.NODE_ENV || 'development',
  };
}

module.exports = { getReleaseInfo, getGitCommit, getVersion };
