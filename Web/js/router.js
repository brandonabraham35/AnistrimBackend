/* eslint-env browser */
// AniStrim Web — hash-based router (independent from Frontend/)
(function () {
  'use strict';

  var routes = [];
  var currentPath = '/';

  function decode(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
  }

  function parseHash() {
    var hash = window.location.hash || '#/';
    if (hash.charAt(0) === '#') hash = hash.slice(1);
    if (hash.charAt(0) !== '/') hash = '/' + hash;
    return hash.split('?')[0];
  }

  function parseQuery() {
    var hash = window.location.hash || '#/';
    var qi = hash.indexOf('?');
    if (qi === -1) return {};
    var qs = hash.slice(qi + 1);
    var out = {};
    new URLSearchParams(qs).forEach(function (v, k) { out[k] = v; });
    return out;
  }

  function match(path) {
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      if (r.regex.test(path)) {
        var m = path.match(r.regex);
        var params = {};
        if (r.keys) {
          r.keys.forEach(function (k, idx) { params[k] = decode(m[idx + 1]); });
        }
        return { route: r, params: params };
      }
    }
    var fallback = routes.find(function (r) { return r.path === '/:fallback'; }) ||
      routes.find(function (r) { return r.path === '*'; });
    return fallback ? { route: fallback, params: {} } : null;
  }

  function navigate(path, params) {
    if (params) {
      var qs = new URLSearchParams(params).toString();
      if (qs) path = path.split('?')[0] + '?' + qs;
    }
    window.location.hash = '#' + path;
  }

  function render() {
    var path = parseHash();
    var previousPath = currentPath;
    if (previousPath.indexOf('/watch') === 0 && path.indexOf('/watch') !== 0 && window.AniStrimPlayer) {
      window.AniStrimPlayer.destroy();
    }
    currentPath = path;
    var m = match(path);
    var main = document.getElementById('site-main');
    if (!main) return;
    if (!m) {
      main.innerHTML = '<div class="page"><h1>Not Found</h1><p>The page you requested does not exist.</p></div>';
      window.scrollTo(0, 0);
      return;
    }
    main.innerHTML = '';
    var view = m.route.view;
    if (view) {
      Promise.resolve(view(m.params, parseQuery())).then(function (html) {
        main.innerHTML = html;
        window.scrollTo(0, 0);
        if (m.route.after) m.route.after(main, m.params, parseQuery());
      }).catch(function (err) {
        main.innerHTML = '<div class="page"><h1>Error</h1><p>' + (err && err.message || 'Something went wrong') + '</p></div>';
      });
    }
  }

  window.AniStrimRouter = {
    register: function (path, view, after) {
      var keys = [];
      var pattern = path.replace(/:[^/]+/g, function (k) {
        keys.push(k.slice(1));
        return '([^/]+)';
      });
      routes.push({
        path: path,
        regex: new RegExp('^' + pattern + '$'),
        keys: keys.length ? keys : null,
        view: view,
        after: after || null,
      });
    },
    navigate: navigate,
    render: render,
    currentPath: function () { return currentPath; },
    query: parseQuery,
  };

  window.addEventListener('hashchange', render);
  window.addEventListener('DOMContentLoaded', render);
})();
