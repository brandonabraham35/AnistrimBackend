# AnimeHeaven Resolution Pipeline

**Subject:** `One Piece` — Episode 1
**Generated:** 2026-08-06T09:00:25.523Z
**Provider:** `animeheaven`

## Provider Resolution Pipeline

✓ Search
✓ Anime page (12 episodes)
✓ Episode page
✓ Iframe extraction
✓ Mirror resolution
✓ Player
✓ Stream extraction

## ✅ All stages passed

**Stream URL:** `https://ck.animeheaven.me/video.mp4?d3fe66f33eb43f610d5dca5262923d0b&35b2d9c8bc1a8bbe4b6e53d944ba586d&error2`
**Sources:** 4
**Subtitles:** 0

---
## Detailed Stage Report

### 1. Search
✅ **PASSED** — 10 results

**Top results:**
- `3jccu` My Unique Skill Makes Me OP even at Level 1 (score 307)
- `1ht8d` One Piece (score 307)
- `a9q9c` takt op.Destiny (score 307)
- `ckqsc` One Piece Heroines (score 210)
- `wn1fk` One Piece in Love (score 206)

### 2. Anime page
✅ **PASSED** — title: My Unique Skill Makes Me OP even at Level 1, episodes: 12

**First episodes:**
- `d3fe66f33eb43f610d5dca5262923d0b` #1 1
- `1503ff526c1e38dec1f57addb5e32150` #2 2
- `8743c4f6cc21b2a244f43c572a468896` #3 3
- `f97771324556dca98d3cb97d9a6ad0bd` #4 4
- `c0917f8eb3997768bf88efe227264cee` #5 5

### 3. Episode/gate page
✅ **PASSED** — reason: none

**Cloudflare detected:** yes
- Ray ID: xxxxxxxx
- Title: AnimeHeaven.Me
- Length: 18442
- Challenge type: javascript
- Server: Apache/2.4.55 (Ubuntu)
- Cookies: `[]`

### 4. Iframe extraction
✅ **PASSED** — 4 sources

**Iframe selectors:**
| Selector | Matches |
|----------|---------|
| `iframe[src]` | 0 |
| `embed[src]` | 0 |
| `object[data]` | 0 |
| `param[name="movie"]` | 0 |

### 5. Mirror resolution
✅ **PASSED** — 4 total sources, 4 playable

### 6. Player
✅ **PASSED** — playerUrl: https://ck.animeheaven.me/video.mp4?d3fe66f33eb43f610d5dca5262923d0b&35b2d9c8bc1a8bbe4b6e53d944ba586d&error2

### 7. Stream extraction
✅ **PASSED** — streamUrl: https://ck.animeheaven.me/video.mp4?d3fe66f33eb43f610d5dca5262923d0b&35b2d9c8bc1a8bbe4b6e53d944ba586d&error2, subtitleMode: embedded, subtitles: 0

---
## HTTP Request Trace

| # | Method | URL | Status | ms | Cloudflare | Ray ID |
|---|--------|-----|--------|----|-----------|--------|
| 1 | GET | `https://animeheaven.me` | 200 | 1136 | 🛡 | - |
| 2 | GET | `https://animeheaven.me/fastsearch.php?xhr=1&s=One%20Piece` | 200 | 260 | no | - |
| 3 | GET | `https://animeheaven.me/search.php?s=One%20Piece` | 200 | 260 | no | - |
| 4 | GET | `https://animeheaven.me/?s=One%20Piece` | 200 | 382 | 🛡 | - |
| 5 | GET | `https://animeheaven.me/` | 200 | 372 | 🛡 | - |
| 6 | GET | `https://animeheaven.me/fastsearch.php?xhr=1&s=op` | 200 | 255 | no | - |
| 7 | GET | `https://animeheaven.me/search.php?s=op` | 200 | 261 | no | - |
| 8 | GET | `https://animeheaven.me/?s=op` | 200 | 389 | 🛡 | - |
| 9 | GET | `https://animeheaven.me/fastsearch.php?xhr=1&s=one%20piece` | 200 | 261 | no | - |
| 10 | GET | `https://animeheaven.me/search.php?s=one%20piece` | 200 | 262 | no | - |
| 11 | GET | `https://animeheaven.me/?s=one%20piece` | 200 | 370 | 🛡 | - |
| 12 | GET | `https://animeheaven.me/fastsearch.php?xhr=1&s=%E3%83%AF%E3%83%B3%E3%83%92%20%...` | 200 | 262 | no | - |
| 13 | GET | `https://animeheaven.me/search.php?s=%E3%83%AF%E3%83%B3%E3%83%92%20%E3%83%BC%E...` | 200 | 256 | no | - |
| 14 | GET | `https://animeheaven.me/?s=%E3%83%AF%E3%83%B3%E3%83%92%20%E3%83%BC%E3%82%B9` | 200 | 366 | 🛡 | - |
| 15 | GET | `https://animeheaven.me/anime.php?3jccu` | 200 | 294 | 🛡 | - |
| 16 | GET | `https://animeheaven.me/gate.php` | 200 | 304 | 🛡 | - |
| 17 | GET | `https://ck.animeheaven.me/subtitles.vtt?d3fe66f33eb43f610d5dca5262923d0b&35b2...` | 404 | 964 | no | - |
| 18 | GET | `https://ck.animeheaven.me/caption.vtt?d3fe66f33eb43f610d5dca5262923d0b&35b2d9...` | 404 | 255 | no | - |
| 19 | GET | `https://ck.animeheaven.me/subtitle.vtt?d3fe66f33eb43f610d5dca5262923d0b&35b2d...` | 404 | 260 | no | - |
| 20 | GET | `https://ck.animeheaven.me/video.vtt?d3fe66f33eb43f610d5dca5262923d0b&35b2d9c8...` | 404 | 263 | no | - |
| 21 | GET | `https://ck.animeheaven.me/subtitles.srt?d3fe66f33eb43f610d5dca5262923d0b&35b2...` | 404 | 257 | no | - |
| 22 | GET | `https://ck.animeheaven.me/subtitle.srt?d3fe66f33eb43f610d5dca5262923d0b&35b2d...` | 404 | 260 | no | - |
| 23 | GET | `https://ck.animeheaven.me/subtitles/d3fe66f33eb43f610d5dca5262923d0b.vtt` | 404 | 262 | no | - |
| 24 | GET | `https://ck.animeheaven.me/subtitle/d3fe66f33eb43f610d5dca5262923d0b.vtt` | 404 | 257 | no | - |
| 25 | GET | `https://ck.animeheaven.me/captions/d3fe66f33eb43f610d5dca5262923d0b.vtt` | 404 | 304 | no | - |
| 26 | GET | `https://ck.animeheaven.me/subtitles/d3fe66f33eb43f610d5dca5262923d0b.srt` | 404 | 255 | no | - |
| 27 | GET | `https://ck.animeheaven.me/subtitle/d3fe66f33eb43f610d5dca5262923d0b.srt` | 404 | 256 | no | - |
| 28 | GET | `https://ck.animeheaven.me/captions/d3fe66f33eb43f610d5dca5262923d0b.srt` | 404 | 254 | no | - |
| 29 | GET | `https://ct.animeheaven.me/subtitles.vtt?d3fe66f33eb43f610d5dca5262923d0b&35b2...` | 404 | 943 | no | - |
| 30 | GET | `https://ct.animeheaven.me/caption.vtt?d3fe66f33eb43f610d5dca5262923d0b&35b2d9...` | 404 | 256 | no | - |
| 31 | GET | `https://ct.animeheaven.me/subtitle.vtt?d3fe66f33eb43f610d5dca5262923d0b&35b2d...` | 404 | 253 | no | - |
| 32 | GET | `https://ct.animeheaven.me/video.vtt?d3fe66f33eb43f610d5dca5262923d0b&35b2d9c8...` | 404 | 254 | no | - |
| 33 | GET | `https://ct.animeheaven.me/subtitles.srt?d3fe66f33eb43f610d5dca5262923d0b&35b2...` | 404 | 258 | no | - |
| 34 | GET | `https://ct.animeheaven.me/subtitle.srt?d3fe66f33eb43f610d5dca5262923d0b&35b2d...` | 404 | 259 | no | - |
| 35 | GET | `https://ct.animeheaven.me/subtitles/d3fe66f33eb43f610d5dca5262923d0b.vtt` | 404 | 253 | no | - |
| 36 | GET | `https://ct.animeheaven.me/subtitle/d3fe66f33eb43f610d5dca5262923d0b.vtt` | 404 | 254 | no | - |
| 37 | GET | `https://ct.animeheaven.me/captions/d3fe66f33eb43f610d5dca5262923d0b.vtt` | 404 | 251 | no | - |
| 38 | GET | `https://ct.animeheaven.me/subtitles/d3fe66f33eb43f610d5dca5262923d0b.srt` | 404 | 254 | no | - |
| 39 | GET | `https://ct.animeheaven.me/subtitle/d3fe66f33eb43f610d5dca5262923d0b.srt` | 404 | 255 | no | - |
| 40 | GET | `https://ct.animeheaven.me/captions/d3fe66f33eb43f610d5dca5262923d0b.srt` | 404 | 253 | no | - |

---
*Full structured trace: `animeheaven-diagnostic.json`*
*Saved evidence: `diagnostics/animeheaven/`*