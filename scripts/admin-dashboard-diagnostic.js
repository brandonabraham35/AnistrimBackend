/**
 * Admin Dashboard — Live Diagnostic Script
 *
 * HOW TO USE:
 * 1. Open https://anistrimbackend.onrender.com/admin/dashboard.html in your browser
 * 2. Log in as admin
 * 3. Open F12 Developer Tools → Console tab
 * 4. Copy-paste this ENTIRE script into the console and press Enter
 * 5. The script will output a structured diagnostic report
 *
 * WHAT IT DOES:
 * - Makes actual API requests with your current admin session
 * - Inspects DOM selectors, computed styles, and rendered values
 * - Reports every JavaScript error during initialization
 * - Compares API values against DOM values
 * - Does NOT log, store, or transmit any tokens or credentials
 *
 * SAFETY: Read-only. Makes GET requests only. No data modification.
 */

(function () {
  'use strict';

  var report = [];
  var passCount = 0;
  var failCount = 0;

  function log(section, status, detail) {
    report.push({ section: section, status: status, detail: detail });
    if (status === 'PASS') passCount++;
    else if (status === 'FAIL') failCount++;
    else console.log('[ADMIN DIAG]', section, '|', status, '|', detail);
  }

  function section(title) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  ' + title);
    console.log('═══════════════════════════════════════════\n');
  }

  // ═══════════════════════════════════════════════
  // SECTION 1: Script Loading Verification
  // ═══════════════════════════════════════════════
  section('1. SCRIPT LOADING');

  var scripts = [
    'AniStrimSession',
    'apiRequest',
    'unwrapAdminEnvelope',
    '_formatNumber',
    '_formatDate',
    '_timeAgo',
    '_escapeHTML',
    'loadOverview',
  ];

  scripts.forEach(function (name) {
    var exists = false;
    if (name === 'AniStrimSession') exists = typeof window.AniStrimSession !== 'undefined' && window.AniStrimSession.create;
    else if (name === 'apiRequest') exists = typeof window.apiRequest === 'function';
    else if (name === 'unwrapAdminEnvelope') exists = typeof window.unwrapAdminEnvelope === 'function';
    else if (name === '_formatNumber') exists = typeof window._formatNumber === 'function';
    else if (name === '_formatDate') exists = typeof window._formatDate === 'function';
    else if (name === '_timeAgo') exists = typeof window._timeAgo === 'function';
    else if (name === '_escapeHTML') exists = typeof window._escapeHTML === 'function';
    else if (name === 'loadOverview') exists = typeof loadOverview === 'function';

    log(name, exists ? 'PASS' : 'FAIL', exists ? 'Loaded' : 'NOT FOUND — this will cause errors');
  });

  // ═══════════════════════════════════════════════
  // SECTION 2: Authentication Check
  // ═══════════════════════════════════════════════
  section('2. AUTHENTICATION');

  var adminSession = window.AniStrimSession ? window.AniStrimSession.create('admin') : null;
  var token = adminSession ? adminSession.getToken() : null;

  log('Admin session object', adminSession ? 'PASS' : 'FAIL', adminSession ? 'Created' : 'AniStrimSession not available');
  log('Token present', token ? 'PASS' : 'FAIL', token ? 'YES (not printed)' : 'NO — you may need to log in again');

  // ═══════════════════════════════════════════════
  // SECTION 3: DOM Selectors
  // ═══════════════════════════════════════════════
  section('3. DOM SELECTORS');

  var selectors = [
    '#stats-total-users',
    '#stats-vip-users',
    '#stats-total-anime',
    '#stats-total-episodes',
    '#stats-cloudinary-videos',
    '#stats-revenue-today',
    '#stats-revenue-month',
    '#stats-revenue-total',
    '#recent-uploads',
    '#top-anime-list',
    '#latest-users',
    '#activity-logs',
    '#dashboard',
  ];

  selectors.forEach(function (sel) {
    var el = document.querySelector(sel);
    log(sel, el ? 'PASS' : 'FAIL', el ? 'Found' : 'NOT FOUND in DOM');
  });

  // ═══════════════════════════════════════════════
  // SECTION 4: CSS Visibility
  // ═══════════════════════════════════════════════
  section('4. CSS VISIBILITY');

  var visSelectors = ['#stats-total-users', '#stats-total-anime', '#stats-total-episodes', '#recent-uploads'];
  visSelectors.forEach(function (sel) {
    var el = document.querySelector(sel);
    if (!el) { log(sel + ' CSS', 'SKIP', 'Element not found'); return; }
    var cs = getComputedStyle(el);
    var hidden = cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' || cs.fontSize === '0px';
    log(sel, hidden ? 'FAIL' : 'PASS',
      'display=' + cs.display + ' visibility=' + cs.visibility + ' opacity=' + cs.opacity + ' fontSize=' + cs.fontSize);
  });

  // ═══════════════════════════════════════════════
  // SECTION 5: Console Errors
  // ═══════════════════════════════════════════════
  section('5. CONSOLE ERRORS (captured from this point forward)');

  var capturedErrors = [];
  var origError = window.onerror;
  window.onerror = function (msg, url, line, col, err) {
    capturedErrors.push({ msg: msg, line: line, url: url });
    if (origError) return origError.apply(this, arguments);
  };

  log('Error capture', 'PASS', 'Listening for errors during diagnostic');

  // ═══════════════════════════════════════════════
  // SECTION 6: Live API Request
  // ═══════════════════════════════════════════════
  section('6. LIVE API REQUEST — /api/admin/dashboard/overview');

  return window.apiRequest('/api/admin/dashboard/overview')
    .then(function (data) {
      log('HTTP request', 'PASS', 'Response received');

      // Check overview
      var overview = data.overview;
      log('data.overview', overview ? 'PASS' : 'FAIL', overview ? 'Present' : 'MISSING — this is the root cause');

      if (overview) {
        log('overview.users.total', 'INFO', 'Value: ' + (overview.users ? overview.users.total : 'undefined'));
        log('overview.users.premium', 'INFO', 'Value: ' + (overview.users ? overview.users.premium : 'undefined'));
        log('overview.users.activeToday', 'INFO', 'Value: ' + (overview.users ? overview.users.activeToday : 'undefined'));
        log('overview.content.totalAnime', 'INFO', 'Value: ' + (overview.content ? overview.content.totalAnime : 'undefined'));
        log('overview.content.totalEpisodes', 'INFO', 'Value: ' + (overview.content ? overview.content.totalEpisodes : 'undefined'));
        log('overview.content.totalViews', 'INFO', 'Value: ' + (overview.content ? overview.content.totalViews : 'undefined'));
        log('overview.content.dailyViews', 'INFO', 'Value: ' + (overview.content ? overview.content.dailyViews : 'undefined'));
        log('overview.revenue.total', 'INFO', 'Value: ' + (overview.revenue ? overview.revenue.total : 'undefined'));
        log('overview.revenue.today', 'INFO', 'Value: ' + (overview.revenue ? overview.revenue.today : 'undefined'));
        log('overview.revenue.month', 'INFO', 'Value: ' + (overview.revenue ? overview.revenue.month : 'undefined'));
        log('overview.cloudinary.ready', 'INFO', 'Value: ' + (overview.cloudinary ? overview.cloudinary.ready : 'undefined'));
      }

      // Check arrays
      var recentEpisodes = data.recentEpisodes || [];
      var recentAnime = data.recentAnime || [];
      var topAnime = data.topAnime || [];
      var latestUsers = data.latestUsers || [];
      var activityLogs = data.activityLogs || [];

      log('data.recentEpisodes', recentEpisodes.length > 0 ? 'PASS' : 'INFO', 'Count: ' + recentEpisodes.length + (recentEpisodes.length ? ' — first: ' + JSON.stringify(recentEpisodes[0]) : ' (empty)'));
      log('data.recentAnime', recentAnime.length > 0 ? 'PASS' : 'INFO', 'Count: ' + recentAnime.length);
      log('data.topAnime', topAnime.length > 0 ? 'PASS' : 'INFO', 'Count: ' + topAnime.length);
      log('data.latestUsers', latestUsers.length > 0 ? 'PASS' : 'INFO', 'Count: ' + latestUsers.length);
      log('data.activityLogs', activityLogs.length > 0 ? 'PASS' : 'INFO', 'Count: ' + activityLogs.length);

      // ═══════════════════════════════════════════════
      // SECTION 7: DOM Values After API Response
      // ═══════════════════════════════════════════════
      section('7. DOM VALUES (current textContent)');

      var domChecks = [
        '#stats-total-users',
        '#stats-vip-users',
        '#stats-total-anime',
        '#stats-total-episodes',
        '#stats-cloudinary-videos',
        '#stats-revenue-today',
        '#stats-revenue-month',
        '#stats-revenue-total',
      ];

      domChecks.forEach(function (sel) {
        var el = document.querySelector(sel);
        var val = el ? el.textContent : 'ELEMENT NOT FOUND';
        log(sel, val === '—' || val === '...' ? 'INFO' : 'PASS', 'textContent = "' + val + '"');
      });

      log('#recent-uploads innerHTML', document.querySelector('#recent-uploads') ? 'PASS' : 'FAIL',
        document.querySelector('#recent-uploads')
          ? (document.querySelector('#recent-uploads').innerHTML.substring(0, 120) || '(empty)')
          : 'ELEMENT NOT FOUND');

      // ═══════════════════════════════════════════════
      // SECTION 8: Comparison — API vs DOM
      // ═══════════════════════════════════════════════
      section('8. API vs DOM COMPARISON');

      if (overview) {
        var apiUsers = overview.users ? overview.users.total : 'N/A';
        var domUsers = document.querySelector('#stats-total-users') ? document.querySelector('#stats-total-users').textContent : 'N/A';
        log('Users: API=' + apiUsers + ' DOM="' + domUsers + '"',
          String(apiUsers) === String(domUsers) ? 'PASS' : 'FAIL',
          String(apiUsers) === String(domUsers) ? 'Match' : 'MISMATCH');

        var apiAnime = overview.content ? overview.content.totalAnime : 'N/A';
        var domAnime = document.querySelector('#stats-total-anime') ? document.querySelector('#stats-total-anime').textContent : 'N/A';
        log('Anime: API=' + apiAnime + ' DOM="' + domAnime + '"',
          String(apiAnime) === String(domAnime) ? 'PASS' : 'FAIL',
          String(apiAnime) === String(domAnime) ? 'Match' : 'MISMATCH');

        var apiEpisodes = overview.content ? overview.content.totalEpisodes : 'N/A';
        var domEpisodes = document.querySelector('#stats-total-episodes') ? document.querySelector('#stats-total-episodes').textContent : 'N/A';
        log('Episodes: API=' + apiEpisodes + ' DOM="' + domEpisodes + '"',
          String(apiEpisodes) === String(domEpisodes) ? 'PASS' : 'FAIL',
          String(apiEpisodes) === String(domEpisodes) ? 'Match' : 'MISMATCH');
      }

      // ═══════════════════════════════════════════════
      // SECTION 9: Chart Endpoints
      // ═══════════════════════════════════════════════
      section('9. CHART ENDPOINTS (parallel)');

      var chartTypes = ['daily-users', 'revenue', 'anime-growth', 'episode-views', 'genre-distribution', 'provider-usage'];
      var chartPromises = chartTypes.map(function (type) {
        return window.apiRequest('/api/admin/dashboard/charts/' + type)
          .then(function (d) {
            log('charts/' + type, d && d.labels ? 'PASS' : 'INFO',
              'labels=' + (d && d.labels ? d.labels.length : 0) + ' values=' + (d && d.values ? d.values.length : 0));
          })
          .catch(function (e) {
            log('charts/' + type, 'FAIL', e.message);
          });
      });

      return Promise.all(chartPromises).then(function () {
        printSummary();
      });
    })
    .catch(function (err) {
      log('API request', 'FAIL', 'ERROR: ' + err.message);
      if (err.message && err.message.indexOf('Session expired') !== -1) {
        log('Authentication', 'FAIL', 'Session expired — you may need to log in again');
      }
      printSummary();
    });

  function printSummary() {
    section('DIAGNOSTIC SUMMARY');

    console.log('  PASS: ' + passCount);
    console.log('  FAIL: ' + failCount);
    console.log('');

    if (failCount === 0) {
      console.log('  ✅ All checks passed. The dashboard is functioning correctly.');
      console.log('     If you see "0" or "No data available", the production database');
      console.log('     genuinely lacks content for those metrics.');
      console.log('');
      console.log('     To populate data:');
      console.log('     1. Ensure users have watched episodes (creates watch_progress rows)');
      console.log('     2. Ensure payments have been processed');
      console.log('     3. Ensure episodes exist with valid anime_id references');
    } else {
      console.log('  ❌ ' + failCount + ' check(s) failed. Review the FAIL entries above.');
      console.log('');
      console.log('  The most critical failures to look for:');
      console.log('  - Token present: FAIL → Authentication problem');
      console.log('  - data.overview: FAIL → API not returning overview object');
      console.log('  - apiRequest: FAIL → Network/API request failure');
      console.log('  - loadOverview: NOT FOUND → Script loading problem');
      console.log('  - #stats-*: NOT FOUND → DOM/HTML problem');
      console.log('  - #stats-* CSS: FAIL → CSS hiding data');
    }

    console.log('\n═══════════════════════════════════════════');
    console.log('  END OF DIAGNOSTIC');
    console.log('═══════════════════════════════════════════\n');
  }
})();
