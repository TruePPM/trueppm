// Boot guard — recover from a hashed entry asset that fails to load (#4408).
//
// Why this lives outside the bundle. During a rolling upgrade of the web tier a
// browser can receive the NEW index.html from a new pod and then request its
// entry script, an eager `modulepreload` chunk, or the entry stylesheet from a
// pod still on the OLD release, which does not have that file and answers 404
// (#4341). The in-app recovery (src/lib/chunkReload.ts) is installed by
// main.tsx, which is part of the entry module graph that just failed, so it
// never runs and the page stays blank. This file is a classic script loaded
// from <head> before the module entry, so it is already listening when the
// entry graph fails. It is an external file, not inline, for the same reason
// as theme-init.js: the CSP is `script-src 'self'` (#897).
//
// What it does. Resource load errors do not bubble, but they are dispatched
// through window in the capture phase, so one capturing listener sees every
// failed <script src> and <link href>. For a same-origin /assets/ script,
// modulepreload or stylesheet that fails BEFORE the app has booted, it reloads
// the page after a short delay. index.html is served `Cache-Control: no-cache`,
// so the reload revalidates the shell and, once the old pods are gone, gets an
// index.html whose assets every pod serves. A retry a moment later is the
// remedy, because the skew window lasts only as long as the rollout.
//
// Safety rails:
// - At most RELOAD_DELAYS_MS.length reloads per RESET_AFTER_MS, counted in
//   sessionStorage, so an asset that is genuinely missing cannot loop the page.
//   When the budget is spent, or storage is unavailable (so no budget can be
//   kept), it renders a static notice with a Reload button instead of a blank
//   page.
// - Never reloads while offline: the browser's offline page is worse than the
//   notice.
// - Stands down once main.tsx calls `__trueppmBootGuard.booted()`. After boot,
//   lazy chunks and their modulepreload links are chunkReload.ts's job, which
//   knows about queued writes that a reload would discard.
(function () {
  var STORAGE_KEY = 'trueppm:boot-reload';
  var RELOAD_DELAYS_MS = [1000, 3000, 8000, 15000];
  var RESET_AFTER_MS = 60000;
  var NOTICE_ID = 'trueppm-boot-notice';

  function isBootAsset(el) {
    if (!el || !el.tagName) return false;
    var tag = String(el.tagName).toLowerCase();
    var url;
    if (tag === 'script') {
      url = el.src;
    } else if (tag === 'link') {
      var rel = String(el.rel || '').toLowerCase();
      if (rel !== 'modulepreload' && rel !== 'stylesheet') return false;
      url = el.href;
    } else {
      return false;
    }
    if (!url) return false;
    try {
      var parsed = new URL(url, window.location.href);
      return parsed.origin === window.location.origin && parsed.pathname.indexOf('/assets/') === 0;
    } catch (_) {
      return false;
    }
  }

  // Returns the number of reloads already spent in the current window, or -1
  // when storage is unavailable (private mode, blocked site data).
  function readAttempts(now) {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return 0;
      var state = JSON.parse(raw);
      if (!state || typeof state.n !== 'number' || typeof state.t !== 'number') return 0;
      if (now - state.t > RESET_AFTER_MS) return 0;
      return state.n;
    } catch (_) {
      return -1;
    }
  }

  function writeAttempts(n, now) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ n: n, t: now }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearAttempts() {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch (_) {
      /* storage unavailable — nothing to clear. */
    }
  }

  // Plain DOM with styles set through CSSOM: the app's stylesheet may be the
  // asset that failed, and textContent keeps the notice free of any markup.
  function showNotice(offline) {
    if (document.getElementById(NOTICE_ID)) return;
    var host = document.getElementById('root') || document.body;
    if (!host) return;
    var box = document.createElement('div');
    box.id = NOTICE_ID;
    box.setAttribute('role', 'alert');
    // Explicit colors: theme-init.js may already have set .dark, and the app's
    // stylesheet (which would style the page for it) may be what failed.
    // A 16px side gutter at phone width: the width leaves 1rem each side and
    // the max-width caps it on wider screens.
    box.style.boxSizing = 'border-box';
    box.style.width = 'calc(100% - 2rem)';
    box.style.maxWidth = '32rem';
    box.style.margin = '4rem auto';
    box.style.padding = '1.5rem';
    box.style.borderRadius = '8px';
    box.style.background = '#FFFFFF';
    box.style.color = '#1B2A4A';
    box.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    box.style.lineHeight = '1.5';
    var heading = document.createElement('h1');
    heading.textContent = offline ? 'You appear to be offline' : 'TruePPM is being updated';
    heading.style.fontSize = '1.25rem';
    heading.style.margin = '0 0 0.5rem';
    var body = document.createElement('p');
    body.textContent = offline
      ? 'TruePPM could not load. Check your connection, then reload.'
      : 'Part of the app could not be loaded, which usually means a new version is being rolled out. Reload in a moment to continue.';
    body.style.margin = '0 0 1rem';
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Reload';
    button.style.font = 'inherit';
    button.style.padding = '0.5rem 1rem';
    button.style.border = '0';
    button.style.borderRadius = '6px';
    button.style.background = '#1B2A4A';
    button.style.color = '#FFFFFF';
    button.style.minHeight = '44px';
    button.style.cursor = 'pointer';
    button.addEventListener('click', function () {
      clearAttempts();
      window.location.reload();
    });
    box.appendChild(heading);
    box.appendChild(body);
    box.appendChild(button);
    host.appendChild(box);
  }

  var deps = {
    now: function () {
      return Date.now();
    },
    isOnline: function () {
      return navigator.onLine !== false;
    },
    reload: function () {
      window.location.reload();
    },
    schedule: function (fn, ms) {
      window.setTimeout(fn, ms);
    },
  };

  var hasBooted = false;
  var handled = false;

  // Decides what one failed boot asset should do. Returns 'ignored',
  // 'reloading' or 'notice' so the decision is observable in tests.
  function handleFailure(el) {
    if (hasBooted || handled || !isBootAsset(el)) return 'ignored';
    handled = true;
    var now = deps.now();
    var attempts = readAttempts(now);
    if (!deps.isOnline()) {
      showNotice(true);
      return 'notice';
    }
    if (attempts < 0 || attempts >= RELOAD_DELAYS_MS.length) {
      showNotice(false);
      return 'notice';
    }
    if (!writeAttempts(attempts + 1, now)) {
      showNotice(false);
      return 'notice';
    }
    deps.schedule(deps.reload, RELOAD_DELAYS_MS[attempts]);
    return 'reloading';
  }

  window.addEventListener(
    'error',
    function (event) {
      handleFailure(event.target);
    },
    true,
  );

  window.__trueppmBootGuard = {
    // Called by main.tsx once the entry module graph has evaluated. A clean
    // boot refunds the reload budget so the next rollout starts from zero.
    booted: function () {
      hasBooted = true;
      clearAttempts();
    },
    // Test seams; production code never calls these.
    _handleFailure: handleFailure,
    _setDeps: function (overrides) {
      for (var k in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) deps[k] = overrides[k];
      }
    },
    _reset: function () {
      hasBooted = false;
      handled = false;
    },
    STORAGE_KEY: STORAGE_KEY,
    RELOAD_DELAYS_MS: RELOAD_DELAYS_MS,
    RESET_AFTER_MS: RESET_AFTER_MS,
  };
})();
