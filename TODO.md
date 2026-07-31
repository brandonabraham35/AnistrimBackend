# Provider Fallback Fix - Implementation Plan

## Files to Modify

1. `services/consumetProvider.js` — Refactor to support per-provider instantiation
2. `services/streamingService.js` — Dynamic resolver pipeline with independent fallback
3. `utils/providerHttp.js` — Better error classification and structured logging

## Implementation Order

- [x] Step 1: Analyze current codebase (completed)
- [x] Step 2: Plan approved by user
- [x] Step 3: Refactor `services/consumetProvider.js`
  - Allow `ConsumetProvider` to accept a `providerName` parameter
  - Create independent axios instances per sub-provider
  - Support `resolveStreamUrl({ provider, title, episode })` signature
- [x] Step 4: Refactor `services/streamingService.js`
  - Build resolver pipeline dynamically from configuration
  - Add per-provider health tracking and retry logic
  - Structured logging with provider name, attempt, proxy, timing, status
  - Ensure loop continues through ALL providers after failures
- [x] Step 5: Update `utils/providerHttp.js`
  - Better error classification with `classifyError()`
  - ERROR_CATEGORIES exported for use by streaming service
- [ ] Step 6: Verify syntax and test
  - Run Node.js syntax validation on modified files
  - Test server startup
  - Verify logs show expected provider execution order
