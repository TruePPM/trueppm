import { WarningIcon } from '@/components/Icons';
import { useEffect, useState } from 'react';

/**
 * Global connectivity indicator (WCAG 4.1.3 status messages).
 *
 * Offline handling elsewhere is reactive — a write fails, then a toast appears.
 * This banner is the proactive signal: it tells the user they're offline *before*
 * they attempt a mutation, so an optimistic create that will later fail isn't a
 * silent surprise. Rendered just below the TopBar in `AppShell`.
 *
 * `role="status" aria-live="polite"` announces the state change to assistive tech
 * without interrupting. The live region is mounted permanently so going offline
 * injects text into an already-present node — a region mounted at the same instant
 * as its content is not reliably announced (#2203). When online it collapses to
 * `sr-only` (no children, no layout footprint) rather than unmounting.
 */
export function OfflineBanner() {
  // Guard for SSR / non-browser test envs where `navigator` may be undefined.
  const [offline, setOffline] = useState<boolean>(
    () => typeof navigator !== 'undefined' && !navigator.onLine,
  );

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        offline
          ? 'flex items-center justify-center gap-2 border-b border-semantic-at-risk bg-semantic-at-risk-bg px-4 py-1.5 text-xs font-medium text-semantic-at-risk'
          : 'sr-only'
      }
    >
      {offline && (
        <>
          <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
          {/* #2028: honest copy. Most offline edits live in an in-memory queue that a
              reload discards, so tell the user to keep the tab open, and name the
              refuse-class (scheduling drags aren't queued at all). */}
          You&rsquo;re offline — edits sync when you reconnect. Keep this tab open; scheduling changes
          need a connection.
        </>
      )}
    </div>
  );
}
