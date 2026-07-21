import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { SearchIcon } from '@/components/Icons';
import { Button } from '@/components/Button';

/**
 * The catch-all 404 surface (issue 2184). Replaces the previous dead-end — a
 * centered "404 / Page not found" with nothing focusable and no way back — that
 * left keyboard and screen-reader users stranded.
 *
 * Wired both as the authed catch-all *inside* `AppShell` (so the sidebar, TopBar,
 * and ⌘K palette stay painted and the user can navigate away without a reload) and
 * as the top-level fallback for any path that never reaches the shell — see
 * `router.tsx`.
 *
 * Focus (web rule 224): a route with no match renders this element fresh, so the
 * NavLink/button the user activated is gone and focus falls to `document.body`. We
 * move focus to the heading on mount — otherwise a keyboard/AT user would have to
 * blind-Tab from `body` to reach the recovery actions that are the whole point of
 * this surface. `role="alert"` announces the dead-end assertively. Recovery uses
 * client-side `Link`/`navigate` (not a hard reload) so the shell is preserved.
 */
export function NotFoundPage() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div
      role="alert"
      className="flex h-full flex-1 flex-col items-center justify-center px-6 py-16 text-center motion-safe:animate-empty-state-in"
    >
      <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-neutral-border bg-neutral-surface-raised text-neutral-text-secondary">
        <SearchIcon aria-hidden="true" className="h-8 w-8" />
      </div>
      {/* tabIndex + `focus:` (not `focus-visible:`, which browsers may withhold on
          a scripted .focus()) so the ring reliably shows when we move focus here. */}
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-5 rounded text-[17px] font-semibold text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        Page not found
      </h1>
      <p className="mt-2 max-w-[380px] text-[13px] leading-relaxed text-neutral-text-secondary">
        We couldn&apos;t find that page. It may have moved, or the link might be
        out of date. Head back to your work to keep going.
      </p>
      <div className="mt-5 flex items-center gap-2">
        <Button variant="primary" onClick={() => void navigate('/me/work')}>
          Go to My Work
        </Button>
        <Button variant="secondary" onClick={() => void navigate('/')}>
          Go to home
        </Button>
      </div>
    </div>
  );
}
