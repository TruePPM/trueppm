import { RetroBoardSurface } from './RetroBoardSurface';

interface Props {
  sprintId: string;
  /** True when the sprint is COMPLETED — switches copy to read-only emphasis. */
  isClosed: boolean;
  /**
   * @deprecated since ADR-0071. Action items no longer auto-promote on save.
   * Promotion happens via the explicit Promote button per item.
   */
  promoteToSprintId?: string | null;
  /** When the requesting user can change visibility (retro author or Project ADMIN+). */
  canEditVisibility?: boolean;
  /** Sprint lifecycle state, when known, so the board can gate read-only / not-yet-open. */
  sprintState?: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
}

/**
 * Sprint retrospective panel — bottom of the Sprints view.
 *
 * Since #851 / ADR-0117 this is the live multi-writer retro board: it delegates
 * to {@link RetroBoardSurface}, which composes the sticky columns (multi-writer),
 * the single-author action items + the #858 "Promote ↗" button (preserved
 * unchanged), the facilitator notes field, and the team-health pulse (#923).
 *
 * The original single-author behaviors are all preserved by the surface:
 *  - below the retro's ``team_visibility`` threshold it renders the counts-only
 *    ``RetroSummaryCard`` (psych-safety per ADR-0071 §3);
 *  - ``PriorRetroSection`` and ``RetroVisibilityToggle`` are unchanged;
 *  - the action-items save / promote / "Save first" states are intact.
 *
 * The public export, props, and the summary-card fallback are kept stable so
 * existing callers (SprintsView) and tests continue to work.
 */
export function RetroPanel({ sprintId, isClosed, canEditVisibility = false, sprintState }: Props) {
  return (
    <RetroBoardSurface
      sprintId={sprintId}
      isClosed={isClosed}
      canEditVisibility={canEditVisibility}
      sprintState={sprintState}
    />
  );
}
