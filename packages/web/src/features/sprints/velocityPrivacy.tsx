/**
 * The single sentence the product uses for a velocity signal the reader may not
 * see (ADR-0104 §2.1 — velocity is team-private by default).
 *
 * It lives here, in one module, because the same absence surfaces on two pages:
 * the Board's velocity card (`features/board/SprintPanel.tsx`) and the Sprints
 * page's velocity panel (`features/sprints/VelocityPanel.tsx`). Before #3472 only
 * the Board read `velocity_suppressed`; the Sprints panel read the nulled
 * `sprints: []` the server sends alongside it and rendered "No closed sprints
 * yet" over four COMPLETED sprints — the same absence with two contradictory
 * explanations, one of them false (web rule 301: a client reading of a server
 * verdict must never fall through to the neutral branch).
 *
 * Two copies of a sentence drift, so there is one, and it is a constant rather
 * than a duplicated literal.
 */
import { LockIcon } from '@/components/Icons';

/**
 * The suppressed-state sentence. Exported so a test can assert the Board and the
 * Sprints page state the SAME thing, rather than each asserting its own literal.
 */
export const VELOCITY_TEAM_PRIVATE_MESSAGE = 'Velocity is team-private (visible to the team).';

/**
 * Renders {@link VELOCITY_TEAM_PRIVATE_MESSAGE} with the house padlock (rule 242
 * — a house SVG, never an emoji; `aria-hidden` because the sentence carries the
 * meaning, rule 6).
 */
export function VelocityTeamPrivateNote({ className = '' }: { className?: string }) {
  return (
    <p
      className={`text-xs text-neutral-text-secondary ${className}`}
      data-testid="velocity-suppressed"
    >
      <LockIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />
      {VELOCITY_TEAM_PRIVATE_MESSAGE}
    </p>
  );
}
