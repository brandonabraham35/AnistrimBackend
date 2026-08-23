// test/mailer.test.js — Postmark mailer unit tests
//
// Tests the mailer module's behavior under various configurations without
// sending real emails. Mocks fetch() to simulate Postmark API responses.
const assert = require('assert');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');

// ── Helpers ──────────────────────────────────────────────────────

// Store original env so we can restore after each test.
const ORIGINAL_ENV = { ...process.env };

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined || v === null) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function resetEnv() {
  // Clear all Postmark-related vars
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('POSTMARK_') || k.startsWith('MAILGUN_') || k === 'NODE_ENV') {
      delete process.env[k];
    }
  }
  // Restore originals
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (k.startsWith('POSTMARK_') || k.startsWith('MAILGUN_') || k === 'NODE_ENV') {
      process.env[k] = v;
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe('mailer (Postmark)', () => {
  let mailer;
  let originalFetch;

  before(() => {
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    // Reload mailer fresh for each test
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');
  });

  afterEach(() => {
    resetEnv();
    global.fetch = originalFetch;
  });

  // ── 1. postmarkConfigured ──────────────────────────────────────

  it('postmarkConfigured returns true when token and from email are set', () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'real-token-abc123',
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');
    assert.strictEqual(mailer.postmarkConfigured(), true);
  });

  it('postmarkConfigured returns false when token is missing', () => {
    setEnv({
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');
    assert.strictEqual(mailer.postmarkConfigured(), false);
  });

  it('postmarkConfigured returns false when from email is missing', () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'real-token-abc123',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');
    assert.strictEqual(mailer.postmarkConfigured(), false);
  });

  it('postmarkConfigured returns false for placeholder token values', () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'your-postmark-server-token',
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');
    assert.strictEqual(mailer.postmarkConfigured(), false);
  });

  // ── 2. Production: not configured → throws ────────────────────

  it('sendEmail throws in production when Postmark is not configured', async () => {
    setEnv({
      NODE_ENV: 'production',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    await assert.rejects(
      () => mailer.sendEmail('test@example.com', 'Subject', '<p>Body</p>'),
      /Postmark is not configured/
    );
  });

  // ── 3. Development: not configured → dev console fallback ─────

  it('sendEmail returns dev-console messageId in development when not configured', async () => {
    setEnv({
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    const result = await mailer.sendEmail('test@example.com', 'Subject', '<p>Body</p>', '123456');
    assert.strictEqual(result.messageId, 'dev-console');
  });

  // ── 4. Successful Postmark send ────────────────────────────────

  it('sendEmail returns messageId on successful Postmark API call', async () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'real-token-abc123',
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    // Mock fetch to return a successful Postmark response
    global.fetch = async (url, options) => {
      assert.strictEqual(url, 'https://api.postmarkapp.com/email');
      assert.strictEqual(options.method, 'POST');
      assert.strictEqual(options.headers['X-Postmark-Server-Token'], 'real-token-abc123');
      assert.strictEqual(options.headers['Content-Type'], 'application/json');

      const body = JSON.parse(options.body);
      assert.strictEqual(body.From, 'AniStrim <admin@anistrim.com>');
      assert.strictEqual(body.To, 'test@example.com');
      assert.strictEqual(body.Subject, 'Test Subject');
      assert.ok(body.HtmlBody.includes('Test HTML'));
      assert.strictEqual(body.MessageStream, 'outbound');

      return {
        ok: true,
        status: 200,
        json: async () => ({ MessageID: 'postmark-message-id-123', ErrorCode: 0, Message: 'OK' }),
      };
    };

    const result = await mailer.sendEmail('test@example.com', 'Test Subject', '<p>Test HTML</p>');
    assert.strictEqual(result.messageId, 'postmark-message-id-123');
  });

  // ── 5. Postmark API failure ────────────────────────────────────

  it('sendEmail throws on Postmark API error response', async () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'real-token-abc123',
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    global.fetch = async () => {
      return {
        ok: false,
        status: 422,
        json: async () => ({ Message: 'Invalid email address', ErrorCode: 300 }),
      };
    };

    await assert.rejects(
      () => mailer.sendEmail('bad-email', 'Subject', '<p>Body</p>'),
      /Postmark send failed/
    );
  });

  // ── 6. Timeout ─────────────────────────────────────────────────

  it('sendEmail throws on timeout', async () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'real-token-abc123',
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      POSTMARK_TIMEOUT_MS: '100',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    // Mock fetch to never resolve (simulate timeout)
    global.fetch = async () => {
      return new Promise(() => {}); // never resolves
    };

    await assert.rejects(
      () => mailer.sendEmail('test@example.com', 'Subject', '<p>Body</p>'),
      /Postmark request timed out/
    );
  });

  // ── 7. OTP text generation ─────────────────────────────────────

  it('sendEmail includes OTP text when otpCode is provided', async () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'real-token-abc123',
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(body.TextBody.includes('Your AniStrim verification code is: 123456'));
      assert.ok(body.TextBody.includes('expires in 15 minutes'));
      return {
        ok: true,
        status: 200,
        json: async () => ({ MessageID: 'msg-1', ErrorCode: 0, Message: 'OK' }),
      };
    };

    await mailer.sendEmail('test@example.com', 'Subject', '<p>Body</p>', '123456');
  });

  // ── 8. smtpConfigured legacy compatibility ─────────────────────

  it('smtpConfigured returns false (legacy compatibility)', () => {
    assert.strictEqual(mailer.smtpConfigured(), false);
  });

  // ── 9. verifyTransport ─────────────────────────────────────────

  it('verifyTransport returns true when Postmark is configured', async () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'real-token-abc123',
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    const result = await mailer.verifyTransport(false);
    assert.strictEqual(result, true);
  });

  it('verifyTransport returns false when Postmark is not configured (exitOnFailure=false)', async () => {
    setEnv({ NODE_ENV: 'development' });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    const result = await mailer.verifyTransport(false);
    assert.strictEqual(result, false);
  });

  it('verifyTransport throws when Postmark is not configured (exitOnFailure=true)', async () => {
    setEnv({ NODE_ENV: 'development' });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    await assert.rejects(
      () => mailer.verifyTransport(true),
      /POSTMARK_SERVER_TOKEN/
    );
  });

  // ── 10. getTransporter legacy compatibility ────────────────────

  it('getTransporter throws (legacy compatibility)', () => {
    assert.throws(
      () => mailer.getTransporter(),
      /SMTP has been removed/
    );
  });

  // ── 11. MessageStream default ──────────────────────────────────

  it('sendEmail uses outbound message stream by default', async () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'real-token-abc123',
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      assert.strictEqual(body.MessageStream, 'outbound');
      return {
        ok: true,
        status: 200,
        json: async () => ({ MessageID: 'msg-1', ErrorCode: 0, Message: 'OK' }),
      };
    };

    await mailer.sendEmail('test@example.com', 'Subject', '<p>Body</p>');
  });

  it('sendEmail uses custom message stream when configured', async () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'real-token-abc123',
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      POSTMARK_MESSAGE_STREAM: 'transactional',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      assert.strictEqual(body.MessageStream, 'transactional');
      return {
        ok: true,
        status: 200,
        json: async () => ({ MessageID: 'msg-1', ErrorCode: 0, Message: 'OK' }),
      };
    };

    await mailer.sendEmail('test@example.com', 'Subject', '<p>Body</p>');
  });

  // ── 12. From address defaults ──────────────────────────────────

  it('sendEmail uses default from address when env vars are not set', async () => {
    setEnv({
      POSTMARK_SERVER_TOKEN: 'real-token-abc123',
      POSTMARK_FROM_EMAIL: 'admin@anistrim.com',
      NODE_ENV: 'development',
    });
    delete require.cache[require.resolve('../utils/mailer')];
    mailer = require('../utils/mailer');

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      assert.strictEqual(body.From, 'AniStrim <admin@anistrim.com>');
      return {
        ok: true,
        status: 200,
        json: async () => ({ MessageID: 'msg-1', ErrorCode: 0, Message: 'OK' }),
      };
    };

    await mailer.sendEmail('test@example.com', 'Subject', '<p>Body</p>');
  });
});