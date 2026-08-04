# TODO — Provider Execution Pipeline Redesign (Sequential → Partial Parallel)

## Objective

Audit the provider execution pipeline and redesign it from sequential to partial-parallel,
preserving the exact API response format and frontend expectations.

## Steps

- [x] 1. Audit current pipeline (read streamingService, providerRegistry, consumetProvider, providerHttp, streamingHttp, logger, streamController, watch.js)
- [x] 2. Confirm current execution mode = SEQUENTIAL
- [x] 3. Identify bugs: `allSources` vs `sources` mismatch; no global pipeline deadline
- [x] 4. Get plan approval from user
- [x] 5. Add `normalizeProviderResult()` helper to map `allSources` → `sources` (fix Consumet sub-provider bug)
- [x] 6. Add a global `PIPELINE_TIMEOUT_MS` deadline
- [x] 7. Refactor `executeWithRetry` → `executeProvider` to be concurrency-safe and collect structured logs
- [x] 8. Add `executeProvidersInParallel()` — parallel race across providers, returns first success
- [x] 9. Rewrite `resolveStream()` → try preferred/first provider first, then parallel race; clean error on total failure
- [x] 10. Rewrite `resolveAllProviders()` → parallel execution, same `providers[]` array shape
- [x] 11. Add structured error handling for Cloudflare, timeout, provider unavailable, empty search, missing episode, invalid stream
- [x] 12. Syntax-check the updated file (node --check → exit 0)
- [x] 13. Verify no frontend/controller changes required (compatibility preserved)
- [ ] 14. Deliver execution flow diagram + explanation + performance comparison
