import { CloseIcon } from '@/components/Icons';
import type { GroupingOutcome } from './buildMode/groupOutcome';

export interface GroupOutcomeNoticeProps {
  outcome: GroupingOutcome | null;
  onDismiss: () => void;
}

/**
 * "4 items are now a phase" — what Group / Ungroup just did (#2955, epic #2946).
 *
 * A strip rather than a toast for one reason: the sentence tells the user there is
 * **nothing else to fill in**, and it is answering a question they are asking while
 * looking at the phase's empty date and estimate cells. A toast that has faded by the
 * time they look down has answered nobody. It dismisses on the next act, and by hand.
 *
 * **Deliberately not a live region.** `ConversionNotice` next to it is `role="status"`
 * because nothing else announces that transition; this one is announced through the
 * outline's existing polite region by `recordAct`, the same channel and the same
 * sentence (`flattenOutcome`). Marking it `role="status"` as well would speak the whole
 * outcome twice — the double-announcement web rule 30 exists to prevent, and the reason
 * `recordAct`'s docstring says "one helper rather than a call at each site".
 *
 * `left_alone` renders here rather than being folded into the headline because it is the
 * part that changes what the user does next: a planner who selected six rows and got a
 * phase of four needs to see the four *and* the two, together, or the group reads as a
 * bug in the product rather than as the rule it is.
 */
export function GroupOutcomeNotice({ outcome, onDismiss }: GroupOutcomeNoticeProps) {
  if (!outcome) return null;

  return (
    <div
      data-testid="group-outcome-notice"
      className="flex items-start gap-2 px-4 py-2 border-b border-neutral-border
        bg-neutral-surface-sunken text-xs text-neutral-text-secondary flex-shrink-0"
    >
      <span className="flex-1">
        <b className="font-medium text-neutral-text-primary">{outcome.headline}</b>{' '}
        {outcome.detail}
        {outcome.leftAlone !== null && (
          <>
            {' '}
            {/* The rows the server did not wrap. Same tone as the rest — this is the
                rule working, not an error, and styling it as a warning would teach the
                user to distrust a correct outcome. */}
            <span data-testid="group-left-alone" className="text-neutral-text-secondary">
              {outcome.leftAlone}
            </span>
          </>
        )}
        {outcome.warning !== null && (
          <>
            {' '}
            <span data-testid="group-outcome-warning" className="text-neutral-text-primary">
              {outcome.warning}
            </span>
          </>
        )}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-neutral-text-secondary hover:text-neutral-text-primary
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control"
      >
        <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
