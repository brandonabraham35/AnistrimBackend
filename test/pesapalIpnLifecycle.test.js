const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

function loadService() {
  delete require.cache[require.resolve('../services/pesapalService')];
  return require('../services/pesapalService');
}

async function withoutConfiguredIpn(run) {
  const original = process.env.PESAPAL_IPN_ID;
  // dotenv does not override an existing empty value, so this also prevents a
  // developer's local .env from changing the test case at module load time.
  process.env.PESAPAL_IPN_ID = '';
  try {
    await run();
  } finally {
    if (original === undefined) delete process.env.PESAPAL_IPN_ID;
    else process.env.PESAPAL_IPN_ID = original;
  }
}

test('registerIPN always reuses the configured ID', async () => {
  const original = process.env.PESAPAL_IPN_ID;
  const originalPost = axios.post;
  process.env.PESAPAL_IPN_ID = 'configured-ipn-id';
  axios.post = async () => { throw new Error('registration must not be called'); };
  try {
    const pesapal = loadService();
    assert.equal(await pesapal.registerIPN('token', 'https://example.test/ipn'), 'configured-ipn-id');
  } finally {
    axios.post = originalPost;
    if (original === undefined) delete process.env.PESAPAL_IPN_ID;
    else process.env.PESAPAL_IPN_ID = original;
  }
});

test('registerIPN caches a successful registration and shares concurrent work', async () => {
  await withoutConfiguredIpn(async () => {
    const originalPost = axios.post;
    let calls = 0;
    axios.post = async () => {
      calls += 1;
      return { data: { ipn_id: 'process-cached-ipn-id' } };
    };
    try {
      const pesapal = loadService();
      const ids = await Promise.all([
        pesapal.registerIPN('token-a', 'https://example.test/ipn'),
        pesapal.registerIPN('token-b', 'https://example.test/ipn'),
        pesapal.registerIPN('token-c', 'https://example.test/ipn'),
      ]);
      assert.deepEqual(ids, ['process-cached-ipn-id', 'process-cached-ipn-id', 'process-cached-ipn-id']);
      assert.equal(calls, 1, 'concurrent checkouts must perform one registration');
      assert.equal(await pesapal.registerIPN('token-d', 'https://example.test/ipn'), 'process-cached-ipn-id');
      assert.equal(calls, 1, 'later checkouts must use the process cache');
    } finally {
      axios.post = originalPost;
    }
  });
});

test('an unknown IPN conflict reports the configuration action instead of retrying', async () => {
  await withoutConfiguredIpn(async () => {
    const originalPost = axios.post;
    axios.post = async () => {
      const error = new Error('conflict');
      error.response = { status: 409, data: { message: 'The URL already exists' } };
      throw error;
    };
    try {
      const pesapal = loadService();
      await assert.rejects(
        pesapal.registerIPN('token', 'https://example.test/ipn'),
        error => error.code === 'PESAPAL_IPN_CONFLICT' && /PESAPAL_IPN_ID/.test(error.message)
      );
    } finally {
      axios.post = originalPost;
    }
  });
});
