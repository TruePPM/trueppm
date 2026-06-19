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
 */
interface Props {
  /** Compact variant drops the text label, keeping only the glyph + a11y name.
   *  Used in dense board-card contexts where the banner already explains scope. */
  compact?: boolean;
  className?: string;
}

export function PendingAcceptanceChip({ compact = false, className }: Props) {
  return (
    <span
      className={[
        'inline-flex items-center gap-0.5 rounded-chip px-1 py-px text-xs font-medium',
        'bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-border',
        className ?? '',
      ].join(' ')}
      title="Added after the sprint started — awaiting acceptance. Not yet counted in the commitment."
      aria-label="Pending acceptance"
    >
      <span aria-hidden="true" className="leading-none">
        ○
      </span>
      {!compact && <span>Pending acceptance</span>}
    </span>
  );
}
