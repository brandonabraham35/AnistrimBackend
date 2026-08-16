'use strict';

const logger = require('../utils/logger');
const { provider } = require('../services/animeHeavenProvider');

const counters = { info: 0, warn: 0, stream: 0, error: 0, debug: 0 };
for (const k of Object.keys(counters)) {
  if (typeof logger[k] === 'function') {
    logger[k] = (...args) => {
      counters[k] += 1;
      return undefined;
    };
  }
}

async function run() {
  const before = provider.getHealthSnapshot();
  await provider.extractStreams({ title: 'A Condition Called Love', identifier: 'u95rf', episode: 1 });
  await provider.extractStreams({ title: 'A Couple of Cuckoos', identifier: 'xqjzb', episode: 1 });
  const after = provider.getHealthSnapshot();

  const requiredFields = [
    'provider',
    'successRate',
    'avgResponseMs',
    'timeouts',
    'cloudflareHits',
    'streamExtractionSuccess',
    'failures',
    'httpFailures',
    'redirectLoops',
    'mirrorFailures',
    'playerFailures',
    'subtitleSuccess',
    'streamSuccess',
  ];

  const fieldPresence = {};
  for (const f of requiredFields) fieldPresence[f] = Object.prototype.hasOwnProperty.call(after, f);

  const out = {
    generatedAt: new Date().toISOString(),
    before,
    after,
    loggerCounters: counters,
    healthSnapshotFieldsPresent: fieldPresence,
    healthSnapshotAllFieldsPresent: Object.values(fieldPresence).every(Boolean),
    loggingObserved: (counters.info + counters.warn + counters.stream + counters.error + counters.debug) > 0,
  };

  console.log(JSON.stringify(out));
}

run().catch((err) => {
  console.error('HEALTH_LOGGING_CHECK_FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
