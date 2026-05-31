import { useState } from 'react';
import type { Task } from '@/types';

interface Props {
  /** Every task the board is rendering. The banner derives its counts from
   *  `sprintScopeChanges` which the API only populates for tasks linked to an
   *  active sprint, so no per-sprint filter is needed at the call site. */
  tasks: Task[];
}

/**
 * Mid-sprint scope-injection banner (ADR-0101 §5).
 *
 * Renders a team-visible summary at the top of the board whenever any task in
 * the active sprint carries a `SprintScopeChange` row — i.e. it was added
 * after the sprint was activated. The PO/SM are also notified via the email
 * pipeline (ADR-0085) but the board banner is the durable, whole-team record
 * that satisfies Morgan's whole-team-default requirement.
 *
 * Counts:
 *  - tasks: distinct tasks injected (one task may carry multiple
 *    scope-change rows over the sprint's life)
 *  - goal-impacting: subset where any row's `goalImpact` is true
 *
 * Renders nothing when nothing was injected. The banner is dismissible per
 * session (sessionStorage) so a quiet sprint isn't crowded by a banner the
 * team has already seen — but it returns on the next injection.
 */
export function BoardScopeInjectionBanner({ tasks }: Props) {
  const injected = tasks.filter((t) => (t.sprintScopeChanges?.length ?? 0) > 0);
  const goalImpactingCount = injected.filter((t) =>
    (t.sprintScopeChanges ?? []).some((sc) => sc.goalImpact),
  ).length;

  // Per-session dismissal: the key includes the count so a new injection
  // re-shows the banner after a dismiss; deliberate behavior (the team
  // should see new scope changes, not "I already dismissed it once").
  const key = `trueppm.scopeInjectionBanner.dismissed.${injected.length}.${goalImpactingCount}`;
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
          {injected.length} task{injected.length === 1 ? '' : 's'} added to the active sprint after it started
        </span>
        {goalImpactingCount > 0 && (
          <span className="ml-1 text-neutral-text-secondary">
            · {goalImpactingCount} affect{goalImpactingCount === 1 ? 's' : ''} the sprint goal
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss scope-injection notice"
        className="shrink-0 inline-flex items-center justify-center
          min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:h-6 sm:w-6
          text-neutral-text-secondary hover:text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
      >
        ×
      </button>
    </div>
  );
}
