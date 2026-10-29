/*
 * Shared by the service worker (importScripts) and its tests. A classic script: it only sets self.agSw.
 * Rules: cache static app files only, never API data; a notification tap may only open a Review screen.
 */
(function (scope) {
  var VERSION = 'v0.8.0';
  var STATIC_FILES = [
    '', 'index.html', 'manifest.webmanifest', 'css/app.css',
    'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/badge-96.png',
    'js/app.js', 'js/api.js', 'js/components.js', 'js/dom.js', 'js/format.js', 'js/previews.js', 'js/state.js', 'js/push.js', 'js/live.js',
    'js/views/agents.js', 'js/views/assistant.js', 'js/views/audit.js', 'js/views/dashboard.js', 'js/views/login.js',
    'js/views/models.js', 'js/views/plans.js', 'js/views/review.js', 'js/views/settings.js', 'js/views/tools.js'
  ];
  var STATIC_PATHS = STATIC_FILES.map(function (f) { return '/' + f; });
  var REVIEW = /^\/#\/review\/act_[A-Za-z0-9_-]{4,64}$/;

  scope.agSw = {
    CACHE: 'agentguard-static-' + VERSION,
    STATIC_FILES: STATIC_FILES,
    /** Only the app's own static files are ever cached; /api (data, the live stream) never is. */
    isCacheable: function (pathname) {
      return typeof pathname === 'string' && pathname.indexOf('/api') !== 0 && STATIC_PATHS.indexOf(pathname) >= 0;
    },
    /** Where a notification tap may go: one action's Review screen, else the Review list. Never anywhere else. */
    safeReviewUrl: function (url) {
      return typeof url === 'string' && REVIEW.test(url) ? url : '/#/review';
    }
  };
})(self);
