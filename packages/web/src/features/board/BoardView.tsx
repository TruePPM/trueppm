/**
 * Board view — progress-aware Kanban with phase swimlanes (issue #130).
 *
 * Layout:
 *   - Rows = WBS phases (summary tasks). Tasks with no summary parent appear
 *     in a "Project Tasks" lane at the bottom.
 *   - Columns = task status (To Do / In Progress / On Hold / Done).
 *   - Each cell is an individual dnd-kit droppable (id = `${phaseId}:${status}`).
 *     Dropping a card updates its status; phase membership follows parentId.
 *   - Lanes are collapsible — state persists to localStorage per project
 *     (issue #190). Collapse all / Expand all in toolbar. [ / ] keyboard shortcuts
 *     surfaced as native tooltips on the toggle button (issue #225).
 *   - Density auto-selects compact below md breakpoint; user may override for
 *     the session on mobile; desktop persists to localStorage (issue #224).
 *
 * WIP limits, progress rings, entry stamps, and CP badges are spec-defined
 * features from the design doc (p3m-vs-oss-views-original.html § ⑤).
 */
import { selectVisibleCards, DEFAULT_CELL_CAP } from './cellCap';
import { QueryErrorState } from '@/components/QueryErrorState';
import {
  memo,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useSearchParams } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjectCustomFields, type ProjectCustomField } from '@/hooks/useProjectCustomFields';
import { useUrlSelectedId } from '@/hooks/useUrlSelectedId';
import { taskDndAnnouncements } from '@/lib/dndAnnouncements';
import { useSpaceDragPan, SpaceAwarePointerSensor } from '@/hooks/useSpaceDragPan';
import { useHasScrollBelow } from '@/hooks/useHasScrollBelow';
import { useHasScrollRight } from '@/hooks/useHasScrollRight';
import {
  DndContext,
  KeyboardSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
} from '@dnd-kit/core';
import { useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { isTaskScheduled } from '@/lib/task';
import { useUpdateTaskStatus } from '@/hooks/useBoardTasks';
import { useBoardConfig } from '@/hooks/useBoardConfig';
import { useMyTasksFilter } from '@/hooks/useMyTasksFilter';
import { useCurrentUserResourceId } from '@/hooks/useCurrentUserResourceId';
import { useBoardKeyboard } from '@/hooks/useBoardKeyboard';
import { useBoardOverallocation } from '@/hooks/useBoardOverallocation';
import { type BoardSortKey, type BoardViewConfig } from '@/hooks/useBoardSavedViews';
import { wipState, type WipState } from './wip';
import { boardGridTemplate } from './boardGrid';
import { ChevronDownIcon, ChevronUpIcon } from '@/components/Icons';
import { PhaseResizeHandle } from './BoardResizeHandle';
import { useBoardColumnWidths, useBoardPhaseHeights } from '@/hooks/useBoardResize';
import { useTaskDependencies } from '@/hooks/useTaskDependencies';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkshopSession, useStartWorkshop, useEndWorkshop } from '@/hooks/useWorkshopSession';
import { usePhaseReorder } from '@/hooks/usePhaseReorder';
import { useQueueReorder } from '@/hooks/useQueueReorder';
import { useCanManageBacklog } from '@/hooks/useMyFacets';
import { useWorkshopSocket } from '@/hooks/useWorkshopSocket';
import { useCreateTask, useUpdateTask } from '@/hooks/useTaskMutations';
import type { ApiSprint, Task, TaskStatus } from '@/types';
import { BoardCard, type BoardDensity, type EvmMode } from './BoardCard';
import { readinessIsInformative } from './card/cardFormat';
import { useBoardOffline } from './offline/useBoardOffline';
import { LaneMeta } from './LaneMeta';
import { PhaseMilestoneRail } from './PhaseMilestoneRail';
import { phaseColor } from './phaseColors';
import { BACKLOG_BAND_DROPPABLE_ID } from './BacklogBand';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { CalmToolbar } from './CalmToolbar';
import { TaskTrashDialog } from '@/features/project/TaskTrashDialog';
import { BoardFilterControl, BoardFilterChips } from './BoardFilterControl';
import { DeletedLabelNotice } from './DeletedLabelNotice';
import { missingLabelIds } from './savedViewSummary';
import { useLabels } from '@/hooks/useLabels';
import { useBoardSavedViews } from '@/hooks/useBoardSavedViews';
import {
  EMPTY_FACETS,
  matchesFacets,
  activeFacetCount,
  isFacetsActive,
  collectAssigneeOptions,
  collectLabelOptions,
  parseFacetsFromParams,
  writeFacetsToParams,
  paramsHaveFacets,
  facetsStorageKey,
  serializeFacets,
  deserializeFacets,
  type FacetFilters,
} from './boardFacets';
import { useBoardTaskMaps } from './boardView/useBoardTaskMaps';
import { useBoardSprintScope } from './boardView/useBoardSprintScope';
import { BoardChrome } from './boardView/BoardChrome';
import { boardKeyboardBindings, isB3OverlayOpen } from './boardView/boardKeyboardBindings';
import { boardReadOnly, useBoardIdentity } from './boardView/useBoardIdentity';
import { COLUMN_TINT } from './boardView/columnTokens';
import { BoardConfirmDialogs } from './boardView/BoardConfirmDialogs';
import { BoardCardOverlays } from './boardView/BoardCardOverlays';
import { BoardSidePanels } from './boardView/BoardSidePanels';
import { visibleLanes, type LaneShape } from './boardView/BoardPhaseLanes';
import { BoardBody } from './boardView/BoardBody';
import { wipBreachInfo, type WipBreach } from './wipBreach';
import {
  useBoardToolbarPrefs,
  resolveBoardLayout,
  type BoardZoom,
  type BoardGroupMode,
} from '@/hooks/useBoardToolbarPrefs';
import { buildAssigneeLanes, buildEpicLanes, epicLaneId, primaryAssigneeLaneId } from './grouping';
import { useBoardCardSearch } from '@/hooks/useBoardCardSearch';
import { useProject } from '@/hooks/useProject';
import { useActiveSprint, useFlowMetrics } from '@/hooks/useSprints';
import { useCanManageScope } from '@/hooks/useCanManageScope';
import { useScopeChangeActions, useScopeDecisionFeedback } from '@/hooks/useScopeChangeActions';
import { BoardDropNotice } from './BoardDropNotice';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { BoardCardScopeActions } from './BoardCard';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { toast } from '@/components/Toast/toast';
import { fmtUtcLong } from '@/lib/formatUtcDate';
import { buildBoardPrintData } from './export/boardPrintData';
import { exportBoardPdf, boardPdfFileName } from './export/exportBoardPdf';

// ---------------------------------------------------------------------------
// Sort helper
// ---------------------------------------------------------------------------

/**
 * The sprint a dropped/promoted card should be assigned to, or undefined when
 * the drop assigns nothing (#429). A COMPLETED sprint view is read-only for
 * assignment — we never back-date scope into a closed sprint.
 */
/**
 * True when a highlight/facet set is active and this card is not in it — the
 * card is dimmed (dep highlight) or removed from the view (facet filter). A
 * `null` set means "no lens active", which dims nothing.
 */
function isOutsideSet(ids: Set<string> | null, taskId: string): boolean {
  return ids !== null && !ids.has(taskId);
}

function sprintAssignTarget(sprint: ApiSprint | null, task: Task): string | undefined {
  if (!sprint) return undefined;
  if (sprint.state !== 'ACTIVE' && sprint.state !== 'PLANNED') return undefined;
  if (task.sprintId === sprint.id) return undefined;
  return sprint.id;
}

/**
 * How many cards are awaiting scope-injection review on the active sprint.
 *
 * A module function rather than an inline `??` at the call site so the absent
 * cases (no active sprint, sprint without the field) resolve in one place.
 */
function activeSprintPendingCount(sprint: ApiSprint | null | undefined): number {
  return sprint?.pending_count ?? 0;
}

/**
 * The three project fields the board chrome reads, resolved in one place.
 *
 * `projectDetail` is undefined until its fetch lands, and each consumer wanted
 * a different one of these — three separate optional chains in the shell, two
 * of them buried in `useMemo`/`useEffect` dependency arrays where a stale or
 * mistyped key fails silently.
 */
type BoardProjectDetail = NonNullable<ReturnType<typeof useProject>['data']>;

function boardProjectMeta(detail: BoardProjectDetail | undefined) {
  return {
    projectName: detail?.name,
    methodology: detail?.methodology,
    boardCadence: detail?.board_cadence,
  };
}

/** The signed-in user's display name, or undefined before the fetch lands. */
function displayNameOf(user: { display_name?: string } | null | undefined): string | undefined {
  return user?.display_name;
}

/**
 * Which cards the dep-chain dim set should highlight.
 *
 * A query with matches takes precedence over a transient dep-hover highlight;
 * an empty query — or one that matches nothing — falls back to the hover set so
 * the board never greys out wholesale (issue 182).
 */
function searchDimSet(
  query: string,
  matchIds: Set<string>,
  hoverHighlightIds: Set<string> | null,
): Set<string> | null {
  const searchActive = query.trim().length > 0 && matchIds.size > 0;
  return searchActive ? matchIds : hoverHighlightIds;
}

/**
 * Facet match count plus the zero-match flag.
 *
 * Zero-match means facets are active but no committed card matches; it drives
 * the dedicated banner, because the board would otherwise render every card
 * dimmed to 30% and read as broken rather than as filtered.
 */
function facetMatchSummary(facetsActive: boolean, matchIds: Set<string> | null) {
  const facetMatchCount = matchIds?.size ?? 0;
  return { facetMatchCount, facetZeroMatch: facetsActive && facetMatchCount === 0 };
}

function sortTasksBy(tasks: Task[], sort: BoardSortKey): Task[] {
  if (sort === 'priority') {
    return [...tasks].sort((a, b) => (a.priorityRank ?? 9999) - (b.priorityRank ?? 9999));
  }
  if (sort === 'start_date') {
    return [...tasks].sort((a, b) => a.start.localeCompare(b.start));
  }
  if (sort === 'percent_complete') {
    return [...tasks].sort((a, b) => b.progress - a.progress);
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

interface Phase {
  id: string; // summary task ID, or 'root' for ungrouped
  name: string;
  tasks: Task[];
  summaryTask: Task | undefined;
}

/**
 * Group leaf tasks by their parent (phase) summary task.
 * Summary tasks are excluded from cards — they appear as lane headers.
 *
 * In workshop mode, root-level tasks (parentId === null) that aren't yet
 * summary tasks are treated as proto-phases so a newly created phase appears
 * as an empty column before any child tasks are added (the backend only sets
 * is_summary=true once children exist).  Empty phases are also kept visible
 * so participants can see and fill them during the session.
 */
/**
 * The tasks that become columns, in board order.
 *
 * Workshop mode additionally promotes every childless root task to a column, so
 * a freshly-drafted phase shows up before the backend flips `is_summary` (which
 * it only does once children exist).
 */
function collectPhaseHeads(
  allTasks: Task[],
  workshopMode: boolean,
): { summaryById: Map<string, Task>; summaryOrder: string[] } {
  const summaryById = new Map<string, Task>();
  const summaryOrder: string[] = [];
  const claim = (t: Task) => {
    summaryById.set(t.id, t);
    summaryOrder.push(t.id);
  };

  for (const t of allTasks) {
    if (t.isSummary) claim(t);
  }
  if (workshopMode) {
    for (const t of allTasks) {
      if (!t.isSummary && t.parentId === null && !summaryById.has(t.id)) claim(t);
    }
  }
  return { summaryById, summaryOrder };
}

/**
 * Split the non-column tasks into per-column buckets and the leftovers that
 * hang off no column at all (rendered as the "Project Tasks" catch-all).
 */
function bucketByPhase(
  allTasks: Task[],
  summaryById: Map<string, Task>,
): { byPhase: Map<string, Task[]>; rootTasks: Task[] } {
  const byPhase = new Map<string, Task[]>();
  const rootTasks: Task[] = [];

  for (const t of allTasks) {
    if (summaryById.has(t.id)) continue;
    const parentId = t.parentId;
    if (parentId && summaryById.has(parentId)) {
      const arr = byPhase.get(parentId) ?? [];
      arr.push(t);
      byPhase.set(parentId, arr);
    } else {
      rootTasks.push(t);
    }
  }
  return { byPhase, rootTasks };
}

function buildPhases(allTasks: Task[], workshopMode = false): Phase[] {
  const { summaryById, summaryOrder } = collectPhaseHeads(allTasks, workshopMode);
  const { byPhase, rootTasks } = bucketByPhase(allTasks, summaryById);

  const phases: Phase[] = summaryOrder
    .map((id) => ({
      id,
      name: summaryById.get(id)!.name,
      summaryTask: summaryById.get(id),
      tasks: byPhase.get(id) ?? [],
    }))
    .filter((p) => workshopMode || p.tasks.length > 0);

  if (rootTasks.length > 0) {
    phases.push({ id: 'root', name: 'Project Tasks', summaryTask: undefined, tasks: rootTasks });
  }

  return phases;
}

// ---------------------------------------------------------------------------
// Average progress for a phase
// ---------------------------------------------------------------------------

function avgProgress(tasks: Task[]): number {
  // Match the CP rollup in PhaseSummaryChips: only scheduled (committed) tasks
  // count. An unscheduled To Do is a 0%-progress task in the data but
  // represents work the PM hasn't committed to yet — including it drags the
  // rollup down by counting backlog ideas against delivery.
  const committed = tasks.filter(isTaskScheduled);
  if (committed.length === 0) return 0;
  return Math.round(committed.reduce((s, t) => s + t.progress, 0) / committed.length);
}

/**
 * Per-phase progress for the lane header (#991, ADR-0115). A board "phase" is a WBS
 * L1 summary task, and that summary task already carries the server-owned,
 * delivery-mode-weighted percent_complete rollup (ADR-0108) — the same number the
 * Gantt shows for it. We render that rather than re-deriving a divergent client mean,
 * closing the #986 API-first gap.
 *
 * The synthetic 'root' lane ("Project Tasks") has no backing summary task — it groups
 * parentless tasks, which is a UI construct, not a domain entity. There is no server
 * fact to strand for it, so it keeps the committed-leaf mean as a local fallback.
 */
function phaseProgress(phase: Phase): number {
  if (phase.summaryTask) return Math.round(phase.summaryTask.progress);
  return avgProgress(phase.tasks);
}

// ---------------------------------------------------------------------------
// WIP badge
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase summary chips
// ---------------------------------------------------------------------------

function PhaseSummaryChips({ phase }: { phase: Phase }) {
  // CP rollup excludes uncommitted tasks (issue #332). CPM marks every dated
  // task as critical; without isTaskScheduled the rollup counts backlog ideas
  // the PM hasn't committed to, which is the bug.
  const cpCount = phase.tasks.filter((t) => t.isCritical && isTaskScheduled(t)).length;
  const doneCount = phase.tasks.filter((t) => t.status === 'COMPLETE').length;
  const allDone = doneCount === phase.tasks.length && phase.tasks.length > 0;

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {allDone && (
        <span className="text-xs px-1 py-px rounded-chip bg-semantic-on-track-bg border border-semantic-on-track/30 text-semantic-on-track font-medium">
          {doneCount} done
        </span>
      )}
      {cpCount > 0 && (
        <span className="text-xs px-1 py-px rounded-chip bg-semantic-critical-bg border border-semantic-critical/30 text-semantic-critical font-medium">
          {cpCount} CP
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board cell (droppable per phase + status)
// ---------------------------------------------------------------------------

interface BoardCellProps {
  phaseId: string;
  status: TaskStatus;
  tasks: Task[];
  isOver: boolean;
  showWip: boolean;
  wipLimit: number | null | undefined;
  isDragActive: boolean;
  showColTints: boolean;
  density: BoardDensity;
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  columns: { status: TaskStatus; label: string; slaDays?: number }[];
  focusedCardId: string | null;
  highlightedTaskIds: Set<string> | null;
  /**
   * Set of task ids matching the active board facet filters (issue 1091), or
   * null when no facet is active. A card not in the set is filtered out (dimmed
   * to 30% + aria-hidden). Distinct from `highlightedTaskIds` (search / dep-hover).
   */
  facetMatchIds: Set<string> | null;
  overallocByResourcePerTask: Map<string, Map<string, number>>;
  onCardFocus: (taskId: string, status: TaskStatus, phaseId: string) => void;
  onShowDeps: (task: Task) => void;
  onShowRisks: (task: Task) => void;
  onChainHover: (taskId: string | null) => void;
  /** Card click → open the info popover (issue #304). */
  onCardClick: (task: Task, anchor: HTMLElement) => void;
  showEvm: EvmMode;
  showCost: boolean;
  customFieldDefs: ProjectCustomField[];
  /** Board-wide readiness-chip gate (#2430) — false when the chip is universal. */
  showReadiness: boolean;
  /** Sprint scope-injection accept/reject affordance (ADR-0102). */
  scopeActions: BoardCardScopeActions;
  /** Closed-sprint read-only (#1141): disables drag on every card in the cell. */
  readOnly?: boolean;
  /**
   * Per-cell card cap (issue 1967, ADR-0420). `null` = off (unbounded stack).
   * A positive integer collapses the calm overflow of an at/under-WIP cell
   * behind a "+N more" disclosure; a WIP-breached cell is never capped.
   */
  cellCap: number | null;
  /** Current user's resource id (rule-238 predicate) — exempts my-own cards from the cap. */
  myResourceId: string | null;
}

// Subtle status tints per column (issue #211).
// Applied to the resting state only — drag-over overrides with brand-primary/5.
// Done is quieted to /[0.025] in epic #361 child E (issue #385): the new
// status-dot in the column header carries enough signal that the cell tint can
// step back toward neutral without losing the "this is the close-out column"
// affordance. Review and Backlog are left at /5 — they don't get a status-dot
// equivalent yet (Backlog is in the band; Review is still loud-by-design).
const BOARD_ZOOM_VARS: Record<BoardZoom, CSSProperties> = {
  small: {
    '--board-phase-col': '150px',
    '--board-col-gap': '0.25rem',
    '--board-card-gap': '0.25rem',
    '--board-col-w': '208px',
  } as CSSProperties,
  normal: {
    '--board-phase-col': '188px',
    '--board-col-gap': '0.5rem',
    '--board-card-gap': '0.375rem',
    '--board-col-w': '272px',
  } as CSSProperties,
  large: {
    '--board-phase-col': '224px',
    '--board-col-gap': '0.75rem',
    '--board-card-gap': '0.625rem',
    '--board-col-w': '336px',
  } as CSSProperties,
};

// Shared empty-array fallbacks (issue 1520). A per-render `?? []` literal is a new
// identity every render, which would defeat the React.memo on BoardCell/BoardCard;
// a single frozen constant keeps the prop reference-stable for empty cells/lanes.
const EMPTY_TASKS: Task[] = [];
const EMPTY_MILESTONES: Task[] = EMPTY_TASKS;
const EMPTY_TASKS_BY_STATUS: Record<TaskStatus, Task[]> = {
  BACKLOG: EMPTY_TASKS,
  NOT_STARTED: EMPTY_TASKS,
  IN_PROGRESS: EMPTY_TASKS,
  REVIEW: EMPTY_TASKS,
  ON_HOLD: EMPTY_TASKS,
  COMPLETE: EMPTY_TASKS,
};

/**
 * Per-cell card cap (issue 1967, ADR-0420) and its ephemeral expansion state.
 *
 * A WIP-breached cell is NEVER capped — the overload pile stays visible (the
 * Scrum-Master signal, and the rule-176 always-on-breach invariant). The breach
 * band itself reads the full `tasks.length`, so it is unaffected by the visible
 * slice.
 *
 * Expansion is deliberately not persisted: the overflow reveals when the user
 * opens it, when keyboard focus lands on a hidden card (rule 105 — never strand
 * a card out of reach), or when a drag just dropped into the cell. During an
 * active drag-over the whole cell is a drop target, so every card shows.
 */
function useCellOverflow(opts: {
  tasks: Task[];
  cellCap: number | null | undefined;
  myResourceId: string | null;
  wipBandRaw: WipState;
  focusedCardId: string | null;
  over: boolean;
  isDragActive: boolean;
}) {
  const { tasks, cellCap, myResourceId, wipBandRaw, focusedCardId, over, isDragActive } = opts;
  const capActive = cellCap != null && wipBandRaw !== 'at' && wipBandRaw !== 'over';
  const { visible, overflow } = useMemo(
    () =>
      capActive
        ? selectVisibleCards(tasks, { cap: cellCap, myResourceId })
        : { visible: tasks, overflow: EMPTY_TASKS },
    [capActive, tasks, cellCap, myResourceId],
  );

  const [manualExpanded, setManualExpanded] = useState(false);
  const focusInTail = focusedCardId != null && overflow.some((t) => t.id === focusedCardId);
  const expanded = manualExpanded || focusInTail;

  // A card dropped into a capped cell may sort into overflow; auto-expand the
  // drop-target cell so the just-moved card is visible where it landed. `over`
  // going false while the drag has *ended* (isDragActive false) — not merely
  // moved to another cell — identifies the drop target.
  const prevOver = useRef(over);
  useEffect(() => {
    if (prevOver.current && !over && !isDragActive) setManualExpanded(true);
    prevOver.current = over;
  }, [over, isDragActive]);

  const showAll = expanded || over;
  const overflowIds = useMemo(() => new Set(overflow.map((t) => t.id)), [overflow]);
  const toggleOverflow = useCallback(() => setManualExpanded((v) => !v), []);

  return {
    renderedTasks: showAll ? tasks : visible,
    overflowIds,
    overflowCount: overflow.length,
    expanded,
    showOverflowToggle: capActive && overflow.length > 0 && !over,
    toggleOverflow,
  };
}

/**
 * Per-cell WIP notice. Only the at/over bands say anything — an under-limit cell
 * stays quiet so the grid reads calm (rule 122).
 */
function CellWipNotice({
  band,
  limit,
  count,
}: {
  band: WipState;
  limit: number | null | undefined;
  count: number;
}) {
  if (band === 'over') {
    return (
      <div className="text-xs text-semantic-critical font-semibold px-1">
        WIP limit: {limit} — {count - (limit ?? 0)} over
      </div>
    );
  }
  if (band === 'at') {
    return (
      <div className="text-xs text-semantic-at-risk font-semibold px-1">
        WIP limit: {limit} — at limit
      </div>
    );
  }
  return null;
}

/**
 * Overflow disclosure (ADR-0420, rule 210): a real aria-expanded toggle, neutral
 * tone (a capped cell is always under-WIP), reusing the ColumnStub tppm-mono
 * count vocabulary. The hidden count is in the accessible name so color/glyph is
 * never the only signal (rule 6).
 */
function CellOverflowToggle({
  expanded,
  hiddenCount,
  controlsId,
  onToggle,
}: {
  expanded: boolean;
  hiddenCount: number;
  controlsId: string;
  onToggle: () => void;
}) {
  const Chevron = expanded ? ChevronUpIcon : ChevronDownIcon;
  return (
    <button
      type="button"
      data-testid="cell-overflow-toggle"
      aria-expanded={expanded}
      aria-controls={controlsId}
      aria-label={expanded ? 'Show fewer cards' : `Show ${hiddenCount} more cards`}
      onClick={onToggle}
      className="w-full min-h-[36px] flex items-center justify-center gap-1.5 rounded-card
            border border-neutral-border bg-neutral-surface text-neutral-text-secondary
            hover:bg-neutral-surface-raised hover:text-neutral-text-primary transition-colors
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset"
    >
      <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="text-xs">
        {expanded ? (
          'Show less'
        ) : (
          <>
            <span className="tppm-mono tabular-nums font-semibold">{hiddenCount}</span> more
          </>
        )}
      </span>
    </button>
  );
}

function BoardCellImpl({
  phaseId,
  status,
  tasks,
  isOver,
  showWip,
  wipLimit,
  isDragActive,
  showColTints,
  density,
  onMenuMove,
  columns,
  focusedCardId,
  highlightedTaskIds,
  overallocByResourcePerTask,
  onCardFocus,
  onShowDeps,
  onShowRisks,
  onChainHover,
  onCardClick,
  showEvm,
  showCost,
  customFieldDefs,
  showReadiness,
  scopeActions,
  readOnly = false,
  facetMatchIds,
  cellCap,
  myResourceId,
}: BoardCellProps) {
  const droppableId = `${phaseId}:${status}`;
  const { setNodeRef } = useDroppable({ id: droppableId });
  const over = isOver && isDragActive;
  // Route through the shared wipState() helper so the *at-limit* band (count
  // exactly equals the limit) is surfaced, not just the over-limit case — a
  // column sitting on its ceiling is the signal a team needs before it tips
  // over (issue 1358 F6). `wipBandRaw` is toggle-independent (rule 176); the
  // displayed chip below is gated on `showWip`, but the cap exemption is not —
  // an overloaded cell must never be tidied, whether or not chips are shown.
  const wipBandRaw = wipState(tasks.length, wipLimit);
  const wipBand = showWip ? wipBandRaw : 'none';
  const restingBg = showColTints
    ? (COLUMN_TINT[status] ?? 'bg-neutral-surface-sunken')
    : 'bg-neutral-surface-sunken';

  const {
    renderedTasks,
    overflowIds,
    overflowCount,
    expanded,
    showOverflowToggle,
    toggleOverflow,
  } = useCellOverflow({
    tasks,
    cellCap,
    myResourceId,
    wipBandRaw,
    focusedCardId,
    over,
    isDragActive,
  });
  const overflowId = `cell-overflow-${phaseId}-${status}`;

  const revealAnimated = (taskId: string) => expanded && !over && overflowIds.has(taskId);

  const isEmpty = tasks.length === 0;
  const showRestingTick = isEmpty && !isDragActive;

  if (showRestingTick) {
    return (
      <div
        ref={setNodeRef}
        data-empty-cell="true"
        // `self-start` is load-bearing (#2427). A grid cell stretches to its row
        // by default, so in a lane made tall by one full column the empty
        // siblings became full-height blank tracks with a lonely tick floating
        // in the middle — on a project with several phases that pushes almost
        // everything below the fold. Sizing the resting cell to its own content
        // leaves the remainder as lane background instead of empty void.
        //
        // Only the RESTING cell shrinks: as soon as a drag starts
        // `showRestingTick` is false and the full-height cell below renders, so
        // the drop target is never smaller than the column it represents.
        className="self-start flex items-center justify-center border-l border-neutral-border min-h-[2rem]"
      >
        <div aria-hidden="true" className="w-8 h-px bg-neutral-border" />
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      className={[
        'rounded-card p-2 min-h-[120px] flex flex-col gap-[var(--board-card-gap,0.375rem)] transition-colors duration-100',
        over
          ? 'bg-brand-primary/5 border-l-2 border-brand-primary'
          : `${restingBg} border-l border-neutral-border`,
      ].join(' ')}
    >
      <CellWipNotice band={wipBand} limit={wipLimit} count={tasks.length} />
      <div id={overflowId} className="contents">
        {renderedTasks.map((task) => (
          <div
            key={task.id}
            // Cards revealed by opening the overflow animate in; the same cards
            // shown because a drag is hovering the cell must not (rule 70).
            className={revealAnimated(task.id) ? 'motion-safe:animate-empty-state-in' : undefined}
            onPointerDown={() => onCardFocus(task.id, status, phaseId)}
            onFocusCapture={() => onCardFocus(task.id, status, phaseId)}
          >
            <BoardCard
              task={task}
              density={density}
              onMenuMove={onMenuMove}
              columns={columns}
              isKeyboardFocused={focusedCardId === task.id}
              isDimmed={isOutsideSet(highlightedTaskIds, task.id)}
              isFilteredOut={isOutsideSet(facetMatchIds, task.id)}
              overallocByResource={overallocByResourcePerTask.get(task.id)}
              onShowDeps={onShowDeps}
              onShowRisks={onShowRisks}
              onChainHover={onChainHover}
              onCardClick={onCardClick}
              showEvm={showEvm}
              showCost={showCost}
              customFieldDefs={customFieldDefs}
              showReadiness={showReadiness}
              scopeActions={scopeActions}
              readOnly={readOnly}
            />
          </div>
        ))}
      </div>
      {/* Overflow disclosure (ADR-0420, rule 210): a real aria-expanded toggle,
          neutral tone (a capped cell is always under-WIP), reusing the ColumnStub
          tppm-mono count vocabulary. The hidden count is in the accessible name
          so color/glyph is never the only signal (rule 6). */}
      {showOverflowToggle && (
        <CellOverflowToggle
          expanded={expanded}
          hiddenCount={overflowCount}
          controlsId={overflowId}
          onToggle={toggleOverflow}
        />
      )}
    </div>
  );
}

// Memoized so a drag-over (which changes `isOver` on at most two cells) or an
// unrelated board re-render skips every cell whose props are unchanged (issue
// 1520). `isOver` is a pre-computed boolean and the task lists / callbacks the
// parent passes are reference-stable, so the default shallow compare is correct.
const BoardCell = memo(BoardCellImpl);

// ---------------------------------------------------------------------------
// Phase lane row
// ---------------------------------------------------------------------------

interface PhaseLaneProps {
  phase: Phase;
  columns: {
    status: TaskStatus;
    label: string;
    wipLimit: number | null;
    color: string | null;
    slaDays?: number;
  }[];
  tasksByStatus: Record<TaskStatus, Task[]>;
  milestones: Task[];
  /**
   * The drag-over column *within this lane* (or null). Pre-computed by the parent
   * from the global `overCell` so only the one or two lanes actually under the
   * pointer get a changed prop — the rest keep `null` and their React.memo skips
   * the re-render (issue 1520). Passing the raw global `overCell` here would
   * re-render every lane on every drag-over tick.
   */
  overStatus: TaskStatus | null;
  isDragActive: boolean;
  showWip: boolean;
  showColTints: boolean;
  density: BoardDensity;
  collapsed: boolean;
  /** Toggle this lane's collapse. Takes the lane's `phase.id` so the parent can
   *  pass one stable reference for every lane instead of a per-lane closure that
   *  would defeat the lane's React.memo (issue 1520). */
  onToggleCollapse: (phaseId: string) => void;
  /** Columns folded to stubs board-wide (issue 1459). */
  collapsedColumns: Set<TaskStatus>;
  /** Expand a folded column from a lane stub cell (issue 1459). */
  onExpandColumn: (status: TaskStatus) => void;
  /** This lane is the active focus target (issue 1460). */
  focused: boolean;
  /** Toggle phase-lane focus mode on this lane (issue 1460). Takes `phase.id` so
   *  the parent passes one stable reference across all lanes (issue 1520). */
  onToggleFocus: (phaseId: string) => void;
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  // Optional: assignee-grouped lanes (324) pass none — a lane id there is a
  // resource, not a parent, so the add-task affordance is suppressed.
  onAddTask?: (phaseId: string, phaseName: string, isSynthetic?: boolean) => void;
  focusedCardId: string | null;
  highlightedTaskIds: Set<string> | null;
  /** Facet-filter match set (issue 1091) — null when no facet active. */
  facetMatchIds: Set<string> | null;
  overallocByResourcePerTask: Map<string, Map<string, number>>;
  onCardFocus: (taskId: string, status: TaskStatus, phaseId: string) => void;
  onShowDeps: (task: Task) => void;
  onShowRisks: (task: Task) => void;
  onChainHover: (taskId: string | null) => void;
  onCardClick: (task: Task, anchor: HTMLElement) => void;
  onOpenMilestone: (task: Task) => void;
  showEvm: EvmMode;
  showCost: boolean;
  customFieldDefs: ProjectCustomField[];
  /** Board-wide readiness-chip gate (#2430) — false when the chip is universal. */
  showReadiness: boolean;
  /** Sprint scope-injection accept/reject affordance (ADR-0102). */
  scopeActions: BoardCardScopeActions;
  /** Closed-sprint read-only (#1141): disables drag-to-assign on every card. */
  readOnly?: boolean;
  /** Workshop mode: editable names, drag handle, tinted bg. */
  workshop?: boolean;
  onPhaseRename?: (phaseId: string, newName: string) => void;
  dragHandleListeners?: Record<string, unknown>;
  dragHandleAttributes?: Record<string, unknown>;
  /** Per-status explicit column widths (issue 285), keyed by status. */
  columnWidths?: Record<string, number>;
  /** Explicit lane height in px (issue 285), or undefined for the natural height. */
  phaseHeight?: number;
  /** Persist a new clamped lane height (issue 285). */
  onResizeHeight: (phaseId: string, px: number) => void;
  /** Per-cell card cap (issue 1967, ADR-0420); `null` = off. */
  cellCap: number | null;
  /** Current user's resource id — exempts my-own cards from the cap. */
  myResourceId: string | null;
}

/**
 * Lane collapse/expand chevron. ~14px glyph plus an invisible expander to reach
 * the 44px touch target (rule 5) without disturbing the dense lane-header row.
 */
function LaneCollapseToggle({
  phaseId,
  phaseName,
  collapsed,
  onToggleCollapse,
  onKeyDown,
}: {
  phaseId: string;
  phaseName: string;
  collapsed: boolean;
  onToggleCollapse: (phaseId: string) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggleCollapse(phaseId)}
      onKeyDown={onKeyDown}
      title={collapsed ? 'Expand lane  ]' : 'Collapse lane  ['}
      className="relative flex-shrink-0 text-neutral-text-secondary text-xs select-none
        focus:ring-2 focus:ring-brand-primary focus:outline-none rounded-control
        before:absolute before:inset-[-15px] before:content-['']"
      aria-expanded={!collapsed}
      aria-controls={`phase-${phaseId}-content`}
      aria-label={collapsed ? `Expand ${phaseName}` : `Collapse ${phaseName}`}
    >
      {collapsed ? '▸' : '▾'}
    </button>
  );
}

/**
 * Phase-lane focus toggle (issue 1460, ADR-0192 Part 3). Zooms the board to this
 * one lane (others hidden) via the ?focus= URL param; pressing it again, or the
 * focus banner's "Exit focus", clears it. Rendered in the lane meta header row so
 * the affordance sits with the phase it scopes to. 22px visual control plus an
 * invisible expander to reach the 44px touch target (rule 5).
 */
function LaneFocusToggle({
  phaseId,
  phaseName,
  focused,
  onToggleFocus,
}: {
  phaseId: string;
  phaseName: string;
  focused: boolean;
  onToggleFocus: (phaseId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggleFocus(phaseId)}
      title={focused ? 'Exit focus' : `Focus on ${phaseName}`}
      data-testid={`focus-lane-${phaseId}`}
      aria-pressed={focused}
      aria-label={focused ? `Exit focus on ${phaseName}` : `Focus on ${phaseName}`}
      className={[
        'relative flex-shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded-control border',
        focused
          ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
          : 'border-neutral-border bg-neutral-surface text-neutral-text-secondary hover:border-brand-primary/50 hover:text-brand-primary',
        'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
        "before:absolute before:inset-[-11px] before:content-['']",
      ].join(' ')}
    >
      <svg
        aria-hidden="true"
        width={13}
        height={13}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/**
 * A column collapsed board-wide (issue 1459) renders as a narrow empty stub
 * track in every lane so the lane stays aligned with the stubbed header;
 * clicking it expands the column back.
 */
function LaneColumnStubTrack({
  phaseId,
  col,
  count,
  onExpandColumn,
}: {
  phaseId: string;
  col: { status: TaskStatus; label: string };
  count: number;
  onExpandColumn: (status: TaskStatus) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onExpandColumn(col.status)}
      title={`Expand ${col.label}`}
      aria-label={`Expand ${col.label} column`}
      data-testid={`lane-stub-${phaseId}-${col.status}`}
      className="bg-neutral-surface-sunken/60 border-l border-neutral-border
                  hover:bg-neutral-surface-sunken focus:outline-none focus:ring-2
                  focus:ring-brand-primary focus:ring-inset"
    >
      {count > 0 && (
        <span className="sr-only">
          {count} task{count !== 1 ? 's' : ''}
        </span>
      )}
    </button>
  );
}

/**
 * A cell inside a collapsed lane: the card count only. An empty one shows a
 * dashed hollow "0" so a collapsed lane reads as "no cards", not "n/a" (#1943)
 * — matching the ColumnStub empty treatment (#1697) instead of a bare em-dash
 * (rule 201).
 */
function CollapsedLaneCell({ count }: { count: number }) {
  return (
    <div className="bg-neutral-surface-sunken border-l border-neutral-border p-2 min-h-[56px] flex items-center justify-center">
      {count > 0 ? (
        <span className="text-xs text-neutral-text-secondary">
          {count} task{count !== 1 ? 's' : ''}
        </span>
      ) : (
        <>
          <span
            aria-hidden="true"
            className="tppm-mono tabular-nums text-xs font-bold min-w-[18px] px-1 py-px rounded-full border border-dashed border-neutral-border text-neutral-text-secondary text-center"
          >
            0
          </span>
          <span className="sr-only">0 cards, empty</span>
        </>
      )}
    </div>
  );
}

function PhaseLaneImpl({
  phase,
  columns,
  tasksByStatus,
  milestones,
  overStatus,
  isDragActive,
  showWip,
  showColTints,
  density,
  collapsed,
  onToggleCollapse,
  collapsedColumns,
  onExpandColumn,
  focused,
  onToggleFocus,
  onMenuMove,
  onAddTask,
  focusedCardId,
  highlightedTaskIds,
  overallocByResourcePerTask,
  onCardFocus,
  onShowDeps,
  onShowRisks,
  onChainHover,
  onCardClick,
  onOpenMilestone,
  showEvm,
  showCost,
  customFieldDefs,
  showReadiness,
  scopeActions,
  readOnly = false,
  workshop = false,
  onPhaseRename,
  dragHandleListeners,
  dragHandleAttributes,
  facetMatchIds,
  columnWidths,
  phaseHeight,
  onResizeHeight,
  cellCap,
  myResourceId,
}: PhaseLaneProps) {
  const avg = phaseProgress(phase);
  const committedTaskCount = phase.tasks.filter(isTaskScheduled).length;
  const color = phaseColor(phase.id);
  // Synthetic phase-less Project Tasks lane (#386 / #387): the only way the
  // 'root' lane has zero tasks is when the `phases` useMemo injected it
  // because the project has no committed structure but at least one BACKLOG
  // card exists. The real 'root' lane (parentless committed tasks) always
  // has tasks.length > 0 by construction in `buildPhases`. When synthetic,
  // the "+ Add task" button reads "Add to backlog" and the modal defaults
  // status to BACKLOG — VoC consensus on the BACKLOG-vs-TO-DO question.
  const isSynthetic = phase.id === 'root' && phase.tasks.length === 0;

  // Aggregate cost data for phase header (issue #189).
  const phaseBudgetAtCompletion = phase.tasks.reduce<number | null>((acc, t) => {
    if (t.budgetAtCompletion == null) return acc;
    return (acc ?? 0) + t.budgetAtCompletion;
  }, null);
  const phaseActualCost = phase.tasks.reduce<number | null>((acc, t) => {
    if (t.actualCost == null) return acc;
    return (acc ?? 0) + t.actualCost;
  }, null);

  // Keyboard [ / ] shortcuts collapse/expand the focused lane (issue #190).
  // Skip when focus is inside a form element to avoid capturing text input.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === '[' && !collapsed) {
        e.preventDefault();
        onToggleCollapse(phase.id);
      }
      if (e.key === ']' && collapsed) {
        e.preventDefault();
        onToggleCollapse(phase.id);
      }
    },
    [collapsed, onToggleCollapse, phase.id],
  );

  const collapseToggle = (
    <LaneCollapseToggle
      phaseId={phase.id}
      phaseName={phase.name}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      onKeyDown={handleKeyDown}
    />
  );
  const focusToggle = (
    <LaneFocusToggle
      phaseId={phase.id}
      phaseName={phase.name}
      focused={focused}
      onToggleFocus={onToggleFocus}
    />
  );

  return (
    <div
      role="group"
      aria-label={`${phase.name} swimlane`}
      className="relative border-b border-neutral-border last:border-b-0"
    >
      {!collapsed && milestones.length > 0 && (
        <PhaseMilestoneRail
          milestones={milestones}
          columns={columns}
          collapsedColumns={collapsedColumns}
          columnWidths={columnWidths}
          onOpenTask={onOpenMilestone}
        />
      )}
      <div
        id={`phase-${phase.id}-content`}
        className="relative grid gap-[var(--board-col-gap,0.5rem)] p-2 w-max min-w-full"
        style={{
          gridTemplateColumns: boardGridTemplate(columns, collapsedColumns, columnWidths),
          // Explicit lane height (issue 285): a min-height so the lane grows to the
          // dragged size but a card is never forced below its own minimum.
          minHeight: !collapsed && phaseHeight ? `${phaseHeight}px` : undefined,
        }}
      >
        {/* Phase meta — LaneMeta atom (issue 208). The outer wrapper is the
            sticky-left sidebar (issue 1458): pinned during horizontal scroll, with
            a sunken background that matches the lane so body cards passing
            behind it (and behind the card's rounded corners) stay hidden. */}
        <div className="sticky left-0 z-[5] bg-neutral-surface-sunken">
          <div className="rounded-card overflow-hidden border border-neutral-border/40 min-w-0 bg-neutral-surface h-full">
            <LaneMeta
              phaseId={phase.id}
              phaseName={phase.name}
              avgProgress={avg}
              taskCount={phase.tasks.length}
              committedTaskCount={committedTaskCount}
              railColor={color}
              workshop={workshop}
              onPhaseRename={onPhaseRename ? (name) => onPhaseRename(phase.id, name) : undefined}
              dragHandleListeners={dragHandleListeners}
              dragHandleAttributes={dragHandleAttributes}
              onAddTask={onAddTask ? () => onAddTask(phase.id, phase.name, isSynthetic) : undefined}
              addTaskLabel={isSynthetic ? 'Add to backlog' : undefined}
              collapseToggle={collapseToggle}
              focusToggle={focusToggle}
              showCost={showCost}
              phaseBudgetAtCompletion={phaseBudgetAtCompletion}
              phaseActualCost={phaseActualCost}
            />
            <div className="px-[11px] pb-2">
              <PhaseSummaryChips phase={phase} />
            </div>
          </div>
        </div>

        {/* Column cells. A column collapsed board-wide (issue 1459) renders as a
            narrow empty stub track in every lane so the lane stays aligned
            with the stubbed header; clicking the header stub expands it. */}
        {columns.map((col) => {
          const cellCount = tasksByStatus[col.status]?.length ?? 0;
          if (collapsedColumns.has(col.status)) {
            return (
              <LaneColumnStubTrack
                key={col.status}
                phaseId={phase.id}
                col={col}
                count={cellCount}
                onExpandColumn={onExpandColumn}
              />
            );
          }
          if (collapsed) {
            return <CollapsedLaneCell key={col.status} count={cellCount} />;
          }
          return (
            <BoardCell
              key={col.status}
              phaseId={phase.id}
              status={col.status}
              tasks={tasksByStatus[col.status] ?? EMPTY_TASKS}
              isOver={overStatus === col.status}
              isDragActive={isDragActive}
              showWip={showWip}
              showColTints={showColTints}
              density={density}
              wipLimit={col.wipLimit}
              onMenuMove={onMenuMove}
              columns={columns}
              focusedCardId={focusedCardId}
              highlightedTaskIds={highlightedTaskIds}
              facetMatchIds={facetMatchIds}
              overallocByResourcePerTask={overallocByResourcePerTask}
              onCardFocus={onCardFocus}
              onShowDeps={onShowDeps}
              onShowRisks={onShowRisks}
              onChainHover={onChainHover}
              onCardClick={onCardClick}
              showEvm={showEvm}
              showCost={showCost}
              customFieldDefs={customFieldDefs}
              showReadiness={showReadiness}
              scopeActions={scopeActions}
              readOnly={readOnly}
              cellCap={cellCap}
              myResourceId={myResourceId}
            />
          );
        })}
        {/* Drag the bottom edge to resize this lane's height (issue 285). Expanded
            lanes only — a collapsed lane has no resizable body. */}
        {!collapsed && (
          <PhaseResizeHandle label={phase.name} onResize={(px) => onResizeHeight(phase.id, px)} />
        )}
      </div>
    </div>
  );
}

// Memoized so a board re-render driven by state that doesn't touch this lane
// (a search keystroke, another lane's drag-over via the pre-computed `overStatus`,
// an unrelated toolbar toggle) skips the lane entirely (issue 1520). Effective
// only because the parent's `laneProps` now feeds reference-stable values —
// stable task-aware callbacks, hoisted empty fallbacks, and a memoized columns
// array — instead of per-lane closures.
const PhaseLane = memo(PhaseLaneImpl);

// ---------------------------------------------------------------------------
// Sortable phase lane — workshop mode drag-to-reorder wrapper
// ---------------------------------------------------------------------------

function SortablePhaseLane(props: PhaseLaneProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `phase:${props.phase.id}`,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  // `attributes` (role=button, tabIndex, aria-*) go on the real ⋮⋮ handle button
  // inside LaneMeta — NOT here. Spreading them on the wrapper turned the entire
  // swimlane into one giant role="button" and left the handle keyboard/SR-inert (#2201).
  return (
    <div ref={setNodeRef} style={style}>
      <PhaseLane
        {...props}
        dragHandleListeners={listeners as Record<string, unknown>}
        dragHandleAttributes={attributes as unknown as Record<string, unknown>}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// localStorage-backed hooks
// ---------------------------------------------------------------------------

/** Persist collapsed lane IDs per project (issue #190). */
function useBoardCollapsedLanes(projectId: string) {
  const storageKey = `trueppm.board.${projectId}.collapsedLanes`;

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });

  const toggle = useCallback(
    (id: string) => {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [storageKey],
  );

  const collapseAll = useCallback(
    (ids: string[]) => {
      const next = new Set(ids);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      setCollapsedIds(next);
    },
    [storageKey],
  );

  const expandAll = useCallback(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([]));
    } catch {
      /* ignore */
    }
    setCollapsedIds(new Set<string>());
  }, [storageKey]);

  return { collapsedIds, toggle, collapseAll, expandAll };
}

/**
 * Persist collapsed *column* (status) IDs per project (issue 1459, ADR-0192 Part 2).
 *
 * Mirrors `useBoardCollapsedLanes` but keyed on TaskStatus and stored under a
 * sibling localStorage key. Collapsing is a vertical operation — a column
 * folded here renders as a stub across every phase lane — so the state is
 * board-wide, not per-lane. localStorage-only by ADR-0192 (no server model);
 * the blob is a plain string[] of statuses, forward-compatible because an
 * unknown status simply never matches a rendered column.
 */
function useBoardCollapsedColumns(projectId: string) {
  const storageKey = `trueppm.board.${projectId}.collapsedColumns`;

  const [collapsedColumns, setCollapsedColumns] = useState<Set<TaskStatus>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return new Set<TaskStatus>(raw ? (JSON.parse(raw) as TaskStatus[]) : []);
    } catch {
      return new Set<TaskStatus>();
    }
  });

  const persist = useCallback(
    (next: Set<TaskStatus>) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );

  const toggleColumn = useCallback(
    (status: TaskStatus) => {
      setCollapsedColumns((prev) => {
        const next = new Set(prev);
        if (next.has(status)) next.delete(status);
        else next.add(status);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const expandColumn = useCallback(
    (status: TaskStatus) => {
      setCollapsedColumns((prev) => {
        if (!prev.has(status)) return prev;
        const next = new Set(prev);
        next.delete(status);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const expandAllColumns = useCallback(() => {
    const empty = new Set<TaskStatus>();
    persist(empty);
    setCollapsedColumns(empty);
  }, [persist]);

  return { collapsedColumns, toggleColumn, expandColumn, expandAllColumns };
}

/**
 * Persist card density preference globally across all projects (issue #193).
 * Below md (768px) the board auto-selects compact density; the user can
 * override for the session. Crossing back above md clears the mobile override
 * and restores the persisted desktop preference (issue #224).
 */
function useBoardDensity() {
  const storageKey = 'trueppm.board.density';

  const [storedDensity, setStoredDensity] = useState<BoardDensity>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === 'compact' || raw === 'comfortable' || raw === 'detailed') return raw;
    } catch {
      /* ignore */
    }
    return 'comfortable';
  });

  // Session-only override applied when the user manually changes density on mobile.
  // Cleared when the viewport grows past md so desktop preference resumes.
  const [mobileOverride, setMobileOverride] = useState<BoardDensity | null>(null);

  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) setMobileOverride(null);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const density: BoardDensity = isMobile ? (mobileOverride ?? 'compact') : storedDensity;

  const setDensity = useCallback(
    (d: BoardDensity) => {
      if (isMobile) {
        setMobileOverride(d);
      } else {
        try {
          localStorage.setItem(storageKey, d);
        } catch {
          /* ignore */
        }
        setStoredDensity(d);
      }
    },
    [isMobile, storageKey],
  );

  return { density, setDensity, isMobile };
}

// ---------------------------------------------------------------------------
// Mobile snap-scroll board (v3 case 8)
// ---------------------------------------------------------------------------

export function BoardView() {
  // document.title for this route is set at the router level (router.tsx
  // `handle.title`) — see RouteTitle (issue 1915, completes #1327 A4).
  const {
    projectId,
    projectIdOrNull,
    projectIdOrUndefined,
    currentRole,
    canShareBoard,
    canConfigureBoard,
  } = useBoardIdentity(useProjectId());
  const [shareOpen, setShareOpen] = useState(false);
  const { columns: rawColumns, save: saveBoardConfig } = useBoardConfig(projectIdOrNull);
  const { tasks, isLoading, error } = useScheduleTasks();
  const updateStatus = useUpdateTaskStatus();
  const updateTask = useUpdateTask();
  const queryClient = useQueryClient();
  // Board offline (ADR-0220): hydrate the offline card-status queue, seed the
  // board from the last cached fetch when opened offline, and flush queued moves
  // on reconnect. Scoped to card-status moves; all other writes keep ADR-0205.
  useBoardOffline(projectIdOrNull);
  const { data: workshopSession } = useWorkshopSession(projectIdOrNull);
  const startWorkshop = useStartWorkshop(projectIdOrNull);
  const endWorkshop = useEndWorkshop(projectIdOrNull);
  const phaseReorder = usePhaseReorder(projectIdOrNull);
  const queueReorder = useQueueReorder(projectIdOrNull);
  const canManageBacklog = useCanManageBacklog(projectIdOrUndefined);
  // BACKLOG cards live in the band above the phase grid (ADR-0057), not in an
  // inline column inside each phase. The visible-column list excludes BACKLOG
  // even when the saved board config marks it visible — that flag governs the
  // (now-deprecated) inline column, not the band.
  // Memoized (issue 1520): a per-render `.filter()` result is a new array identity
  // every render, which would ripple into `handleMenuMove`'s dep list and every
  // `columns` prop, defeating the BoardCell/PhaseLane/BoardCard memoization.
  const COLUMNS = useMemo(
    () => rawColumns.filter((c) => c.visible && c.status !== 'BACKLOG'),
    [rawColumns],
  );

  // Board resize (issue 285). Per-column widths (keyed by status) override the
  // zoom-driven --board-col-w track; per-phase heights (keyed by phase id) set a
  // lane min-height. Both persist to localStorage and clamp on write.
  const { widths: columnWidths, setWidth: setColumnWidth } = useBoardColumnWidths();
  const { heights: phaseHeights, setHeight: setPhaseHeight } = useBoardPhaseHeights();

  const [searchParams, setSearchParams] = useSearchParams();

  // Board sprint view (#429, #1141). The selected sprint scopes the phase
  // columns to a single sprint; `null` = Project view (all committed tasks).
  // Persisted in the `?sprint=` URL param (a distinct, shareable axis from the
  // `?view=` saved views) so a sprint board link can be shared. The backlog band
  // is unaffected — it stays the intake source you drag from.
  const {
    sprints,
    selectedSprintId,
    selectedSprint,
    selectedSprintName,
    setSelectedSprintId,
    sprintClosed,
  } = useBoardSprintScope(projectId, searchParams, setSearchParams);

  const readOnly = boardReadOnly(currentRole, sprintClosed);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overCell, setOverCell] = useState<string | null>(null); // `${phaseId}:${status}`
  // Scope-injection drop toast (#1140) — set when a drop into the ACTIVE sprint
  // creates a pending scope-change; `BoardDropNotice` auto-dismisses it.
  const [dropNotice, setDropNotice] = useState<{ key: number; text: string } | null>(null);
  const [workshopMode, setWorkshopMode] = useState(false);
  // Open the workshop WS channel while a session is active so participant
  // join/leave events update the banner in real time.
  useWorkshopSocket(projectIdOrNull, workshopMode && !!workshopSession, (event) => {
    if (event.event_type === 'participant_joined' || event.event_type === 'participant_left') {
      void queryClient.invalidateQueries({ queryKey: ['workshopSession', projectId] });
    }
  });
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const workshopToggleRef = useRef<HTMLButtonElement>(null);
  const [phaseOrder, setPhaseOrder] = useState<string[]>([]);
  const [sort, setSort] = useState<BoardSortKey>('priority');
  const [showWip, setShowWip] = useState(true);
  const [showColTints, setShowColTints] = useState(true);
  // `isSynthetic` flags the phase-less Project Tasks lane (#386) — when true,
  // TaskFormModal opens with status defaulting to BACKLOG and the modal title
  // reads "Add to backlog" rather than "Add to Project Tasks". Issue #387.
  const [addTaskPhase, setAddTaskPhase] = useState<{
    id: string;
    name: string;
    isSynthetic?: boolean;
    // Explicit status override (issue 605) — the mobile FAB targets the group in
    // view, so it opens the modal preset to that status. When absent the modal
    // falls back to the isSynthetic-derived default (BACKLOG / NOT_STARTED).
    status?: TaskStatus;
  } | null>(null);
  // The status column currently snapped into view on the mobile board (issue 605)
  // — drives the FAB's create-into-visible-group default. Seeded to the first
  // column and kept in sync by MobileBoard's IntersectionObserver.
  const [mobileActiveStatus, setMobileActiveStatus] = useState<TaskStatus>('NOT_STARTED');
  const [riskLinkedOnly, setRiskLinkedOnly] = useState(false);
  // Tech-debt filter (ADR-0178, #1076) — transient board toggle that narrows to
  // type=tech_debt so a team can see remediation work distinctly. Not part of a
  // saved view; it's a quick lens, like the at-risk toggle's intent.
  const [debtOnly, setDebtOnly] = useState(false);
  const [evmMode, setEvmMode] = useState<EvmMode>('off');
  const [showCost, setShowCost] = useState(false);
  // Built-in view filter state (issue #191)
  const [cpOnly, setCpOnly] = useState(false);
  const [dueSoonDays, setDueSoonDays] = useState<number | null>(null);
  // "My tasks" filter (issue #198) — default by role, persisted per-user-per-project.
  const myTasksFilter = useMyTasksFilter(projectIdOrUndefined);
  const { resourceId: myResourceId } = useCurrentUserResourceId(projectIdOrUndefined);
  // Active when the user has opted in AND has a resource on the project. If the
  // user has no resource and no email match, mineActive is true but myResourceId
  // is null — phaseTaskMap below resolves that to "zero matches" so the
  // dedicated empty state renders.
  const mineActive = myTasksFilter.enabled && !myTasksFilter.isLoading;
  // Active saved/built-in view ID — synced to ?view= URL param
  const [activeViewId, setActiveViewId] = useState<string | null>(() => searchParams.get('view'));
  // Keyboard focus (issue #195) — focused card + last-focused column for L/H traversal.
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [focusedColumn, setFocusedColumn] = useState<TaskStatus | null>(null);
  const [focusedPhaseId, setFocusedPhaseId] = useState<string | null>(null);
  // Overlay state — only one is open at a time.
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  // "Recently deleted" task Trash (#2494, ADR-0689) — recovery that outlives the
  // delete Undo toast. Every member may open it; per-row Restore is server-gated.
  const [taskTrashOpen, setTaskTrashOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [depTask, setDepTask] = useState<Task | null>(null);
  const [riskTask, setRiskTask] = useState<Task | null>(null);
  // Card popover (issue #304) — single instance at a time. Anchor is the
  // originating card element; required for desktop placement and for
  // returning focus on close. selectedTaskId drives the TaskDetailDrawer
  // mount (folded #265 in via the popover's "Open detail" CTA).
  const [popoverTask, setPopoverTask] = useState<Task | null>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<HTMLElement | null>(null);
  // Drawer selection round-trips `?task=` so a `/board?task=<id>` deep-link opens
  // the card and every open/close survives a refresh or link-copy (issue #2031).
  // The shared hook seeds from the initializer and mirrors back with the guard
  // that stops the mount write from clobbering `?sprint=`.
  const [selectedTaskId, setSelectedTaskId] = useUrlSelectedId('task');
  // Board activity feed panel (ADR-0160, issue 1261) — open state persisted per project,
  // mirroring the SprintPanel/FlowAnalyticsPanel disclosure convention.
  const activityStorageKey = `trueppm.board.${projectId}.activityPanel.open`;
  const [activityOpen, setActivityOpen] = useState(false);
  useEffect(() => {
    try {
      setActivityOpen(window.localStorage.getItem(activityStorageKey) === 'true');
    } catch {
      // localStorage unavailable (private mode) — default closed.
    }
  }, [activityStorageKey]);
  const toggleActivity = useCallback(() => {
    setActivityOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(activityStorageKey, String(next));
      } catch {
        // best-effort persistence
      }
      return next;
    });
  }, [activityStorageKey]);
  // Daily standup walk-the-board mode (issue 1278, ADR-0166). State lives in the URL
  // (?standup=1) — a focused "drive the room" mode is shareable to a projector tab and
  // survives refresh, unlike the localStorage-persisted activity rail.
  const standupOpen = searchParams.get('standup') === '1';
  const openStandup = useCallback(() => {
    setSearchParams((prev: URLSearchParams) => {
      prev.set('standup', '1');
      return prev;
    });
  }, [setSearchParams]);
  const closeStandup = useCallback(() => {
    setSearchParams(
      (prev: URLSearchParams) => {
        prev.delete('standup');
        return prev;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  // Phase-lane focus mode (issue 1460, ADR-0192 Part 3). Like ?standup=, the focused
  // phase lives in the URL (?focus=<phaseId>) so the zoomed-in view is
  // shareable to a teammate or projector tab and survives refresh. Other URL
  // scope params (?sprint=, ?q=) are preserved by the functional updater, so a
  // focus link keeps the active-sprint scope alongside it (VoC: Alex).
  const focusedLanePhaseId = searchParams.get('focus');
  const setFocusLane = useCallback(
    (phaseId: string) => {
      setSearchParams((prev: URLSearchParams) => {
        prev.set('focus', phaseId);
        return prev;
      });
    },
    [setSearchParams],
  );
  const exitFocusLane = useCallback(() => {
    setSearchParams((prev: URLSearchParams) => {
      prev.delete('focus');
      return prev;
    });
  }, [setSearchParams]);
  const toggleFocusLane = useCallback(
    (phaseId: string) => {
      if (focusedLanePhaseId === phaseId) exitFocusLane();
      else setFocusLane(phaseId);
    },
    [focusedLanePhaseId, exitFocusLane, setFocusLane],
  );
  // editTaskId opens the unified TaskFormModal in edit mode (issue #305).
  // The popover's "Edit" footer action sets this; the modal owns the rest.
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  // Dim non-connected cards (#182) — null means no highlight active.
  const [highlightedTaskIds, setHighlightedTaskIds] = useState<Set<string> | null>(null);
  const [chainHoverTaskId, setChainHoverTaskId] = useState<string | null>(null);
  const ariaLiveRef = useRef<HTMLDivElement>(null);

  // Board card search (issue 323, ADR-0145). The query mirrors to ?q= for shareable
  // links; matching IDs feed the existing dim plumbing via effectiveHighlightIds.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState<string>(() => searchParams.get('q') ?? '');
  const onSearchQueryChange = useCallback(
    (q: string) => {
      setSearchQuery(q);
      setSearchParams(
        (prev: URLSearchParams) => {
          if (q.trim()) prev.set('q', q);
          else prev.delete('q');
          return prev;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const {
    matchIds: searchMatchIds,
    matchCount: searchMatchCount,
    isSearching,
  } = useBoardCardSearch(projectId, searchQuery);
  // Search dimming reuses the issue-182 dep-chain dim set. A query with matches takes
  // precedence over a transient dep-hover highlight; an empty query (or one that
  // matches nothing) leaves the board undimmed so it never greys out wholesale.
  const effectiveHighlightIds = searchDimSet(searchQuery, searchMatchIds, highlightedTaskIds);

  // Board facet filters (issue 1091, ADR-0199). URL params (fa/fp/fd) are the
  // shareable source of truth; localStorage per project seeds them once on first
  // mount when the URL carries no facet params (a shared link is authoritative).
  const [facetFilters, setFacetFilters] = useState<FacetFilters>(() =>
    parseFacetsFromParams(searchParams),
  );
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const facetSeededRef = useRef(false);
  useEffect(() => {
    if (facetSeededRef.current) return;
    if (!projectId) return;
    facetSeededRef.current = true;
    // A URL that already carries facets wins — never override a shared link.
    if (paramsHaveFacets(searchParams)) return;
    let stored: FacetFilters = EMPTY_FACETS;
    try {
      stored = deserializeFacets(localStorage.getItem(facetsStorageKey(projectId)));
    } catch {
      /* localStorage unavailable — start empty */
    }
    if (isFacetsActive(stored)) {
      setFacetFilters(stored);
      setSearchParams(
        (prev: URLSearchParams) => {
          const next = new URLSearchParams(prev);
          writeFacetsToParams(next, stored);
          return next;
        },
        { replace: true },
      );
    }
  }, [projectId, searchParams, setSearchParams]);

  // Single writer for facet changes: pushes to both the URL (shareable) and
  // per-project localStorage (persistence). One path so the two never diverge.
  const onFacetsChange = useCallback(
    (next: FacetFilters) => {
      setFacetFilters(next);
      setSearchParams(
        (prev: URLSearchParams) => {
          const params = new URLSearchParams(prev);
          writeFacetsToParams(params, next);
          return params;
        },
        { replace: true },
      );
      if (projectId) {
        try {
          localStorage.setItem(facetsStorageKey(projectId), serializeFacets(next));
        } catch {
          /* best-effort persistence */
        }
      }
    },
    [setSearchParams, projectId],
  );
  const onClearAllFacets = useCallback(() => onFacetsChange(EMPTY_FACETS), [onFacetsChange]);
  const toggleFilterPanel = useCallback(() => setFilterPanelOpen((v) => !v), []);

  // Snapshot of current toolbar state for "Save view" — keeps the dropdown in sync.
  // filters always carries the live facet state (never `undefined`) so saving
  // captures "no filters active" as explicitly as it captures an active set —
  // the round trip must be lossless in both directions (#1918).
  const currentViewConfig: BoardViewConfig = useMemo(
    () => ({
      sort,
      showWip,
      showColTints,
      evmMode,
      showCost,
      riskLinkedOnly,
      cpOnly: cpOnly || undefined,
      dueSoonDays: dueSoonDays ?? undefined,
      filters: facetFilters,
    }),
    [
      sort,
      showWip,
      showColTints,
      evmMode,
      showCost,
      riskLinkedOnly,
      cpOnly,
      dueSoonDays,
      facetFilters,
    ],
  );

  const applyViewConfig = useCallback(
    (config: Partial<BoardViewConfig>, viewId: string | null) => {
      if (config.sort !== undefined) setSort(config.sort);
      if (config.showWip !== undefined) setShowWip(config.showWip);
      if (config.showColTints !== undefined) setShowColTints(config.showColTints);
      if (config.evmMode !== undefined) setEvmMode(config.evmMode);
      if (config.showCost !== undefined) setShowCost(config.showCost);
      if (config.riskLinkedOnly !== undefined) setRiskLinkedOnly(config.riskLinkedOnly);
      setCpOnly(config.cpOnly ?? false);
      setDueSoonDays(config.dueSoonDays ?? null);
      // Facets are reset unconditionally on every view switch (like cpOnly /
      // dueSoonDays above), not merged: a built-in quick filter has no opinion
      // on facets and should clear whatever was active, while a saved view's
      // config.filters is the sole source of truth for what to restore (#1918).
      onFacetsChange(config.filters ?? EMPTY_FACETS);
      setActiveViewId(viewId);
      // Sync view ID to URL for deep links
      if (viewId) {
        setSearchParams(
          (prev: URLSearchParams) => {
            prev.set('view', viewId);
            return prev;
          },
          { replace: true },
        );
      } else {
        setSearchParams(
          (prev: URLSearchParams) => {
            prev.delete('view');
            return prev;
          },
          { replace: true },
        );
      }
    },
    [setSearchParams, onFacetsChange],
  );

  const {
    collapsedIds,
    toggle: toggleCollapse,
    collapseAll,
    expandAll,
  } = useBoardCollapsedLanes(projectId);
  const { collapsedColumns, toggleColumn, expandColumn, expandAllColumns } =
    useBoardCollapsedColumns(projectId);
  const { density, setDensity, isMobile } = useBoardDensity();
  const toolbarPrefs = useBoardToolbarPrefs();

  // Custom-field marks on cards (#2144): the showOnCard subset, sorted by order,
  // gated by the per-user board master switch. Empty when muted so BoardCard renders
  // no field band. Memoized on the fields + the switch so the cards' React.memo holds.
  const { fields: allCustomFields } = useProjectCustomFields(projectId);
  const cardCustomFieldDefs = useMemo<ProjectCustomField[]>(
    () =>
      toolbarPrefs.showCustomFieldsOnCards
        ? allCustomFields.filter((f) => f.showOnCard).sort((a, b) => a.order - b.order)
        : [],
    [allCustomFields, toolbarPrefs.showCustomFieldsOnCards],
  );

  // On a phone the rail / drawer phase-grid layouts are unusable, so default a
  // user who never explicitly picked a layout to the mobile-friendly Queue
  // (issue 605). An explicit desktop choice is preserved across the breakpoint.
  const effectiveLayout = resolveBoardLayout(
    toolbarPrefs.layout,
    toolbarPrefs.layoutExplicit,
    isMobile,
  );
  // Effective swimlane grouping (324). Workshop mode authors WBS phase
  // structure, so it always groups by phase regardless of the saved preference.
  const groupMode: BoardGroupMode = workshopMode ? 'phase' : toolbarPrefs.groupBy;
  const { data: projectDetail } = useProject(projectIdOrNull);
  const iterationLabel = useIterationLabel(projectIdOrUndefined);

  // WIP-creep trend arrows (issue 1213). The CFD daily per-status counts already
  // carry each column's recent occupancy; read them at board level so the header
  // arrows are always-on (passive creep detection is the point). The default
  // window shares its TanStack Query key with FlowAnalyticsPanel, so opening the
  // panel reuses this cache rather than re-fetching. Suppressed / errored reads
  // yield no series → no arrow (ADR-0104; trend is enhancement-only chrome).
  const { data: flowMetrics } = useFlowMetrics(projectIdOrNull);
  const wipTrendSeriesByStatus = useMemo(() => {
    const map: Partial<Record<TaskStatus, number[]>> = {};
    if (!flowMetrics || flowMetrics.flow_metrics_suppressed) return map;
    const cfdStatuses = ['BACKLOG', 'NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'COMPLETE'] as const;
    for (const status of cfdStatuses) {
      map[status] = flowMetrics.cfd.map((row) => row.counts[status]);
    }
    return map;
  }, [flowMetrics]);

  // Sprint scope-injection approve-gate (ADR-0102). The active sprint carries
  // `pending_count`; a team-owned actor (role >= ADMIN) can open the review
  // slide-over. The server is the real gate — this only hides the affordance.
  const { sprint: activeSprint } = useActiveSprint(projectIdOrNull);
  const activeSprintId = useMemo(() => activeSprint?.id ?? null, [activeSprint]);
  const canManageScope = useCanManageScope(projectIdOrUndefined);
  const [scopeReviewOpen, setScopeReviewOpen] = useState(false);
  const { acceptOne: acceptScope, rejectOne: rejectScope } = useScopeChangeActions(
    projectIdOrNull,
    activeSprintId,
  );
  // rules 149/150: accept confirms, single reject offers an Undo re-add (#2149).
  // The hook toasts failures; this adds the positive path, same as the panel.
  const { confirmAccepted, confirmRejectedWithUndo } = useScopeDecisionFeedback(
    projectIdOrNull,
    activeSprintId,
  );
  const { projectName, methodology, boardCadence } = boardProjectMeta(projectDetail);
  // Map a pending card to its latest pending scope-change row id (the
  // accept/reject target) before firing the mutation. ADR-0102.
  const pendingScopeChangeId = useCallback((task: Task): string | undefined => {
    return (task.sprintScopeChanges ?? []).filter((sc) => sc.status === 'pending' && sc.id).at(-1)
      ?.id;
  }, []);
  const scopeActions: BoardCardScopeActions = useMemo(
    () => ({
      canManage: canManageScope,
      offline: typeof navigator !== 'undefined' && !navigator.onLine,
      onAccept: (task: Task) => {
        const id = pendingScopeChangeId(task);
        if (id) acceptScope.mutate(id, { onSuccess: () => confirmAccepted(task.name) });
      },
      onReject: (task: Task) => {
        const id = pendingScopeChangeId(task);
        if (id)
          rejectScope.mutate(id, {
            onSuccess: () => confirmRejectedWithUndo(task.id, task.name),
          });
      },
    }),
    [
      canManageScope,
      pendingScopeChangeId,
      acceptScope,
      rejectScope,
      confirmAccepted,
      confirmRejectedWithUndo,
    ],
  );

  // Space-held click-drag panning of the board grid (issue 1265). While Space is
  // held, `shouldSuppressDrag` gates the pointer sensor so a pointer-down pans
  // the scroll container instead of lifting a card; releasing Space restores
  // normal @dnd-kit drag. `scrollRef` attaches to the desktop grid scroller.
  const {
    setScrollEl: setBoardScrollEl,
    scrollEl: boardScrollEl,
    isSpaceHeld: isBoardPanArmed,
    isPanning: isBoardPanning,
    shouldSuppressDrag,
  } = useSpaceDragPan();

  // Vertical-overflow probe for the bottom edge-fade affordance (#1962). On
  // macOS/touch the auto-hiding scrollbar is the only "more below" cue, so a
  // card clipped at the fold reads as truncation; the fade renders only while
  // content sits below the scroll position.
  const hasScrollBelow = useHasScrollBelow(boardScrollEl);
  const hasScrollRight = useHasScrollRight(boardScrollEl);

  const sensors = useSensors(
    useSensor(SpaceAwarePointerSensor, {
      activationConstraint: { distance: 4 },
      shouldSuppressActivation: shouldSuppressDrag,
    }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const createTask = useCreateTask(projectIdOrNull);

  // Partition BACKLOG cards out of the phase tree (ADR-0057). Summary tasks
  // never have BACKLOG status, so the isSummary check is defensive — it would
  // otherwise be unreachable. The committed half drives buildPhases; the
  // backlog half drives the BacklogBand above the grid.
  // ⌘K handoff (issue 1609): the rail's search box opens the shared command
  // palette rather than owning its own capture overlay.
  const openCommandPalette = useCommandPaletteStore((s) => s.setOpen);
  const { committedTasks, backlogTasks } = useMemo(() => {
    const committed: Task[] = [];
    const backlog: Task[] = [];
    for (const t of tasks ?? []) {
      if (t.status === 'BACKLOG' && !t.isSummary) {
        backlog.push(t);
      } else if (selectedSprintId && t.sprintId !== selectedSprintId && !t.isSummary) {
        // Sprint view (#429): a committed task not in the selected sprint is
        // hidden from the phase columns. Summary tasks are kept so their phase
        // lane still renders as a drop target for pulling cards into the sprint.
        continue;
      } else {
        committed.push(t);
      }
    }
    return { committedTasks: committed, backlogTasks: backlog };
  }, [tasks, selectedSprintId]);

  // Facet-filter derivation (issue 1091). Pure client-side over the already-loaded
  // committed cards. `facetMatchIds` is null when no facet is active (nothing
  // dimmed); otherwise it is the set of card ids matching the active facets, and
  // any card not in it is dimmed (30% + aria-hidden). "Now" is captured once per
  // render so overdue/this-week are stable across the pass.
  const facetsActive = isFacetsActive(facetFilters);
  const assigneeOptions = useMemo(() => collectAssigneeOptions(committedTasks), [committedTasks]);
  const assigneeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const opt of assigneeOptions) m.set(opt.resourceId, opt.name);
    return m;
  }, [assigneeOptions]);
  // Label facet options + id→name map (ADR-0400) — derived from the labels on the
  // board's committed cards, mirroring the assignee-facet derivation above.
  const labelOptions = useMemo(() => collectLabelOptions(committedTasks), [committedTasks]);
  const labelNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const opt of labelOptions) m.set(opt.id, opt.name);
    return m;
  }, [labelOptions]);
  // Readiness chip gate (#2430): the chip is a *comparative* signal, so it is
  // suppressed board-wide when every visible card carries the same readiness —
  // a `baselined` chip on all of them is noise, not information. Decided here
  // (not in the card) so BoardCard stays unaware of board-view state, mirroring
  // the `cardCustomFieldDefs` contract.
  const showReadinessOnCards = useMemo(
    () => readinessIsInformative(committedTasks),
    [committedTasks],
  );
  const facetMatchIds = useMemo(() => {
    if (!facetsActive) return null;
    const now = new Date();
    const ids = new Set<string>();
    for (const t of committedTasks) {
      if (t.isSummary) continue;
      if (matchesFacets(t, facetFilters, now)) ids.add(t.id);
    }
    return ids;
  }, [facetsActive, committedTasks, facetFilters]);
  const { facetMatchCount, facetZeroMatch } = facetMatchSummary(facetsActive, facetMatchIds);

  // A saved view can outlive a label it filters on (#2394): #2385 made the
  // label filter persist, so deleting the label afterwards leaves a dangling id
  // that silently widens the board. Resolve against the project's label CATALOG,
  // never the card-derived `labelNameById` — that map omits live labels no
  // visible card carries, so it cannot tell "deleted" from "unused".
  const { data: labelCatalog } = useLabels(projectId ?? undefined);
  const { views: savedViews, update: updateSavedView } = useBoardSavedViews(projectId ?? null);
  const activeSavedView = savedViews.find((v) => v.id === activeViewId) ?? null;
  const danglingLabelIds = useMemo(
    () => missingLabelIds(activeSavedView?.config, labelCatalog),
    [activeSavedView, labelCatalog],
  );
  const facetCount = activeFacetCount(facetFilters);

  // Announce filter changes to assistive tech (issue 1091 AC; the issue 1033 aria
  // omission this explicitly guards against). Skips the initial mount so a plain
  // page load stays silent; a shared link with facets announces on first change.
  const facetAnnounceRef = useRef(false);
  useEffect(() => {
    if (!facetAnnounceRef.current) {
      facetAnnounceRef.current = true;
      return;
    }
    const node = ariaLiveRef.current;
    if (!node) return;
    node.textContent = facetsActive
      ? `${facetCount} filter${facetCount === 1 ? '' : 's'} active, ${facetMatchCount} card${
          facetMatchCount === 1 ? '' : 's'
        } match`
      : 'Filters cleared';
  }, [facetsActive, facetCount, facetMatchCount]);

  // Epic id → display name (364), built from the full task set: an epic story's
  // parent epic may sit outside the committed/in-sprint slice, so deriving names
  // from `committedTasks` alone would mislabel lanes. Epics are real Task rows
  // (type='epic') returned by the same schedule query.
  const epicNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks ?? []) {
      if (t.taskType === 'epic') m.set(t.id, t.name);
    }
    return m;
  }, [tasks]);

  const phases = useMemo<Phase[]>(() => {
    // Epic grouping (364): one lane per parent epic + a "(No epic)" lane. A pure
    // client lens over the same cards — read-only (the epic FK is edited from the
    // card drawer, never by dragging between lanes).
    if (groupMode === 'epic') {
      return buildEpicLanes(committedTasks, epicNameById);
    }
    // Assignee grouping (324): one lane per primary assignee + an Unassigned
    // lane. A pure client view over the same cards — no synthetic root/backlog
    // injection (that is phase-mode promote-target plumbing, 386).
    if (groupMode === 'assignee') {
      return buildAssigneeLanes(committedTasks);
    }
    const built = buildPhases(committedTasks, workshopMode);
    // #386: phase-less projects with at least one backlog card need a drop
    // target so the rail/drawer's "Drag right onto a phase" affordance works.
    // The synthetic 'root' lane already covers parentless committed tasks
    // (`buildPhases` injects it when rootTasks.length > 0); extend the same
    // injection to "has backlog but nothing committed" so promote-from-band
    // lands on `parent_id = null`. Workshop mode is a separate path (it
    // already shows + Add Phase as the empty CTA), so skip there.
    const hasRootLane = built.some((p) => p.id === 'root');
    if (!workshopMode && !hasRootLane && built.length === 0 && backlogTasks.length > 0) {
      built.push({ id: 'root', name: 'Project Tasks', summaryTask: undefined, tasks: [] });
    }
    return built;
  }, [committedTasks, workshopMode, backlogTasks.length, groupMode, epicNameById]);

  // Board PDF export (issue 326, ADR-0159). An off-screen `BoardPrintLayout`
  // (mounted below) is rasterized on demand; we render it from the same
  // already-filtered `phases`/`COLUMNS` the live board draws, so the export
  // honors the active sprint scope and saved-view filters with no re-derivation.
  const { user: currentUser } = useCurrentUser();
  const currentUserName = displayNameOf(currentUser);
  const boardPrintRef = useRef<HTMLDivElement>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  // The print surface mounts only while an export is in flight (not on every
  // render) so its duplicate projection of every card/column/phase name never
  // collides with the live board's text nodes — which would otherwise break
  // single-match queries across the app and the board's own tests.
  const [exportRequested, setExportRequested] = useState(false);
  const boardPrintData = useMemo(
    () =>
      buildBoardPrintData({
        projectName: projectName ?? 'Board',
        sprintName: selectedSprintName ?? null,
        columns: COLUMNS.map((c) => ({ status: c.status, label: c.label })),
        lanes: phases.map((p) => ({ id: p.id, name: p.name, tasks: p.tasks })),
        userName: currentUserName ?? null,
        generatedAtLabel: fmtUtcLong(new Date().toISOString()),
        filters: {
          myTasks: myTasksFilter.enabled,
          atRisk: riskLinkedOnly,
          techDebt: debtOnly,
          showCost,
          searchQuery,
          // BoardView holds the active view id but not its name (a child control
          // fetches the saved-views list); the sprint + filter context below
          // carry the scope, so a named view is intentionally not surfaced here.
          savedViewName: null,
        },
      }),
    [
      projectName,
      selectedSprintName,
      COLUMNS,
      phases,
      currentUserName,
      myTasksFilter.enabled,
      riskLinkedOnly,
      debtOnly,
      showCost,
      searchQuery,
    ],
  );

  // Requesting an export only flips `exportRequested`, which mounts the print
  // surface (below). The rasterize itself runs in the effect once the node is
  // committed to the DOM — so the layout exists for exactly the export and
  // never lingers to duplicate the board's text.
  const onExportPdf = useCallback(() => {
    if (exportRequested || exportingPdf) return;
    setExportRequested(true);
  }, [exportRequested, exportingPdf]);

  useEffect(() => {
    if (!exportRequested) return;
    const node = boardPrintRef.current;
    let cancelled = false;
    setExportingPdf(true);
    void (async () => {
      try {
        if (node) {
          await exportBoardPdf(node, {
            fileName: boardPdfFileName(projectName ?? 'board', new Date().toISOString()),
          });
        }
      } catch {
        if (!cancelled) toast.error("Couldn't generate the PDF — try again.");
      } finally {
        if (!cancelled) {
          setExportingPdf(false);
          setExportRequested(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exportRequested, projectName]);

  // Demotion confirmation candidate (ADR-0057, Option C) — set by handleDragEnd
  // when a NOT_STARTED card is dropped on the band; cleared on confirm/cancel.
  const [backlogDemoteCandidate, setBacklogDemoteCandidate] = useState<Task | null>(null);

  // Deferred WIP-breach move (#2050) — when a drop / keyboard move would push a
  // column past its WIP limit, the move is stashed here behind a styled
  // alertdialog instead of a native window.confirm fired mid-gesture. `perform`
  // is the full move (mutate + aria-live + drop notice) executed on confirm.
  const [wipMoveCandidate, setWipMoveCandidate] = useState<{
    breach: WipBreach;
    taskName: string;
    perform: () => void;
  } | null>(null);

  // Keyboard "Schedule…" dialog (#318, rule 135) — opened from a BacklogCard's
  // ··· action. Single instance like BacklogDemoteConfirmDialog. The trigger
  // ref returns focus to the originating ··· button on close.
  const [scheduleDialogTask, setScheduleDialogTask] = useState<Task | null>(null);
  const scheduleTriggerRef = useRef<HTMLElement | null>(null);
  const handleScheduleRequest = useCallback((task: Task, trigger: HTMLElement) => {
    scheduleTriggerRef.current = trigger;
    setScheduleDialogTask(task);
  }, []);
  const handleScheduleDialogClose = useCallback(() => {
    setScheduleDialogTask(null);
    scheduleTriggerRef.current?.focus();
    scheduleTriggerRef.current = null;
  }, []);

  // Every task grouping the three layouts read (grid cells, mobile snap lists,
  // queue list) plus the live per-status counts the WIP-limit guard needs before
  // issuing a move mutation (#232). Derived from one shared filter definition.
  const sortCell = useCallback((list: Task[]) => sortTasksBy(list, sort), [sort]);
  const boardFilters = useMemo(
    () => ({ cpOnly, dueSoonDays, mineActive, myResourceId, debtOnly, riskLinkedOnly }),
    [cpOnly, dueSoonDays, mineActive, myResourceId, debtOnly, riskLinkedOnly],
  );
  const { phaseTaskMap, mobileTasksByStatus, queueTasks, totalByStatus, myCountByStatus } =
    useBoardTaskMaps({ phases, allTasks: tasks, filters: boardFilters, sortCell });

  const handleAddPhase = useCallback(() => {
    const name = `Phase ${phases.filter((p) => p.id !== 'root').length + 1}`;
    createTask.mutate(
      { name, duration: 0, parent_id: null },
      // The create is fire-and-forget; without this a failed POST added nothing
      // to the board and told the user nothing (#2030).
      { onError: () => toast.error(`Couldn't add ${name} — try again.`) },
    );
  }, [createTask, phases]);

  // Keep phaseOrder in sync with server data; only reset when the phase set changes.
  // Preserve manual drag order: keep existing positions, append new phases at the end.
  const phaseIdKey = phases.map((p) => p.id).join(',');
  useEffect(() => {
    setPhaseOrder((prev) => {
      const newIds = phases.map((p) => p.id);
      const existing = prev.filter((id) => newIds.includes(id));
      const added = newIds.filter((id) => !prev.includes(id));
      return [...existing, ...added];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseIdKey]);

  // In workshop mode, sort phases by the locally-managed phaseOrder (optimistic).
  const sortedPhases = useMemo(() => {
    if (!workshopMode || phaseOrder.length === 0) return phases;
    return [...phases].sort((a, b) => {
      const ai = phaseOrder.indexOf(a.id);
      const bi = phaseOrder.indexOf(b.id);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [phases, phaseOrder, workshopMode]);

  // Lookup index for jump-to-card from popovers (#182, #195) and milestone classification.
  const taskIndex = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of tasks ?? []) m.set(t.id, t);
    return m;
  }, [tasks]);

  // Phase → milestone tasks (issue #187).  Milestones live on the same WBS branch
  // as their phase but are flagged via is_milestone.
  const milestonesByPhase = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks ?? []) {
      if (!t.isMilestone) continue;
      const phaseId = t.parentId ?? 'root';
      const list = m.get(phaseId) ?? [];
      list.push(t);
      m.set(phaseId, list);
    }
    return m;
  }, [tasks]);

  // Resource overallocation (issue #184) — peak factor per (resource, task).
  // Returns Map<task_id, Map<resource_id, factor>> for fast per-card lookup.
  const overalloc = useBoardOverallocation(projectId);
  const overallocByResourcePerTask = useMemo(() => {
    const out = new Map<string, Map<string, number>>();
    for (const [pairKey, factor] of overalloc.overallocByPair.entries()) {
      const [resourceId, taskId] = pairKey.split(':');
      const inner = out.get(taskId) ?? new Map<string, number>();
      inner.set(resourceId, factor);
      out.set(taskId, inner);
    }
    return out;
  }, [overalloc.overallocByPair]);

  // Dim non-connected cards (#182) — fetch dep edges only when hovering a chain icon.
  const chainHoverDeps = useTaskDependencies(chainHoverTaskId);
  useEffect(() => {
    if (!chainHoverTaskId) {
      setHighlightedTaskIds(null);
      return;
    }
    if (chainHoverDeps.isLoading) return;
    const connected = new Set<string>([chainHoverTaskId]);
    for (const e of chainHoverDeps.predecessors) connected.add(e.predecessorId);
    for (const e of chainHoverDeps.successors) connected.add(e.successorId);
    setHighlightedTaskIds(connected);
  }, [
    chainHoverTaskId,
    chainHoverDeps.isLoading,
    chainHoverDeps.predecessors,
    chainHoverDeps.successors,
  ]);

  const activeTask = useMemo(
    () => (activeId ? (tasks?.find((t) => t.id === activeId) ?? null) : null),
    [activeId, tasks],
  );

  const focusedTask = focusedCardId ? taskIndex.get(focusedCardId) : null;

  // Phase-name + phase-color lookups for the queue layout (#384). Keyed by
  // summary-task id with 'root' as the sentinel for parentless tasks.
  const phaseNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const phase of phases) m.set(phase.id, phase.name);
    return m;
  }, [phases]);

  // Single writer for the board's aria-live region (rule 105) so every move
  // path — drag, keyboard Move-to, demote confirm — announces the same way.
  const announce = useCallback((text: string) => {
    if (ariaLiveRef.current) ariaLiveRef.current.textContent = text;
  }, []);

  // WIP-limit guard (#232, #2050): if the destination column is at or over its
  // limit and the task isn't already there, defer the move behind a styled
  // confirm dialog instead of a native window.confirm mid-drop.
  // Toggle-independent (rule 176; #2169): the confirm is a process guardrail, so
  // — like the always-on breach chip — it must NOT be gated on the cosmetic
  // `showWip` display toggle. Only the numeric badge obeys `showWip`; a breach
  // still gates the move even with chips hidden.
  const guardWipThenMove = useCallback(
    (fromStatus: TaskStatus, toStatus: TaskStatus, taskName: string, perform: () => void) => {
      const breach =
        toStatus !== fromStatus ? wipBreachInfo(COLUMNS, totalByStatus, toStatus) : null;
      if (breach) {
        setWipMoveCandidate({ breach, taskName, perform });
        return;
      }
      perform();
    },
    [COLUMNS, totalByStatus],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const overId = event.over?.id;
      if (!overId) {
        setOverCell(null);
        return;
      }
      const cellId = String(overId); // `${phaseId}:${status}` or BACKLOG_BAND_DROPPABLE_ID
      // Backlog band: highlight unless the dragged card is already in backlog.
      if (cellId === BACKLOG_BAND_DROPPABLE_ID) {
        if (activeTask?.status === 'BACKLOG') setOverCell(null);
        else setOverCell(cellId);
        return;
      }
      const [, newStatus] = cellId.split(':');
      // Don't highlight source cell (rule 103)
      if (newStatus === activeTask?.status) {
        setOverCell(null);
      } else {
        setOverCell(cellId);
      }
    },
    [activeTask?.status],
  );

  // Phase reorder (workshop mode) — the dragged id is prefixed with 'phase:'.
  // Optimistic: the local order moves first and rolls back if the PATCH fails.
  const reorderPhases = useCallback(
    (activeIdStr: string, overIdStr: string) => {
      if (activeIdStr === overIdStr) return;
      const fromIdx = phaseOrder.indexOf(activeIdStr.replace('phase:', ''));
      const toIdx = phaseOrder.indexOf(overIdStr.replace('phase:', ''));
      if (fromIdx === -1 || toIdx === -1) return;
      const prevOrder = phaseOrder;
      const newOrder = arrayMove(phaseOrder, fromIdx, toIdx);
      setPhaseOrder(newOrder);
      phaseReorder.mutate(
        newOrder.map((id) => ({ id, serverVersion: taskIndex.get(id)?.serverVersion ?? 0 })),
        { onError: () => setPhaseOrder(prevOrder) },
      );
    },
    [phaseOrder, phaseReorder, taskIndex],
  );

  // Drop onto the BACKLOG band above the phase grid (ADR-0057).
  const dropOnBacklogBand = useCallback(
    (task: Task) => {
      // No-op when already in backlog — drag dropped back onto the band.
      if (task.status === 'BACKLOG') return;
      // Lock at IN_PROGRESS+: work has begun (or finished), demoting back to
      // BACKLOG would erase momentum/history. The card simply doesn't move;
      // we announce via the live region so the keyboard/SR path isn't silent.
      if (task.status === 'IN_PROGRESS' || task.status === 'REVIEW' || task.status === 'COMPLETE') {
        announce(`${task.name} cannot move to backlog — work has already started.`);
        return;
      }
      // NOT_STARTED (TO DO): committed but not started — open the deliberate-
      // decision dialog (VoC outcome, Option C). Sarah's mobile concern is
      // mitigated by a focus-first confirm button + Esc-to-cancel.
      if (task.status === 'NOT_STARTED') {
        setBacklogDemoteCandidate(task);
        return;
      }
      // ON_HOLD (legacy) follows the same guard pattern as a backlog item —
      // it's not a committed delivery, so demote it without confirmation.
      updateStatus.mutate({ projectId, taskId: task.id, status: 'BACKLOG' });
      announce(`${task.name} moved to Backlog`);
    },
    [announce, projectId, updateStatus],
  );

  // Drop into a `${phaseId}:${status}` grid cell — the status move, plus the
  // workshop-mode phase move and the sprint-view assignment that ride with it.
  const dropOnCell = useCallback(
    (task: Task, cellId: string) => {
      const [newPhaseId, newStatus] = cellId.split(':');
      if (!newStatus) return;
      const phaseChanged = workshopMode && newPhaseId !== (task.parentId ?? 'root');
      // Cross-lane drag under assignee (324) or epic (364) grouping: drag-to-
      // reassign is a deferred follow-up, so a drop into a different assignee or
      // epic lane never changes the assignee or the parent epic. A status
      // (column) change in the same drop still applies; we append a hint
      // pointing at the card's own control for that dimension.
      const reassignDeferred =
        (groupMode === 'assignee' && newPhaseId !== primaryAssigneeLaneId(task)) ||
        (groupMode === 'epic' && newPhaseId !== epicLaneId(task));
      if (newStatus === task.status && !phaseChanged) {
        if (reassignDeferred) {
          const noun = groupMode === 'epic' ? 'epic' : 'assignee';
          announce(
            `Drag-to-reassign isn't available yet — open ${task.name} to change its ${noun}.`,
          );
        }
        return;
      }
      // Sprint view drag-to-assign (#429): dropping a card into a phase while
      // scoped to a PLANNED/ACTIVE sprint it isn't yet in assigns it to that
      // sprint. The backend auto-sets sprint_pending for an ACTIVE sprint
      // (ADR-0102 post-activation injection); PLANNED links are part of the
      // commitment baseline with no pending gate. A COMPLETED sprint view is
      // read-only for assignment — we never back-date scope into a closed sprint.
      // Computed ahead of the WIP guard so both the immediate and the
      // deferred-confirm paths share one move definition.
      const assignSprintId = sprintAssignTarget(selectedSprint, task);
      const performMove = () => {
        updateStatus.mutate({
          projectId,
          taskId: task.id,
          status: newStatus as TaskStatus,
          ...(phaseChanged ? { parentId: newPhaseId } : {}),
          ...(assignSprintId ? { sprintId: assignSprintId } : {}),
        });
        const colLabel = COLUMNS.find((c) => c.status === newStatus)?.label ?? newStatus;
        const intoSprint = assignSprintId ? ` and added to ${selectedSprint?.name}` : '';
        const reassignNote = reassignDeferred ? ' — reassign from the card' : '';
        announce(`${task.name} moved to ${colLabel}${intoSprint}${reassignNote}`);
        // Scope-injection drop toast (#1140): only an ACTIVE-sprint assignment
        // creates a pending scope-change (ADR-0102 post-activation injection). A
        // PLANNED-sprint link is part of the commitment baseline (no pending
        // gate), and a plain status move assigns nothing — neither toasts.
        if (assignSprintId && selectedSprint?.state === 'ACTIVE') {
          setDropNotice({
            key: Date.now(),
            text: `Added to ${iterationLabel.singular} ${selectedSprint.name} as pending scope — awaiting acceptance.`,
          });
        }
      };
      guardWipThenMove(task.status, newStatus as TaskStatus, task.name, performMove);
    },
    [
      announce,
      COLUMNS,
      groupMode,
      guardWipThenMove,
      iterationLabel,
      projectId,
      selectedSprint,
      updateStatus,
      workshopMode,
    ],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const activeIdStr = String(active.id);
      setActiveId(null);
      setOverCell(null);

      if (activeIdStr.startsWith('phase:')) {
        if (over) reorderPhases(activeIdStr, String(over.id));
        return;
      }

      // Card status change (and optional phase move in workshop mode)
      const overId = over?.id;
      if (!overId || !activeTask) return;
      if (String(overId) === BACKLOG_BAND_DROPPABLE_ID) {
        dropOnBacklogBand(activeTask);
        return;
      }
      dropOnCell(activeTask, String(overId));
    },
    [activeTask, reorderPhases, dropOnBacklogBand, dropOnCell],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverCell(null);
  }, []);

  // Name the dragged card on pickup/cancel instead of dnd-kit's raw-UUID
  // default (#2203); the move outcome is announced via ariaLiveRef on drag end.
  const dndAnnouncements = useMemo(() => taskDndAnnouncements(tasks), [tasks]);

  const handleMenuMove = useCallback(
    (task: Task, newStatus: TaskStatus) => {
      // A closed-sprint board is read-only: drag is already disabled per card
      // (useSortable disabled), but the keyboard "Move to…" menu is a second
      // write path into the same status mutation. Guard it here so a closed
      // sprint can never be mutated regardless of which affordance triggers the
      // move — the banner alone was purely cosmetic (issue 1512).
      if (readOnly) return;
      guardWipThenMove(task.status, newStatus, task.name, () => {
        updateStatus.mutate({ projectId, taskId: task.id, status: newStatus });
        const colLabel = COLUMNS.find((c) => c.status === newStatus)?.label ?? newStatus;
        announce(`${task.name} moved to ${colLabel}`);
      });
    },
    [announce, COLUMNS, guardWipThenMove, projectId, readOnly, updateStatus],
  );

  const handleAddTask = useCallback((phaseId: string, phaseName: string, isSynthetic = false) => {
    // Synthetic phase-less Project Tasks lane (#387): the lane is intake
    // scaffolding, not a real committed structure, so the modal opens
    // with `defaultStatus="BACKLOG"` and the header reads "Add to backlog".
    // VoC panel resolved the BACKLOG-vs-TO-DO default tension (#386 follow-up)
    // by treating the synthetic lane as context-aware intake.
    setAddTaskPhase({
      id: phaseId,
      name: isSynthetic ? 'backlog' : phaseName,
      isSynthetic,
    });
  }, []);

  // Quick capture from the backlog rail (#1973): the intake inbox's primary
  // affordance is fast, no-modal capture — create a BACKLOG idea directly from
  // the typed title so the user can fire off successive ideas without a dialog.
  // The richer path (assignee, description) stays on the "Add with details…"
  // button, which opens the full modal via handleAddTask above.
  const handleQuickCaptureBacklog = useCallback(
    (name: string, opts?: { onError?: () => void }) => {
      const trimmed = name.trim();
      if (!trimmed || !projectId) return;
      createTask.mutate(
        { name: trimmed, duration: 0, status: 'BACKLOG', parent_id: null },
        {
          // Rapid-fire intake clears the field optimistically; if the POST fails
          // the idea is gone with no trace. Surface it and let the rail restore
          // the typed text into the input (#2030).
          onError: () => {
            toast.error(`Couldn't add "${trimmed}" — try again.`);
            opts?.onError?.();
          },
        },
      );
    },
    [createTask, projectId],
  );

  // Mobile FAB (issue 605): open the create modal targeting the group in view.
  // Queue is a flat, backlog-first list so intake lands in BACKLOG; the snap
  // board creates into whichever status column is currently swiped into view.
  const handleMobileFabAdd = useCallback(() => {
    if (effectiveLayout === 'queue') {
      setAddTaskPhase({ id: 'root', name: 'backlog', isSynthetic: true, status: 'BACKLOG' });
      return;
    }
    const label = COLUMNS.find((c) => c.status === mobileActiveStatus)?.label ?? 'board';
    setAddTaskPhase({ id: 'root', name: label, status: mobileActiveStatus });
  }, [effectiveLayout, mobileActiveStatus, COLUMNS]);

  const handlePhaseRename = useCallback(
    (phaseId: string, newName: string) => {
      if (!phaseId || phaseId === 'root') return;
      updateTask.mutate({ id: phaseId, projectId, name: newName });
    },
    [updateTask, projectId],
  );

  const handleCardFocus = useCallback((taskId: string, status: TaskStatus, phaseId: string) => {
    setFocusedCardId(taskId);
    setFocusedColumn(status);
    setFocusedPhaseId(phaseId);
  }, []);

  // Stable milestone-open handler (issue 1520): keeps `laneProps` from allocating
  // a fresh `(t) => …` closure per lane, which would defeat the PhaseLane memo.
  const handleOpenMilestone = useCallback(
    (t: Task) => {
      handleCardFocus(t.id, t.status, t.parentId ?? 'root');
    },
    [handleCardFocus],
  );

  const handleShowDeps = useCallback(
    (task: Task) => {
      setRiskTask(null);
      setShowCheatsheet(false);
      setDepTask(task);
      handleCardFocus(task.id, task.status, task.parentId ?? 'root');
    },
    [handleCardFocus],
  );

  const handleShowRisks = useCallback(
    (task: Task) => {
      setDepTask(null);
      setShowCheatsheet(false);
      setRiskTask(task);
      handleCardFocus(task.id, task.status, task.parentId ?? 'root');
    },
    [handleCardFocus],
  );

  const handleChainHover = useCallback((taskId: string | null) => {
    setChainHoverTaskId(taskId);
  }, []);

  // Card popover (issue #304) — opens on click (mouse/touch/keyboard parity
  // is on the card root). Closes other overlays so only one popover is
  // visible at a time, mirroring the depTask/riskTask exclusivity above.
  const handleCardClick = useCallback(
    (task: Task, anchor: HTMLElement) => {
      setDepTask(null);
      setRiskTask(null);
      setShowCheatsheet(false);
      setPopoverTask(task);
      setPopoverAnchor(anchor);
      handleCardFocus(task.id, task.status, task.parentId ?? 'root');
    },
    [handleCardFocus],
  );

  const closeCardPopover = useCallback(() => {
    setPopoverTask(null);
    setPopoverAnchor(null);
  }, []);

  const closeAllOverlays = useCallback(() => {
    setDepTask(null);
    setRiskTask(null);
    setShowCheatsheet(false);
    setPopoverTask(null);
    setPopoverAnchor(null);
  }, []);

  // Keyboard navigation — J/K within column (across phases), L/H across columns
  // within phase (#195).  Wraps; skips empty cells.  See ADR-0035 §Q3.
  const moveFocusInColumn = useCallback(
    (direction: 'up' | 'down') => {
      if (!focusedColumn) return;
      // Build a flat list of (phaseId, taskId) for the focused column across all phases.
      const orderedPhaseIds = phases.map((p) => p.id);
      const flat: Array<{ phaseId: string; taskId: string }> = [];
      for (const pid of orderedPhaseIds) {
        const tasksInCell = phaseTaskMap.get(pid)?.[focusedColumn] ?? [];
        for (const t of tasksInCell) flat.push({ phaseId: pid, taskId: t.id });
      }
      if (flat.length === 0) return;

      let idx = focusedCardId ? flat.findIndex((x) => x.taskId === focusedCardId) : -1;
      if (idx === -1) {
        idx = direction === 'down' ? 0 : flat.length - 1;
      } else {
        idx =
          direction === 'down' ? (idx + 1) % flat.length : (idx - 1 + flat.length) % flat.length;
      }
      const next = flat[idx];
      setFocusedCardId(next.taskId);
      setFocusedPhaseId(next.phaseId);
    },
    [focusedColumn, focusedCardId, phases, phaseTaskMap],
  );

  const moveFocusInPhase = useCallback(
    (direction: 'left' | 'right') => {
      // Skip columns folded to stubs (issue 1459) — keyboard traversal should only
      // land on columns the user can actually see cards in.
      const visibleColumns = COLUMNS.map((c) => c.status).filter(
        (status) => !collapsedColumns.has(status),
      );
      if (visibleColumns.length === 0) return;
      const activePhaseId = focusedPhaseId ?? phases[0]?.id;
      if (!activePhaseId) return;
      const tasksByCol = phaseTaskMap.get(activePhaseId);
      if (!tasksByCol) return;

      let colIdx = focusedColumn ? visibleColumns.indexOf(focusedColumn) : -1;
      // Walk in the chosen direction looking for a non-empty column; wrap once.
      const step = direction === 'right' ? 1 : -1;
      for (let i = 0; i < visibleColumns.length; i++) {
        colIdx = (colIdx + step + visibleColumns.length) % visibleColumns.length;
        const candidate = visibleColumns[colIdx];
        const cellTasks = tasksByCol[candidate] ?? [];
        if (cellTasks.length > 0) {
          setFocusedColumn(candidate);
          setFocusedCardId(cellTasks[0].id);
          setFocusedPhaseId(activePhaseId);
          return;
        }
      }
      // No non-empty column in this phase — leave focus untouched.
    },
    [COLUMNS, collapsedColumns, focusedColumn, focusedPhaseId, phases, phaseTaskMap],
  );

  const openCheatsheet = useCallback(() => setShowCheatsheet(true), []);
  const focusSearchInput = useCallback(() => searchInputRef.current?.focus(), []);

  // When AddTaskModal is open, the modal owns the keyboard.
  useBoardKeyboard(
    boardKeyboardBindings({
      overlayOpen: isB3OverlayOpen({ depTask, riskTask, showCheatsheet, popoverTask, editTaskId }),
      focusedTask,
      focusedCardId,
      focusedColumn,
      moveFocusInColumn,
      moveFocusInPhase,
      onEditTask: setEditTaskId,
      onShowDeps: handleShowDeps,
      onShowCheatsheet: openCheatsheet,
      onFocusSearch: focusSearchInput,
      onOpenFilter: toggleFilterPanel,
      onCloseOverlay: closeAllOverlays,
    }),
    addTaskPhase === null,
  );

  // One lane's props. Held together here (rather than in `BoardPhaseLanes`) so the
  // reference-stable values the PhaseLane memo depends on stay assembled in the
  // component that owns them (issue 1520).
  const laneProps = (phase: Phase) => ({
    phase,
    columns: COLUMNS,
    tasksByStatus: phaseTaskMap.get(phase.id) ?? EMPTY_TASKS_BY_STATUS,
    milestones: milestonesByPhase.get(phase.id) ?? EMPTY_MILESTONES,
    // Pre-compute this lane's drag-over column so only the lane under
    // the pointer sees a changed prop; every other lane stays null and
    // its memo skips the drag-over re-render (issue 1520). overCell is
    // `${phaseId}:${status}`; phase ids carry no ':'.
    overStatus:
      overCell && overCell.startsWith(`${phase.id}:`)
        ? (overCell.slice(phase.id.length + 1) as TaskStatus)
        : null,
    isDragActive: activeId !== null,
    showWip,
    showColTints,
    density,
    collapsed: collapsedIds.has(phase.id),
    onToggleCollapse: toggleCollapse,
    collapsedColumns,
    onExpandColumn: expandColumn,
    focused: focusedLanePhaseId === phase.id,
    onToggleFocus: toggleFocusLane,
    onMenuMove: handleMenuMove,
    // Assignee (324) and epic (364) lanes can't host a new task (a
    // lane id is a resource or an epic, not a WBS parent) — suppress
    // the per-lane add button in those read-only lenses. Also
    // suppressed board-wide when `readOnly` (closed sprint or a
    // Viewer, #2146).
    onAddTask:
      readOnly || groupMode === 'assignee' || groupMode === 'epic' ? undefined : handleAddTask,
    focusedCardId,
    // Search match set (when active) overrides the issue-182 dep-hover
    // dim set — see effectiveHighlightIds (issue 323).
    highlightedTaskIds: effectiveHighlightIds,
    facetMatchIds,
    overallocByResourcePerTask,
    onCardFocus: handleCardFocus,
    onShowDeps: handleShowDeps,
    onShowRisks: handleShowRisks,
    onChainHover: handleChainHover,
    onCardClick: handleCardClick,
    onOpenMilestone: handleOpenMilestone,
    showEvm: evmMode,
    showCost,
    customFieldDefs: cardCustomFieldDefs,
    showReadiness: showReadinessOnCards,
    scopeActions,
    readOnly,
    workshop: workshopMode,
    onPhaseRename: workshopMode ? handlePhaseRename : undefined,
    // Board resize (issue 285): per-column widths + this lane's height.
    columnWidths,
    phaseHeight: phaseHeights[phase.id],
    onResizeHeight: setPhaseHeight,
    // Per-cell card cap (issue 1967, ADR-0420) — desktop matrix only.
    cellCap: toolbarPrefs.cellCap,
    myResourceId,
  });

  // Workshop mode makes lanes sortable; every other mode renders them plain.
  // Deliberately not memoized: `laneProps` closes over ~40 board values and is
  // rebuilt every render regardless, so a useCallback here would never hit — and
  // `BoardPhaseLanes` is not memoized, so nothing downstream depends on the
  // identity. The per-lane memo that does matter lives on `PhaseLane` itself,
  // and it is preserved because `laneProps` still feeds reference-stable values.
  const renderLane = (lane: LaneShape) => {
    const phase = lane as Phase;
    return workshopMode ? (
      <SortablePhaseLane key={phase.id} {...laneProps(phase)} />
    ) : (
      <PhaseLane key={phase.id} {...laneProps(phase)} />
    );
  };

  // Chrome-band inputs (#2378). `tasks ?? []` was defaulted inline at two call
  // sites; hoisting it keeps the absent case resolved once and gives both
  // consumers the same array rather than two fresh ones per render.
  const allTasks = useMemo(() => tasks ?? [], [tasks]);
  const scopePendingCount = activeSprintPendingCount(activeSprint);
  const focusedLanePhaseName = useMemo(
    () => phases.find((p) => p.id === focusedLanePhaseId)?.name ?? null,
    [phases, focusedLanePhaseId],
  );
  const openWorkshopExitConfirm = useCallback(() => setShowExitConfirm(true), []);
  const openScopeReview = useCallback(() => setScopeReviewOpen(true), []);
  const clearMyTasksFilter = useCallback(() => myTasksFilter.setEnabled(false), [myTasksFilter]);
  const clearDebtOnly = useCallback(() => setDebtOnly(false), []);

  // A failed tasks fetch must read as broken, not as an empty board — an empty
  // board and a dead request otherwise render identically (issue #1764).
  if (error) {
    return <QueryErrorState message="Couldn't load the board." />;
  }

  if (isLoading) {
    // Column-ghost skeleton — mirror the four-lane board shape the sibling
    // surfaces (Grid/My Work/Overview) skeleton with, so the board no longer
    // flashes a bare "Loading…" line while the other views ghost. The accessible
    // name stays "Loading board…" so the E2E wait-for-paint gate still resolves.
    return (
      <div
        role="status"
        aria-label="Loading board…"
        className="flex h-full gap-4 overflow-hidden p-4"
      >
        {[0, 1, 2, 3].map((col) => (
          <div key={col} aria-hidden="true" className="flex w-72 flex-shrink-0 flex-col gap-3">
            <div className="h-5 w-32 motion-safe:animate-pulse rounded-chip bg-neutral-surface-sunken" />
            {[0, 1, 2].map((card) => (
              <div
                key={card}
                className="h-20 motion-safe:animate-pulse rounded-card border border-neutral-border bg-neutral-surface-sunken"
              />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {/* aria-live region for status change announcements (rule 105) */}
      <div ref={ariaLiveRef} aria-live="polite" className="sr-only" />
      <h1 className="sr-only">Board</h1>

      <DndContext
        sensors={sensors}
        accessibility={{ announcements: dndAnnouncements }}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="relative flex flex-col h-full overflow-hidden bg-app-canvas">
          {/* Board toolbar — calm refactor (issue #382, epic #361 child B). */}
          <CalmToolbar
            projectId={projectId}
            projectName={projectName}
            activeCount={committedTasks.filter((t) => !t.isSummary).length}
            backlogCount={backlogTasks.length}
            searchQuery={searchQuery}
            onSearchQueryChange={onSearchQueryChange}
            searchMatchCount={searchMatchCount}
            isSearching={isSearching}
            searchInputRef={searchInputRef}
            currentViewConfig={currentViewConfig}
            activeViewId={activeViewId}
            onApplyView={applyViewConfig}
            sprints={sprints}
            selectedSprintId={selectedSprintId}
            onSelectSprint={setSelectedSprintId}
            groupBy={groupMode}
            onGroupByChange={toolbarPrefs.setGroupBy}
            sort={sort}
            onSortChange={setSort}
            density={density}
            onDensityChange={setDensity}
            zoom={toolbarPrefs.zoom}
            onZoomChange={toolbarPrefs.setZoom}
            backlogDensity={toolbarPrefs.backlogDensity}
            onBacklogDensityChange={toolbarPrefs.setBacklogDensity}
            layout={effectiveLayout}
            onLayoutChange={toolbarPrefs.setLayout}
            myTasksEnabled={myTasksFilter.enabled}
            myTasksLoading={myTasksFilter.isLoading}
            onMyTasksToggle={() => myTasksFilter.setEnabled(!myTasksFilter.enabled)}
            riskLinkedOnly={riskLinkedOnly}
            onRiskLinkedToggle={() => setRiskLinkedOnly((v) => !v)}
            debtOnly={debtOnly}
            onDebtOnlyToggle={() => setDebtOnly((v) => !v)}
            showCost={showCost}
            onShowCostToggle={() => setShowCost((v) => !v)}
            filterControl={
              <BoardFilterControl
                filters={facetFilters}
                assigneeOptions={assigneeOptions}
                labelOptions={labelOptions}
                onChange={onFacetsChange}
                onClearAll={onClearAllFacets}
                open={filterPanelOpen}
                onOpenChange={setFilterPanelOpen}
                triggerRef={filterTriggerRef}
              />
            }
            activityOpen={activityOpen}
            onToggleActivity={toggleActivity}
            onCollapseAll={() => collapseAll(phases.map((p) => p.id))}
            onExpandAll={expandAll}
            showWip={showWip}
            onShowWipToggle={() => setShowWip((v) => !v)}
            showColTints={showColTints}
            onShowColTintsToggle={() => setShowColTints((v) => !v)}
            capCellsOn={toolbarPrefs.cellCap != null}
            onCapCellsToggle={() =>
              toolbarPrefs.setCellCap(toolbarPrefs.cellCap == null ? DEFAULT_CELL_CAP : null)
            }
            evmMode={evmMode}
            onEvmChange={setEvmMode}
            onOpenColumns={() => setShowSettings(true)}
            onOpenCheatsheet={() => setShowCheatsheet(true)}
            onOpenTrash={projectId ? () => setTaskTrashOpen(true) : undefined}
            onShare={canShareBoard && projectId ? () => setShareOpen(true) : undefined}
            onExportPdf={onExportPdf}
            exportingPdf={exportingPdf}
            workshopMode={workshopMode}
            workshopDisabled={startWorkshop.isPending}
            workshopButtonRef={workshopToggleRef}
            onWorkshopToggle={() => {
              if (workshopMode) {
                setShowExitConfirm(true);
              } else {
                startWorkshop.mutate(undefined, {
                  onSuccess: () => setWorkshopMode(true),
                });
              }
            }}
          />
          {activeSavedView && danglingLabelIds.length > 0 && (
            <DeletedLabelNotice
              projectId={projectId}
              viewId={activeSavedView.id}
              viewName={activeSavedView.name}
              config={activeSavedView.config}
              missingIds={danglingLabelIds}
              matchCount={facetMatchCount}
              totalCount={committedTasks.length}
              isRepairing={updateSavedView.isPending}
              onRepair={(config) => {
                updateSavedView.mutate(
                  { id: activeSavedView.id, config },
                  { onSuccess: (view) => applyViewConfig(view.config, view.id) },
                );
              }}
            />
          )}
          {/* Active-filter chip bar (issue 1091) — keeps the facet lens
              inescapable when the popover is closed; each chip removes its facet. */}
          <BoardFilterChips
            filters={facetFilters}
            assigneeNameById={assigneeNameById}
            labelNameById={labelNameById}
            matchCount={facetMatchCount}
            onChange={onFacetsChange}
            onClearAll={onClearAllFacets}
          />
          <BoardChrome
            projectId={projectId}
            tasks={allTasks}
            exportRequested={exportRequested}
            boardPrintRef={boardPrintRef}
            boardPrintData={boardPrintData}
            workshopMode={workshopMode}
            workshopSession={workshopSession}
            workshopEnding={endWorkshop.isPending}
            onEndWorkshop={openWorkshopExitConfirm}
            scopePendingCount={scopePendingCount}
            canManageScope={canManageScope}
            onReviewScope={openScopeReview}
            mineActive={mineActive}
            onClearMine={clearMyTasksFilter}
            debtOnly={debtOnly}
            onClearDebt={clearDebtOnly}
            selectedSprint={selectedSprint}
            boardCadence={boardCadence}
            onOpenStandup={openStandup}
            sprintClosed={sprintClosed}
            focusedLanePhaseName={focusedLanePhaseName}
            onExitFocusLane={exitFocusLane}
            columns={COLUMNS}
            collapsedColumns={collapsedColumns}
            totalByStatus={totalByStatus}
            myCountByStatus={myCountByStatus}
            onExpandColumn={expandColumn}
            onToggleColumn={toggleColumn}
            onExpandAllColumns={expandAllColumns}
            facetZeroMatch={facetZeroMatch}
            onClearAllFacets={onClearAllFacets}
          />

          <BoardBody
            projectId={projectId}
            facetZeroMatch={facetZeroMatch}
            effectiveLayout={effectiveLayout}
            isMobile={isMobile}
            columns={COLUMNS}
            methodology={methodology}
            boardCadence={boardCadence}
            queueTasks={queueTasks}
            phaseNameFor={(parentId) => phaseNameMap.get(parentId ?? 'root') ?? 'Project'}
            phaseColorFor={(parentId) => phaseColor(parentId ?? 'root')}
            canReorder={canManageBacklog}
            onReorderGroup={(entries) => queueReorder.mutate(entries)}
            backlogTasks={backlogTasks}
            isDragActive={activeId !== null}
            isBacklogOver={overCell === BACKLOG_BAND_DROPPABLE_ID}
            backlogDensity={toolbarPrefs.backlogDensity}
            onSchedule={handleScheduleRequest}
            onQuickCapture={handleQuickCaptureBacklog}
            isQuickCapturePending={createTask.isPending}
            onCaptureIdea={() => handleAddTask('root', 'backlog', true)}
            onOpenCommandPalette={() => openCommandPalette(true)}
            mobileTasksByStatus={mobileTasksByStatus}
            onActiveStatusChange={setMobileActiveStatus}
            density={density}
            onMenuMove={handleMenuMove}
            focusedCardId={focusedCardId}
            onCardFocus={handleCardFocus}
            onShowDeps={handleShowDeps}
            onShowRisks={handleShowRisks}
            onCardClick={handleCardClick}
            showEvm={evmMode}
            showCost={showCost}
            cardCustomFieldDefs={cardCustomFieldDefs}
            showReadiness={showReadinessOnCards}
            scopeActions={scopeActions}
            readOnly={readOnly}
            facetMatchIds={facetMatchIds}
            setBoardScrollEl={setBoardScrollEl}
            isBoardPanArmed={isBoardPanArmed}
            isBoardPanning={isBoardPanning}
            zoomVars={BOARD_ZOOM_VARS[toolbarPrefs.zoom]}
            hasScrollBelow={hasScrollBelow}
            hasScrollRight={hasScrollRight}
            collapsedColumns={collapsedColumns}
            columnWidths={columnWidths}
            totalByStatus={totalByStatus}
            myCountByStatus={myCountByStatus}
            showWip={showWip}
            wipTrendSeriesByStatus={wipTrendSeriesByStatus}
            onToggleColumn={toggleColumn}
            onResizeColumn={setColumnWidth}
            lanes={visibleLanes(sortedPhases, focusedLanePhaseId, phaseTaskMap, {
              cpOnly,
              dueSoonDays,
              mineActive,
              debtOnly,
              riskLinkedOnly,
            })}
            renderLane={renderLane}
            workshopMode={workshopMode}
            onAddPhase={handleAddPhase}
            isAddingPhase={createTask.isPending}
            mineActive={mineActive}
            onShowAllTasks={() => myTasksFilter.setEnabled(false)}
            onAddTask={handleMobileFabAdd}
          />

          {/* Scope-injection drop toast (#1140) — bottom-center, neutral, ephemeral.
              Positioned absolute within this relative board container. */}
          <BoardDropNotice notice={dropNotice} />
        </div>

        {/* Drag overlay — floating card follows the pointer */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <BoardCard task={activeTask} isOverlay onMenuMove={() => {}} columns={COLUMNS} />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Mobile FAB (issue 605) — opens the create modal targeting the group in
          view: BACKLOG under the Queue layout, else the snapped-to status column.
          `md:hidden` keeps it phone-only; the desktop lane "+" affordances cover
          create above the breakpoint. */}
      {projectId && (
        <button
          type="button"
          onClick={handleMobileFabAdd}
          title="Add task"
          className="fixed bottom-16 right-4 w-14 h-14 rounded-full bg-brand-primary
            border border-brand-primary-dark text-neutral-text-inverse flex items-center justify-center
            text-2xl font-light md:hidden z-10
            focus:ring-2 focus:ring-white focus:ring-offset-2
            focus:ring-offset-brand-primary"
          aria-label="Add task"
        >
          +
        </button>
      )}

      <BoardConfirmDialogs
        projectId={projectId}
        isMobile={isMobile}
        selectedSprint={selectedSprint}
        backlogDemoteCandidate={backlogDemoteCandidate}
        onBacklogDemoteCancel={() => setBacklogDemoteCandidate(null)}
        onBacklogDemoteConfirm={(target) => {
          setBacklogDemoteCandidate(null);
          updateStatus.mutate({ projectId, taskId: target.id, status: 'BACKLOG' });
          if (ariaLiveRef.current) {
            ariaLiveRef.current.textContent = `${target.name} moved to Backlog`;
          }
        }}
        wipMoveCandidate={wipMoveCandidate}
        onWipMoveCancel={() => setWipMoveCandidate(null)}
        onWipMoveConfirm={(perform) => {
          setWipMoveCandidate(null);
          perform();
        }}
        scheduleDialogTask={scheduleDialogTask}
        onScheduleDialogClose={handleScheduleDialogClose}
        addTaskPhase={addTaskPhase}
        onAddTaskClose={() => setAddTaskPhase(null)}
        workshopExitOpen={showExitConfirm}
        workshopEnding={endWorkshop.isPending}
        workshopToggleRef={workshopToggleRef}
        onWorkshopExitCancel={() => setShowExitConfirm(false)}
        onWorkshopExitConfirm={() => {
          endWorkshop.mutate(undefined, {
            onSettled: () => {
              setWorkshopMode(false);
              setShowExitConfirm(false);
              workshopToggleRef.current?.focus();
            },
          });
        }}
      />

      {taskTrashOpen && projectId && (
        <TaskTrashDialog projectId={projectId} onClose={() => setTaskTrashOpen(false)} />
      )}

      <BoardCardOverlays
        projectId={projectId}
        isMobile={isMobile}
        taskIndex={taskIndex}
        showCheatsheet={showCheatsheet}
        onCloseCheatsheet={() => setShowCheatsheet(false)}
        shareOpen={shareOpen}
        onCloseShare={() => setShareOpen(false)}
        showSettings={showSettings}
        onCloseSettings={() => setShowSettings(false)}
        rawColumns={rawColumns}
        onSaveBoardConfig={saveBoardConfig}
        showCustomFieldsOnCards={toolbarPrefs.showCustomFieldsOnCards}
        onToggleCustomFieldsOnCards={toolbarPrefs.setShowCustomFieldsOnCards}
        canConfigureBoard={canConfigureBoard}
        depTask={depTask}
        onCloseDeps={() => setDepTask(null)}
        onJumpToTask={(taskId) => {
          const target = taskIndex.get(taskId);
          if (target) handleCardFocus(taskId, target.status, target.parentId ?? 'root');
          setDepTask(null);
        }}
        riskTask={riskTask}
        onCloseRisks={() => setRiskTask(null)}
        popoverTask={popoverTask}
        popoverAnchor={popoverAnchor}
        onClosePopover={() => {
          // Return focus to the originating card on close (rule 4 / a11y).
          const anchor = popoverAnchor;
          closeCardPopover();
          if (anchor?.isConnected) anchor.focus();
        }}
        onOpenDetail={(id) => {
          closeCardPopover();
          setSelectedTaskId(id);
        }}
        onEditTask={(id) => {
          closeCardPopover();
          setEditTaskId(id);
        }}
        selectedTaskId={selectedTaskId}
        onCloseDrawer={() => setSelectedTaskId(null)}
        onDrawerSwapCanceled={(keptId) => setSelectedTaskId(keptId)}
        editTaskId={editTaskId}
        onCloseEditModal={() => setEditTaskId(null)}
        onEditModalDeleted={() => {
          setEditTaskId(null);
          setSelectedTaskId(null);
        }}
      />

      <BoardSidePanels
        projectId={projectId}
        tasks={allTasks}
        isTaskOpenable={(taskId) => taskIndex.has(taskId)}
        onOpenTask={(taskId) => setSelectedTaskId(taskId)}
        activityOpen={activityOpen}
        onCloseActivity={toggleActivity}
        activeSprintId={activeSprintId}
        standupOpen={standupOpen}
        onCloseStandup={closeStandup}
        scopeReviewOpen={scopeReviewOpen}
        canManageScope={canManageScope}
        onCloseScopeReview={() => setScopeReviewOpen(false)}
      />
    </>
  );
}
