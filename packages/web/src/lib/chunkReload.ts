/**
 * One-shot automatic reload when a lazily loaded chunk fails to load.
 *
 * Why: during a rolling upgrade a client can hold an `index.html` from one
 * release while a later request for a hashed chunk lands on a pod of the other
 * release, which does not have that file. The server answers 404 (never the SPA
 * fallback), Vite fires `vite:preloadError`, and the module graph cannot
 * resolve. A reload fetches the new `index.html` and its matching chunks, which
 * is the actual remedy, so we do it once without waiting for the user to find
 * the Reload button on the error surface.
 *
 * Safety rails, each of which avoids making things worse:
 * - Reload at most once per {@link RELOAD_WINDOW_MS}, tracked in sessionStorage,
 *   so a chunk that is genuinely gone cannot cause a reload loop. When the guard
 *   is set we do nothing and the existing RouteErrorBoundary UI takes over.
 * - Never reload while offline: the reload would replace the app with the
 *   browser's offline page, which is worse than the error surface.
 * - Never reload while queued writes exist: a reload discards the in-memory
 *   mutation queue (see RouteErrorBoundary's discard confirmation).
 * - Storage may throw (private mode, blocked site data); that is treated as
 *   "guard unavailable" and the reload is skipped rather than risking a loop.
 */

/** sessionStorage key holding the epoch-ms timestamp of the last auto-reload. */
export const CHUNK_RELOAD_KEY = 'trueppm:chunk-reload-at';

/** Minimum gap between automatic reloads; also how long a page must survive to clear the guard. */
export const RELOAD_WINDOW_MS = 10_000;

export interface ChunkReloadDeps {
  now?: () => number;
  reload?: () => void;
  isOnline?: () => boolean;
  pendingWriteCount?: () => number;
}

/**
 * Reloads the page once if the guard allows it.
 *
 * @param deps Injection seams for tests; production callers pass nothing.
 * @returns True if a reload was triggered, false if it was suppressed.
 */
export function reloadOnceForChunkFailure(deps: ChunkReloadDeps = {}): boolean {
  const now = deps.now ?? Date.now;
  const reload = deps.reload ?? (() => window.location.reload());
  const isOnline = deps.isOnline ?? (() => navigator.onLine !== false);
  const pending = deps.pendingWriteCount ?? (() => 0);

  if (!isOnline() || pending() > 0) return false;

  try {
    const last = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY));
    const t = now();
    if (Number.isFinite(last) && last > 0 && t - last < RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(t));
  } catch {
    return false;
  }

  reload();
  return true;
}

/** Removes the reload guard; called once the reloaded page has proven healthy. */
export function clearChunkReloadGuard(): void {
  try {
    window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // Storage unavailable: nothing was stored, nothing to clear.
  }
}

/**
 * Wires the `vite:preloadError` handler and schedules the guard to clear after
 * the page has stayed alive for {@link RELOAD_WINDOW_MS}.
 *
 * @param deps Injection seams for tests; production callers pass nothing.
 * @returns A teardown function that removes the listener and the timer.
 */
export function installChunkReloadHandler(deps: ChunkReloadDeps = {}): () => void {
  const onError = (event: Event) => {
    // preventDefault stops Vite rethrowing, but only when we are recovering by
    // reload; otherwise let the error reach the route boundary as before.
    if (reloadOnceForChunkFailure(deps)) event.preventDefault();
  };
  window.addEventListener('vite:preloadError', onError);
  const timer = window.setTimeout(clearChunkReloadGuard, RELOAD_WINDOW_MS);
  return () => {
    window.removeEventListener('vite:preloadError', onError);
    window.clearTimeout(timer);
  };
}
