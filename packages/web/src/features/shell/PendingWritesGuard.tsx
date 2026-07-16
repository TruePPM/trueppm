import { useEffect } from 'react';
import { usePendingWriteCount } from '@/hooks/useSyncStatus';

/**
 * Warn before a tab close / reload while writes are still un-drained (#2028).
 *
 * Most offline writes (drawer saves, progress, assignments, comments) sit in
 * TanStack Query's in-memory paused-mutation queue — a reload discards them
 * silently even though the OfflineBanner and SyncStatusBadge promise they'll
 * sync. Until the queue is made durable (persistQueryClient / outbox, tracked
 * in #1427), this `beforeunload` guard is the honest stopgap: the browser's
 * native "Leave site?" prompt gives the user a chance to stay and let the queue
 * drain instead of losing the work.
 *
 * Renders nothing. Mounted once in {@link AppShell} so it observes every write.
 */
export function PendingWritesGuard() {
  const pendingCount = usePendingWriteCount();

  useEffect(() => {
    if (pendingCount === 0) return;
    function handler(e: BeforeUnloadEvent) {
      // The spec requires preventDefault (and legacy returnValue) to trigger
      // the native confirmation dialog; the custom string is ignored by modern
      // browsers, which show their own generic "unsaved changes" copy.
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pendingCount]);

  return null;
}
