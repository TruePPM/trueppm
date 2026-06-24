import { useMemo } from 'react';
import type { ApiSprint } from '@/types';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { SprintGoalCard } from './SprintGoalCard';
import { AdvancingToMilestoneCard } from './AdvancingToMilestoneCard';
import { predecessorsInSprint } from './sprintMath';

interface Props {
  sprint: ApiSprint;
  projectId: string;
  /** Render-gate for inline goal editing (server independently enforces). */
  canEdit: boolean;
  /** Task ids committed to this sprint — intersected with the milestone's
   *  predecessors to show "N of M predecessor tasks land in this sprint". */
  sprintTaskIds: readonly string[];
}

/**
 * Planning-state bridge banner (#866, ADR-0094 §1) — the PLANNED-state mirror of
 * the active-sprint "advancing to milestone" surface. A two-column band that
 * frames the sprint's *draft goal* (left) next to the *schedule milestone it
 * advances* (right), making the agile→waterfall bridge explicit at planning time:
 * the team states an outcome and binds it to the CPM milestone that outcome moves.
 *
 * Composes the existing, tested {@link SprintGoalCard} (relabeled "Draft sprint
 * goal") and {@link AdvancingToMilestoneCard} (which carries the milestone
 * picker + rollup) rather than reimplementing either; the new planning-specific
 * value it adds is the bridge framing and the predecessor-intersection count,
 * derived here from the server-supplied `target_milestone_detail.predecessor_ids`.
 *
 * Rendered only on PLANNED state — the caller gates on `sprint.state`.
 */
export function SprintPlanningBridge({ sprint, projectId, canEdit, sprintTaskIds }: Props) {
  const itl = useIterationLabel();
  const predecessors = useMemo(
    () =>
      predecessorsInSprint(
        sprint.target_milestone_detail?.predecessor_ids,
        sprintTaskIds,
      ),
    [sprint.target_milestone_detail?.predecessor_ids, sprintTaskIds],
  );

  return (
    <section
      aria-labelledby="sprint-planning-bridge-heading"
      className="rounded-card border border-brand-primary/20 bg-brand-primary/5 p-3 flex flex-col gap-3"
    >
      <h2
        id="sprint-planning-bridge-heading"
        className="text-xs font-semibold tracking-widest uppercase text-brand-primary-dark flex items-center gap-2"
      >
        <span aria-hidden="true">◆</span>
        Planning bridge — this {itl.lower}&rsquo;s goal advances a schedule milestone
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="md:col-span-3">
          <SprintGoalCard
            sprint={sprint}
            projectId={projectId}
            canEdit={canEdit}
            heading={`Draft ${itl.lower} goal`}
          />
        </div>
        <div className="md:col-span-2">
          <AdvancingToMilestoneCard
            sprint={sprint}
            projectId={projectId}
            predecessorsInSprint={predecessors}
          />
        </div>
      </div>
    </section>
  );
}
