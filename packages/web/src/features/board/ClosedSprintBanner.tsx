/**
 * Closed-sprint read-only banner (#1141, ADR-0123).
 *
 * Rendered below the sprint header and above the grid when the selected sprint
 * is COMPLETED. Viewing a closed sprint's board is a legitimate retrospective
 * read, but card moves must never back-date scope into a closed sprint — drag
 * is disabled board-wide (see `readOnly` threading in BoardView) and this banner
 * explains why.
 *
 * Tone is NEUTRAL (rule 149): a closed sprint is an inert state, not a warning —
 * the sunken surface + `neutral-text-secondary` reads as "informational, not
 * actionable", NEVER amber/red. The 🔒 glyph is `aria-hidden`; the banner text
 * carries the full meaning.
 */
import { useIterationLabel } from '@/hooks/useIterationLabel';

interface ClosedSprintBannerProps {
  projectId: string;
}

export function ClosedSprintBanner({ projectId }: ClosedSprintBannerProps) {
  const itl = useIterationLabel(projectId);
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-y border-neutral-border bg-neutral-surface-sunken
        px-4 py-2 text-sm text-neutral-text-secondary"
    >
      <span aria-hidden="true">🔒</span>
      <span>
        Closed {itl.singular.toLowerCase()} — read only. Card moves won&rsquo;t change this{' '}
        {itl.singular.toLowerCase()}&rsquo;s scope.
      </span>
      {/* itl.singular defaults to "Sprint" so the copy reads
          "Closed sprint — read only…" on a default project (ADR-0111). */}
    </div>
  );
}
