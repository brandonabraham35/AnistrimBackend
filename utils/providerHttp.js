const axios = require('axios');

async function request(config, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await axios({ timeout: Number(process.env.PROVIDER_TIMEOUT_MS) || 8000, ...config });
    } catch (error) {
      lastError = error;
      const retryable = !error.response || error.response.status >= 500 || error.response.status === 429;
      if (!retryable || attempt === retries) break;
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

module.exports = { request };
