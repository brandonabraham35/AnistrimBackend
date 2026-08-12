'use strict';
// Waits until subtitle-proof-data.json / embedded-subtitle-proof.md are regenerated
// (i.e. the running _subtitle_runtime_proof.js completes) or the node process exits.
const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, 'subtitle-proof-data.json');
const mdFile = path.join(__dirname, 'embedded-subtitle-proof.md');

function statTime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

const startDataTime = statTime(dataFile);
const startMdTime = statTime(mdFile);
const deadline = Date.now() + 25 * 60 * 1000; // 25 min
const intervalMs = 15000;

function nodeRunning() {
  // crude: check via tasklist for node.exe
  try {
    const out = require('child_process').execSync('tasklist /FI "IMAGENAME eq node.exe"', { encoding: 'utf8' });
    return /node\.exe/i.test(out);
  } catch { return true; }
}

const timer = setInterval(() => {
  const now = Date.now();
  const curData = statTime(dataFile);
  const curMd = statTime(mdFile);
  const dataRegen = curData > startDataTime + 1000;
  const mdRegen = curMd > startMdTime + 1000;

  if (dataRegen && mdRegen) {
    clearInterval(timer);
    console.log('PROOF_FILES_REGENERATED');
    process.exit(0);
  }
  if (!nodeRunning()) {
    clearInterval(timer);
    console.log('NODE_PROCESS_EXITED');
    process.exit(0);
  }
  if (now > deadline) {
    clearInterval(timer);
    console.log('TIMEOUT_WAITING');
    process.exit(1);
  }
}, intervalMs);

console.log('Waiting for proof run to complete...');
