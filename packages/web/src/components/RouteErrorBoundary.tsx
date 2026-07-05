import { useEffect, useRef } from 'react';
import { useRouteError } from 'react-router';
import { WarningIcon } from '@/components/Icons';
import { Button } from '@/components/Button';

/**
 * True when the error is a failed dynamic `import()` of a route chunk — the most
 * common route failure in production: a stale module graph right after a deploy,
 * an offline user, or a transient CDN blip. Vite/Rollup phrase this a few ways
 * ("Failed to fetch dynamically imported module", "error loading dynamically
 * imported module", "Loading chunk N failed"), so match the family loosely.
 */
function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /dynamically imported module|loading chunk .* failed|failed to fetch/i.test(message);
}

/**
 * The route-level `errorElement` (issue 1654). Replaces React Router's built-in
 * default error screen — the raw "Unexpected Application Error!" + "💿 Hey
 * developer 👋" dump — which otherwise reaches end users on any lazy-chunk load
 * failure or render throw in a route subtree.
 *
 * Two responsibilities, deliberately split so neither leaks into the other:
 *  - the USER sees a calm, branded surface (v2 EmptyState anatomy, rule 177) with
 *    plain-language copy and a recovery path — never the internal error text;
 *  - the DEVELOPER still gets the real error + stack on the console (where React
 *    Router used to print its hint), so nothing is lost for debugging.
 *
 * `role="alert"` (not the EmptyState `role="status"`) so assistive tech announces
 * the failure assertively — this is an error the user landed in, not a calm empty
 * view. Recovery: **Reload** re-fetches the failed chunk (the actual remedy for a
 * stale/failed dynamic import); **Go to home** hard-navigates to `/` for the case
 * where the current route itself is the problem.
 *
 * Wired at the route tree root (whole-app net) and again on `ProjectShell` /
 * `ProgramShell` (so a single view failure keeps the sidebar and the user can
 * navigate away) — see `router.tsx`.
 *
 * Focus (web-rule 224): the erroring route subtree unmounts, dropping focus to
 * `document.body`, so we move focus to the heading on mount — otherwise a keyboard
 * or screen-reader user would have to blind-Tab from `body` to reach the recovery
 * actions that are the whole point of this surface.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Preserve the developer signal without ever showing it to a user. Guard the
  // console call so SSR/headless render paths without a console don't throw.
  if (typeof console !== 'undefined') {
    console.error('[RouteErrorBoundary] a route failed to render:', error);
  }

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const chunkFailure = isChunkLoadError(error);

  const title = chunkFailure ? "Couldn't finish loading" : 'Something went wrong';
  const description = chunkFailure
    ? "A part of the app didn't load — this usually happens right after an update. Reloading should put it right."
    : 'We hit an unexpected error. Reload this view, or head back to your home screen.';

  return (
    <div
      role="alert"
      className="flex h-full flex-1 flex-col items-center justify-center px-6 py-16 text-center motion-safe:animate-empty-state-in"
    >
      <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-neutral-border bg-neutral-surface-raised text-neutral-text-secondary">
        <WarningIcon aria-hidden="true" className="h-8 w-8" />
      </div>
      {/* tabIndex + `focus:` (not `focus-visible:`, which browsers may withhold on
          a scripted .focus()) so the ring reliably shows when we move focus here. */}
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="mt-5 rounded text-[17px] font-semibold text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        {title}
      </h2>
      <p className="mt-2 max-w-[380px] text-[13px] leading-relaxed text-neutral-text-secondary">
        {description}
      </p>
      <div className="mt-5 flex items-center gap-2">
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            window.location.href = '/';
          }}
        >
          Go to home
        </Button>
      </div>
    </div>
  );
}
