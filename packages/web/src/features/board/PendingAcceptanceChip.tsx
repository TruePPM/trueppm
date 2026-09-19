import { RadioDotIcon } from '@/components/Icons';
import { CardPeekButton } from './CardPeekButton';

/**
 * Pending-acceptance chip for mid-sprint scope-injection (ADR-0102 §6, #882 rule).
 *
 * A task injected into an active sprint after activation is visible but NOT yet
 * part of the commitment (excluded from burndown) until a team-owned actor
 * accepts or rejects it. This chip is the read-state badge for that condition.
 *
 * IMPORTANT (frontend/CLAUDE.md rule 149): pending is a NEUTRAL read-state, not
 * a warning. It uses the neutral/gray surface + a hollow ○ glyph — NEVER amber
 * or red. It must never read as an error, a notification, or a guardrail notice.
 * This single component is the shared source for both the planning board and
 * the contributor "My Work" row, so the two surfaces can never drift in tone.
 *
 * It is a passive label: it carries no accept/reject controls of its own. The
 * decision affordances live on the board card / review panel (planning
 * surfaces, role-gated) and never in the me tree.
 *
 * When {@link Props.explainer} is supplied (#1472) the chip becomes an
 * interactive *disclosure*: tapping it opens a neutral popover with a
 * plain-language explanation plus a "Got it" close button. This exists so a
 * plain Member — who sees the pending signal but has no reachable accept/reject
 * — can understand it instead of staring at a control she can't touch. The
 * explainer is *close-only and ephemeral*: it grants NO accept/reject capability
 * and persists nothing. Pending is a server-owned transient (ADR-0102); the chip
 * stays until the server clears it on accept/reject.
 */
interface Props {
  /** Compact variant drops the text label, keeping only the glyph + a11y name.
   *  Used in dense board-card contexts where the banner already explains scope. */
  compact?: boolean;
  className?: string;
  /**
   * Plain-language, role-neutral explanation sentence (#1472). When present the
   * chip renders as an interactive disclosure trigger; when absent it stays the
   * passive read-state label (its original form), preserving the passivity
   * contract on read-only surfaces and all existing snapshot expectations.
   *
   * Build it with {@link pendingAcceptanceExplainer} so board and My Work never
   * drift; the board passes the configured iteration label, My Work the default.
   */
  explainer?: string;
}

/**
 * Compose the neutral, role-neutral pending-acceptance explanation sentence.
 *
 * Role-neutral by design (#1472): acceptance authority is *any* Admin/Scrum
 * Master/Product Owner holder, not one deterministic person — so the copy names
 * the outcome ("someone on the team accepts it"), never a specific role, which
 * would be wrong on a PO-run board or in cross-project My Work. The "sprint"
 * default is a lib-level fallback (not JSX copy — the iteration-label lint gate
 * targets JSX text/display attributes, not helper strings); board callers pass
 * `useIterationLabel().lower` so the noun follows the project configuration.
 *
 * @param iterationLabelLower Lowercase iteration-container noun (e.g. "sprint",
 *   "iteration"). Defaults to "sprint" for surfaces with no single project
 *   context (My Work is cross-project).
 * @returns One plain-language sentence, outcome-only, no state-machine jargon.
 */
export function pendingAcceptanceExplainer(iterationLabelLower = 'sprint'): string {
  return (
    `Added after the ${iterationLabelLower} started — it won't count toward the ` +
    'committed plan until someone on the team accepts it.'
  );
}

/** Shared neutral chip surface — identical tokens for the passive span and the
 *  interactive trigger, so the two forms are visually indistinguishable at rest
 *  (rule 149: never amber/red). */
const CHIP_SURFACE =
  'inline-flex items-center gap-0.5 rounded-chip px-1 py-px text-xs font-medium ' +
  'bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-border';

export function PendingAcceptanceChip({ compact = false, className, explainer }: Props) {
  // No explainer → the original passive label. Kept a hook-free early return so
  // read-only surfaces mount zero disclosure state and the passivity tests
  // (queryByRole('button') absent) stay green.
  if (explainer === undefined) {
    return (
      <span
        className={[CHIP_SURFACE, className ?? ''].join(' ')}
        title={
          // This shared chip also renders in cross-project "My Work" (features/me),
          // where no single project's iteration label applies — so the generic
          // "sprint" wording is intentional rather than read from useIterationLabel().
          // eslint-disable-next-line no-restricted-syntax -- see comment above
          'Added after the sprint started — awaiting acceptance. Not yet counted in the commitment.'
        }
        aria-label="Pending acceptance"
      >
        <RadioDotIcon aria-hidden="true" filled={false} className="h-2.5 w-2.5 shrink-0" />
        {!compact && <span>Pending acceptance</span>}
      </span>
    );
  }

  return <InteractivePendingChip compact={compact} className={className} explainer={explainer} />;
}

/**
 * Interactive disclosure variant (#1472), built on the shared rule-253 peek
 * mechanism (`CardPeekButton`, #1947): portaled `role="note"` popover with
 * Escape / "Got it" close + focus return, outside-pointerdown dismissal,
 * scroll/resize repositioning, and `stopPropagation` so opening the explainer
 * never selects, drags, or opens the card.
 */
function InteractivePendingChip({
  compact,
  className,
  explainer,
}: {
  compact: boolean;
  className?: string;
  explainer: string;
}) {
  return (
    // Wrapper is a `<span>` (phrasing content) so the chip stays valid inside
    // the My Work `<p>`; `CardPeekButton` portals its popover to document.body.
    <span className={['inline-flex', className ?? ''].join(' ')}>
      <CardPeekButton
        triggerContent={
          <>
            <RadioDotIcon aria-hidden="true" filled={false} className="h-2.5 w-2.5 shrink-0" />
            {!compact && <span>Pending acceptance</span>}
          </>
        }
        triggerClassName={CHIP_SURFACE}
        ariaLabel="Pending acceptance. What does this mean?"
        peekAriaLabel="Pending acceptance — explanation"
      >
        {explainer}
      </CardPeekButton>
    </span>
  );
}
