import { useEffect, useRef } from 'react';
import { Button } from '@/components/Button';

interface Props {
  /** Project start date (ISO `YYYY-MM-DD`) — shown literally in the header. */
  projectStartDate: string;
  /**
   * Effective floor (ISO) — first working day on or after the project start
   * (#884). The snap targets this; when it differs from `projectStartDate` (the
   * start is a weekend/holiday) the dialog names it explicitly.
   */
  effectiveFloorDate: string;
  /** The start date the user dragged/typed the task to (ISO `YYYY-MM-DD`). */
  attemptedStart: string;
  /** Whether the current user (Admin/Owner) may move the project start date. */
  canMoveStart: boolean;
  /** Inline error from a failed snap/move mutation, or null. */
  error: string | null;
  /** True while a snap or move mutation is in flight — disables the actions. */
  isPending: boolean;
  /** Re-pin the task to the project start date. */
  onSnap: () => void;
  /** Move the project start date to the attempted date (Admin/Owner only). */
  onMoveStart: () => void;
  /** Revert the bar to its original position; persist nothing. */
  onCancel: () => void;
}

/** Format an ISO date as `Mon D, YYYY` in UTC (no off-by-one from local tz). */
function formatIso(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ' +
  'focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface';

/**
 * Project-start floor prompt (#868). Replaces the silent clamp when a task is
 * dragged/typed before the project's start date. Offers three resolutions:
 * snap the task to the project start, move the project start earlier
 * (Admin/Owner only — the supported escape, since the CPM floor is a hard
 * `max()` term), or cancel. The true relax-the-floor override is #867.
 */
export function BeforeProjectStartDialog({
  projectStartDate,
  effectiveFloorDate,
  attemptedStart,
  canMoveStart,
  error,
  isPending,
  onSnap,
  onMoveStart,
  onCancel,
}: Props) {
  const snapRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    snapRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const startLabel = formatIso(projectStartDate);
  const floorLabel = formatIso(effectiveFloorDate);
  // When the project start is a non-working day, the snap target is the first
  // working day after it (#884) — name it so "Snap" isn't a surprise.
  const floorDiffers = effectiveFloorDate !== projectStartDate;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-neutral-overlay" aria-hidden="true" onClick={onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="before-start-title"
        aria-describedby="before-start-desc"
        className="relative z-10 rounded-card bg-neutral-surface border border-neutral-border p-6 w-[360px]"
      >
        <h2
          id="before-start-title"
          className="text-sm font-semibold text-neutral-text-primary mb-2"
        >
          Schedule before the project start?
        </h2>
        <p id="before-start-desc" className="text-sm text-neutral-text-secondary mb-5">
          This project starts on{' '}
          <span className="tppm-mono text-neutral-text-primary">{startLabel}</span>
          {floorDiffers ? (
            <>
              {' '}
              (a non-working day, so the earliest a task can start is{' '}
              <span className="tppm-mono text-neutral-text-primary">{floorLabel}</span>)
            </>
          ) : null}
          . A task can&rsquo;t begin before then.{' '}
          {canMoveStart
            ? `Snap the task to ${floorDiffers ? floorLabel : 'the project start'}, or move the project start earlier.`
            : `Snap the task to ${floorDiffers ? floorLabel : 'the project start'}, or ask a project admin to move the project start date.`}
        </p>
        {error ? (
          <p className="text-xs text-semantic-critical mb-3" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className={
              'border border-neutral-border rounded-control h-8 px-4 text-xs font-medium ' +
              'text-neutral-text-primary hover:bg-neutral-surface-raised ' +
              'disabled:cursor-not-allowed disabled:text-neutral-text-secondary ' +
              FOCUS_RING
            }
          >
            Cancel
          </button>
          {canMoveStart ? (
            <button
              type="button"
              onClick={onMoveStart}
              disabled={isPending}
              title={`Move the project start to ${formatIso(attemptedStart)}`}
              className={
                'border border-neutral-border rounded-control h-8 px-4 text-xs font-medium ' +
                'text-neutral-text-primary hover:bg-neutral-surface-raised ' +
                'disabled:cursor-not-allowed disabled:text-neutral-text-secondary ' +
                FOCUS_RING
              }
            >
              Move project start
            </button>
          ) : null}
          <Button ref={snapRef} variant="primary" onClick={onSnap} disabled={isPending}>
            Snap to project start
          </Button>
        </div>
      </div>
    </div>
  );
}
