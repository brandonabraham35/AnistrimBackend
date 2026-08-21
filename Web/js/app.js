/* eslint-env browser */
/* global AniStrimViews, AniStrimRouter */
// AniStrim Web — bootstrap (independent from Frontend/)
(function () {
  'use strict';
  var Router = window.AniStrimRouter;
  var V = window.AniStrimViews;

  Router.register('/', V.home);
  Router.register('/login', V.login);
  Router.register('/signup', V.signup);
  Router.register('/verify', V.verify);
  Router.register('/forgot-password', V.forgotPassword);
  Router.register('/reset-password', V.resetPassword);
  Router.register('/auth/google/callback', V.googleCallback);
  Router.register('/browse', V.browse, V.afterBrowse);
  Router.register('/search', V.search, V.afterSearch);
  Router.register('/anime/:id', V.anime, V.afterAnime);
  Router.register('/watch/:id/:ep', V.watch, V.afterWatch);
  Router.register('/watchlist', V.watchlist, V.afterWatchlist);
  Router.register('/history', V.history, V.afterHistory);
  Router.register('/profile', V.profile, V.afterProfile);
  Router.register('/settings', V.profile, V.afterProfile);
  Router.register('/upgrade', V.upgrade);
  Router.register('/payment-return', V.paymentReturn, V.afterPaymentReturn);
  Router.register('/:fallback', function () {
    return '<div class="page"><div class="container"><h1>Not Found</h1><p>The page you requested does not exist.</p></div></div>';
  });

  // router.js renders on DOMContentLoaded. Do not render here as well: these
  // synchronous scripts run before that event and would otherwise duplicate
  // the initial home/API load.
})();
