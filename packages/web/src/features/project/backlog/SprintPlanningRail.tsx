import { CapacityPreflight } from '@/features/sprints/CapacityPreflight';
import { formatShortDate } from '@/features/sprints/sprintMath';
import { useSprintCapacity } from '@/hooks/useSprints';
import type { ApiSprint } from '@/types';

interface Props {
  plannedSprint: ApiSprint;
  /** Story points committed to the planned sprint (derived from the backlog). */
  committedPoints: number;
  storyCount: number;
  /** Iteration noun (sprint / iteration / PI …) — ADR-0111/0116. */
  iterationLower: string;
}

/**
 * The sprint-planning rail on the Product Backlog (issue 1291).
 *
 * Desktop-only (`hidden lg:flex`) right column that turns the backlog into a
 * one-surface planning view: while the PO commits stories on the left (via the
 * per-row toggle), this reflects live capacity (reusing CapacityPreflight) and
 * names the milestone the planned sprint advances — so "does this story fit, and
 * does it serve the right milestone?" is answered without leaving the backlog.
 *
 * Milestone mapping is read-only here; binding/changing it stays on the sprint
 * panel (the keystone bridge action), so this surface never duplicates that flow.
 */
export function SprintPlanningRail({
  plannedSprint,
  committedPoints,
  storyCount,
  iterationLower,
}: Props) {
  const capacity = useSprintCapacity(plannedSprint.id);
  const milestone = plannedSprint.target_milestone_detail;
  const variance = milestone?.rollup?.variance_days;

  return (
    <aside
      aria-label={`${iterationLower} planning summary`}
      className="hidden w-[320px] shrink-0 flex-col gap-3 self-stretch overflow-auto border-l border-neutral-border bg-app-canvas p-4 lg:flex"
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary">
            Planning
          </h2>
          <span className="tppm-mono text-xs text-neutral-text-secondary">
            {plannedSprint.short_id_display}
          </span>
          <span className="rounded-chip border border-neutral-border px-1.5 py-px text-xs font-medium text-neutral-text-secondary">
            Planned
          </span>
        </div>
        <p className="tppm-mono text-xs text-neutral-text-secondary">
          {formatShortDate(plannedSprint.start_date)} → {formatShortDate(plannedSprint.finish_date)}
        </p>
      </div>

      {capacity.isLoading ? (
        <div
          className="h-32 motion-safe:animate-pulse rounded-card border border-neutral-border bg-neutral-surface"
          aria-hidden
        />
      ) : capacity.data ? (
        <CapacityPreflight
          capacity={capacity.data}
          points={{ committed: committedPoints, capacity: plannedSprint.capacity_points }}
        />
      ) : null}

      <div className="rounded-card border border-neutral-border bg-neutral-surface p-3">
        {milestone ? (
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-1.5 text-xs font-medium text-neutral-text-primary">
              <span aria-hidden className="text-brand-accent-dark">
                ◆
              </span>
              <span className="truncate">{milestone.name}</span>
            </p>
            <p className="text-xs text-neutral-text-secondary">
              {milestone.finish && (
                <>
                  Due <span className="tppm-mono">{formatShortDate(milestone.finish)}</span>
                </>
              )}
              {milestone.rollup?.percent_complete != null && (
                <>
                  {' · '}
                  <span className="tppm-mono">
                    {Math.round(milestone.rollup.percent_complete)}%
                  </span>{' '}
                  complete
                </>
              )}
            </p>
            {variance != null && variance !== 0 && (
              <p
                className={`text-xs ${variance > 0 ? 'text-semantic-at-risk' : 'text-semantic-on-track'}`}
              >
                {variance > 0 ? '+' : ''}
                <span className="tppm-mono">{variance}d</span> vs milestone
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-neutral-text-secondary">
            No milestone linked — bind one on the {iterationLower} panel.
          </p>
        )}
      </div>

      <p className="text-xs text-neutral-text-secondary">
        <span className="tppm-mono font-semibold text-neutral-text-primary">{committedPoints}</span>{' '}
        pts committed across <span className="tppm-mono">{storyCount}</span>{' '}
        {storyCount === 1 ? 'story' : 'stories'}
      </p>
    </aside>
  );
}
