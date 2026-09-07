/**
 * The single sentence used by the two surfaces that render a full velocity CARD
 * for a reader below the velocity audience (ADR-0104 §2.1 — velocity is
 * team-private by default): the Board's velocity card
 * (`features/board/SprintPanel.tsx`) and the Sprints page's velocity panel
 * (`features/sprints/VelocityPanel.tsx`).
 *
 * Before #3472 only the Board read `velocity_suppressed`; the Sprints panel read
 * the nulled `sprints: []` the server sends alongside it and rendered "No closed
 * sprints yet" over four COMPLETED sprints — the same absence with two
 * contradictory explanations, one of them false. The anchors are rule 246/300
 * (a state must not fall through to a branch that reads as "nothing here") and
 * this tree's own rule 379(e).
 *
 * **This is NOT the whole velocity-privacy family, and saying so here matters**
 * (rule 395(c)). Four other surfaces state the same verdict in their own words
 * and deliberately do not import this: `MultiTeamLens` ("Team-private", a
 * compact per-row chip), `healthClusterModel`'s velocity-gated row ("Kept to the
 * team"), `MilestoneBridgeForecast` ("Hidden by this team's signal settings",
 * whose own docstring argues for that wording), and — with a different SUBJECT
 * rather than a different wording — `SprintForecastWidget` /
 * `FlowAnalyticsPanel`. Unifying them behind a `SignalPrivacyNote({ subject })`
 * is what would make the family provably agree; it is filed as #3507,
 * not implied by this module's existence.
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
 *
 * Takes no props: both mount sites render it bare, and a `className` escape hatch
 * with no caller is a dead API on a brand-new module that `web:knip` cannot see
 * (it reports exports, not unused props).
 */
export function VelocityTeamPrivateNote() {
  return (
    <p className="text-xs text-neutral-text-secondary" data-testid="velocity-suppressed">
      <LockIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />
      {VELOCITY_TEAM_PRIVATE_MESSAGE}
    </p>
  );
}
