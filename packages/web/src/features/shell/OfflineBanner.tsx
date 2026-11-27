import { useEffect, useState } from 'react';
import { WarningIcon } from '@/components/Icons';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { usePendingWriteCount } from '@/hooks/useSyncStatus';

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
 *
 * Three states (ADR-1523, #1427): `offline` → `syncing` (back online while writes
 * queued offline are still draining, with their count) → cleared. Coming back
 * online with nothing queued clears it at once. `pendingWrites` comes from
 * {@link ConnectedOfflineBanner}; the default keeps this component provider-free.
 */
export function OfflineBanner({ pendingWrites = 0 }: { pendingWrites?: number }) {
  const offline = !useOnlineStatus();
  // Latched when the connection drops; released once the queue has drained online.
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    if (offline) setReconnecting(true);
    else if (pendingWrites === 0) setReconnecting(false);
  }, [offline, pendingWrites]);
  const syncing = !offline && reconnecting && pendingWrites > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        offline
          ? 'flex items-center justify-center gap-2 border-b border-semantic-at-risk bg-semantic-at-risk-bg px-4 py-1.5 text-xs font-medium text-semantic-at-risk'
          : syncing
            ? 'flex items-center justify-center gap-2 border-b border-brand-primary/40 bg-brand-primary/5 px-4 py-1.5 text-xs font-medium text-neutral-text-primary'
            : 'sr-only'
      }
    >
      {syncing && (
        <>
          Back online — syncing {pendingWrites} {pendingWrites === 1 ? 'change' : 'changes'} made
          offline…
        </>
      )}
      {offline && (
        <>
          <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
          {/* #2028: honest copy. Most offline edits live in an in-memory queue that a
              reload discards, so tell the user to keep the tab open, and name the
              refuse-class (scheduling drags aren't queued at all). */}
          You&rsquo;re offline — edits sync when you reconnect. Keep this tab open; scheduling
          changes need a connection.
        </>
      )}
    </div>
  );
}

/** The shell's banner, fed the live count of queued writes. Needs a QueryClient. */
export function ConnectedOfflineBanner() {
  return <OfflineBanner pendingWrites={usePendingWriteCount()} />;
}
