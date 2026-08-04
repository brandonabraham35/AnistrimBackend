# TODO — Provider Health Monitoring (Phase 5)

## Objective

Extend the existing provider health tracking system with richer runtime
statistics and a canonical helper API, while preserving every existing export
and making NO behavioural changes to provider selection, failover order,
retry logic, cooldown logic, request routing, stream resolution, or API
responses. This phase is observations-only.

## Steps

- [x] 1. Read current providerHttp.js health tracking + consumers (streamingService, consumetProvider, adminController)
- [x] 2. Get plan approval from user (approved with refinements)
- [x] 3. Enhance provider record with: successCount, failureCount, timeoutCount, consecutiveFailures, lastSuccessAt, lastFailureAt, firstSeenAt
- [x] 4. Add canonical API: markSuccess(), markFailure(), markTimeout(), isHealthy(), getHealthStats()
- [x] 5. Keep old API as delegating wrappers: recordSuccess(), recordFailure(), isProviderHealthy(), getProviderHealth()
- [x] 6. Compute uptimePercentage = successCount / (successCount + failureCount); 100% when zero requests
- [x] 7. Timeout detection: only ECONNABORTED / ETIMEDOUT / axios timeout / messages containing "timeout" → timeout path
- [x] 8. In request() catch, route genuine timeouts to markTimeout() instead of markFailure()
- [x] 9. Integrate markTimeout() into streamingService.executeProvider() when category === TIMEOUT
- [x] 10. Update getProviderHealthStatus() to expose enriched stats
- [x] 11. Append provider health into existing admin dashboard health endpoint (no new endpoint)
- [x] 12. Syntax-check all modified files (node --check)
- [x] 13. Verify no behavioural changes / external API contract changes
