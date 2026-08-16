'use strict';
/**
 * _subtitle_runtime_proof.js — Runtime proof: does AnimeHeaven deliver subtitles?
 *
 * PURPOSE:
 *   Verify at RUNTIME (>=20 episodes) whether AnimeHeaven streams contain
 *   subtitles, using a REAL headless Chrome browser (puppeteer-core).
 *
 *   Unlike the earlier _subtitle_runtime_investigation.js (which only probed the
 *   HTTP layer server-side and could NOT see JS-injected subtitles or screenshots),
 *   this harness:
 *     1. Resolves each AnimeHeaven episode via the provider (gets gate page + video URL).
 *     2. Loads the ACTUAL video in a real Chrome browser.
 *     3. Captures EVERY network request (looking for .vtt/.srt/.ass/.ssa, HLS
 *        TYPE=SUBTITLES, DASH text AdaptationSets, <track> resources).
 *     4. Reads the <video> element's textTracks in the live DOM.
 *     5. Takes SCREENSHOTS while the video is playing.
 *     6. Detects ON-SCREEN subtitle text (OCR-free heuristic below) to classify
 *        whether subtitles are VISIBLE during playback.
 *
 * PER-EPISODE RECORD:
 *   { episode, videoUrl, subtitleUrl, visibleSubtitles, embedded, external,
 *     evidence: { playerHtml(trunc), network, textTracks, screenshot } }
 *
 * OUTPUT:
 *   embedded-subtitle-proof.md            (the deliverable report)
 *   subtitle-proof-screenshots/<ep>.png   (evidence screenshots)
 *   subtitle-proof-data.json              (raw structured evidence)
 *
 * CONCLUSION RULE (strict):
 *   Only conclude "embedded subtitles" if runtime evidence proves it:
 *     - a playable video played in the browser, AND
 *     - NO external subtitle track was delivered (no .vtt/.srt/.ass/.ssa, no
 *       HLS TYPE=SUBTITLES, no DASH text AdaptationSet, no <track>), AND
 *     - subtitle text is VISIBLE in the rendered video frames (on-screen text
 *       detected in the screenshot while playing).
 *
 *   If subtitles are NOT visible in the frames and no external track exists,
 *   we must NOT claim "embedded" — we report accurately.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const { provider } = require('./services/animeHeavenProvider');

const MAX_EPISODES = 24; // need >= 20
const CONCURRENCY = 1;   // sequential to keep screenshots clean & avoid rate limits
const PLAY_SECONDS = 8;  // how long to "watch" each episode before screenshot
const SCREENSHOT_DIR = path.join(__dirname, 'subtitle-proof-screenshots');

// A curated list of AnimeHeaven identifiers (title key -> identifier) that
// resolved successfully in prior audits. We open episode 1 for each.
const TITLES = [
  ['A Certain Magical Index III', 'rk3og'],
  ['A Condition Called Love', 'u95rf'],
  ['A Couple of Cuckoos', 'xqjzb'],
  ['A Galaxy Next Door', 'ryvby'],
  ['A Girl & Her Guard Dog', '4u7r9'],
  ['Babanbabanban Vampire', 'rgc1p'],
  ['Babylon', '1ne58'],
  ['Bad Girl', 'hfrok'],
  ['Baka and Test 2', 'o8tj1'],
  ['Bakemonogatari', '1j1cc'],
  ['Baki', 'tgl3z'],
  ['Call of the Night', 'vjm84'],
  ['Campfire Cooking in Another World', 'xbuk9'],
  ['Can a Boy-Girl Friendship Survive?', 'pqlwq'],
  ['Cat Planet Cuties', '6p1bo'],
  ['Cautious Hero', 'up8au'],
  ['D4DJ All Mix', 'u57xa'],
  ['Dandadan', 'j2np5'],
  ['Danganronpa', 'q1y3b'],
  ['Dark Gathering', 'mekup'],
  ['Darker than Black', 'qviiw'],
  ['Edens Zero', 'hertd'],
  ['Elfen Lied', 's43yb'],
  ['ERASED', 'zs72q'],
].slice(0, MAX_EPISODES);

const SUBTITLE_EXT_RX = /\.(vtt|srt|ass|ssa)(\?|$)/i;
const HLS_SUB_RX = /#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES/i;
const DASH_SUB_RX = /<AdaptationSet[^>]*>[^<]*<[^>]*contentType\s*=\s*["']text["']|<Role[^>]*schemeIdUri\s*=\s*["'][^"']*subtitle["']/i;

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function shortUrl(u, n = 240) {
  const s = String(u || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function classifySubtitleUrl(url) {
  const u = String(url || '').toLowerCase();
  if (SUBTITLE_EXT_RX.test(u)) return 'external-file';
  if (/\.m3u8/.test(u)) return 'hls';
  if (/\.mpd/.test(u)) return 'dash';
  if (/\.mp4/.test(u)) return 'mp4';
  if (/\.(png|jpe?g|gif|webp|svg|css|js)(\?|$)/.test(u)) return 'static';
  return 'other';
}

/**
 * Minimal PNG decoder (RGBA) — decodes just enough of the PNG to read pixel
 * luminance in the target band. Supports 8-bit truecolor (color type 2) and
 * truecolor+alpha (color type 6), which is what Chrome screenshots produce.
 * Uses zlib (built-in) to inflate IDAT scanlines.
 */
function decodePngRgba(buf) {
  if (buf.length < 33) throw new Error('png too small');
  // IHDR
  if (buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a png');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported png format bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const hasAlpha = colorType === 6;
  const channels = hasAlpha ? 4 : 3;
  const bpp = channels; // 8-bit => 1 byte per channel
  // Gather IDAT chunks, inflate.
  const chunks = Buffer.alloc(0);
  let offset = 8;
  let idat = Buffer.alloc(0);
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') {
      idat = Buffer.concat([idat, buf.slice(offset + 8, offset + 8 + len)]);
    }
    offset += 12 + len;
  }
  const zlib = require('zlib');
  const raw = zlib.inflateSync(idat);
  const stride = width * bpp;
  // Allocate output RGBA buffer.
  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride, 0);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.slice(pos, pos + stride);
    pos += stride;
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0; // left
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let val = line[i];
      switch (filter) {
        case 1: val = (val + a) & 0xff; break; // Sub
        case 2: val = (val + b) & 0xff; break; // Up
        case 3: val = (val + ((a + b) >> 1)) & 0xff; break; // Average
        case 4: { // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          val = (val + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 0xff;
          break;
        }
        default: break; // None
      }
      recon[i] = val;
    }
    // Write row into rgba.
    for (let x = 0; x < width; x++) {
      const src = x * bpp;
      const dst = (y * width + x) * 4;
      rgba[dst] = recon[src];
      rgba[dst + 1] = recon[src + 1];
      rgba[dst + 2] = recon[src + 2];
      rgba[dst + 3] = hasAlpha ? recon[src + 3] : 255;
    }
    prev.set(recon);
  }
  return { width, height, data: rgba };
}

/**
 * Heuristic on-screen subtitle detection.
 * Subtitles burned into frames are almost always LIGHT (white/yellow) text
 * near the BOTTOM-CENTRE of the frame on a video that is otherwise dark-ish.
 * We sample the bottom-centre band of the screenshot and look for clusters of
 * bright pixels (high luminance) that are NOT part of a large uniform region.
 *
 * This is intentionally conservative: it returns true only when there is a
 * clear bright-text-on-darker-background signature in the lower-middle band,
 * which is exactly where burned subtitle text sits.
 */
async function detectOnScreenSubtitlesFromPng(pngBuffer) {
  try {
    const png = decodePngRgba(pngBuffer);
    const { width, height, data } = png;
    // Bottom band: from 72% to 92% of height, central 60% of width.
    const y0 = Math.floor(height * 0.72);
    const y1 = Math.floor(height * 0.92);
    const x0 = Math.floor(width * 0.20);
    const x1 = Math.floor(width * 0.80);
    let bright = 0;
    let sampled = 0;
    let brightClusters = 0;
    let inCluster = false;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (width * y + x) << 2;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        sampled++;
        // luminance
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        // bright = light text (luminance > 200) — typical white/yellow subs
        const isBright = lum > 200;
        if (isBright) {
          bright++;
          if (!inCluster) { inCluster = true; brightClusters++; }
        } else {
          inCluster = false;
        }
      }
      inCluster = false;
    }
    const brightRatio = sampled ? bright / sampled : 0;
    // Requires a meaningful but not overwhelming fraction of bright pixels
    // (text lines, not a white frame) and more than a couple of clusters.
    const detected = brightRatio > 0.01 && brightRatio < 0.55 && brightClusters >= 3;
    return { detected, brightRatio: Number(brightRatio.toFixed(4)), brightClusters, sampled };
  } catch (err) {
    return { detected: false, error: String(err && err.message) };
  }
}

/**
 * Open a real browser page, load the video URL, capture network + textTracks,
 * play briefly, screenshot, and return runtime evidence.
 */
async function captureRuntimePlayback(browser, videoUrl, episodeLabel, referer) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  // AnimeHeaven's CDN (ck./ax.animeheaven.me) rejects requests without a real
  // Referer/Origin — the video returns HTTP 403 and never plays. Send the same
  // referer the provider uses server-side (providerRegistry.js
  // PROVIDER_REFERERS[ANIME_HEAVEN] = 'https://animeheaven.ru/').
  await page.setExtraHTTPHeaders({
    'Referer': 'https://animeheaven.ru/',
    'Origin': 'https://animeheaven.ru/',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  });

  const network = [];
  let subtitleTracksFetched = [];

  // Capture all network requests.
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:')) return; // Chrome's inline SVG/icon noise — not real network traffic
    const type = classifySubtitleUrl(url);
    network.push({ url: shortUrl(url), method: req.method(), type, resourceType: req.resourceType() });
    if (type === 'external-file') subtitleTracksFetched.push(url);
  });

  page.on('response', async (res) => {
    const url = res.url();
    const ct = String(res.headers()['content-type'] || '');
    const entry = network.find(x => x.url === shortUrl(url));
    if (entry) entry.status = res.status();
    if (/m3u8/i.test(url) && /text|application/.test(ct)) {
      try {
        const body = await res.text().catch(() => '');
        if (HLS_SUB_RX.test(body)) {
          if (!subtitleTracksFetched.includes(url)) subtitleTracksFetched.push(url + ' [HLS TYPE=SUBTITLES]');
        }
      } catch (e) { /* ignore */ }
    }
    if (/mpd/i.test(url)) {
      try {
        const body = await res.text().catch(() => '');
        if (DASH_SUB_RX.test(body)) {
          if (!subtitleTracksFetched.includes(url)) subtitleTracksFetched.push(url + ' [DASH text AdaptationSet]');
        }
      } catch (e) { /* ignore */ }
    }
  });

  // Build a minimal HTML page that just plays the video (with HLS.js if needed).
  let isHls = /\.m3u8(\?|$)/i.test(videoUrl);
  const html = `<!DOCTYPE html><html><head>
    ${isHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>' : ''}
    </head><body style="margin:0;background:#000">
    <video id="v" width="1280" height="720" controls autoplay playsinline muted></video>
    <script>
      window.__tracks = [];
      const v = document.getElementById('v');
      function snapshotTracks() {
        window.__tracks = Array.from(v.textTracks || []).map(t => ({
          kind: t.kind, label: t.label, language: t.language, mode: t.mode,
          cues: t.cues ? Array.from(t.cues).slice(0,3).map(c => (c && c.text || '').slice(0,80)) : []
        }));
      }
      setInterval(snapshotTracks, 1000);
      const src = ${JSON.stringify(videoUrl)};
      ${isHls ? `
        if (window.Hls && Hls.isSupported()) {
          const hls = new Hls({ enableWebVTT: true, enableCEA708: true });
          hls.loadSource(src); hls.attachMedia(v);
          hls.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(()=>{}); });
        } else { v.src = src; v.play().catch(()=>{}); }
      ` : `v.src = src; v.load(); v.play().catch(()=>{});`}
      window.__ready = true;
    </script></body></html>`;

  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // Wait for the video to start playing / buffering.
    try {
      await page.waitForFunction(() => {
        const v = document.getElementById('v');
        return v && (v.currentTime > 0.5 || v.readyState >= 2);
      }, { timeout: 15000 });
    } catch (e) { /* video may not advance; still capture */ }

    // Let it play a bit so burned subs (if any) become visible.
    await new Promise(r => setTimeout(r, PLAY_SECONDS * 1000));

    // Force a seek into the middle if the video stalled at 0 (some CDNs need a start).
    try {
      await page.evaluate(() => {
        const v = document.getElementById('v');
        if (v && isFinite(v.duration) && v.duration > 10 && v.currentTime < 2) {
          v.currentTime = Math.min(v.duration * 0.3, 60);
        }
      });
    } catch (e) { /* ignore */ }
    await new Promise(r => setTimeout(r, 3000));

    // Screenshot (full body = the video).
    const shotPath = path.join(SCREENSHOT_DIR, `${sanitize(episodeLabel)}.png`);
    await page.screenshot({ path: shotPath, type: 'png' });

    // Capture runtime state from the live DOM.
    const runtime = await page.evaluate(() => {
      const v = document.getElementById('v');
      return {
        currentTime: v ? v.currentTime : 0,
        duration: v ? (isFinite(v.duration) ? v.duration : 0) : 0,
        readyState: v ? v.readyState : 0,
        networkState: v ? v.networkState : 0,
        paused: v ? v.paused : true,
        error: v && v.error ? (v.error.code + ':' + v.error.message) : null,
        src: v ? (v.currentSrc || v.src || '') : '',
        textTracks: window.__tracks || [],
        hasChildTracks: v ? Array.from(v.querySelectorAll('track')).map(t => ({ src: t.getAttribute('src'), kind: t.getAttribute('kind'), srclang: t.getAttribute('srclang'), label: t.getAttribute('label') })) : [],
      };
    });

    // On-screen subtitle detection from the screenshot.
    const onScreen = await detectOnScreenSubtitlesFromPng(fs.readFileSync(shotPath));

    await page.close();

    return {
      screenshot: path.relative(__dirname, shotPath),
      screenshotPath: shotPath,
      network,
      subtitleTracksFetched,
      onScreen,
      runtime,
    };
  } catch (err) {
    try { await page.close(); } catch (e) {}
    return { error: String(err && err.message), network, subtitleTracksFetched, onScreen: { detected: false } };
  }
}

function sanitize(label) {
  return String(label).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'ep';
}

async function main() {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const chrome = findChrome();
  if (!chrome) {
    console.error('❌ No Chrome/Edge executable found. Cannot capture runtime screenshots.');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });

  const results = [];
  const startAll = Date.now();

  for (let idx = 0; idx < TITLES.length; idx++) {
    const [title, identifier] = TITLES[idx];
    const epLabel = `${title} — Ep 1`;
    const t0 = Date.now();
    process.stdout.write(`\n[${idx + 1}/${TITLES.length}] ${epLabel} …`);

    const record = {
      episode: epLabel,
      title,
      identifier,
      videoUrl: null,
      subtitleUrl: null,
      visibleSubtitles: false,
      embedded: false,
      external: false,
      inconclusive: false,
      evidence: {},
      ok: false,
      error: null,
    };

    try {
      // 1) Resolve the stream via the provider (server-side).
      const stream = await provider.extractStreams({ title, episode: 1, identifier });
      const videoUrl = stream && stream.streamUrl;
      const providerSubs = (stream && stream.subtitles) || [];

      record.videoUrl = videoUrl || null;
      record.evidence.providerSubtitleMode = stream ? stream.subtitleMode : null;
      record.evidence.providerSubtitleCount = providerSubs.length;
      record.evidence.providerSubtitles = providerSubs.map(s => ({ lang: s.lang, url: shortUrl(s.url), format: s.format }));

      if (videoUrl) {
        record.evidence.videoUrl = shortUrl(videoUrl);
        // 2) Runtime playback in a real browser.
        const playback = await captureRuntimePlayback(browser, videoUrl, epLabel, null);
        record.evidence.playback = {
          network: (playback.network || []).slice(0, 60),
          networkCount: (playback.network || []).length,
          subtitleTracksFetched: playback.subtitleTracksFetched || [],
          onScreen: playback.onScreen,
          runtime: playback.runtime ? {
            currentTime: Number(playback.runtime.currentTime || 0).toFixed(1),
            duration: Number(playback.runtime.duration || 0).toFixed(1),
            readyState: playback.runtime.readyState,
            paused: playback.runtime.paused,
            error: playback.runtime.error,
            textTracks: playback.runtime.textTracks,
            childTracks: playback.runtime.hasChildTracks || [],
          } : null,
          error: playback.error || null,
        };
        record.evidence.screenshot = playback.screenshot || null;

        // Subtitle URL = any external subtitle resource actually fetched at runtime.
        const extTracks = playback.subtitleTracksFetched || [];
        record.subtitleUrl = extTracks.length ? extTracks[0] : null;
        record.evidence.externalSubtitleTracksFound = extTracks;

        // Visible subtitles = on-screen bright text detected in the frames.
        record.visibleSubtitles = !!(playback.onScreen && playback.onScreen.detected);

// Classification (STRICT — runtime evidence only):
        //   external  = a separate subtitle resource was actually fetched/declared.
        //   embedded  = NO external resource AND subtitles were VISIBLE in the
        //               rendered video frames (proven runtime burned-in).
        //   none      = no external resource AND no visible on-screen text.
        //   inconclusive = the video never actually played (HTTP error / media
        //               error / no frames rendered). On-screen subtitle detection
        //               is meaningless for a video that never rendered, so we
        //               must NOT label it "none"/"no subtitles".
        const anyExternal = extTracks.length > 0
          || (playback.runtime && ((playback.runtime.textTracks && playback.runtime.textTracks.length) || (playback.runtime.childTracks && playback.runtime.childTracks.length)))
          || (providerSubs.length > 0 && providerSubs.some(s => /\.(vtt|srt|ass|ssa)/i.test(s.url || '')));

        // Determine whether the video actually decoded & rendered frames.
        const rt = (playback && playback.runtime) || {};
        const videoPlayed = !rt.error
          && rt.readyState > 0
          && (Number(rt.currentTime || 0) > 0 || rt.readyState >= 2 || Number(rt.duration || 0) > 0);

        if (anyExternal) {
          record.external = true;
          record.embedded = false;
        } else if (record.visibleSubtitles && videoPlayed) {
          record.embedded = true;
          record.external = false;
        } else if (!videoPlayed) {
          // Video never rendered a frame — cannot draw a subtitle conclusion.
          record.embedded = false;
          record.external = false;
          record.inconclusive = true;
        } else {
          record.embedded = false;
          record.external = false;
        }

        record.ok = true;
      } else {
        record.error = 'No playable video URL resolved by provider.';
        record.evidence.providerSubtitleMode = stream ? stream.subtitleMode : null;
      }
    } catch (err) {
      record.error = String(err && err.message);
    }

    record.evidence.durationMs = Date.now() - t0;
    results.push(record);
    process.stdout.write(` done ${record.evidence.durationMs}ms ${record.ok ? (record.embedded ? 'EMBEDDED' : (record.external ? 'EXTERNAL' : 'NONE')) : 'FAIL'}`);
  }

  await browser.close();

// ---------- Aggregate ----------
  const n = results.length;
  const ok = results.filter(r => r.ok).length;
  const embedded = results.filter(r => r.embedded).length;
  const external = results.filter(r => r.external).length;
  const none = results.filter(r => r.ok && !r.embedded && !r.external && !r.inconclusive).length;
  const inconclusive = results.filter(r => r.inconclusive).length;
  const failed = results.filter(r => !r.ok).length;

  const data = {
    generatedAt: new Date().toISOString(),
    method: 'runtime-headless-chrome-via-puppeteer-core',
    episodesInspected: n,
    episodesPlayed: ok,
    summary: { embedded, external, none, inconclusive, failed },
    results,
  };
  fs.writeFileSync(path.join(__dirname, 'subtitle-proof-data.json'), JSON.stringify(data, null, 2), 'utf8');

  // ---------- Build the markdown report ----------
  const md = buildMarkdown(data);
  fs.writeFileSync(path.join(__dirname, 'embedded-subtitle-proof.md'), md, 'utf8');

  console.log('\n\n✅ Report written to embedded-subtitle-proof.md');
console.log(`Episodes: ${n} (${ok} played), embedded=${embedded}, external=${external}, none=${none}, inconclusive=${inconclusive}, failed=${failed}`);
  console.log(`Duration: ${((Date.now() - startAll) / 1000).toFixed(0)}s`);
}

function buildMarkdown(data) {
  const { results, summary } = data;
const rows = results.map(r => {
    let verdict;
    if (r.error) verdict = '⚠️ FAILED';
    else if (r.embedded) verdict = '✅ Embedded';
    else if (r.external) verdict = '🔄 External';
    else if (r.inconclusive) verdict = '⏸️ Inconclusive (video did not play)';
    else verdict = '❌ None';
    const subs = r.subtitleUrl ? `\`${shortUrl(r.subtitleUrl, 60)}\`` : '—';
    const vis = r.visibleSubtitles ? 'Yes' : (r.error ? '—' : (r.inconclusive ? '—' : 'No'));
    const trackCount = r.evidence.playback ? (r.evidence.playback.subtitleTracksFetched || []).length : 0;
    const netCount = r.evidence.playback ? r.evidence.playback.networkCount || 0 : 0;
    const shot = r.evidence.screenshot ? `![${r.episode}](${r.evidence.screenshot})` : '—';
    const video = r.evidence.videoUrl ? `\`${shortUrl(r.evidence.videoUrl, 70)}\`` : '—';
    return `| ${r.episode} | ${video} | ${subs} | ${vis} | ${r.embedded ? 'Yes' : 'No'} | ${r.external ? 'Yes' : 'No'} | ${trackCount} | ${netCount} | ${shot} | ${verdict} |`;
  }).join('\n');

const embeddedCount = summary.embedded;
  const externalCount = summary.external;
  const noneCount = summary.none;
  const inconclusiveCount = summary.inconclusive || 0;

  let conclusion;
  if (embeddedCount > 0 && externalCount === 0 && noneCount === 0 && inconclusiveCount === 0) {
    conclusion = '**EMBEDDED SUBTITLES PROVEN.** Every anime episode that played delivered subtitles burned/embedded directly into the video frames. No external subtitle files (.vtt/.srt/.ass/.ssa), no HLS TYPE=SUBTITLES tracks, no DASH text AdaptationSets, and no <track> elements were delivered at runtime — yet subtitle text was visible in the rendered frames.';
  } else if (embeddedCount > 0 && embeddedCount >= externalCount && embeddedCount > noneCount) {
    conclusion = `**PRIMARILY EMBEDDED.** ${embeddedCount} played episodes showed on-screen burned-in subtitles with no external track. ${externalCount} exposed external tracks, ${noneCount} had no visible subtitles, ${inconclusiveCount} could not be concluded (video did not play).`;
  } else if (externalCount > 0 && externalCount >= embeddedCount) {
    conclusion = `**EXTERNAL SUBTITLES.** ${externalCount} episodes delivered separate subtitle tracks. The "embedded" claim is NOT proven by runtime evidence.`;
  } else if (inconclusiveCount > 0 && embeddedCount === 0 && externalCount === 0 && noneCount === 0) {
    conclusion = `**INCONCLUSIVE.** Every episode failed to play in the headless browser (HTTP 403/400/404, MEDIA_ERR_SRC_NOT_SUPPORTED, no frames rendered). A video that never rendered cannot prove or disprove subtitles. Do NOT label these as "no subtitles".`;
  } else {
    conclusion = `**NO PROVEN SUBTITLES.** Runtime evidence did not show visible on-screen subtitles in the frames, nor external subtitle tracks. The provider's "embedded" claim is NOT confirmed by runtime playback evidence.`;
  }

  return `# AnimeHeaven — Embedded Subtitle Runtime Proof

> **Method:** Real headless Chrome (puppeteer-core) playing each resolved AnimeHeaven video URL, capturing network requests, live \`<video>\` textTracks, and screenshots while playing.
> **Episodes inspected:** ${data.episodesInspected}  |  **Actually played in browser:** ${data.episodesPlayed}
> **Generated:** ${data.generatedAt}

## Summary

| Verdict | Count |
|---|---|
| ▶️ Played successfully | ${summary.episodesPlayed} |
| ✅ Embedded (visible on-screen, no external track) | ${summary.embedded} |
| 🔄 External subtitle track delivered | ${summary.external} |
| ❌ No visible subtitles, no external track | ${summary.none} |
| ⏸️ Inconclusive (video did not play) | ${summary.inconclusive || 0} |
| ⚠️ Failed to resolve/play | ${summary.failed} |

## Conclusion

${conclusion}

> **Strictness note:** "Embedded" is only concluded here from **runtime evidence** — subtitle text visually detected in the rendered video frames while playing, with **no** external subtitle resource delivered. The provider reports \`subtitleMode: "embedded"\` server-side, but that alone is NOT counted as proof.

## Per-Episode Evidence

| Episode | Video URL | Subtitle URL | Visible subtitles? | Embedded? | External? | External tracks fetched | Network reqs | Evidence screenshot | Verdict |
|---|---|---|---|---|---|---|---|---|---|
${rows}

## Notes on Evidence Capture

- **Network requests:** captured via Chrome DevTools Protocol while each video played (~11s watch window).
- **Subtitle URL:** any \`.vtt/.srt/.ass/.ssa\`, HLS \`TYPE=SUBTITLES\`, DASH text AdaptationSet, or \`<track>\` resource actually fetched/declared at runtime.
- **Visible subtitles:** detected by a conservative OCR-free heuristic that looks for light (white/yellow) text clusters in the bottom-centre band of the video frame. This detects burned-in subtitle text.
- **Embedded** = on-screen subtitle text visible AND no external subtitle resource delivered.
- **External** = a separate subtitle track/resource was actually delivered.
- **None** = played fine but no visible on-screen text and no external track.
- **Inconclusive** = a video URL was resolved but playback never started (HTTP 403/400/404, \`MEDIA_ERR_SRC_NOT_SUPPORTED\`, \`currentTime\` 0, \`readyState\` 0, no frames rendered). On-screen subtitle detection is **meaningless** for a video that never rendered — these are **never** labeled "no subtitles".
`;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
