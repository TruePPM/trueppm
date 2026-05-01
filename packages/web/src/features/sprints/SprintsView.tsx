import { useMemo, useState } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import {
  useSprints,
  useSprintsByState,
  useSprintMutations,
  useSprintBurndown,
  useSprintCapacity,
  useProjectVelocity,
} from '@/hooks/useSprints';
import { SprintHeader } from './SprintHeader';
import { SprintGoalCard } from './SprintGoalCard';
import { AdvancingToMilestoneCard } from './AdvancingToMilestoneCard';
import { SprintTimelineStrip } from './SprintTimelineStrip';
import { SprintBurndownChart } from './SprintBurndownChart';
import { CapacityPreflight } from './CapacityPreflight';
import { VelocityPanel } from './VelocityPanel';
import { SprintBacklogTable } from './SprintBacklogTable';
import { MultiTeamLens } from './MultiTeamLens';
import { useSprintBacklog } from '@/hooks/useSprintBacklog';
import { useMyActiveSprints } from '@/hooks/useMyActiveSprints';
import { daysBetween } from './sprintMath';

/**
 * Sprints workspace — issue #227.
 *
 * Renders the Sprint header (title + status pill + actions), the
 * Goal/Milestone two-column grid, and the horizontal sprint timeline strip.
 * Burndown / capacity / velocity panels (issue #228), backlog table (#229),
 * and remaining wave/10 features layer beneath this header in subsequent
 * MRs — this PR establishes the route and the page chrome.
 */
export function SprintsView() {
  const projectId = useProjectId();
  const projectQuery = useProject(projectId);
  const { sprints, isLoading, error } = useSprints(projectId);
  const buckets = useSprintsByState(projectId);
  const { closeSprint, createSprint } = useSprintMutations(projectId);

  // Sprint number is 1-based chronological index across all sprints (any state).
  // Derived once per data update so every child can read the same answer.
  const sprintNumberByID = useMemo(() => {
    const sorted = [...sprints].sort((a, b) =>
      a.start_date.localeCompare(b.start_date),
    );
    return new Map(sorted.map((s, i) => [s.id, i + 1]));
  }, [sprints]);

  const iterationWeeks = useMemo(() => {
    if (sprints.length === 0) return undefined;
    const widths = sprints.map((s) =>
      Math.max(1, daysBetween(s.start_date, s.finish_date) + 1),
    );
    widths.sort((a, b) => a - b);
    const median = widths[Math.floor(widths.length / 2)];
    return median !== undefined ? Math.round(median / 7) : undefined;
  }, [sprints]);

  const activeSprint = buckets.active;
  const hasPlannedSprint = buckets.planned.length > 0;
  const projectName = projectQuery.data?.name;

  // Metrics row queries — only fire when we have an active sprint.
  const burndown = useSprintBurndown(activeSprint?.id);
  const capacity = useSprintCapacity(activeSprint?.id);
  const velocity = useProjectVelocity(projectId);
  const backlog = useSprintBacklog(projectId, activeSprint?.id);
  const myTeams = useMyActiveSprints();
  const myTeamsCount = myTeams.data?.length ?? 0;
  // Toggle only useful when the user has assignments in ≥ 2 active sprints.
  const showLensToggle = myTeamsCount >= 2;
  const [scope, setScope] = useState<'project' | 'teams'>('project');
  const lensEntries = myTeams.data ?? [];

  function handlePlanNext() {
    // Scaffold: the sprint planning wizard ships in #229 (backlog) / #228
    // (capacity preflight). Until then the button no-ops to satisfy the
    // disabled-state acceptance criteria without committing UX shape that
    // a downstream wave issue is responsible for.
    if (hasPlannedSprint) return;
    void createSprint;
  }

  function handleCloseSprint() {
    if (!activeSprint) return;
    closeSprint.mutate({
      sprintId: activeSprint.id,
      payload: { carry_over_to: 'backlog' },
    });
  }

  function handleFilter() {
    // Filter popover ships in #229 alongside the backlog table.
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-neutral-surface">
      <nav
        aria-label="Breadcrumb"
        className="px-6 pt-5 flex items-center justify-between gap-3"
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
          <span className="truncate">{projectName ?? 'Project'}</span>
          <span aria-hidden="true" className="text-neutral-text-disabled">/</span>
          <span>Sprints</span>
        </div>
        {showLensToggle && (
          <div
            role="tablist"
            aria-label="Sprint scope"
            className="inline-flex rounded border border-neutral-border bg-neutral-surface text-xs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'project'}
              onClick={() => setScope('project')}
              className={`px-3 py-1 ${scope === 'project' ? 'bg-brand-primary/10 text-brand-primary font-medium' : 'text-neutral-text-secondary'}
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-l`}
            >
              This project
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'teams'}
              onClick={() => setScope('teams')}
              className={`px-3 py-1 ${scope === 'teams' ? 'bg-brand-primary/10 text-brand-primary font-medium' : 'text-neutral-text-secondary'}
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-r`}
            >
              My Teams ({myTeamsCount})
            </button>
          </div>
        )}
      </nav>

      {scope === 'teams' ? (
        <main className="flex-1 overflow-y-auto pb-6">
          <MultiTeamLens entries={lensEntries} />
        </main>
      ) : (
        <>
      <SprintHeader
        sprint={activeSprint}
        sprintNumber={
          activeSprint ? (sprintNumberByID.get(activeSprint.id) ?? 1) : 0
        }
        hasPlannedSprint={hasPlannedSprint}
        onPlanNext={handlePlanNext}
        onCloseSprint={handleCloseSprint}
        onFilter={handleFilter}
      />

      <main className="flex-1 overflow-y-auto px-6 pb-6 flex flex-col gap-4">
        {isLoading && (
          <p className="text-sm text-neutral-text-secondary">Loading sprints…</p>
        )}

        {error && (
          <p role="alert" className="text-sm text-semantic-critical">
            Could not load sprints. {error.message}
          </p>
        )}

        {!isLoading && !error && sprints.length === 0 && (
          <div
            role="status"
            className="rounded-md border border-dashed border-neutral-border bg-neutral-surface-raised p-6 text-center"
          >
            <p className="text-sm font-medium text-neutral-text-primary">
              No sprints yet
            </p>
            <p className="mt-1 text-xs text-neutral-text-secondary">
              Plan your first sprint to start tracking velocity and burn.
            </p>
          </div>
        )}

        {!isLoading && !error && activeSprint && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <div className="md:col-span-3">
                <SprintGoalCard sprint={activeSprint} />
              </div>
              <div className="md:col-span-2">
                <AdvancingToMilestoneCard sprint={activeSprint} projectId={projectId ?? ''} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <div className="md:col-span-3">
                {burndown.data ? (
                  <SprintBurndownChart
                    sprint={burndown.data.sprint}
                    snapshots={burndown.data.snapshots}
                  />
                ) : (
                  <ChartSkeleton label="Sprint Burndown" />
                )}
              </div>
              <div className="md:col-span-2 flex flex-col gap-4">
                {capacity.data ? (
                  <CapacityPreflight capacity={capacity.data} />
                ) : (
                  <ChartSkeleton label="Capacity Preflight" />
                )}
                {velocity.data ? (
                  <VelocityPanel velocity={velocity.data} />
                ) : (
                  <ChartSkeleton label="Velocity" />
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {!isLoading && !error && sprints.length > 0 && (
        <SprintTimelineStrip
          closed={buckets.closed}
          active={buckets.active}
          planned={buckets.planned}
          onPlanNext={handlePlanNext}
          iterationWeeks={iterationWeeks}
          milestoneName={activeSprint?.target_milestone_detail?.name ?? null}
        />
      )}

      {!isLoading && !error && activeSprint && projectId && (
        <SprintBacklogTable
          projectId={projectId}
          sprintId={activeSprint.id}
          tasks={backlog.data ?? []}
        />
      )}
        </>
      )}
    </div>
  );
}

function ChartSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${label}`}
      className="rounded-md border border-neutral-border bg-neutral-surface-raised p-4 min-h-[180px] flex items-center justify-center"
    >
      <span className="text-xs text-neutral-text-disabled">Loading {label}…</span>
    </div>
  );
}
