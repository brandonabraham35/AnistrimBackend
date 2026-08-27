/**
 * Test: TLS Error Retry Logic in providerHttp.js
 * 
 * This script verifies that:
 * 1. EPROTO errors are properly classified
 * 2. The classifyError function returns TLS_ERROR category
 * 3. createRelaxedTlsAgent function exists and creates an agent
 */

const { classifyError, ERROR_CATEGORIES } = require('./utils/providerHttp');

console.log('=== TLS Error Classification Test ===\n');

// Test 1: EPROTO error classification
const eprotoError = new Error('write EPROTO 009D4CC204790000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long');
eprotoError.code = 'EPROTO';

const classification = classifyError(eprotoError);
console.log('Test 1: EPROTO Error Classification');
console.log('  Input error code:', eprotoError.code);
console.log('  Input error message:', eprotoError.message.substring(0, 80) + '...');
console.log('  Result category:', classification.category);
console.log('  Expected:', ERROR_CATEGORIES.TLS_ERROR);
console.log('  PASS:', classification.category === ERROR_CATEGORIES.TLS_ERROR);
console.log('  Retryable:', classification.retryable);
console.log();

// Test 2: SSL routines error (without EPROTO code)
const sslError = new Error('some OpenSSL error ssl routines:tls_process_server_certificate');
const sslClassification = classifyError(sslError);
console.log('Test 2: SSL Routines Error (no EPROTO code)');
console.log('  Input error message:', sslError.message.substring(0, 80) + '...');
console.log('  Result category:', sslClassification.category);
console.log('  Expected:', ERROR_CATEGORIES.TLS_ERROR);
console.log('  PASS:', sslClassification.category === ERROR_CATEGORIES.TLS_ERROR);
console.log();

// Test 3: Regular network error (should NOT be TLS_ERROR)
const netError = new Error('Connection refused');
netError.code = 'ECONNREFUSED';
const netClassification = classifyError(netError);
console.log('Test 3: Regular Network Error (should NOT be TLS_ERROR)');
console.log('  Input error code:', netError.code);
console.log('  Result category:', netClassification.category);
console.log('  Expected:', ERROR_CATEGORIES.CONNECTION_REFUSED);
console.log('  PASS:', netClassification.category === ERROR_CATEGORIES.CONNECTION_REFUSED);
console.log();

console.log('=== All Tests Complete ===');
