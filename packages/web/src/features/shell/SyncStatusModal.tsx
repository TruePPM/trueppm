import { useState } from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { ProgressBar } from '@/components/ProgressBar';
import { Button } from '@/components/Button';
import {
  formatLastSync,
  syncStatusPresentation,
  type SyncStatus,
} from './syncStatus';
import type { PendingWrite } from '@/hooks/useSyncStatus';

interface Props {
  status: SyncStatus;
  pendingWrites: PendingWrite[];
  lastError: string | null;
  lastSyncAt: number | null;
  pendingPeak: number;
  onRetry: () => Promise<void>;
  onClose: () => void;
}

const WRITE_STATE_LABEL: Record<PendingWrite['state'], string> = {
  queued: 'Queued',
  sending: 'Sending…',
  failed: 'Failed',
};

/**
 * Expanded sync detail (issue 374): current state, last-sync time, drain
 * progress, the pending-write list, and the last error — with a manual retry.
 * A true focus-trapped modal (mirrors KeyboardShortcutsModal): backdrop click and
 * Escape close it, and focus returns to the badge trigger on close.
 */
export function SyncStatusModal({
  status,
  pendingWrites,
  lastError,
  lastSyncAt,
  pendingPeak,
  onRetry,
  onClose,
}: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const [retrying, setRetrying] = useState(false);
  const { label } = syncStatusPresentation(status);

  const outstanding = pendingWrites.length;
  const drained = Math.max(0, pendingPeak - outstanding);
  // Determinate drain progress only while actively syncing online; offline the
  // queue is paused (not draining), so a progress bar would be misleading.
  const showProgress = status.kind === 'syncing' && pendingPeak > 0;
  const drainPct = pendingPeak > 0 ? Math.round((drained / pendingPeak) * 100) : 0;

  const canRetry = outstanding > 0;

  async function handleRetry() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sync status"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div className="fixed inset-0 bg-neutral-overlay" aria-hidden="true" onClick={onClose} />
      <div
        ref={trapRef}
        tabIndex={-1}
        className="relative z-10 flex max-h-[80vh] w-[min(92vw,26rem)] flex-col gap-4 overflow-hidden rounded-card border border-neutral-border bg-neutral-surface p-5 focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-text-primary">Sync status</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sync status"
            className="rounded-control text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M12.207 4.207a1 1 0 0 0-1.414-1.414L8 5.586 5.207 2.793a1 1 0 0 0-1.414 1.414L6.586 8l-2.793 2.793a1 1 0 1 0 1.414 1.414L8 10.414l2.793 2.793a1 1 0 0 0 1.414-1.414L9.414 8l2.793-2.793z" />
            </svg>
          </button>
        </div>

        {/* Current state + last sync */}
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-neutral-text-primary">{label}</p>
          <p className="text-xs text-neutral-text-secondary">{formatLastSync(lastSyncAt)}</p>
        </div>

        {/* Drain progress */}
        {showProgress && (
          <ProgressBar
            pct={drainPct}
            label={`Syncing ${outstanding} of ${pendingPeak} change${pendingPeak === 1 ? '' : 's'}`}
          />
        )}

        {/* Live-updates degraded (#2053): writes still work, but real-time
            updates from others aren't arriving — explain the slow-poll fallback
            so the amber badge doesn't read as "your changes are lost". */}
        {status.kind === 'stale' && (
          <div className="rounded-control border border-semantic-at-risk bg-semantic-at-risk-bg p-3">
            <p className="text-xs font-semibold text-semantic-at-risk">Live updates disconnected</p>
            <p className="mt-1 text-xs text-semantic-at-risk">
              Changes from others may not appear right away. This view refreshes
              periodically until the connection returns. Your own changes still save.
            </p>
          </div>
        )}

        {/* Last error */}
        {status.kind === 'error' && lastError && (
          <div className="rounded-control border border-semantic-critical bg-semantic-critical-bg p-3">
            <p className="text-xs font-semibold text-semantic-critical">Last error</p>
            <p className="mt-1 break-words text-xs text-semantic-critical">{lastError}</p>
          </div>
        )}

        {/* Pending writes */}
        <div className="flex min-h-0 flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
            Pending changes ({outstanding})
          </h3>
          {outstanding === 0 ? (
            <p className="text-sm text-neutral-text-secondary">
              No pending changes — everything is saved.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 overflow-y-auto">
              {pendingWrites.map((write) => (
                <li
                  key={write.id}
                  className="flex items-center justify-between gap-3 rounded-control border border-neutral-border px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm text-neutral-text-primary">
                    {write.label}
                  </span>
                  <span
                    className={`shrink-0 text-xs ${
                      write.state === 'failed'
                        ? 'text-semantic-critical'
                        : 'text-neutral-text-secondary'
                    }`}
                  >
                    {WRITE_STATE_LABEL[write.state]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Retry */}
        {canRetry && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleRetry()}
            disabled={retrying}
            className="self-end"
          >
            {retrying ? 'Retrying…' : 'Retry now'}
          </Button>
        )}
      </div>
    </div>
  );
}
