import { useState } from 'react';
import type { Task } from '@/types';
import { useIterationLabel } from '@/hooks/useIterationLabel';

interface Props {
  /** Every task the board is rendering. The banner derives its counts from
   *  `sprintScopeChanges` which the API only populates for tasks linked to an
   *  active sprint, so no per-sprint filter is needed at the call site. */
  tasks: Task[];
  /**
   * Pending-acceptance count for the active sprint (ADR-0102 §5) — the
   * server-supplied `sprint.pending_count`. When > 0 the banner adds a
   * "pending acceptance" line and (for a team-owned actor) a Review button.
   * Default 0 so the banner degrades to its ADR-0101 form. */
  pendingCount?: number;
  /** Render-gate for the Review button — `useCanManageScope` (role >= ADMIN).
   *  The server is the real gate; this only hides the affordance. */
  canManageScope?: boolean;
  /** Opens the ScopePendingReviewPanel. Required for the Review button to show. */
  onReview?: () => void;
}

/**
 * Mid-sprint scope-injection banner (ADR-0101 §5, extended for ADR-0102 §5).
 *
 * Renders a team-visible summary at the top of the board whenever any task in
 * the active sprint carries a `SprintScopeChange` row — i.e. it was added
 * after the sprint was activated. The PO/SM are also notified via the email
 * pipeline (ADR-0085) but the board banner is the durable, whole-team record
 * that satisfies Morgan's whole-team-default requirement.
 *
 * ADR-0102 adds a pending-acceptance line when `pendingCount > 0`: those tasks
 * are visible but NOT yet in the commitment, and a team-owned actor (gated by
 * `canManageScope`) gets a `Review (N)` button that opens the review slide-over.
 * Pending is a neutral read-state (frontend rule 149) — the banner keeps its
 * `role="status"` (NOT `role="alert"`); it is a notice, never a block.
 *
 * Counts:
 *  - tasks: distinct tasks injected (one task may carry multiple
 *    scope-change rows over the sprint's life)
 *  - goal-impacting: subset where any row's `goalImpact` is true
 *  - pending: server-supplied count of un-accepted injections
 *
 * Renders nothing when nothing was injected. The banner is dismissible per
 * session (sessionStorage) so a quiet sprint isn't crowded by a banner the
 * team has already seen — but it returns on the next injection.
 */
export function BoardScopeInjectionBanner({
  tasks,
  pendingCount = 0,
  canManageScope = false,
  onReview,
}: Props) {
  const itl = useIterationLabel();
  const injected = tasks.filter((t) => (t.sprintScopeChanges?.length ?? 0) > 0);
  const goalImpactingCount = injected.filter((t) =>
    (t.sprintScopeChanges ?? []).some((sc) => sc.goalImpact),
  ).length;

  // Per-session dismissal: the key includes the counts so a new injection or a
  // change in the pending tally re-shows the banner after a dismiss; deliberate
  // behavior (the team should see new scope changes, not "I already dismissed
  // it once").
  const key = `trueppm.scopeInjectionBanner.dismissed.${injected.length}.${goalImpactingCount}.${pendingCount}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.sessionStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });

  if (injected.length === 0 || dismissed) return null;

  function dismiss() {
    try {
      window.sessionStorage.setItem(key, '1');
    } catch {
      // sessionStorage may be disabled — in-memory dismissal is still in effect.
    }
    setDismissed(true);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 px-3 py-2 text-xs border-b
        bg-sem-at-risk-bg border-semantic-at-risk/30 text-semantic-at-risk"
    >
      <span aria-hidden="true" className="mt-0.5">◆</span>
      <div className="flex-1">
        <span className="font-medium text-neutral-text-primary">
          {injected.length} task{injected.length === 1 ? '' : 's'} added to the active {itl.lower} after it started
        </span>
        {goalImpactingCount > 0 && (
          <span className="ml-1 text-neutral-text-secondary">
            · {goalImpactingCount} affect{goalImpactingCount === 1 ? 's' : ''} the {itl.lower} goal
          </span>
        )}
        {pendingCount > 0 && (
          <span className="block mt-0.5 text-neutral-text-secondary">
            <span aria-hidden="true">○</span> {pendingCount} pending acceptance — not yet
            counted in the commitment
          </span>
        )}
      </div>
      {pendingCount > 0 && canManageScope && onReview && (
        <button
          type="button"
          onClick={onReview}
          className="shrink-0 h-6 px-2 rounded-control text-xs font-medium
            border border-neutral-border bg-neutral-surface text-neutral-text-primary
            hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Review ({pendingCount})
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss scope-injection notice"
        className="shrink-0 inline-flex items-center justify-center
          min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:h-6 md:w-6
          text-neutral-text-secondary hover:text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
      >
        ×
      </button>
    </div>
  );
}
