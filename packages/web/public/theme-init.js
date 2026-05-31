// Blocking theme init — apply .dark before first paint to prevent flash.
// Mirrors the logic in useThemeInit.ts. Key: trueppm.theme
//
// Moved out of an inline <script> in index.html to an external file (#897) so a
// strict CSP (script-src 'self') can permit it without an inline hash or
// 'unsafe-inline'. Loaded with a blocking <script src> in <head> so it runs
// before first paint.
(function () {
  try {
    var t = localStorage.getItem('trueppm.theme');
    if (
      t === 'dark' ||
      (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ) {
      document.documentElement.classList.add('dark');
    }
  } catch (_) {
    /* localStorage unavailable (private mode / disabled) — leave default theme. */
  }
})();
