import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import {
  useSprints,
  useSprintsByState,
  useSprintMutations,
  useSprintCapacity,
  useProjectVelocity,
  useSprintOutcome,
  type CapacityWarning,
} from '@/hooks/useSprints';
import { ExcludeFromVelocityToggle } from './ExcludeFromVelocityToggle';
import { SprintClosedOutcome } from './SprintClosedOutcome';
import { SprintHeader } from './SprintHeader';
import { SprintGoalCard } from './SprintGoalCard';
import { AdvancingToMilestoneCard } from './AdvancingToMilestoneCard';
import { SprintPlanningBridge } from './SprintPlanningBridge';
import { IncomingCarryoverCard } from './IncomingCarryoverCard';
import { SprintTimelineStrip } from './SprintTimelineStrip';
import { BurnChart } from '@/features/reports/BurnChart';
import { CapacityPreflight } from './CapacityPreflight';
import { VelocityPanel } from './VelocityPanel';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { SprintBacklogTable } from './SprintBacklogTable';
import { GuardrailHealthBadges } from './GuardrailHealthBadges';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { MultiTeamLens } from './MultiTeamLens';
import { PlanSprintModal } from './PlanSprintModal';
import {
  SprintFilterPopover,
  applySprintFilter,
  type SprintFilterValue,
} from './SprintFilterPopover';
import { CloseSprintDialog } from './CloseSprintDialog';
import { ScopePendingReviewPanel } from './ScopePendingReviewPanel';
import { useCanManageScope } from '@/hooks/useCanManageScope';
import { useCanEditSprintGoal } from '@/hooks/useCanEditSprintGoal';
import { RetroPanel } from './RetroPanel';
import { useSprintBacklog } from '@/hooks/useSprintBacklog';
import { useMyActiveSprints } from '@/hooks/useMyActiveSprints';
import { useCurrentUserResourceId } from '@/hooks/useCurrentUserResourceId';
import { daysBetween } from './sprintMath';
import { TaskFormModal } from '@/features/board/TaskFormModal';

function sprintFilterKey(sprintId: string): string {
  return `trueppm.sprintFilter.${sprintId}`;
}

function readStoredFilter(sprintId: string): SprintFilterValue | null {
  try {
    const raw = window.sessionStorage.getItem(sprintFilterKey(sprintId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { assignee?: unknown; statuses?: unknown };
    const assignee: SprintFilterValue['assignee'] =
      typeof parsed.assignee === 'string' ? parsed.assignee : 'anyone';
    const statuses = Array.isArray(parsed.statuses)
      ? new Set(parsed.statuses.filter((s): s is string => typeof s === 'string'))
      : new Set<string>();
    return { assignee, statuses: statuses as SprintFilterValue['statuses'] };
  } catch {
    return null;
  }
}

function writeStoredFilter(sprintId: string, value: SprintFilterValue): void {
  try {
    window.sessionStorage.setItem(
      sprintFilterKey(sprintId),
      JSON.stringify({
        assignee: value.assignee,
        statuses: Array.from(value.statuses),
      }),
    );
  } catch {
    // sessionStorage disabled or full — in-memory state is still in effect.
  }
}

const EMPTY_FILTER: SprintFilterValue = { assignee: 'anyone', statuses: new Set() };

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
  const itl = useIterationLabel();
  const { sprints, isLoading, error } = useSprints(projectId);
  const buckets = useSprintsByState(projectId);
  const { closeSprint, activateSprint } = useSprintMutations(projectId);
  const { resourceId: myResourceId } = useCurrentUserResourceId(projectId ?? undefined);
  // Project-wide tasks feed the Tier-3 health badges (ADR-0101 §4) — orphan
  // and summary-in-sprint counts are *project*-level, not per-sprint, so they
  // can't be computed from `backlogTasks` (active sprint only). TanStack Query
  // caches this list with the Schedule view, so we don't refetch on tab swap.
  const { tasks: projectTasks } = useScheduleTasks(projectId ?? undefined);
  // SCHEDULER+ can pull retro action items into a PLANNED sprint.
  const { role: currentRole } = useCurrentUserRole(projectId ?? undefined);
  const canPullCarryover = (currentRole ?? -1) >= ROLE_SCHEDULER;

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
  const plannedSprint = buckets.planned[0] ?? null;
  const hasPlannedSprint = buckets.planned.length > 0;
  const projectName = projectQuery.data?.name;

  // The timeline strip is a sprint SELECTOR (ADR-0094 + #567 amendment): the
  // workspace body renders the state-appropriate surface for the SELECTED sprint
  // so a user can review ANY past sprint, not just the most-recently-closed one.
  // Lifecycle actions (Close/Plan/Activate) stay tied to the real active/planned
  // sprint regardless of selection (one-active-sprint model). Default selection:
  // active → next planned → most-recently-closed.
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedSprintId !== null) return;
    const fallback =
      activeSprint?.id ??
      plannedSprint?.id ??
      buckets.closed[buckets.closed.length - 1]?.id ??
      null;
    if (fallback) setSelectedSprintId(fallback);
  }, [selectedSprintId, activeSprint, plannedSprint, buckets.closed]);
  const selectedSprint = useMemo(
    () => sprints.find((s) => s.id === selectedSprintId) ?? null,
    [sprints, selectedSprintId],
  );
  // The consolidated review read (#985) — the server-owned source for the CLOSED
  // outcome cards + "didn't ship". Only fetched for a closed selection; the
  // active view keeps its existing burndown/capacity/velocity panels.
  const outcomeQuery = useSprintOutcome(selectedSprint?.id, {
    enabled: !!selectedSprint && selectedSprint.state === 'COMPLETED',
  });

  // Metrics row queries — only fire when we have an active sprint.
  const capacity = useSprintCapacity(activeSprint?.id);
  const velocity = useProjectVelocity(projectId);
  const backlog = useSprintBacklog(projectId, activeSprint?.id);
  const plannedBacklog = useSprintBacklog(projectId, plannedSprint?.id);
  // Capacity for the PLANNED surface (#495/#864) — same per-person + aggregate
  // read the ACTIVE view uses, plus the points chip derived below.
  const plannedCapacity = useSprintCapacity(plannedSprint?.id);
  const myTeams = useMyActiveSprints();
  const queryClient = useQueryClient();
  const updateTask = useUpdateTask();
  const myTeamsCount = myTeams.data?.length ?? 0;
  // Toggle only useful when the user has assignments in ≥ 2 active sprints.
  const showLensToggle = myTeamsCount >= 2;
  const [scope, setScope] = useState<'project' | 'teams'>('project');
  const [planOpen, setPlanOpen] = useState(false);
  // Edit-mode for the planned sprint card "Edit" button (#299).
  const [editSprintId, setEditSprintId] = useState<string | null>(null);
  // Close-sprint dialog (#299) replaces the old direct closeSprint.mutate call.
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  // Scope-injection review slide-over (ADR-0102 §5) — alt entry to the board
  // banner's Review button. Gated by useCanManageScope (render-gate only).
  const [scopeReviewOpen, setScopeReviewOpen] = useState(false);
  const canManageScope = useCanManageScope(projectId ?? undefined);
  // Goal-edit follows the Scrum-Master facet (or Admin+), distinct from the
  // scope-accept gate above (#1095 / ADR-0078).
  const canEditGoal = useCanEditSprintGoal(projectId ?? undefined);
  // Task create modal — opens with the target sprint pre-populated.
  // null = modal closed; a sprint id string = modal open targeting that sprint.
  const [addTaskForSprintId, setAddTaskForSprintId] = useState<string | null>(null);
  // Sprint backlog filter (#299) — popover open + value, persisted in
  // sessionStorage keyed by active sprint id. Bound to the Filter button
  // anchor for placement.
  const [filterOpen, setFilterOpen] = useState(false);
  const filterAnchorRef = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<SprintFilterValue>(EMPTY_FILTER);
  const [filterHydratedFor, setFilterHydratedFor] = useState<string | null>(null);
  // Capacity warnings surfaced by the activate response — cleared when
  // the user dismisses the banner or the active sprint changes.
  const [capacityWarnings, setCapacityWarnings] = useState<CapacityWarning[]>([]);
  const lensEntries = myTeams.data ?? [];

  // Hydrate the filter from sessionStorage when the active sprint changes.
  // The filter is per-sprint so a tab swap or active-sprint rollover starts
  // fresh unless the user has previously persisted a value for that sprint.
  useEffect(() => {
    if (!activeSprint) {
      setFilter(EMPTY_FILTER);
      setFilterHydratedFor(null);
      return;
    }
    if (filterHydratedFor === activeSprint.id) return;
    const stored = readStoredFilter(activeSprint.id);
    setFilter(stored ?? EMPTY_FILTER);
    setFilterHydratedFor(activeSprint.id);
  }, [activeSprint, filterHydratedFor]);

  // Reset capacity warnings when the active sprint rolls over.
  useEffect(() => {
    setCapacityWarnings([]);
  }, [activeSprint?.id]);

  // ⌘K / Ctrl+K opens the task create modal pre-targeted at the active sprint,
  // or the planned sprint when there is no active sprint yet.
  useEffect(() => {
    const targetSprint = activeSprint ?? plannedSprint;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && targetSprint) {
        e.preventDefault();
        setAddTaskForSprintId(targetSprint.id);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activeSprint, plannedSprint]);

  const editingSprint = useMemo(() => {
    if (!editSprintId) return undefined;
    return buckets.planned.find((s) => s.id === editSprintId);
  }, [editSprintId, buckets.planned]);

  // Filtered backlog feeds the SprintBacklogTable; the metrics row continues
  // to receive the unfiltered list so burndown / capacity / velocity reflect
  // the whole sprint regardless of the user's view filter.
  const backlogTasks = useMemo(() => backlog.data ?? [], [backlog.data]);
  const filteredBacklog = useMemo(
    () => applySprintFilter(backlogTasks, filter, myResourceId),
    [backlogTasks, filter, myResourceId],
  );
  const plannedBacklogTasks = useMemo(() => plannedBacklog.data ?? [], [plannedBacklog.data]);
  // Draft points load (#864, ADR-0094 §3): sum of story points over *assigned*
  // tasks in the planned backlog — the planning chip's numerator against
  // capacity_points. Client-derived (the ADR sanctions it); the authoritative
  // committed math stays server-side on committed_points.
  const plannedDraftPoints = useMemo(
    () =>
      plannedBacklogTasks.reduce(
        (sum, t) => (t.assignments.length > 0 ? sum + (t.story_points ?? 0) : sum),
        0,
      ),
    [plannedBacklogTasks],
  );
  // Task ids committed to the planned sprint, for the bridge's predecessor count.
  const plannedTaskIds = useMemo(
    () => plannedBacklogTasks.map((t) => t.id),
    [plannedBacklogTasks],
  );

  function handlePlanNext() {
    if (hasPlannedSprint) return;
    setPlanOpen(true);
  }

  function handleCloseSprint() {
    if (!activeSprint) return;
    setCloseDialogOpen(true);
  }

  function handleConfirmClose(
    carryOverTo: string,
    pendingDisposition?: 'carry' | 'reject',
  ) {
    if (!activeSprint) return;
    closeSprint.mutate(
      {
        sprintId: activeSprint.id,
        payload: {
          carry_over_to: carryOverTo,
          ...(pendingDisposition ? { pending_disposition: pendingDisposition } : {}),
        },
      },
      {
        onSuccess: () => setCloseDialogOpen(false),
      },
    );
  }

  function handleFilter() {
    setFilterOpen((open) => !open);
  }

  function handleFilterChange(next: SprintFilterValue) {
    setFilter(next);
    if (activeSprint) writeStoredFilter(activeSprint.id, next);
  }

  function handleActivateSprint(sprintId: string) {
    activateSprint.mutate(sprintId, {
      onSuccess: (data) => {
        setCapacityWarnings(data.warnings ?? []);
      },
    });
  }

  function handleEditPlanned(sprintId: string) {
    setEditSprintId(sprintId);
  }

  function handleRemoveFromSprint(taskId: string) {
    if (!projectId) return;
    updateTask.mutate({ id: taskId, projectId, sprint: null }, {
      onSuccess: () => {
        // Invalidate both active and planned sprint backlog caches.
        void queryClient.invalidateQueries({ queryKey: ['sprint-backlog', projectId] });
      },
    });
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
          <span>{itl.plural}</span>
        </div>
        {showLensToggle && (
          <div
            role="tablist"
            aria-label={`${itl.singular} scope`}
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
        filterButtonRef={filterAnchorRef}
      />
      {/* Popover places itself in fixed coords from the Filter button so it
          stays anchored regardless of horizontal layout overflow. */}
      {activeSprint && (
        <SprintFilterPopover
          open={filterOpen}
          anchorRef={filterAnchorRef}
          value={filter}
          onChange={handleFilterChange}
          tasks={backlogTasks}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {/* Tier-3 health badges (ADR-0101 §4, #988) — read-only signals owned by
          the server (count, verdict, tone, and copy); renders nothing when the
          endpoint returns no signals so the surface fades away on healthy
          projects. */}
      <div className="mx-6 mt-2 flex items-center justify-between gap-2 flex-wrap">
        <GuardrailHealthBadges projectId={projectId} />
        {/* Alt entry to the scope-injection review (ADR-0102 §5) — mirrors the
            board banner's Review button. Render-gated by canManageScope; the
            server is the real gate. */}
        {activeSprint && (activeSprint.pending_count ?? 0) > 0 && canManageScope && (
          <button
            type="button"
            onClick={() => setScopeReviewOpen(true)}
            className="shrink-0 h-7 px-2 rounded text-xs font-medium
              border border-neutral-border bg-neutral-surface text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <span aria-hidden="true">○</span> Review pending ({activeSprint.pending_count})
          </button>
        )}
      </div>

      {capacityWarnings.length > 0 && (
        <div
          role="alert"
          className="mx-6 mt-2 rounded-md border border-semantic-at-risk/40 bg-semantic-at-risk-bg
            text-semantic-at-risk px-3 py-2 text-xs flex items-start justify-between gap-3"
        >
          <div className="flex flex-col gap-1">
            <p className="font-medium">
              {itl.singular} activated with {capacityWarnings.length} capacity warning
              {capacityWarnings.length === 1 ? '' : 's'}
            </p>
            <ul className="list-disc list-inside space-y-0.5">
              {capacityWarnings.slice(0, 3).map((w) => (
                <li key={w.resource_id}>{w.message}</li>
              ))}
              {capacityWarnings.length > 3 && (
                <li className="italic">
                  and {capacityWarnings.length - 3} more…
                </li>
              )}
            </ul>
          </div>
          <button
            type="button"
            onClick={() => setCapacityWarnings([])}
            className="shrink-0 text-xs underline hover:no-underline
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-at-risk focus-visible:ring-offset-1 rounded"
          >
            Dismiss
          </button>
        </div>
      )}

      <main className="flex-1 overflow-y-auto pb-6 flex flex-col gap-4">
        <div className="px-6 flex flex-col gap-4">
        {isLoading && (
          <p className="text-sm text-neutral-text-secondary">Loading {itl.lowerPlural}…</p>
        )}

        {error && (
          <p role="alert" className="text-sm text-semantic-critical">
            Could not load {itl.lowerPlural}. {error.message}
          </p>
        )}

        {!isLoading && !error && sprints.length === 0 && (
          <div
            role="status"
            className="rounded-md border border-dashed border-neutral-border bg-neutral-surface-raised p-6 text-center"
          >
            <p className="text-sm font-medium text-neutral-text-primary">
              No {itl.lowerPlural} yet
            </p>
            <p className="mt-1 text-xs text-neutral-text-secondary">
              Plan your first {itl.lower} to start tracking velocity and burn.
            </p>
          </div>
        )}

        {!isLoading && !error && selectedSprint && (
          <>
            {/* PLANNED (#495/#866) — the planning bridge banner (draft goal ↔
                advancing milestone) replaces the generic two-card header so the
                agile→waterfall link is explicit at planning time. ACTIVE/CLOSED
                keep the standard goal + milestone grid. */}
            {selectedSprint.state === 'PLANNED' ? (
              <SprintPlanningBridge
                sprint={selectedSprint}
                projectId={projectId ?? ''}
                canEdit={canEditGoal}
                sprintTaskIds={
                  selectedSprint.id === plannedSprint?.id ? plannedTaskIds : []
                }
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                <div className="md:col-span-3">
                  <SprintGoalCard
                    sprint={selectedSprint}
                    projectId={projectId ?? ''}
                    canEdit={canEditGoal && selectedSprint.state !== 'COMPLETED'}
                  />
                </div>
                <div className="md:col-span-2">
                  <AdvancingToMilestoneCard sprint={selectedSprint} projectId={projectId ?? ''} />
                </div>
              </div>
            )}

            {/* ADR-0113: team-owned "Sprint 0" escape hatch. Available in every
                state (settable post-close); SCHEDULER+ writes, others read-only. */}
            <ExcludeFromVelocityToggle
              sprint={selectedSprint}
              projectId={projectId ?? ''}
              canEdit={(currentRole ?? -1) >= ROLE_SCHEDULER}
            />

            {/* ACTIVE — burndown + capacity + velocity (unchanged this MR; the
                ADR-0094 "launcher" dedup is a follow-up). */}
            {selectedSprint.state === 'ACTIVE' && (
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                <div className="md:col-span-3">
                  <BurnChart sprintId={selectedSprint.id} defaultVariant="burndown" />
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
            )}

            {/* CLOSED — read-only outcome (5-card row + "what didn't ship") bound
                to /outcome/, plus the frozen historical burndown. */}
            {selectedSprint.state === 'COMPLETED' && (
              <div className="flex flex-col gap-4">
                {outcomeQuery.data ? (
                  <SprintClosedOutcome outcome={outcomeQuery.data} />
                ) : (
                  <ChartSkeleton label="Sprint outcome" />
                )}
                <BurnChart sprintId={selectedSprint.id} defaultVariant="burndown" />
              </div>
            )}
          </>
        )}
        </div>

        {!isLoading && !error && sprints.length > 0 && (
          <SprintTimelineStrip
            closed={buckets.closed}
            active={buckets.active}
            planned={buckets.planned}
            selectedSprintId={selectedSprint?.id ?? null}
            onSelect={setSelectedSprintId}
            onPlanNext={handlePlanNext}
            onActivate={handleActivateSprint}
            onEditPlanned={handleEditPlanned}
            iterationWeeks={iterationWeeks}
            milestoneName={activeSprint?.target_milestone_detail?.name ?? null}
          />
        )}

        {/* Editable backlog only for the active sprint when it is selected. */}
        {!isLoading && !error && selectedSprint?.id === activeSprint?.id && activeSprint && projectId && (
          <SprintBacklogTable
            projectId={projectId}
            sprintId={activeSprint.id}
            tasks={filteredBacklog}
            onAddTask={() => setAddTaskForSprintId(activeSprint.id)}
            onRemoveTask={handleRemoveFromSprint}
          />
        )}

        {/* PLANNED unified surface (#495, ADR-0094 §1): priority-ordered backlog
            on the left; capacity gauge (#864 points chip + footer), incoming
            carryover preview (#865), and a collapsed velocity panel on the right
            — the whole sprint-commitment conversation on one surface. */}
        {!isLoading && !error && selectedSprint?.id === plannedSprint?.id && plannedSprint && projectId && (
          <div className="px-6 grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
            <div className="lg:col-span-3 rounded-md border border-neutral-border overflow-hidden">
              <SprintBacklogTable
                projectId={projectId}
                sprintId={plannedSprint.id}
                tasks={plannedBacklogTasks}
                onAddTask={() => setAddTaskForSprintId(plannedSprint.id)}
                onRemoveTask={handleRemoveFromSprint}
                showCarryoverLane
                canPullCarryover={canPullCarryover}
              />
            </div>
            <div className="lg:col-span-2 flex flex-col gap-4">
              {plannedCapacity.data ? (
                <CapacityPreflight
                  capacity={plannedCapacity.data}
                  points={{
                    committed: plannedDraftPoints,
                    capacity: plannedSprint.capacity_points,
                  }}
                />
              ) : (
                <ChartSkeleton label="Capacity Preflight" />
              )}
              <IncomingCarryoverCard
                sprintId={plannedSprint.id}
                currentSprintShortId={plannedSprint.short_id_display}
              />
              {velocity.data && (
                <details className="rounded-md border border-neutral-border bg-neutral-surface">
                  <summary
                    className="cursor-pointer px-4 py-2 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-md"
                  >
                    Velocity
                  </summary>
                  <div className="px-4 pb-4">
                    <VelocityPanel velocity={velocity.data} />
                  </div>
                </details>
              )}
            </div>
          </div>
        )}

        {/* Retro follows the selected sprint when it is active or closed (the
            two states a retro belongs to); hidden for a planned selection. */}
        {!isLoading &&
          !error &&
          selectedSprint &&
          (selectedSprint.state === 'ACTIVE' || selectedSprint.state === 'COMPLETED') && (
            <RetroPanel
              sprintId={selectedSprint.id}
              isClosed={selectedSprint.state === 'COMPLETED'}
              sprintState={selectedSprint.state}
            />
          )}
      </main>
        </>
      )}

      {planOpen && projectId && (
        <PlanSprintModal
          projectId={projectId}
          defaultStart={
            buckets.planned[buckets.planned.length - 1]?.finish_date ??
            activeSprint?.finish_date
          }
          onClose={() => setPlanOpen(false)}
        />
      )}

      {editingSprint && projectId && (
        <PlanSprintModal
          projectId={projectId}
          existingSprint={{
            id: editingSprint.id,
            name: editingSprint.name,
            goal: editingSprint.goal ?? '',
            start_date: editingSprint.start_date,
            finish_date: editingSprint.finish_date,
          }}
          onClose={() => setEditSprintId(null)}
        />
      )}

      {closeDialogOpen && activeSprint && (
        <CloseSprintDialog
          sprint={activeSprint}
          nextPlannedSprintId={buckets.planned[0]?.id ?? null}
          nextPlannedSprintName={buckets.planned[0]?.name ?? null}
          backlogTasks={backlogTasks}
          isClosing={closeSprint.isPending}
          onCancel={() => setCloseDialogOpen(false)}
          onConfirm={handleConfirmClose}
        />
      )}

      {scopeReviewOpen && projectId && activeSprint && canManageScope && (
        <ScopePendingReviewPanel
          projectId={projectId}
          sprintId={activeSprint.id}
          tasks={projectTasks ?? []}
          offline={typeof navigator !== 'undefined' && !navigator.onLine}
          onClose={() => setScopeReviewOpen(false)}
        />
      )}

      {addTaskForSprintId !== null && projectId && (
        <TaskFormModal
          projectId={projectId}
          task={null}
          defaultSprintId={addTaskForSprintId}
          isMobile={false}
          onClose={() => setAddTaskForSprintId(null)}
        />
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
