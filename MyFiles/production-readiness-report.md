# AnimeHeaven Provider Production Readiness Report

Generated: 2026-08-04
Mode: Verification pass only (no provider source modifications)

## Scope Executed

Artifacts consumed:

- [tmp/subtitle-validation.json](tmp/subtitle-validation.json)
- [mirror-validation.json](mirror-validation.json)
- [metadata-completeness.json](metadata-completeness.json)
- [stream-validation.json](stream-validation.json)
- [cloudflare-validation.json](cloudflare-validation.json)
- [failure-recovery.json](failure-recovery.json)
- [cache-validation.json](cache-validation.json)
- [concurrency-report.json](concurrency-report.json)

Additional runtime validation used for required subsystems:

- [search-quality-report.json](search-quality-report.json)
- [tmp/health-logging-metrics-check.json](tmp/health-logging-metrics-check.json)

## Subsystem Verdicts

| Subsystem         | Verdict | Evidence                                                                                                                                                                                                    |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search            | PARTIAL | [search-quality-report.json](search-quality-report.json): totalQueries=200, top1Rate=0.805, top10Recall=0.83, falseNegativeQueries=34.                                                                      |
| Aliases           | PASS    | [metadata-completeness.json](metadata-completeness.json): aliases completeness 200/200 (100%).                                                                                                              |
| Metadata          | FAIL    | [metadata-completeness.json](metadata-completeness.json): overallCompleteness=66.67%; studios/status/duration/rating each 0%.                                                                               |
| Episode parsing   | PASS    | [metadata-completeness.json](metadata-completeness.json): episodeCount 200/200 (100%); [mirror-validation.json](mirror-validation.json): episodesTested=50 with resolvePlayerSuccess=50.                    |
| Player extraction | PASS    | [mirror-validation.json](mirror-validation.json): resolvePlayerSuccess=50/50, avgSourcesPerEpisode=12.                                                                                                      |
| Nested iframes    | PARTIAL | [mirror-validation.json](mirror-validation.json) confirms source extraction success, but no dedicated nested-depth hit evidence is recorded in artifact fields.                                             |
| Mirrors           | PARTIAL | [mirror-validation.json](mirror-validation.json): mirrorsValidated=0, mirrorNeverAppeared=true, so mirror-host resolution could not be exercised.                                                           |
| Retries           | PARTIAL | [cloudflare-validation.json](cloudflare-validation.json): retryLogicActivated=false (no challenge condition observed); failure handling verified in [failure-recovery.json](failure-recovery.json).         |
| Cloudflare        | PASS    | [cloudflare-validation.json](cloudflare-validation.json): classification=PASS, totalProviderRequests=500, requestSuccess=500, cloudflareChallenges=0, permanentBlocked=0.                                   |
| Redirects         | PARTIAL | [stream-validation.json](stream-validation.json): avgRedirectCount=0; no redirect paths observed in this sample.                                                                                            |
| Subtitles         | PARTIAL | [tmp/subtitle-validation.json](tmp/subtitle-validation.json): testedTitles=100, subtitlePositiveTitles=0, parserMissCount=0 with rationale that subtitles were likely dynamic/unavailable in sampled pages. |
| Streams           | PASS    | [stream-validation.json](stream-validation.json): episodesTested=100, totalExtractedStreams=400, brokenStreams=0, healthyStreams=400.                                                                       |
| Qualities         | PASS    | [stream-validation.json](stream-validation.json): qualityLabels populated and 400 stream URLs classified.                                                                                                   |
| Caching           | PASS    | [cache-validation.json](cache-validation.json): identical requests 100x -> cacheHits=99, cacheMisses=1; expiration and key invalidation checks both true.                                                   |
| Concurrency       | PASS    | [concurrency-report.json](concurrency-report.json): totalRequests=185, totalSuccess=185, totalFailures=0, totalTimeouts=0, raceConditionKeys=0.                                                             |
| Memory            | PASS    | [failure-recovery.json](failure-recovery.json): doesNotLeakMemory true in 8/8 scenarios; [cache-validation.json](cache-validation.json): rssDelta +3,067,904 with stable execution and no hangs/crashes.    |
| CPU               | PASS    | [concurrency-report.json](concurrency-report.json): stress levels up to concurrency=100 completed with zero failures/timeouts; maxCpuPercentSingleCoreEquivalent observed 163.98 under load.                |
| Failure recovery  | PASS    | [failure-recovery.json](failure-recovery.json): overallStatus=PASS, scenariosTested=8, passCount=8, doesNotCrash/doesNotHang/returnsCorrectError all 8/8.                                                   |
| Logging           | PASS    | [tmp/health-logging-metrics-check.json](tmp/health-logging-metrics-check.json): loggingObserved=true; loggerCounters show info=16, stream=10 during live calls.                                             |
| Metrics           | PASS    | [tmp/health-logging-metrics-check.json](tmp/health-logging-metrics-check.json): health snapshot counters changed after runtime calls (streamExtractionSuccess, streamSuccess, successRate, avgResponseMs).  |
| Health snapshot   | PASS    | [tmp/health-logging-metrics-check.json](tmp/health-logging-metrics-check.json): healthSnapshotAllFieldsPresent=true across all expected fields.                                                             |

## Score

Overall production score: 80/100

Deduction policy applied: only evidence-backed failures were deducted.

Deductions:

- -14 metadata completeness failure: [metadata-completeness.json](metadata-completeness.json) shows 0% for studios/status/duration/rating and 66.67% overall completeness.
- -6 search quality gap: [search-quality-report.json](search-quality-report.json) shows 34 false-negative queries out of 200 and top1Rate 80.5%.

No deductions were applied for PARTIAL verdicts that represent coverage gaps without direct failure evidence (mirrors, nested iframes, retries under Cloudflare challenge, redirects, subtitles).

## Overall Verdict

PARTIAL production readiness.

Reason: core runtime stability, extraction, caching, concurrency, failure recovery, logging, and health telemetry passed; readiness is held back by evidence-backed metadata completeness failure and measurable search miss rate.
