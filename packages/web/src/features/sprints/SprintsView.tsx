import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_SCHEDULER } from '@/lib/roles';
import { useProjectId } from '@/hooks/useProjectId';
import { setSearchParam, useUrlSelectedId } from '@/hooks/useUrlSelectedId';
import { useProject } from '@/hooks/useProject';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { isSyncConflict } from '@/api/conflict';
import { extractValidationMessage } from '@/lib/apiError';
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
import { SprintReforecastCard } from './SprintReforecastCard';
import { SprintDailyDeltaPanel } from './SprintDailyDeltaPanel';
import { BlockedRollupPanel } from '@/features/blocker/BlockedRollupPanel';
import { SprintHeader } from './SprintHeader';
import { SprintGoalCard } from './SprintGoalCard';
import { AdvancingToMilestoneCard } from './AdvancingToMilestoneCard';
import { SprintPlanningBridge } from './SprintPlanningBridge';
import { EstimationPokerCard } from './poker/EstimationPokerCard';
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
import { StoryPickerModal } from './StoryPickerModal';
import {
  SprintFilterPopover,
  applySprintFilter,
  type SprintFilterValue,
} from './SprintFilterPopover';
import { CloseSprintDialog } from './CloseSprintDialog';
import { buildCarryoverToast, carryoverAdvanceTarget } from './carryoverToast';
import { toast } from '@/components/Toast/toast';
import { RetroHandoffBanner } from './RetroHandoffBanner';
import { ScopePendingReviewPanel } from './ScopePendingReviewPanel';
import { useCanManageScope } from '@/hooks/useCanManageScope';
import { useCanEditSprintGoal } from '@/hooks/useCanEditSprintGoal';
import { EmptyState } from '@/components/EmptyState';
import { MethodologyEmptyState } from '@/features/shell/MethodologyEmptyState';
import { isTypingInInput } from '@/hooks/useGlobalShortcut';
import { QueryErrorState } from '@/components/QueryErrorState';
import { Button } from '@/components/Button';
import { RadioDotIcon, SprintIcon } from '@/components/Icons';
import { RetroPanel } from './RetroPanel';
import { useSprintBacklog, type SprintBacklogTask } from '@/hooks/useSprintBacklog';
import { useMyActiveSprints } from '@/hooks/useMyActiveSprints';
import { useCurrentUserResourceId } from '@/hooks/useCurrentUserResourceId';
import { daysBetween } from './sprintMath';
import { TaskFormModal } from '@/features/board/TaskFormModal';
import { TaskDetailDrawer } from '@/features/schedule/TaskDetailDrawer';
import type { ApiSprint, Methodology, Task, TaskStatus } from '@/types';

type IterationLabel = ReturnType<typeof useIterationLabel>;
type CloseSprintMutation = ReturnType<typeof useSprintMutations>['closeSprint'];
type ActivateSprintMutation = ReturnType<typeof useSprintMutations>['activateSprint'];
type CapacityQuery = ReturnType<typeof useSprintCapacity>;
type VelocityQuery = ReturnType<typeof useProjectVelocity>;
type OutcomeQuery = ReturnType<typeof useSprintOutcome>;

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

// Scope-switcher option order — drives the roving-tabindex arrow navigation on
// the segmented radiogroup (web-rule 179/167).
const SCOPE_ORDER = ['project', 'teams'] as const;
type SprintScope = (typeof SCOPE_ORDER)[number];

// The task statuses close-time carry-over actually moves — mirrors the backend
// `_CARRY_OVER_INCOMPLETE_STATUSES` (projects/services.py). Used to estimate the
// carried count for the close-success toast (#1470, ADR-0232); ON_HOLD and
// COMPLETE are deliberately excluded because apply_carry_over leaves them behind.
const CARRY_OVER_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'BACKLOG',
  'NOT_STARTED',
  'IN_PROGRESS',
  'REVIEW',
]);

// ---------------------------------------------------------------------------
// Pure derivations (kept out of the component so its render stays a thin
// composition — issue #2355 cognitive-complexity decomposition).
// ---------------------------------------------------------------------------

/** 1-based chronological sprint number (any state) keyed by sprint id. */
function computeSprintNumbers(sprints: ApiSprint[]): Map<string, number> {
  const sorted = [...sprints].sort((a, b) => a.start_date.localeCompare(b.start_date));
  return new Map(sorted.map((s, i) => [s.id, i + 1]));
}

/** Median sprint length rounded to whole weeks, or undefined when there are none. */
function computeIterationWeeks(sprints: ApiSprint[]): number | undefined {
  if (sprints.length === 0) return undefined;
  const widths = sprints.map((s) => Math.max(1, daysBetween(s.start_date, s.finish_date) + 1));
  widths.sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)];
  return median !== undefined ? Math.round(median / 7) : undefined;
}

/** Index the project task list by id for the backlog → drawer round-trip. */
function indexTasksById(tasks: Task[] | undefined): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const t of tasks ?? []) map.set(t.id, t);
  return map;
}

/** Draft points load (#864, ADR-0094 §3): story points over *assigned* tasks. */
function sumAssignedStoryPoints(tasks: SprintBacklogTask[]): number {
  return tasks.reduce(
    (sum, t) => (t.assignments.length > 0 ? sum + (t.story_points ?? 0) : sum),
    0,
  );
}

// ---------------------------------------------------------------------------
// State hooks — each groups a cohesive slice of the workspace's local state,
// effects, and handlers so no single function carries the whole surface.
// ---------------------------------------------------------------------------

/**
 * The selected-sprint selector (ADR-0094 + #567 amendment). Owns `selectedSprintId`,
 * mirrors it into `?sprint=<id>` (#2046), and resolves the default selection
 * (active → next planned → most-recently-closed) when the param is absent.
 */
function useSelectedSprint(
  sprints: ApiSprint[],
  activeSprint: ApiSprint | null,
  plannedSprint: ApiSprint | null,
  closed: ApiSprint[],
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSprintId, setSelectedSprintIdState] = useState<string | null>(() =>
    searchParams.get('sprint'),
  );
  const setSelectedSprintId = useCallback(
    (id: string | null) => {
      setSelectedSprintIdState(id);
      setSearchParam(setSearchParams, 'sprint', id);
    },
    [setSearchParams],
  );
  useEffect(() => {
    if (selectedSprintId !== null) return;
    const fallback = activeSprint?.id ?? plannedSprint?.id ?? closed[closed.length - 1]?.id ?? null;
    if (fallback) setSelectedSprintId(fallback);
  }, [selectedSprintId, activeSprint, plannedSprint, closed, setSelectedSprintId]);
  const selectedSprint = useMemo(
    () => sprints.find((s) => s.id === selectedSprintId) ?? null,
    [sprints, selectedSprintId],
  );
  return { selectedSprintId, selectedSprint, setSelectedSprintId };
}

/**
 * The per-sprint backlog filter (#299), persisted in sessionStorage keyed by the
 * active sprint id. Hydrates fresh on active-sprint rollover.
 */
function useSprintFilter(activeSprint: ApiSprint | null) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<SprintFilterValue>(EMPTY_FILTER);
  const [filterHydratedFor, setFilterHydratedFor] = useState<string | null>(null);

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

  const handleFilter = useCallback(() => setFilterOpen((open) => !open), []);
  const handleFilterChange = useCallback(
    (next: SprintFilterValue) => {
      setFilter(next);
      if (activeSprint) writeStoredFilter(activeSprint.id, next);
    },
    [activeSprint],
  );

  return { filter, filterOpen, setFilterOpen, handleFilter, handleFilterChange };
}

/**
 * The `c` quick-create shortcut — opens the task-create modal pre-targeted at the
 * active sprint (or the planned sprint when none is active). Single-key, so it
 * routes through the shared typing guard and yields whenever a modal owns the
 * surface (#1557, #2162).
 */
function useQuickCreateShortcut(activeSprint: ApiSprint | null, plannedSprint: ApiSprint | null) {
  const [addTaskForSprintId, setAddTaskForSprintId] = useState<string | null>(null);

  useEffect(() => {
    const targetSprint = activeSprint ?? plannedSprint;
    if (!targetSprint) return;
    const targetId = targetSprint.id;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key !== 'c') return;
      if (isTypingInInput(e.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      setAddTaskForSprintId(targetId);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activeSprint, plannedSprint]);

  return { addTaskForSprintId, setAddTaskForSprintId };
}

/**
 * The close-sprint dialog + post-close retro handoff (#299, #1470/ADR-0232, #1471).
 * Owns the close confirmation, the carryover toast + auto-advance, and the deep-link
 * scroll to the just-closed sprint's retro.
 */
function useCloseAndRetro({
  activeSprint,
  plannedSprints,
  backlogTasks,
  closeSprint,
  itl,
  selectedSprintId,
  setSelectedSprintId,
}: {
  activeSprint: ApiSprint | null;
  plannedSprints: ApiSprint[];
  backlogTasks: SprintBacklogTask[];
  closeSprint: CloseSprintMutation;
  itl: IterationLabel;
  selectedSprintId: string | null;
  setSelectedSprintId: (id: string | null) => void;
}) {
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [retroHandoff, setRetroHandoff] = useState<{
    sprintId: string;
    sprintName: string;
  } | null>(null);
  const [scrollToRetro, setScrollToRetro] = useState(false);
  const retroSectionRef = useRef<HTMLDivElement>(null);

  function handleCloseSprint() {
    if (!activeSprint) return;
    setCloseDialogOpen(true);
  }

  function handleConfirmClose(carryOverTo: string, pendingDisposition?: 'carry' | 'reject') {
    if (!activeSprint) return;
    // Capture the sprint being closed before the mutation invalidates the list
    // and it leaves the active bucket — the retro handoff must reference this
    // exact sprint, not whatever becomes active after the refetch.
    const closing = { sprintId: activeSprint.id, sprintName: activeSprint.name };
    // Carryover summary for the close-success toast + auto-advance (#1470,
    // ADR-0232). Computed here at confirm time from the active sprint's backlog:
    // the close is async (202 queued), so the exact server-side moved count isn't
    // known yet — this is the carry-eligible estimate. The authoritative
    // per-assignee signal is the backend in-app notification; this toast is the
    // closer's immediate confirmation. carryOverTo is 'backlog', 'none', or a
    // destination sprint UUID (the dialog resolves the "next planned" choice to
    // the sprint id before calling us), so a non-literal value is a real sprint.
    const carriedCount = backlogTasks.filter((t) => CARRY_OVER_STATUSES.has(t.status)).length;
    const advanceTo = carryoverAdvanceTarget(carryOverTo);
    const destName = advanceTo ? (plannedSprints[0]?.name ?? null) : null;
    closeSprint.mutate(
      {
        sprintId: activeSprint.id,
        payload: {
          carry_over_to: carryOverTo,
          ...(pendingDisposition ? { pending_disposition: pendingDisposition } : {}),
        },
      },
      {
        onSuccess: () => {
          setCloseDialogOpen(false);
          setRetroHandoff(closing);
          // Confirm what moved where (#1470). The toast host is an aria-live
          // region, so this doubles as the SR announcement for the programmatic
          // selection change below (no extra live region needed).
          toast.success(
            buildCarryoverToast(closing.sprintName, carriedCount, carryOverTo, destName),
          );
          // Auto-advance: land on the destination sprint so the user sees where
          // the work went, not the just-closed tab. Only when carrying to a real
          // sprint — backlog/none have no destination tab. Does not fight the
          // retro-handoff banner, which is keyed off retroHandoff state (not the
          // selection) and still offers a one-tap jump back to the closed sprint's
          // retro. No focus move — the aria-live toast covers the context shift.
          if (advanceTo) {
            setSelectedSprintId(advanceTo);
          }
        },
        // The dialog only closes in onSuccess, so a failed close leaves it open
        // with no other signal. Fire an explicit error toast so the user knows
        // the sprint was not closed and can retry (issue 1631).
        onError: () => {
          toast.error(`Couldn't close the ${itl.lower} — try again.`);
        },
      },
    );
  }

  function handleRunRetro() {
    if (!retroHandoff) return;
    // Deep-link: select the just-closed sprint so its RetroPanel is the one
    // rendered, then scroll+focus it once the selection re-render commits.
    setSelectedSprintId(retroHandoff.sprintId);
    setRetroHandoff(null);
    setScrollToRetro(true);
  }

  // Scroll the retro surface into view after "Run the retro" selects the closed
  // sprint. Depends on selectedSprintId so it runs after the re-render mounts the
  // correct sprint's panel; focus moves to the region for keyboard/SR users.
  useEffect(() => {
    if (!scrollToRetro) return;
    const el = retroSectionRef.current;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.focus();
    }
    setScrollToRetro(false);
  }, [scrollToRetro, selectedSprintId]);

  return {
    closeDialogOpen,
    setCloseDialogOpen,
    handleCloseSprint,
    handleConfirmClose,
    retroHandoff,
    setRetroHandoff,
    handleRunRetro,
    retroSectionRef,
  };
}

/**
 * Sprint activation + the capacity warnings the activate response surfaces. Lifecycle
 * is a SCHEDULER+ write (#2146); the handler guards in depth even though the
 * affordance is already role-gated at render.
 */
function useActivateSprint({
  activeSprintId,
  canManageLifecycle,
  activateSprint,
  itl,
}: {
  activeSprintId: string | undefined;
  canManageLifecycle: boolean;
  activateSprint: ActivateSprintMutation;
  itl: IterationLabel;
}) {
  const [capacityWarnings, setCapacityWarnings] = useState<CapacityWarning[]>([]);

  // Reset capacity warnings when the active sprint rolls over.
  useEffect(() => {
    setCapacityWarnings([]);
  }, [activeSprintId]);

  function handleActivateSprint(sprintId: string) {
    if (!canManageLifecycle) return;
    activateSprint.mutate(sprintId, {
      onSuccess: (data) => {
        setCapacityWarnings(data.warnings ?? []);
      },
      // A failed activation — including the DESIGNED single-active-sprint 409
      // (ADR-0037) — otherwise does nothing on screen. Surface the server's own
      // reason so the user learns why the sprint didn't start, mirroring the
      // explicit close-sprint error toast in the same view (#2150, #1631).
      onError: (error) => {
        toast.error(
          extractValidationMessage(error, `Couldn't start the ${itl.lower} — try again.`),
        );
      },
    });
  }

  return { capacityWarnings, setCapacityWarnings, handleActivateSprint };
}

/**
 * Remove-from-sprint scope write (SCHEDULER+, #2146). Invalidates both active and
 * planned backlog caches; the optimistic 409 path is toasted by useUpdateTask.
 */
function useRemoveFromSprint({
  projectId,
  canManageLifecycle,
  itl,
}: {
  projectId: string | undefined;
  canManageLifecycle: boolean;
  itl: IterationLabel;
}) {
  const queryClient = useQueryClient();
  const updateTask = useUpdateTask();

  return useCallback(
    (taskId: string) => {
      if (!projectId || !canManageLifecycle) return;
      updateTask.mutate(
        { id: taskId, projectId, sprint: null },
        {
          onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['sprint-backlog', projectId] });
          },
          // useUpdateTask already toasts + rolls back the optimistic patch on a 409
          // conflict; a 403/500/network failure otherwise rolls back silently. Add
          // a generic fallback for those, guarded so it never stacks with the
          // conflict toast (#2150).
          onError: (error) => {
            if (!isSyncConflict(error)) {
              toast.error(`Couldn't remove the task from the ${itl.lower} — try again.`);
            }
          },
        },
      );
    },
    [projectId, canManageLifecycle, itl, queryClient, updateTask],
  );
}

/**
 * Sprints workspace — issue #227.
 *
 * Renders the Sprint header (title + status pill + actions), the
 * Goal/Milestone two-column grid, and the horizontal sprint timeline strip.
 * The heavy branch bodies are delegated to the leaf components below so this
 * function stays a thin composition (issue #2355).
 */
export function SprintsView() {
  const projectId = useProjectId();
  const projectQuery = useProject(projectId);
  const itl = useIterationLabel();
  const { sprints, isLoading, error, refetch } = useSprints(projectId);
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
  // Sprint lifecycle (plan / activate / edit-planned / close / scope-membership)
  // is a SCHEDULER+ write per the server gates (#2146). Pessimistic while the
  // role loads (`currentRole ?? -1`) so Plan/Activate/Close/Remove chrome never
  // flashes for a viewer who turns out to lack it. The server is authoritative.
  const canManageLifecycle = (currentRole ?? -1) >= ROLE_SCHEDULER;

  const sprintNumberByID = useMemo(() => computeSprintNumbers(sprints), [sprints]);
  const iterationWeeks = useMemo(() => computeIterationWeeks(sprints), [sprints]);

  const activeSprint = buckets.active;
  const plannedSprint = buckets.planned[0] ?? null;
  const hasPlannedSprint = buckets.planned.length > 0;
  const projectName = projectQuery.data?.name;
  // Server-resolved preset (web-rule 196) — WATERFALL hides the DELIVER nav group
  // (methodologyTabs.ts), but the route stays reachable by design (issue #2619).
  // Drives the explanatory empty state below and the orphaned-sprints banner.
  const effectiveMethodology = projectQuery.data?.effective_methodology ?? 'HYBRID';

  const { selectedSprintId, selectedSprint, setSelectedSprintId } = useSelectedSprint(
    sprints,
    activeSprint,
    plannedSprint,
    buckets.closed,
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
  const myTeamsCount = myTeams.data?.length ?? 0;
  // Toggle only useful when the user has assignments in ≥ 2 active sprints.
  const showLensToggle = myTeamsCount >= 2;
  const [scope, setScope] = useState<SprintScope>('project');
  const [planOpen, setPlanOpen] = useState(false);
  // Story picker (issue #2670) — multi-select existing backlog stories into the
  // PLANNED sprint without leaving this page. Opened from the planned surface's
  // "Pull from backlog" button; SprintModals renders the modal itself so its
  // focus trap sits alongside the other sprint-lifecycle modals.
  const [storyPickerOpen, setStoryPickerOpen] = useState(false);
  // Edit-mode for the planned sprint card "Edit" button (#299).
  const [editSprintId, setEditSprintId] = useState<string | null>(null);
  // Scope-injection review slide-over (ADR-0102 §5) — alt entry to the board
  // banner's Review button. Gated by useCanManageScope (render-gate only).
  const [scopeReviewOpen, setScopeReviewOpen] = useState(false);
  const canManageScope = useCanManageScope(projectId ?? undefined);
  // Goal-edit follows the Scrum-Master facet (or Admin+), distinct from the
  // scope-accept gate above (#1095 / ADR-0078).
  const canEditGoal = useCanEditSprintGoal(projectId ?? undefined);
  // Task detail drawer — opened by clicking a backlog row. Mirrors the
  // Board/Schedule pattern (ADR-0050); the shared hook round-trips `?task=` (#2031).
  const [selectedTaskId, setSelectedTaskId] = useUrlSelectedId('task');
  const taskIndex = useMemo(() => indexTasksById(projectTasks), [projectTasks]);
  const filterAnchorRef = useRef<HTMLButtonElement>(null);
  const lensEntries = myTeams.data ?? [];

  const { filter, filterOpen, setFilterOpen, handleFilter, handleFilterChange } =
    useSprintFilter(activeSprint);
  const { addTaskForSprintId, setAddTaskForSprintId } = useQuickCreateShortcut(
    activeSprint,
    plannedSprint,
  );

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
  const plannedDraftPoints = useMemo(
    () => sumAssignedStoryPoints(plannedBacklogTasks),
    [plannedBacklogTasks],
  );
  // Task ids committed to the planned sprint, for the bridge's predecessor count.
  const plannedTaskIds = useMemo(() => plannedBacklogTasks.map((t) => t.id), [plannedBacklogTasks]);

  const {
    closeDialogOpen,
    setCloseDialogOpen,
    handleCloseSprint,
    handleConfirmClose,
    retroHandoff,
    setRetroHandoff,
    handleRunRetro,
    retroSectionRef,
  } = useCloseAndRetro({
    activeSprint,
    plannedSprints: buckets.planned,
    backlogTasks,
    closeSprint,
    itl,
    selectedSprintId,
    setSelectedSprintId,
  });

  const { capacityWarnings, setCapacityWarnings, handleActivateSprint } = useActivateSprint({
    activeSprintId: activeSprint?.id,
    canManageLifecycle,
    activateSprint,
    itl,
  });

  const handleRemoveFromSprint = useRemoveFromSprint({ projectId, canManageLifecycle, itl });

  function handlePlanNext() {
    if (hasPlannedSprint) return;
    setPlanOpen(true);
  }

  function handleEditPlanned(sprintId: string) {
    setEditSprintId(sprintId);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-app-canvas">
      <nav aria-label="Breadcrumb" className="px-6 pt-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
          <span className="truncate">{projectName ?? 'Project'}</span>
          <span aria-hidden="true" className="text-neutral-text-disabled">
            /
          </span>
          <span>{itl.plural}</span>
        </div>
        {showLensToggle && (
          <SprintScopeSwitcher
            scope={scope}
            onScopeChange={setScope}
            myTeamsCount={myTeamsCount}
            itl={itl}
          />
        )}
      </nav>

      {scope === 'teams' ? (
        <div className="flex-1 overflow-y-auto pb-6">
          <MultiTeamLens entries={lensEntries} />
        </div>
      ) : (
        <>
          <SprintHeader
            sprint={activeSprint}
            sprintNumber={activeSprint ? (sprintNumberByID.get(activeSprint.id) ?? 1) : 0}
            hasPlannedSprint={hasPlannedSprint}
            onPlanNext={handlePlanNext}
            onCloseSprint={handleCloseSprint}
            onFilter={handleFilter}
            filterButtonRef={filterAnchorRef}
            canManageLifecycle={canManageLifecycle}
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

          <GuardrailRow
            projectId={projectId}
            activeSprint={activeSprint}
            canManageScope={canManageScope}
            onReview={() => setScopeReviewOpen(true)}
          />

          {/* A methodology flip to WATERFALL hides the DELIVER nav group but never
          touches sprint data (issue #2619) — without this, a team that already
          committed to sprints would see them vanish from the nav with no signal
          they still exist. */}
          {!isLoading && !error && effectiveMethodology === 'WATERFALL' && sprints.length > 0 && (
            <MethodologyMismatchBanner projectId={projectId} itl={itl} count={sprints.length} />
          )}

          <CapacityWarningsAlert
            warnings={capacityWarnings}
            itl={itl}
            onDismiss={() => setCapacityWarnings([])}
          />

          {/* Post-close retro handoff (issue 1471) — appears on close success,
          hands the team one tap into the just-closed sprint's retro. Sits above
          the scroll region so it stays visible regardless of scroll position. */}
          {retroHandoff && (
            <RetroHandoffBanner
              sprintName={retroHandoff.sprintName}
              iterationLabel={itl.lower}
              onRun={handleRunRetro}
              onDismiss={() => setRetroHandoff(null)}
            />
          )}

          <section
            aria-label={itl.plural}
            className="flex-1 overflow-y-auto pb-6 flex flex-col gap-4"
          >
            <div className="px-6 flex flex-col gap-4">
              <SprintStateBody
                isLoading={isLoading}
                error={error}
                sprints={sprints}
                selectedSprint={selectedSprint}
                projectId={projectId}
                plannedSprint={plannedSprint}
                plannedTaskIds={plannedTaskIds}
                plannedBacklogTasks={plannedBacklogTasks}
                canEditGoal={canEditGoal}
                canManageScope={canManageScope}
                currentRole={currentRole}
                activeSprint={activeSprint}
                capacity={capacity}
                velocity={velocity}
                outcomeQuery={outcomeQuery}
                projectTasks={projectTasks}
                itl={itl}
                effectiveMethodology={effectiveMethodology}
                onRetry={refetch}
                onPlanNext={handlePlanNext}
              />
            </div>

            <SprintTimeline
              ready={!isLoading && !error}
              sprints={sprints}
              buckets={buckets}
              selectedSprint={selectedSprint}
              canManageLifecycle={canManageLifecycle}
              onSelect={setSelectedSprintId}
              onPlanNext={handlePlanNext}
              onActivate={handleActivateSprint}
              onEditPlanned={handleEditPlanned}
              iterationWeeks={iterationWeeks}
              activeSprint={activeSprint}
            />

            <ActiveSprintBacklog
              ready={!isLoading && !error}
              selectedSprint={selectedSprint}
              activeSprint={activeSprint}
              projectId={projectId}
              tasks={filteredBacklog}
              canManageLifecycle={canManageLifecycle}
              onAddTask={setAddTaskForSprintId}
              onRemoveTask={handleRemoveFromSprint}
              onOpenTask={setSelectedTaskId}
            />

            <PlannedSprintSurface
              ready={!isLoading && !error}
              selectedSprint={selectedSprint}
              plannedSprint={plannedSprint}
              projectId={projectId}
              tasks={plannedBacklogTasks}
              plannedCapacity={plannedCapacity}
              plannedDraftPoints={plannedDraftPoints}
              velocity={velocity}
              canManageLifecycle={canManageLifecycle}
              canPullCarryover={canPullCarryover}
              onAddTask={setAddTaskForSprintId}
              onRemoveTask={handleRemoveFromSprint}
              onOpenTask={setSelectedTaskId}
              onOpenPicker={() => setStoryPickerOpen(true)}
            />

            <SprintRetroSection
              ready={!isLoading && !error}
              selectedSprint={selectedSprint}
              retroSectionRef={retroSectionRef}
            />
          </section>
        </>
      )}

      <SprintModals
        projectId={projectId}
        buckets={buckets}
        activeSprint={activeSprint}
        planOpen={planOpen}
        onClosePlan={() => setPlanOpen(false)}
        editingSprint={editingSprint}
        onCloseEdit={() => setEditSprintId(null)}
        closeDialogOpen={closeDialogOpen}
        backlogTasks={backlogTasks}
        isClosing={closeSprint.isPending}
        onCancelClose={() => setCloseDialogOpen(false)}
        onConfirmClose={handleConfirmClose}
        scopeReviewOpen={scopeReviewOpen}
        canManageScope={canManageScope}
        projectTasks={projectTasks}
        onCloseScopeReview={() => setScopeReviewOpen(false)}
        addTaskForSprintId={addTaskForSprintId}
        onCloseAddTask={() => setAddTaskForSprintId(null)}
        selectedTaskId={selectedTaskId}
        taskIndex={taskIndex}
        onCloseTaskDrawer={() => setSelectedTaskId(null)}
        onSwapCanceled={(keptId) => setSelectedTaskId(keptId)}
        storyPickerOpen={storyPickerOpen}
        plannedSprint={plannedSprint}
        plannedDraftPoints={plannedDraftPoints}
        sprintPickerReadyOnlyDefault={
          projectQuery.data?.effective_sprint_picker_ready_only_default ?? true
        }
        onCloseStoryPicker={() => setStoryPickerOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaf components — each owns its own render guard so the workspace above
// stays a flat composition.
// ---------------------------------------------------------------------------

/**
 * Scope switcher — the house segmented radiogroup (web-rule 179/167), NOT a
 * tablist. Roving tabindex, wrapping Arrow + Home/End that commit the selection
 * immediately (the swap is non-destructive), and the rule-179 `bg-brand-primary`
 * active fill so selection is conveyed by fill, not text shade alone. `focus:`
 * (not `focus-visible:`) per rule 4/214 so the ring renders on the scripted
 * `.focus()` the arrow keys drive.
 */
function SprintScopeSwitcher({
  scope,
  onScopeChange,
  myTeamsCount,
  itl,
}: {
  scope: SprintScope;
  onScopeChange: (scope: SprintScope) => void;
  myTeamsCount: number;
  itl: IterationLabel;
}) {
  const scopeRadioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onScopeKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      const current = SCOPE_ORDER.indexOf(scope);
      let next: number;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        next = (current + 1) % SCOPE_ORDER.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        next = (current - 1 + SCOPE_ORDER.length) % SCOPE_ORDER.length;
      } else if (e.key === 'Home') {
        next = 0;
      } else if (e.key === 'End') {
        next = SCOPE_ORDER.length - 1;
      } else {
        return;
      }
      e.preventDefault();
      onScopeChange(SCOPE_ORDER[next]);
      scopeRadioRefs.current[next]?.focus();
    },
    [scope, onScopeChange],
  );

  return (
    <div
      role="radiogroup"
      aria-label={`${itl.singular} scope`}
      className="inline-flex rounded border border-neutral-border bg-neutral-surface overflow-hidden text-xs"
    >
      {SCOPE_ORDER.map((value, i) => {
        const selected = scope === value;
        const label = value === 'project' ? 'This project' : `My Teams (${myTeamsCount})`;
        return (
          <button
            key={value}
            ref={(el) => {
              scopeRadioRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onScopeChange(value)}
            onKeyDown={onScopeKeyDown}
            className={`px-3 py-1 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-primary ${
              selected
                ? 'bg-brand-primary text-neutral-text-inverse font-medium'
                : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Tier-3 health badges (ADR-0101 §4, #988) plus the alt entry to the
 * scope-injection review (ADR-0102 §5) — mirrors the board banner's Review
 * button. Render-gated by canManageScope; the server is the real gate.
 */
function GuardrailRow({
  projectId,
  activeSprint,
  canManageScope,
  onReview,
}: {
  projectId: string | undefined;
  activeSprint: ApiSprint | null;
  canManageScope: boolean;
  onReview: () => void;
}) {
  const showReview = !!activeSprint && (activeSprint.pending_count ?? 0) > 0 && canManageScope;
  return (
    <div className="mx-6 mt-2 flex items-center justify-between gap-2 flex-wrap">
      <GuardrailHealthBadges projectId={projectId} />
      {showReview && activeSprint && (
        <button
          type="button"
          onClick={onReview}
          className="shrink-0 h-7 px-2 rounded text-xs font-medium
        border border-neutral-border bg-neutral-surface text-neutral-text-primary
        hover:bg-neutral-surface-raised
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          <RadioDotIcon
            aria-hidden="true"
            filled={false}
            className="mr-1 inline-block h-2.5 w-2.5 align-[-0.125em]"
          />
          Review pending ({activeSprint.pending_count})
        </button>
      )}
    </div>
  );
}

/** Capacity warnings surfaced by the activate response — dismissible; auto-clears
 *  when the active sprint changes (handled by useActivateSprint). */
function CapacityWarningsAlert({
  warnings,
  itl,
  onDismiss,
}: {
  warnings: CapacityWarning[];
  itl: IterationLabel;
  onDismiss: () => void;
}) {
  if (warnings.length === 0) return null;
  return (
    <div
      role="alert"
      className="mx-6 mt-2 rounded-card border border-semantic-at-risk/40 bg-semantic-at-risk-bg
    text-semantic-at-risk px-3 py-2 text-xs flex items-start justify-between gap-3"
    >
      <div className="flex flex-col gap-1">
        <p className="font-medium">
          {itl.singular} activated with {warnings.length} capacity warning
          {warnings.length === 1 ? '' : 's'}
        </p>
        <ul className="list-disc list-inside space-y-0.5">
          {warnings.slice(0, 3).map((w) => (
            <li key={w.resource_id}>{w.message}</li>
          ))}
          {warnings.length > 3 && <li className="italic">and {warnings.length - 3} more…</li>}
        </ul>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-xs underline hover:no-underline
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-at-risk focus-visible:ring-offset-1 rounded"
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * Explains why sprints are visible on a project now configured as WATERFALL
 * (issue #2619). A methodology flip hides the DELIVER nav group but never
 * touches sprint data — including sprints a team already committed to — so
 * without this notice they become reachable only by URL with no on-screen
 * signal they still exist. Read-only; routes to Settings → Methodology so
 * reintegrating them is a deliberate choice, never a silent fix.
 */
function MethodologyMismatchBanner({
  projectId,
  itl,
  count,
}: {
  projectId: string | undefined;
  itl: IterationLabel;
  count: number;
}) {
  const navigate = useNavigate();
  const noun = count === 1 ? itl.lower : itl.lowerPlural;
  return (
    <div
      role="status"
      className="mx-6 mt-2 rounded-card border border-semantic-at-risk/40 bg-semantic-at-risk-bg
    text-semantic-at-risk px-3 py-2 text-xs flex items-center justify-between gap-3 flex-wrap"
    >
      <p>
        This project is configured as Waterfall, but {count} {noun} already{' '}
        {count === 1 ? 'is' : 'are'} committed here — they stay reachable even though they sit
        outside its workflow.
      </p>
      <button
        type="button"
        onClick={() => projectId && void navigate(`/projects/${projectId}/settings#methodology`)}
        className="shrink-0 text-xs font-semibold underline hover:no-underline
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-at-risk focus-visible:ring-offset-1 rounded"
      >
        Review methodology
      </button>
    </div>
  );
}

/** The px-6 stack body — loading skeleton / error / empty state, else the selected
 *  sprint's cards. Early returns keep the branch selection linear. */
function SprintStateBody({
  isLoading,
  error,
  sprints,
  selectedSprint,
  projectId,
  plannedSprint,
  plannedTaskIds,
  plannedBacklogTasks,
  canEditGoal,
  canManageScope,
  currentRole,
  activeSprint,
  capacity,
  velocity,
  outcomeQuery,
  projectTasks,
  itl,
  effectiveMethodology,
  onRetry,
  onPlanNext,
}: {
  isLoading: boolean;
  error: unknown;
  sprints: ApiSprint[];
  selectedSprint: ApiSprint | null;
  projectId: string | undefined;
  plannedSprint: ApiSprint | null;
  plannedTaskIds: string[];
  plannedBacklogTasks: SprintBacklogTask[];
  canEditGoal: boolean;
  canManageScope: boolean;
  currentRole: number | null | undefined;
  activeSprint: ApiSprint | null;
  capacity: CapacityQuery;
  velocity: VelocityQuery;
  outcomeQuery: OutcomeQuery;
  projectTasks: Task[] | undefined;
  itl: IterationLabel;
  effectiveMethodology: Methodology;
  onRetry: (() => void) | undefined;
  onPlanNext: () => void;
}) {
  if (isLoading) {
    return (
      <div role="status" aria-label={`Loading ${itl.lowerPlural}…`} className="flex flex-col gap-4">
        {[0, 1].map((i) => (
          <div
            key={i}
            aria-hidden="true"
            className="rounded-card border border-neutral-border bg-neutral-surface-raised p-4"
          >
            <div className="h-4 w-40 motion-safe:animate-pulse rounded-chip bg-neutral-surface-sunken" />
            <div className="mt-3 h-24 motion-safe:animate-pulse rounded-card bg-neutral-surface-sunken" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <QueryErrorState
        variant="inline"
        message={`Couldn't load ${itl.lowerPlural}.`}
        onRetry={() => onRetry?.()}
      />
    );
  }

  if (sprints.length === 0) {
    // WATERFALL hides the DELIVER nav group (methodologyTabs.ts), but the route
    // stays reachable by direct URL on purpose (issue #2619) — the bug was this
    // generic cold-start CTA inviting the deviation the preset exists to
    // discourage, with no signal the project is configured otherwise.
    if (effectiveMethodology === 'WATERFALL') {
      return (
        <MethodologyEmptyState
          className="rounded-card border border-neutral-border bg-neutral-surface-raised"
          projectId={projectId}
          icon={SprintIcon}
          title={`${itl.plural} aren't part of this project's workflow`}
          description={`This project runs on phases and gates, not ${itl.lowerPlural}. If ${itl.lowerPlural} fit better here, switch the methodology in Settings.`}
          primaryLabel="Go to Schedule"
          primaryTo={projectId ? `/projects/${projectId}/schedule` : '#'}
        />
      );
    }
    return (
      <EmptyState
        className="rounded-card border border-neutral-border bg-neutral-surface-raised"
        icon={SprintIcon}
        title={`No ${itl.lowerPlural} yet`}
        // The CTA below carries a distinct label ("Plan a sprint") so this
        // orientation copy stays the single "Plan your first {sprint}" match
        // and never render-depends on the viewer's permission to plan.
        description={`Plan your first ${itl.lower} to start tracking velocity and burn.`}
        action={
          canManageScope ? <Button onClick={onPlanNext}>Plan a {itl.lower}</Button> : undefined
        }
      />
    );
  }

  if (!selectedSprint) return null;

  return (
    <SelectedSprintCards
      selectedSprint={selectedSprint}
      projectId={projectId}
      plannedSprint={plannedSprint}
      plannedTaskIds={plannedTaskIds}
      plannedBacklogTasks={plannedBacklogTasks}
      canEditGoal={canEditGoal}
      canManageScope={canManageScope}
      currentRole={currentRole}
      activeSprint={activeSprint}
      capacity={capacity}
      velocity={velocity}
      outcomeQuery={outcomeQuery}
      projectTasks={projectTasks}
    />
  );
}

/** The state-appropriate cards for the selected sprint: PLANNED bridge + poker, or
 *  the goal/milestone grid, plus the Sprint-0 velocity toggle and the ACTIVE /
 *  COMPLETED panels. */
function SelectedSprintCards({
  selectedSprint,
  projectId,
  plannedSprint,
  plannedTaskIds,
  plannedBacklogTasks,
  canEditGoal,
  canManageScope,
  currentRole,
  activeSprint,
  capacity,
  velocity,
  outcomeQuery,
  projectTasks,
}: {
  selectedSprint: ApiSprint;
  projectId: string | undefined;
  plannedSprint: ApiSprint | null;
  plannedTaskIds: string[];
  plannedBacklogTasks: SprintBacklogTask[];
  canEditGoal: boolean;
  canManageScope: boolean;
  currentRole: number | null | undefined;
  activeSprint: ApiSprint | null;
  capacity: CapacityQuery;
  velocity: VelocityQuery;
  outcomeQuery: OutcomeQuery;
  projectTasks: Task[] | undefined;
}) {
  const isSelectedPlanned = selectedSprint.id === plannedSprint?.id;
  return (
    <>
      {/* PLANNED (#495/#866) — the planning bridge banner (draft goal ↔
      advancing milestone) replaces the generic two-card header so the
      agile→waterfall link is explicit at planning time. ACTIVE/CLOSED
      keep the standard goal + milestone grid. */}
      {selectedSprint.state === 'PLANNED' ? (
        <>
          <SprintPlanningBridge
            sprint={selectedSprint}
            projectId={projectId ?? ''}
            canEdit={canEditGoal}
            sprintTaskIds={isSelectedPlanned ? plannedTaskIds : []}
          />
          {/* Estimation poker (ADR-0179, issue 863) — size unestimated candidates in-place. */}
          <EstimationPokerCard
            sprintId={selectedSprint.id}
            candidates={isSelectedPlanned ? plannedBacklogTasks : []}
            canFacilitate={canManageScope}
          />
        </>
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

      {selectedSprint.state === 'ACTIVE' && (
        <ActiveSprintPanels
          selectedSprint={selectedSprint}
          projectId={projectId}
          capacity={capacity}
          velocity={velocity}
          activeSprint={activeSprint}
        />
      )}

      {selectedSprint.state === 'COMPLETED' && (
        <ClosedSprintPanels
          selectedSprint={selectedSprint}
          projectId={projectId}
          currentRole={currentRole}
          outcomeQuery={outcomeQuery}
          projectTasks={projectTasks}
        />
      )}
    </>
  );
}

/** ACTIVE — burndown + capacity + velocity, the daily-delta standup, and the
 *  impediment roll-up (unchanged this MR; the ADR-0094 "launcher" dedup is a follow-up). */
function ActiveSprintPanels({
  selectedSprint,
  projectId,
  capacity,
  velocity,
  activeSprint,
}: {
  selectedSprint: ApiSprint;
  projectId: string | undefined;
  capacity: CapacityQuery;
  velocity: VelocityQuery;
  activeSprint: ApiSprint | null;
}) {
  return (
    <>
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
            <VelocityPanel velocity={velocity.data} currentSprint={activeSprint} />
          ) : (
            <ChartSkeleton label="Velocity" />
          )}
        </div>
      </div>
      {/* Team daily standup — "what changed since yesterday" (#925). */}
      <SprintDailyDeltaPanel sprintId={selectedSprint.id} />
      {/* Impediment roll-up — the SM's blocked-task triage list (ADR-0124).
          projectId lets blocked rows deep-link into the task drawer (#2159). */}
      {projectId && (
        <BlockedRollupPanel scope="sprint" sprintId={selectedSprint.id} projectId={projectId} />
      )}
    </>
  );
}

/** CLOSED — read-only outcome (5-card row + "what didn't ship") bound to /outcome/,
 *  the reforecast card, and the frozen historical burndown. */
function ClosedSprintPanels({
  selectedSprint,
  projectId,
  currentRole,
  outcomeQuery,
  projectTasks,
}: {
  selectedSprint: ApiSprint;
  projectId: string | undefined;
  currentRole: number | null | undefined;
  outcomeQuery: OutcomeQuery;
  projectTasks: Task[] | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      {outcomeQuery.data ? (
        <SprintClosedOutcome
          outcome={outcomeQuery.data}
          canCurateDemo={(currentRole ?? -1) >= ROLE_MEMBER}
        />
      ) : (
        <ChartSkeleton label="Sprint outcome" />
      )}
      {projectId && (
        <SprintReforecastCard
          projectId={projectId}
          sprintId={selectedSprint.id}
          sprintName={selectedSprint.name}
          tasks={projectTasks ?? []}
          canManage={(currentRole ?? -1) >= ROLE_ADMIN}
        />
      )}
      <BurnChart sprintId={selectedSprint.id} defaultVariant="burndown" />
    </div>
  );
}

/** The sprint timeline strip (ADR-0094 + #567) — a sprint SELECTOR. Lifecycle write
 *  handlers are omitted below SCHEDULER (#2146) so the strip renders read-only. */
function SprintTimeline({
  ready,
  sprints,
  buckets,
  selectedSprint,
  canManageLifecycle,
  onSelect,
  onPlanNext,
  onActivate,
  onEditPlanned,
  iterationWeeks,
  activeSprint,
}: {
  ready: boolean;
  sprints: ApiSprint[];
  buckets: ReturnType<typeof useSprintsByState>;
  selectedSprint: ApiSprint | null;
  canManageLifecycle: boolean;
  onSelect: (id: string) => void;
  onPlanNext: () => void;
  onActivate: (sprintId: string) => void;
  onEditPlanned: (sprintId: string) => void;
  iterationWeeks: number | undefined;
  activeSprint: ApiSprint | null;
}) {
  if (!ready || sprints.length === 0) return null;
  return (
    <SprintTimelineStrip
      closed={buckets.closed}
      active={buckets.active}
      planned={buckets.planned}
      selectedSprintId={selectedSprint?.id ?? null}
      onSelect={onSelect}
      onPlanNext={canManageLifecycle ? onPlanNext : undefined}
      onActivate={canManageLifecycle ? onActivate : undefined}
      onEditPlanned={canManageLifecycle ? onEditPlanned : undefined}
      iterationWeeks={iterationWeeks}
      milestoneName={activeSprint?.target_milestone_detail?.name ?? null}
    />
  );
}

/** Editable backlog for the active sprint when it is the selected one. Add-to- and
 *  remove-from-sprint are scope writes gated to SCHEDULER+ (#2146). */
function ActiveSprintBacklog({
  ready,
  selectedSprint,
  activeSprint,
  projectId,
  tasks,
  canManageLifecycle,
  onAddTask,
  onRemoveTask,
  onOpenTask,
}: {
  ready: boolean;
  selectedSprint: ApiSprint | null;
  activeSprint: ApiSprint | null;
  projectId: string | undefined;
  tasks: SprintBacklogTask[];
  canManageLifecycle: boolean;
  onAddTask: (sprintId: string) => void;
  onRemoveTask: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  if (!ready || selectedSprint?.id !== activeSprint?.id || !activeSprint || !projectId) return null;
  return (
    <SprintBacklogTable
      projectId={projectId}
      sprintId={activeSprint.id}
      tasks={tasks}
      onAddTask={canManageLifecycle ? () => onAddTask(activeSprint.id) : undefined}
      onRemoveTask={canManageLifecycle ? onRemoveTask : undefined}
      onOpenTask={onOpenTask}
    />
  );
}

/** PLANNED unified surface (#495, ADR-0094 §1): priority-ordered backlog on the
 *  left; capacity gauge (#864 points chip + footer), incoming carryover preview
 *  (#865), and a collapsed velocity panel on the right. */
function PlannedSprintSurface({
  ready,
  selectedSprint,
  plannedSprint,
  projectId,
  tasks,
  plannedCapacity,
  plannedDraftPoints,
  velocity,
  canManageLifecycle,
  canPullCarryover,
  onAddTask,
  onRemoveTask,
  onOpenTask,
  onOpenPicker,
}: {
  ready: boolean;
  selectedSprint: ApiSprint | null;
  plannedSprint: ApiSprint | null;
  projectId: string | undefined;
  tasks: SprintBacklogTask[];
  plannedCapacity: CapacityQuery;
  plannedDraftPoints: number;
  velocity: VelocityQuery;
  canManageLifecycle: boolean;
  canPullCarryover: boolean;
  onAddTask: (sprintId: string) => void;
  onRemoveTask: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  /** Opens the story picker (issue #2670) — SCHEDULER+ only, mirroring onAddTask. */
  onOpenPicker: () => void;
}) {
  if (!ready || selectedSprint?.id !== plannedSprint?.id || !plannedSprint || !projectId) {
    return null;
  }
  return (
    <div className="px-6 grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
      <div className="lg:col-span-3 rounded-card border border-neutral-border overflow-hidden">
        <SprintBacklogTable
          projectId={projectId}
          sprintId={plannedSprint.id}
          tasks={tasks}
          onAddTask={canManageLifecycle ? () => onAddTask(plannedSprint.id) : undefined}
          onRemoveTask={canManageLifecycle ? onRemoveTask : undefined}
          onOpenTask={onOpenTask}
          showCarryoverLane
          canPullCarryover={canPullCarryover}
          onOpenPicker={canManageLifecycle ? onOpenPicker : undefined}
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
          <details className="rounded-card border border-neutral-border bg-neutral-surface">
            <summary
              className="cursor-pointer px-4 py-2 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
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
  );
}

/** Retro follows the selected sprint when it is active or closed (the two states a
 *  retro belongs to); hidden for a planned selection. */
function SprintRetroSection({
  ready,
  selectedSprint,
  retroSectionRef,
}: {
  ready: boolean;
  selectedSprint: ApiSprint | null;
  retroSectionRef: RefObject<HTMLDivElement | null>;
}) {
  if (
    !ready ||
    !selectedSprint ||
    (selectedSprint.state !== 'ACTIVE' && selectedSprint.state !== 'COMPLETED')
  ) {
    return null;
  }
  return (
    // Focusable scroll target for the issue 1471 retro deep-link; tabIndex=-1
    // so "Run the retro" can move focus here for keyboard/SR users.
    <div
      ref={retroSectionRef}
      tabIndex={-1}
      data-testid="retro-handoff-target"
      className="focus:outline-none"
    >
      <RetroPanel
        sprintId={selectedSprint.id}
        isClosed={selectedSprint.state === 'COMPLETED'}
        sprintState={selectedSprint.state}
      />
    </div>
  );
}

/** The workspace's overlay cluster — plan/edit modals, close dialog, scope review
 *  slide-over, quick-create modal, and the shared task detail drawer. */
function SprintModals({
  projectId,
  buckets,
  activeSprint,
  planOpen,
  onClosePlan,
  editingSprint,
  onCloseEdit,
  closeDialogOpen,
  backlogTasks,
  isClosing,
  onCancelClose,
  onConfirmClose,
  scopeReviewOpen,
  canManageScope,
  projectTasks,
  onCloseScopeReview,
  addTaskForSprintId,
  onCloseAddTask,
  selectedTaskId,
  taskIndex,
  onCloseTaskDrawer,
  onSwapCanceled,
  storyPickerOpen,
  plannedSprint,
  plannedDraftPoints,
  sprintPickerReadyOnlyDefault,
  onCloseStoryPicker,
}: {
  projectId: string | undefined;
  buckets: ReturnType<typeof useSprintsByState>;
  activeSprint: ApiSprint | null;
  planOpen: boolean;
  onClosePlan: () => void;
  editingSprint: ApiSprint | undefined;
  onCloseEdit: () => void;
  closeDialogOpen: boolean;
  backlogTasks: SprintBacklogTask[];
  isClosing: boolean;
  onCancelClose: () => void;
  onConfirmClose: (carryOverTo: string, pendingDisposition?: 'carry' | 'reject') => void;
  scopeReviewOpen: boolean;
  canManageScope: boolean;
  projectTasks: Task[] | undefined;
  onCloseScopeReview: () => void;
  addTaskForSprintId: string | null;
  onCloseAddTask: () => void;
  selectedTaskId: string | null;
  taskIndex: Map<string, Task>;
  onCloseTaskDrawer: () => void;
  onSwapCanceled: (keptId: string) => void;
  /** Story picker (issue #2670). */
  storyPickerOpen: boolean;
  plannedSprint: ApiSprint | null;
  plannedDraftPoints: number;
  sprintPickerReadyOnlyDefault: boolean;
  onCloseStoryPicker: () => void;
}) {
  return (
    <>
      {planOpen && projectId && (
        <PlanSprintModal
          projectId={projectId}
          defaultStart={
            buckets.planned[buckets.planned.length - 1]?.finish_date ?? activeSprint?.finish_date
          }
          onClose={onClosePlan}
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
          onClose={onCloseEdit}
        />
      )}

      {closeDialogOpen && activeSprint && (
        <CloseSprintDialog
          sprint={activeSprint}
          nextPlannedSprintId={buckets.planned[0]?.id ?? null}
          nextPlannedSprintName={buckets.planned[0]?.name ?? null}
          backlogTasks={backlogTasks}
          isClosing={isClosing}
          onCancel={onCancelClose}
          onConfirm={onConfirmClose}
        />
      )}

      {scopeReviewOpen && projectId && activeSprint && canManageScope && (
        <ScopePendingReviewPanel
          projectId={projectId}
          sprintId={activeSprint.id}
          tasks={projectTasks ?? []}
          offline={typeof navigator !== 'undefined' && !navigator.onLine}
          onClose={onCloseScopeReview}
        />
      )}

      {addTaskForSprintId !== null && projectId && (
        <TaskFormModal
          projectId={projectId}
          task={null}
          defaultSprintId={addTaskForSprintId}
          isMobile={false}
          onClose={onCloseAddTask}
        />
      )}

      {/* Task detail drawer — opened by clicking a backlog row. Shares the
          registry-backed editor the Board and Schedule use (ADR-0050). The full
          Task is resolved from the project task list; an id with no match (e.g.
          a brand-new task not yet in the cache) leaves the drawer closed. */}
      {projectId && selectedTaskId && (
        <TaskDetailDrawer
          task={taskIndex.get(selectedTaskId) ?? null}
          projectId={projectId}
          onClose={onCloseTaskDrawer}
          // Restore selection to the still-shown task when a dirty swap is kept (#1978).
          onSwapCanceled={onSwapCanceled}
        />
      )}

      {storyPickerOpen && projectId && plannedSprint && (
        <StoryPickerModal
          projectId={projectId}
          sprint={plannedSprint}
          committedPoints={plannedDraftPoints}
          readyOnlyDefault={sprintPickerReadyOnlyDefault}
          onClose={onCloseStoryPicker}
        />
      )}
    </>
  );
}

function ChartSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${label}`}
      className="rounded-card border border-neutral-border bg-neutral-surface-raised p-4 min-h-[180px] flex items-center justify-center"
    >
      <span className="text-xs text-neutral-text-secondary">Loading {label}…</span>
    </div>
  );
}
