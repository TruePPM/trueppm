/**
 * The reconciliation review strip (ADR-0784 §D7, issue #2725).
 *
 * Docked immediately above `ScheduleForecastBar` and deliberately NOT part of
 * it: the forecast bar returns `null` or an empty state when no Monte Carlo run
 * exists, and is `hidden md:flex`. Folding the reconciliation announcement into
 * it would mean a project that has never run a simulation gets no announcement
 * at all, and mobile never gets one.
 *
 * The `role="status"` region is ALWAYS mounted, even when there is nothing to
 * say. A live region that mounts at the same moment its text appears is not
 * reliably announced by screen readers — the element has to already be in the
 * accessibility tree when the text changes.
 *
 * Hard failures do NOT get a second assertive region here; they route to the
 * existing `ariaAssertiveRef` region already threaded through `useScheduleCommit`
 * (two assertive regions on one view is how announcements get lost).
 */
import { useMemo } from 'react';

import { useReconcileStore } from '@/stores/reconcileStore';

import { announcement, changedCountLabel, describeDivergence } from './reconcileCopy';
import { divergedEntries, rejectedEntries, type ReconcileEntry } from './reconcileState';

// `h-7` matches `ScheduleForecastBar`'s BTN_CLS — this strip docks directly
// above it, and the rule-118 `h-6` density exception is scoped to
// `features/settings/` only. `focus-visible:` is correct here: the Schedule tree
// stays `focus-visible:` deliberately (web rule 4 / rule 137).
const GHOST_BTN =
  'inline-flex items-center h-7 px-2 rounded-control border border-neutral-border ' +
  'bg-neutral-surface text-xs font-medium text-neutral-text-primary ' +
  'hover:bg-neutral-surface-raised ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

interface Props {
  /** The project's effective working-day bitmask — the ONLY cause the client can prove. */
  workingDaysMask: number;
  /** CPM project finish, for the announcement. Null when unknown. */
  projectFinish?: string | null;
}

/**
 * One rejected write, with the server's reason and the two things a planner can
 * do about it. Retry is a deliberate human gesture, never automatic: the common
 * causes (permission, lock, validation) do not resolve on their own.
 */
function RejectedRow({
  entry,
  onRetry,
  onDismiss,
}: {
  entry: ReconcileEntry;
  onRetry: (e: ReconcileEntry) => void;
  onDismiss: (e: ReconcileEntry) => void;
}) {
  return (
    <li className="flex items-center gap-2 py-0.5">
      <span aria-hidden="true" className="text-semantic-critical">
        ⚠
      </span>
      <span className="truncate text-xs font-medium text-neutral-text-primary">
        {entry.taskName}
      </span>
      <span className="truncate text-xs text-semantic-critical">
        {entry.reason ?? 'The server refused this change.'}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {entry.retry && (
          <button
            type="button"
            onClick={() => onRetry(entry)}
            aria-label={`Retry the refused change on ${entry.taskName}`}
            className={GHOST_BTN}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={() => onDismiss(entry)}
          aria-label={`Dismiss the refused change on ${entry.taskName}`}
          className={GHOST_BTN}
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}

export function ScheduleReconcileStrip({ workingDaysMask, projectFinish = null }: Props) {
  const entries = useReconcileStore((s) => s.entries);
  const reviewFilterActive = useReconcileStore((s) => s.reviewFilterActive);
  const setReviewFilter = useReconcileStore((s) => s.setReviewFilter);
  const acknowledgeAll = useReconcileStore((s) => s.acknowledgeAll);
  const acknowledgeOne = useReconcileStore((s) => s.acknowledge);
  const retryOne = useReconcileStore((s) => s.retry);

  const diverged = useMemo(() => divergedEntries(entries), [entries]);
  const rejected = useMemo(() => rejectedEntries(entries), [entries]);
  const liveText = announcement(diverged.length, projectFinish);
  const idle = diverged.length === 0 && rejected.length === 0;

  return (
    <section
      data-testid="schedule-reconcile-strip"
      aria-label="Schedule changes"
      className={
        idle
          ? 'flex-shrink-0'
          : 'flex-shrink-0 border-t border-neutral-border bg-neutral-surface px-5 py-1.5'
      }
    >
      {/*
        Always in the DOM so the region is in the accessibility tree before the
        text changes. Visually hidden — the visible count below carries the same
        information for sighted users, and announcing it twice is worse than not
        at all.
      */}
      <span role="status" aria-live="polite" data-testid="reconcile-live" className="sr-only">
        {liveText}
      </span>

      {!idle && (
        <div className="flex flex-wrap items-center gap-2">
          {diverged.length > 0 && (
            <>
              <span
                data-testid="reconcile-count"
                className="inline-flex items-center gap-1 rounded-chip border border-semantic-at-risk/40 px-1.5 py-0.5 text-xs font-medium text-semantic-at-risk"
              >
                {/* The arrow is the non-color signal for the change (WCAG 1.4.1). */}
                <span aria-hidden="true">→</span>
                {changedCountLabel(diverged.length)}
              </span>
              <button
                type="button"
                data-testid="reconcile-review-toggle"
                aria-pressed={reviewFilterActive}
                onClick={() => setReviewFilter(!reviewFilterActive)}
                className={
                  reviewFilterActive
                    ? `${GHOST_BTN} border-brand-primary text-brand-primary`
                    : GHOST_BTN
                }
              >
                {reviewFilterActive
                  ? `Showing ${diverged.length} changed`
                  : `Show ${diverged.length} change${diverged.length === 1 ? '' : 's'}`}
              </button>
              <button
                type="button"
                data-testid="reconcile-ack-all"
                onClick={acknowledgeAll}
                className={GHOST_BTN}
              >
                Acknowledge all
              </button>
            </>
          )}
          {rejected.length > 0 && (
            <span
              data-testid="reconcile-rejected-count"
              className="inline-flex items-center gap-1 rounded-chip border border-semantic-critical/40 px-1.5 py-0.5 text-xs font-medium text-semantic-critical"
            >
              <span aria-hidden="true">⚠</span>
              {rejected.length === 1 ? '1 change refused' : `${rejected.length} changes refused`}
            </span>
          )}
        </div>
      )}

      {diverged.length > 0 && reviewFilterActive && (
        <ul data-testid="reconcile-change-list" className="mt-1 flex flex-col gap-0.5">
          {diverged.map((e) => (
            <li key={`${e.taskId}:${e.field}`} className="flex items-center gap-2 py-0.5">
              <span className="truncate text-xs font-medium text-neutral-text-primary">
                {e.taskName}
              </span>
              {/* The full old → new sentence lives here: the ~74px grid cell
                  cannot carry it, so this list is where it is actually read. */}
              <span className="truncate text-xs text-neutral-text-secondary">
                {describeDivergence(e, workingDaysMask)}
              </span>
              <button
                type="button"
                onClick={() => acknowledgeOne(e.taskId, e.field)}
                aria-label={`Acknowledge the date change on ${e.taskName}`}
                className={`ml-auto shrink-0 ${GHOST_BTN}`}
              >
                Got it
              </button>
            </li>
          ))}
        </ul>
      )}

      {rejected.length > 0 && (
        <ul data-testid="reconcile-rejected-list" className="mt-1 flex flex-col gap-0.5">
          {rejected.map((e) => (
            <RejectedRow
              key={`${e.taskId}:${e.field}`}
              entry={e}
              onRetry={(x) => retryOne(x.taskId, x.field)}
              onDismiss={(x) => acknowledgeOne(x.taskId, x.field)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
