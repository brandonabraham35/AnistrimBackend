# CACHE HIT IMMUTABILITY VERIFICATION REPORT

**Mode:** READ-ONLY (no source/DB/config modification)
**Timestamp:** 2026-08-09T19:52:24.033Z
**Target:** `episode_id=33` · `anime="Jujutsu Kaisen 0"` · `episode=1` · `provider=animeheaven`

## Verdict

> **NOT VERIFIED**

## Expiry Gate

| Key | Value |
| --- | --- |
| rowFound | true |
| rowCount | 1 |
| expires_at | 2026-08-09T08:55:31.000Z |
| dbNow | 2026-08-09T16:52:27.000Z |
| remainingMs | -28616000 |
| expired | true |

## Baseline stream_data Validity

| Key | Value |
| --- | --- |
| hasSource | true |
| hasProxyUrl | false |
| hasErrorUrl | false |

## Captured Logs

```
[2026-08-09T19:52:24.901Z] [LOG] DB connected: anistrim_requirebut
[2026-08-09T19:52:25.107Z] [LOG] DB NOW(): "2026-08-09T16:52:27.000Z"
[2026-08-09T19:52:25.314Z] [LOG] RESULT: NOT VERIFIED — cache row EXPIRED (remainingMs=-28616000)
```
