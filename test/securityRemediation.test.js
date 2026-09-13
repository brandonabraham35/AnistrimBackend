// test/securityRemediation.test.js - regression/security tests for the production
// security remediation pass (TLS, SSRF redirects, uploads, error leakage, CORS,
// payment verification, premium media doc).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---- 1. TLS verification (no insecure downgrade) ----

test('providerHttp has no rejectUnauthorized:false / relaxed TLS fallback', () => {
  const src = read('utils/providerHttp.js');
  assert.doesNotMatch(src, /rejectUnauthorized\s*:\s*false/, 'must never disable certificate verification');
  assert.doesNotMatch(src, /createRelaxedTlsAgent/, 'relaxed-TLS agent must be removed');
  assert.doesNotMatch(src, /relaxed/, 'must not reference a relaxed-TLS path');
  assert.match(src, /followWithGuard\(/, 'provider fetch must route through the redirect guard');
});

// ---- 2. SSRF redirect handling ----

function mockClient(responses) {
  let i = 0;
  return { request: async () => responses[Math.min(i++, responses.length - 1)] };
}

test('redirect to a private/loopback target is blocked (SSRF)', async () => {
  const { followWithGuard } = require(path.join(ROOT, 'utils', 'redirectSafeHttp.js'));
  const client = mockClient([{ status: 302, headers: { location: 'http://127.0.0.1:8080/x' } }]);
  await assert.rejects(
    () => followWithGuard(client, { url: 'https://legit.example/a' }),
    (e) => e.code === 'SSRF_REDIRECT_BLOCKED'
  );
});

test('redirect to a public target is followed safely', async () => {
  const { followWithGuard } = require(path.join(ROOT, 'utils', 'redirectSafeHttp.js'));
  const client = mockClient([
    { status: 302, headers: { location: 'http://8.8.8.8/x' } },
    { status: 200, data: 'ok' },
  ]);
  const ok = await followWithGuard(client, { url: 'https://legit.example/a' });
  assert.strictEqual(ok.data, 'ok');
});

test('redirect loop is capped (too many redirects)', async () => {
  const { followWithGuard } = require(path.join(ROOT, 'utils', 'redirectSafeHttp.js'));
  const hop = { status: 302, headers: { location: 'http://8.8.8.8/x' } };
  const client = mockClient([hop, hop, hop, hop, hop, hop]);
  await assert.rejects(
    () => followWithGuard(client, { url: 'https://legit.example/a' }),
    (e) => e.code === 'TOO_MANY_REDIRECTS'
  );
});

// ---- 3. Upload content validation ----

test('image magic-byte sniffing recognizes real formats and rejects impostors', () => {
  const { sniffImageType } = require(path.join(ROOT, 'utils', 'uploadContent.js'));
  assert.strictEqual(sniffImageType(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg');
  assert.strictEqual(sniffImageType(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])), 'png');
  assert.strictEqual(sniffImageType(Buffer.from('RIFF0000WEBP')), 'webp');
  assert.strictEqual(sniffImageType(Buffer.from('not an image!')), null);
});

test('video magic-byte sniffing recognizes MP4/QuickTime/WebM and rejects impostors', () => {
  const { sniffVideoType } = require(path.join(ROOT, 'utils', 'uploadContent.js'));
  const mp4 = Buffer.alloc(16);
  mp4.write('ftyp', 4, 'ascii');
  assert.strictEqual(sniffVideoType(mp4), 'mp4/quicktime');
  const ebml = Buffer.alloc(16);
  ebml[0] = 0x1A; ebml[1] = 0x45; ebml[2] = 0xDF; ebml[3] = 0xA3;
  assert.strictEqual(sniffVideoType(ebml), 'mkv/webm');
  assert.strictEqual(sniffVideoType(Buffer.alloc(16, 0)), null);
});

test('image upload path validates content server-side; video route cleans up temp files', () => {
  const bu = read('utils/bunnyUpload.js');
  const ur = read('routes/uploadRoutes.js');
  const bc = read('controllers/bunnyStreamController.js');
  assert.match(bu, /sniffImageType/, 'image upload must sniff magic bytes');
  assert.match(ur, /files: 1/, 'video upload must cap the file count');
  assert.match(ur, /sweepVideoTempDir/, 'must sweep abandoned temp files');
  assert.match(bc, /sniffVideoType/, 'video upload must sniff container bytes');
});

// ---- 4. Production error leakage ----

test('controllers do not leak raw error.message to clients', () => {
  for (const f of ['controllers/adminController.js', 'controllers/adminImportController.js', 'controllers/bunnyStreamController.js', 'utils/bunnyUpload.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /res\.status\(5\d\d\)\.json\(\{[^}]*message: error\.message/, `${f} must not return raw error.message in 5xx`);
    assert.doesNotMatch(src, /error: error\.message/, `${f} must not echo raw error.message`);
  }
});

// ---- 5. CORS rejected origins -> 403 (no 500) ----

test('CORS blocked origin yields allow=false (no throw / no 500)', () => {
  const corsConfig = require(path.join(ROOT, 'config', 'cors.js'));
  const rollback = { NODE_ENV: process.env.NODE_ENV, API_ALLOWED_ORIGINS: process.env.API_ALLOWED_ORIGINS };
  process.env.NODE_ENV = 'production';
  process.env.API_ALLOWED_ORIGINS = '';
  try {
    const options = corsConfig.buildCorsOptions();
    options.origin('https://evil.example.com', (err, allow) => {
      assert.strictEqual(err, null);
      assert.strictEqual(allow, false);
    });
  } finally {
    process.env.NODE_ENV = rollback.NODE_ENV;
    process.env.API_ALLOWED_ORIGINS = rollback.API_ALLOWED_ORIGINS;
  }
});

// ---- 6. Payment verification (finite / required fields) ----

test('completed IPN payments require finite amount, matching currency and merchant reference', () => {
  const src = read('controllers/paymentController.js');
  assert.match(src, /Number\.isFinite\(txnAmount\)/, 'amount must be finite');
  assert.match(src, /amountValid/, 'must validate amount');
  assert.match(src, /currencyValid/, 'must validate currency');
  assert.match(src, /merchantRefValid = txnStatus\.merchant_reference === OrderMerchantReference/, 'must require merchant reference');
  assert.match(src, /Completed payment missing\/invalid amount/, 'must fail closed on incomplete financial data');
});

// ---- 7. Premium media URL risk is documented ----

test('premium media URL risk is documented for the product decision', () => {
  const doc = read('docs/security-remediation.md');
  assert.match(doc, /Premium media URLs/, 'must document the premium media URL risk');
  assert.match(doc, /signed delivery/, 'must document the signed/private delivery option');
});
