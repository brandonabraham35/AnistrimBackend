# AnimeHeaven Nightly Validation Report

- **Generated:** 2026-08-06T16:38:02.452Z
- **Run ID:** 2026-08-06
- **Overall Status:** `FAIL`
- **Production Score:** 42/100

## Trend vs Previous Run

- Previous score: **52** / 100 (delta **-10**)
- Previous overall status: **FAIL**

- **Regressions:** Concurrency
- **New failures:** Concurrency

## Subsystems

| Subsystem | Status | Detail | Weighted |
|-----------|--------|--------|----------|
| Streams | FAIL | Healthy rate 0% | 0 |
| Search | PARTIAL | Top-10 recall 88.24% | 9 |
| Metadata | PASS | Completeness 100% | 10 |
| Subtitles | FAIL | Coverage 11.11% (external 0%) | 0 |
| Mirrors | PARTIAL | 0 mirror hosts detected | 3 |
| Cache | FAIL | Hit ratio 0% | 0 |
| Failure Recovery | PASS | Recovery rate 100% | 10 |
| Concurrency | FAIL | Real success rate 0% | 0 |
| Cloudflare | PASS | Cloudflare rate 0% | 5 |
| Health | PASS | No degraded providers | 5 |

## Counts
- **PASS:** 4
- **PARTIAL:** 2
- **FAIL:** 4

## Recommendations

- [Streams] Healthy rate 0%
- [Search] Top-10 recall 88.24%
- [Subtitles] Coverage 11.11% (external 0%)
- [Mirrors] 0 mirror hosts detected
- [Cache] Hit ratio 0%
- [Concurrency] Real success rate 0%

## Errors Encountered During Harvest

- kickassanime / resolveStream: Request failed with status code 404
- kickassanime / resolveStream: Request failed with status code 404
- kickassanime / resolveStream: Request failed with status code 404
- kickassanime / resolveStream: Request failed with status code 404
- kickassanime / resolveStream: Request failed with status code 404
- animekai / resolveStream: Something went wrong. Please try again later.
- animekai / resolveStream: Something went wrong. Please try again later.
- animekai / resolveStream: Something went wrong. Please try again later.
- animekai / resolveStream: Something went wrong. Please try again later.
- animekai / resolveStream: Something went wrong. Please try again later.
- animepahe / resolveStream: getaddrinfo EAI_AGAIN animepahe.si
- animepahe / resolveStream: getaddrinfo ENOTFOUND animepahe.si
- animepahe / resolveStream: getaddrinfo ENOTFOUND animepahe.si
- animepahe / resolveStream: getaddrinfo ENOTFOUND animepahe.si
- animepahe / resolveStream: getaddrinfo ENOTFOUND animepahe.si
- hianime / resolveStream: Cannot read properties of null (reading 'Page')
- hianime / resolveStream: Cannot read properties of null (reading 'Page')
- hianime / resolveStream: Cannot read properties of null (reading 'Page')
- hianime / resolveStream: Cannot read properties of null (reading 'Page')
- hianime / resolveStream: Cannot read properties of null (reading 'Page')
