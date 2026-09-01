// test/setup.js — Test environment bootstrap
// Loaded via Node's --require flag before any test file runs.
// Ensures Postmark test mode is active so test-triggered signup
// emails never reach the production Postmark server.
process.env.POSTMARK_TEST_MODE = 'true';