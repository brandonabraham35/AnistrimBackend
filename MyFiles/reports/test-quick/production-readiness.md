# AnimeHeaven Nightly Validation Report

- **Generated:** 2026-08-04T18:33:01.768Z
- **Run ID:** test-quick
- **Overall Status:** `FAIL`
- **Production Score:** 42/100

## Subsystems

| Subsystem | Status | Detail | Weighted |
|-----------|--------|--------|----------|
| Streams | FAIL | Healthy rate 60% | 0 |
| Search | PARTIAL | Top-10 recall 88.24% | 9 |
| Metadata | PASS | Completeness 100% | 10 |
| Subtitles | FAIL | Coverage 0% | 0 |
| Mirrors | PARTIAL | 0 mirror hosts detected | 3 |
| Cache | FAIL | Hit ratio 0% | 0 |
| Failure Recovery | PASS | Recovery rate 100% | 10 |
| Concurrency | FAIL | No concurrency report | 0 |
| Cloudflare | PASS | Cloudflare rate 0% | 5 |
| Health | PASS | No degraded providers | 5 |

## Counts
- **PASS:** 4
- **PARTIAL:** 2
- **FAIL:** 4

## Recommendations

- [Streams] Healthy rate 60%
- [Search] Top-10 recall 88.24%
- [Subtitles] Coverage 0%
- [Mirrors] 0 mirror hosts detected
- [Cache] Hit ratio 0%
- [Concurrency] No concurrency report

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
