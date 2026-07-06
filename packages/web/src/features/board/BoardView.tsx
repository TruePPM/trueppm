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
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN } from '@/lib/roles';
import { ShareViewDialog } from '@/features/share/ShareViewDialog';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useSpaceDragPan, SpaceAwarePointerSensor } from '@/hooks/useSpaceDragPan';
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
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { isTaskScheduled } from '@/lib/task';
import { useUpdateTaskStatus } from '@/hooks/useBoardTasks';
import { useBoardConfig } from '@/hooks/useBoardConfig';
import { FlowAnalyticsPanel } from './FlowAnalyticsPanel';
import { useMyTasksFilter } from '@/hooks/useMyTasksFilter';
import { useCurrentUserResourceId } from '@/hooks/useCurrentUserResourceId';
import { useBoardKeyboard } from '@/hooks/useBoardKeyboard';
import { useBoardOverallocation } from '@/hooks/useBoardOverallocation';
import { type BoardSortKey, type BoardViewConfig } from '@/hooks/useBoardSavedViews';
import { wipState, wipTrend, type WipState, type WipTrend } from './wip';
import { boardGridTemplate } from './boardGrid';
import { ColumnResizeHandle, PhaseResizeHandle } from './BoardResizeHandle';
import { useBoardColumnWidths, useBoardPhaseHeights } from '@/hooks/useBoardResize';
import { useTaskDependencies } from '@/hooks/useTaskDependencies';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkshopSession, useStartWorkshop, useEndWorkshop } from '@/hooks/useWorkshopSession';
import { usePhaseReorder } from '@/hooks/usePhaseReorder';
import { useQueueReorder } from '@/hooks/useQueueReorder';
import { useCanManageBacklog } from '@/hooks/useMyFacets';
import { useWorkshopSocket } from '@/hooks/useWorkshopSocket';
import { useCreateTask, useUpdateTask } from '@/hooks/useTaskMutations';
import type { Task, TaskStatus } from '@/types';
import { BoardCard, type BoardDensity, type EvmMode } from './BoardCard';
import { useBoardOffline } from './offline/useBoardOffline';
import { MobileColumnStrip, type MobileColumnStripSegment } from './MobileColumnStrip';
import { LaneMeta } from './LaneMeta';
import { WorkshopBanner } from './WorkshopBanner';
import { BoardScopeInjectionBanner } from './BoardScopeInjectionBanner';
import { TaskFormModal } from './TaskFormModal';
import { PhaseMilestoneRail } from './PhaseMilestoneRail';
import { KeyboardCheatsheet } from './KeyboardCheatsheet';
import { BoardSettingsPanel } from './BoardSettingsPanel';
import { DepPopover } from './DepPopover';
import { RiskPopover } from './RiskPopover';
import { BoardCardPopover } from './BoardCardPopover';
import { TaskDetailDrawer } from '@/features/schedule/TaskDetailDrawer';
import { phaseColor } from './phaseColors';
import { BacklogBand, BACKLOG_BAND_DROPPABLE_ID } from './BacklogBand';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { BacklogDrawer } from './BacklogDrawer';
import { QueueLayout } from './QueueLayout';
import { BacklogDemoteConfirmDialog } from './BacklogDemoteConfirmDialog';
import { ScheduleTaskDialog } from '@/features/schedule/ScheduleTaskDialog';
import { CalmToolbar } from './CalmToolbar';
import { BoardFilterControl, BoardFilterChips } from './BoardFilterControl';
import {
  EMPTY_FACETS,
  matchesFacets,
  activeFacetCount,
  isFacetsActive,
  collectAssigneeOptions,
  parseFacetsFromParams,
  writeFacetsToParams,
  paramsHaveFacets,
  facetsStorageKey,
  serializeFacets,
  deserializeFacets,
  type FacetFilters,
} from './boardFacets';
import { SprintPanel } from './SprintPanel';
import { BoardActivityPanel } from './activity/BoardActivityPanel';
import { StandupMode } from './standup/StandupMode';
import {
  useBoardToolbarPrefs,
  resolveBoardLayout,
  type BoardZoom,
  type BoardGroupMode,
} from '@/hooks/useBoardToolbarPrefs';
import { buildAssigneeLanes, buildEpicLanes, epicLaneId, primaryAssigneeLaneId } from './grouping';
import { useBoardCardSearch } from '@/hooks/useBoardCardSearch';
import { useProject } from '@/hooks/useProject';
import { useActiveSprint, useFlowMetrics, useSprints } from '@/hooks/useSprints';
import { useCanManageScope } from '@/hooks/useCanManageScope';
import { useScopeChangeActions } from '@/hooks/useScopeChangeActions';
import { ScopePendingReviewPanel } from '@/features/sprints/ScopePendingReviewPanel';
import { BoardSprintHeader } from './BoardSprintHeader';
import { BoardDropNotice } from './BoardDropNotice';
import { ClosedSprintBanner } from './ClosedSprintBanner';
import { useDefaultBoardSprint } from '@/hooks/useDefaultBoardSprint';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { BoardCardScopeActions } from './BoardCard';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { toast } from '@/components/Toast/toast';
import { fmtUtcLong } from '@/lib/formatUtcDate';
import { BoardPrintLayout } from './export/BoardPrintLayout';
import { buildBoardPrintData } from './export/boardPrintData';
import { exportBoardPdf, boardPdfFileName } from './export/exportBoardPdf';

// ---------------------------------------------------------------------------
// Sort helper
// ---------------------------------------------------------------------------

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
function buildPhases(allTasks: Task[], workshopMode = false): Phase[] {
  const summaryById = new Map<string, Task>();
  const summaryOrder: string[] = [];

  for (const t of allTasks) {
    if (t.isSummary) {
      summaryById.set(t.id, t);
      summaryOrder.push(t.id);
    }
  }

  if (workshopMode) {
    for (const t of allTasks) {
      if (!t.isSummary && t.parentId === null && !summaryById.has(t.id)) {
        summaryById.set(t.id, t);
        summaryOrder.push(t.id);
      }
    }
  }

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

interface WipBadgeProps {
  count: number;
  limit: number | null | undefined;
}

/**
 * WIP-limit badge for board column headers (#232).
 *
 * Three visual bands per the spec:
 *   count < limit   → neutral (no warning chrome)
 *   count == limit  → at-risk amber, label `{N}/{limit} WIP`
 *   count >  limit  → critical red, label `{N}/{limit} — over WIP limit`
 *
 * `limit == null` falls back to a count-only neutral chip — fully
 * backwards compatible with projects that haven't configured WIP yet.
 */
function WipBadge({ count, limit }: WipBadgeProps) {
  if (limit == null) {
    return (
      <span className="ml-1.5 text-xs text-neutral-text-disabled font-medium tppm-mono">
        {count}
      </span>
    );
  }
  if (count > limit) {
    return (
      <span
        className="ml-1.5 text-xs font-medium px-1 py-0.5 rounded-chip border bg-semantic-critical-bg border-semantic-critical/40 text-semantic-critical tppm-mono"
        aria-label={`${count} of ${limit} WIP limit, over limit`}
      >
        {count}/{limit} — over WIP limit
      </span>
    );
  }
  if (count >= limit) {
    return (
      <span
        className="ml-1.5 text-xs font-medium px-1 py-0.5 rounded-chip border bg-semantic-at-risk-bg border-semantic-at-risk/40 text-semantic-at-risk tppm-mono"
        aria-label={`${count} of ${limit} WIP limit, at limit`}
      >
        {count}/{limit} WIP
      </span>
    );
  }
  return (
    <span
      className="ml-1.5 text-xs font-medium px-1 py-0.5 rounded-chip border bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary tppm-mono"
      aria-label={`${count} of ${limit} WIP limit`}
    >
      {count}/{limit}
    </span>
  );
}

/**
 * Always-on WIP breach chip for a column header (issue 1188 / ADR-0130 D2).
 *
 * Unlike WipBadge (which shows the numeric N/limit only under the "Show WIP
 * limits" toggle), this renders whenever a limit is at/over breach — a breach is
 * a signal Alex needs to catch before the retro, not an opt-in detail. Color is
 * never the sole cue: the ⚠ glyph + text carry the meaning. The chip itself is
 * aria-hidden because the column's <h2> accessible name already announces the
 * breach, so a screen reader hears it once, not twice.
 */
function WipBreachChip({ state }: { state: 'at' | 'over' }) {
  const cls =
    state === 'over'
      ? 'bg-semantic-critical-bg text-semantic-critical'
      : 'bg-semantic-at-risk-bg text-semantic-at-risk';
  return (
    <span
      aria-hidden="true"
      data-testid="wip-breach-chip"
      data-breach={state}
      className={`inline-flex items-center gap-0.5 rounded-chip px-1 py-0.5 text-xs font-semibold ${cls}`}
    >
      <span aria-hidden="true">⚠</span>
      {state === 'over' ? 'Over limit' : 'At limit'}
    </span>
  );
}

/**
 * Tiny WIP trend arrow for a column header (issue 1213, VoC Alex).
 *
 * The always-on WipBreachChip catches a column that is *already* at/over limit;
 * this catches the creep *before* it breaches by reading the recent slope of the
 * column's CFD occupancy (computed by `wipTrend()`). An arrow — not a sparkline —
 * because a single high-contrast glyph is WCAG-legible at header scale where a
 * ~2px sparkline bar is not, and the header only needs the one-bit direction
 * signal (the full curve lives in FlowAnalyticsPanel).
 *
 * Color is never the sole cue: the ▲/▼ orientation carries the direction and the
 * `aria-label` names it. Amber (`approaching`) is reserved for the actionable
 * "rising and about to tip" case; a rising column comfortably under its limit,
 * and any falling column, stay neutral. Unlike the breach chip this is *not*
 * announced by the column <h2> accessible name (it's net-new information), so the
 * span carries `role="img"` + a label rather than being aria-hidden.
 */
function WipTrendArrow({ trend }: { trend: WipTrend }) {
  const rising = trend.direction === 'rising';
  const cls = trend.approaching ? 'text-semantic-at-risk' : 'text-neutral-text-secondary';
  const label = rising
    ? trend.approaching
      ? 'trending up toward WIP limit'
      : 'trending up'
    : 'trending down';
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="wip-trend-arrow"
      data-trend={trend.direction}
      data-approaching={trend.approaching ? 'true' : 'false'}
      className={`text-xs font-semibold leading-none ${cls}`}
    >
      <span aria-hidden="true">{rising ? '▲' : '▼'}</span>
    </span>
  );
}

/**
 * Collapsed-column stub for the board header (issue 1459, ADR-0192 Part 2).
 *
 * A 34px-wide rail standing in for a folded column: status dot, a label
 * rotated to read bottom-to-top, and a count badge whose tone reflects the
 * WIP band (neutral / at-limit amber / over-limit red). The whole stub is a
 * button — clicking it expands the column back to full width. The WIP band is
 * computed via the shared `wipState()` helper so the stub badge never drifts
 * from the expanded header (issue 546). The glyphs are `aria-hidden`; the button's
 * accessible name carries the column, count, and any breach.
 */
function ColumnStub({
  label,
  status,
  count,
  wipBand,
  onExpand,
}: {
  label: string;
  status: TaskStatus;
  count: number;
  wipBand: WipState;
  onExpand: () => void;
}) {
  const dotClass = COLUMN_DOT_CLASS[status] ?? 'bg-neutral-text-disabled';
  // Pair the `-bg` pill fill with the matching full semantic token for text +
  // border (rule 8b) — `bg-semantic-critical text-white` failed WCAG 1.4.3 in
  // dark mode (white on the critical red-400 fill is approx 2.8:1). The `-bg` tints are pre-computed
  // per-mode in globals.css so the badge stays AA in both themes.
  const badgeClass =
    wipBand === 'over'
      ? 'bg-semantic-critical-bg text-semantic-critical border-semantic-critical/40'
      : wipBand === 'at'
        ? 'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40'
        : 'bg-neutral-surface text-neutral-text-secondary border-neutral-border';
  return (
    <button
      type="button"
      onClick={onExpand}
      title={`Expand ${label}`}
      data-testid={`column-stub-${status}`}
      data-wip-state={wipBand}
      aria-label={`Expand ${label} column, ${count} task${count !== 1 ? 's' : ''}${
        wipBand === 'over' ? ', over WIP limit' : wipBand === 'at' ? ', at WIP limit' : ''
      }`}
      className="h-full w-full py-2.5 flex flex-col items-center gap-2 bg-neutral-surface-sunken
        hover:bg-neutral-surface transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
    >
      <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClass}`} />
      <span
        aria-hidden="true"
        className="text-xs font-semibold text-neutral-text-primary whitespace-nowrap tracking-wide
          [writing-mode:vertical-rl] rotate-180"
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        className={`tppm-mono text-xs font-bold min-w-[18px] px-1 py-px rounded-full border text-center ${badgeClass}`}
      >
        {count}
        {wipBand === 'over' ? '!' : ''}
      </span>
    </button>
  );
}

/**
 * Confirm-prompt guard for moving a task into a column at or over its WIP
 * limit (#232). Returns ``true`` when the move should proceed (under limit
 * or user confirmed) and ``false`` when it should be cancelled.
 *
 * Uses the native ``window.confirm`` rather than a custom modal — the spec
 * is explicit about a "warning prompt" and the lighter pattern keeps board
 * drag flows responsive. Skips silently when ``window`` isn't available
 * (vitest jsdom + e2e environments both expose it; the guard is defensive).
 */
function confirmWipMove(
  columns: { status: TaskStatus; label: string; wipLimit: number | null }[],
  countByStatus: Record<string, number>,
  newStatus: TaskStatus,
): boolean {
  const col = columns.find((c) => c.status === newStatus);
  const limit = col?.wipLimit;
  if (!limit) return true;
  const projected = (countByStatus[newStatus] ?? 0) + 1;
  if (projected <= limit) return true;
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(
    `This column is at its WIP limit (${countByStatus[newStatus] ?? 0}/${limit}). Move anyway?`,
  );
}

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
  /** Sprint scope-injection accept/reject affordance (ADR-0102). */
  scopeActions: BoardCardScopeActions;
  /** Closed-sprint read-only (#1141): disables drag on every card in the cell. */
  readOnly?: boolean;
}

// Subtle status tints per column (issue #211).
// Applied to the resting state only — drag-over overrides with brand-primary/5.
// Done is quieted to /[0.025] in epic #361 child E (issue #385): the new
// status-dot in the column header carries enough signal that the cell tint can
// step back toward neutral without losing the "this is the close-out column"
// affordance. Review and Backlog are left at /5 — they don't get a status-dot
// equivalent yet (Backlog is in the band; Review is still loud-by-design).
const COLUMN_TINT: Partial<Record<TaskStatus, string>> = {
  COMPLETE: 'bg-semantic-on-track/[0.025]',
  REVIEW: 'bg-brand-accent/5',
  BACKLOG: 'bg-neutral-text-disabled/5',
};

// Status-dot color per column (epic #361 child E, issue #385).
// Drives the 6px dot prefix on each column header — a non-color label is
// always present, so the dot is `aria-hidden`. BACKLOG is mapped for
// completeness but never renders in the current grid (ADR-0057 lifted it
// into the band).
const COLUMN_DOT_CLASS: Record<TaskStatus, string> = {
  BACKLOG: 'bg-neutral-text-disabled',
  NOT_STARTED: 'bg-neutral-text-disabled',
  IN_PROGRESS: 'bg-brand-primary',
  REVIEW: 'bg-brand-accent',
  ON_HOLD: 'bg-neutral-text-disabled',
  COMPLETE: 'bg-semantic-on-track',
};

// Board zoom (issue 379, ADR-0145). Each level sets coordinated CSS custom properties
// on the board grid container; the column-header / lane / phase-rail grids read
// --board-phase-col and --board-col-gap, and the column card-stack reads
// --board-card-gap. `normal` reproduces the pre-zoom defaults exactly (188px /
// gap-2 / gap-1.5) so the default board is visually unchanged. dnd-kit-safe:
// these are real CSS sizes, not a transform/zoom that would break drag math.
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
  scopeActions,
  readOnly = false,
  facetMatchIds,
}: BoardCellProps) {
  const droppableId = `${phaseId}:${status}`;
  const { setNodeRef } = useDroppable({ id: droppableId });
  const over = isOver && isDragActive;
  // Route through the shared wipState() helper so the *at-limit* band (count
  // exactly equals the limit) is surfaced, not just the over-limit case — a
  // column sitting on its ceiling is the signal a team needs before it tips
  // over (issue 1358 F6).
  const wipBand = showWip ? wipState(tasks.length, wipLimit) : 'none';
  const restingBg = showColTints
    ? (COLUMN_TINT[status] ?? 'bg-neutral-surface-sunken')
    : 'bg-neutral-surface-sunken';

  // Phase-grid quieting (epic #361 child E, issue #385). At rest with no
  // committed cards, the cell collapses to a 16px tick — no card outline,
  // no surface fill, no "drop here" hint. The droppable is still wired up,
  // so during drag (`isDragActive`) the cell expands back to a full slot
  // so the user has a target. The tick line is `aria-hidden`; the column
  // header's count chip already announces "0 tasks" to assistive tech.
  const isEmpty = tasks.length === 0;
  const showRestingTick = isEmpty && !isDragActive;

  if (showRestingTick) {
    return (
      <div ref={setNodeRef} data-empty-cell="true" className="h-4 flex items-center justify-center">
        <div aria-hidden="true" className="w-8 h-px bg-neutral-border/60" />
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
          : `${restingBg} border-l-2 border-transparent`,
      ].join(' ')}
    >
      {wipBand === 'over' && (
        <div className="text-xs text-semantic-critical font-semibold px-1">
          WIP limit: {wipLimit} — {tasks.length - (wipLimit ?? 0)} over
        </div>
      )}
      {wipBand === 'at' && (
        <div className="text-xs text-semantic-at-risk font-semibold px-1">
          WIP limit: {wipLimit} — at limit
        </div>
      )}
      {tasks.map((task) => (
        <div
          key={task.id}
          onPointerDown={() => onCardFocus(task.id, status, phaseId)}
          onFocusCapture={() => onCardFocus(task.id, status, phaseId)}
        >
          <BoardCard
            task={task}
            density={density}
            onMenuMove={onMenuMove}
            columns={columns}
            isKeyboardFocused={focusedCardId === task.id}
            isDimmed={highlightedTaskIds !== null && !highlightedTaskIds.has(task.id)}
            isFilteredOut={facetMatchIds !== null && !facetMatchIds.has(task.id)}
            overallocByResource={overallocByResourcePerTask.get(task.id)}
            onShowDeps={onShowDeps}
            onShowRisks={onShowRisks}
            onChainHover={onChainHover}
            onCardClick={onCardClick}
            showEvm={showEvm}
            showCost={showCost}
            scopeActions={scopeActions}
            readOnly={readOnly}
          />
        </div>
      ))}
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
  /** Sprint scope-injection accept/reject affordance (ADR-0102). */
  scopeActions: BoardCardScopeActions;
  /** Closed-sprint read-only (#1141): disables drag-to-assign on every card. */
  readOnly?: boolean;
  /** Workshop mode: editable names, drag handle, tinted bg. */
  workshop?: boolean;
  onPhaseRename?: (phaseId: string, newName: string) => void;
  dragHandleListeners?: Record<string, unknown>;
  /** Per-status explicit column widths (issue 285), keyed by status. */
  columnWidths?: Record<string, number>;
  /** Explicit lane height in px (issue 285), or undefined for the natural height. */
  phaseHeight?: number;
  /** Persist a new clamped lane height (issue 285). */
  onResizeHeight: (phaseId: string, px: number) => void;
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
  scopeActions,
  readOnly = false,
  workshop = false,
  onPhaseRename,
  dragHandleListeners,
  facetMatchIds,
  columnWidths,
  phaseHeight,
  onResizeHeight,
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
    <button
      type="button"
      onClick={() => onToggleCollapse(phase.id)}
      onKeyDown={handleKeyDown}
      title={collapsed ? 'Expand lane  ]' : 'Collapse lane  ['}
      className="flex-shrink-0 text-neutral-text-secondary text-xs select-none
        focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded-control"
      aria-expanded={!collapsed}
      aria-controls={`phase-${phase.id}-content`}
      aria-label={collapsed ? `Expand ${phase.name}` : `Collapse ${phase.name}`}
    >
      {collapsed ? '▸' : '▾'}
    </button>
  );

  // Phase-lane focus toggle (issue 1460, ADR-0192 Part 3). Zooms the board to this
  // one lane (others hidden) via the ?focus= URL param; pressing it again, or
  // the focus banner's "Exit focus", clears it. Rendered in the lane meta
  // header row so the affordance sits with the phase it scopes to.
  const focusToggle = (
    <button
      type="button"
      onClick={() => onToggleFocus(phase.id)}
      title={focused ? 'Exit focus' : `Focus on ${phase.name}`}
      data-testid={`focus-lane-${phase.id}`}
      aria-pressed={focused}
      aria-label={focused ? `Exit focus on ${phase.name}` : `Focus on ${phase.name}`}
      className={[
        'relative flex-shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded-control border',
        focused
          ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
          : 'border-neutral-border bg-neutral-surface text-neutral-text-secondary hover:border-brand-primary/50 hover:text-brand-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        // 22px visual control + an invisible expander to reach the 44px touch
        // target (rule 5) without disturbing the dense lane-meta layout.
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

  return (
    <div
      role="group"
      aria-label={`${phase.name} swimlane`}
      className="relative border-b border-neutral-border/60 last:border-b-0"
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
          if (collapsedColumns.has(col.status)) {
            const count = tasksByStatus[col.status]?.length ?? 0;
            return (
              <button
                key={col.status}
                type="button"
                onClick={() => onExpandColumn(col.status)}
                title={`Expand ${col.label}`}
                aria-label={`Expand ${col.label} column`}
                data-testid={`lane-stub-${phase.id}-${col.status}`}
                className="bg-neutral-surface-sunken/60 border-l border-neutral-border/30
                  hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-brand-primary focus-visible:ring-inset"
              >
                {count > 0 && (
                  <span className="sr-only">
                    {count} task{count !== 1 ? 's' : ''}
                  </span>
                )}
              </button>
            );
          }
          if (collapsed) {
            const count = tasksByStatus[col.status]?.length ?? 0;
            return (
              <div
                key={col.status}
                className="bg-neutral-surface-sunken rounded-card p-2 min-h-[56px] flex items-center justify-center"
              >
                <span className="text-xs text-neutral-text-disabled">
                  {count > 0 ? `${count} task${count !== 1 ? 's' : ''}` : '—'}
                </span>
              </div>
            );
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
              scopeActions={scopeActions}
              readOnly={readOnly}
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

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <PhaseLane {...props} dragHandleListeners={listeners as Record<string, unknown>} />
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

interface MobileBoardProps {
  columns: {
    status: TaskStatus;
    label: string;
    wipLimit: number | null;
    color: string | null;
    slaDays?: number;
  }[];
  /** Flat per-status task lists — phase grouping collapses on mobile. */
  tasksByStatus: Record<TaskStatus, Task[]>;
  density: BoardDensity;
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  focusedCardId: string | null;
  onCardFocus: (taskId: string, status: TaskStatus, phaseId: string) => void;
  onShowDeps: (task: Task) => void;
  onShowRisks: (task: Task) => void;
  onCardClick: (task: Task, anchor: HTMLElement) => void;
  showEvm: EvmMode;
  showCost: boolean;
  scopeActions: BoardCardScopeActions;
  readOnly: boolean;
  /** Facet-filter match set (issue 1091) — null when no facet active. */
  facetMatchIds: Set<string> | null;
  /** Per-status CFD daily-count series for the WIP-creep trend arrow (issue 1213). */
  wipTrendSeriesByStatus: Partial<Record<TaskStatus, number[]>>;
  /** Reports the status column currently snapped into view (issue 605, FAB target). */
  onActiveStatusChange?: (status: TaskStatus) => void;
}

/**
 * Mobile board: each status column is a full-width snap-scroll page, with a
 * dot-strip nav above (v3 design case 8).
 *
 * Phase grouping is intentionally **collapsed** on mobile — a phase × status
 * grid is unreadable on a 375px screen, so each column shows a flat list of
 * its cards across every phase. The phase a card belongs to is still legible
 * from the card itself; the column's job here is the status axis.
 *
 * Snap-scroll is native CSS (`snap-x snap-mandatory` on the scroller, each
 * column `min-w-full snap-start`) — no JS scroll animation, so it is inherently
 * `prefers-reduced-motion` safe. An IntersectionObserver tracks which column is
 * snapped into view to drive the strip's active segment; tapping a strip
 * segment scrolls that column into view (`scrollIntoView({ inline: 'start' })`,
 * gated to `smooth` only under `motion-safe`).
 *
 * Card anatomy, the WIP pill, critical (red left-border) / blocked treatment,
 * and the status vocabulary are unchanged from desktop — `BoardCard` is reused
 * as-is; only the layout reflows.
 */
function MobileBoard({
  columns,
  tasksByStatus,
  density,
  onMenuMove,
  focusedCardId,
  onCardFocus,
  onShowDeps,
  onShowRisks,
  onCardClick,
  showEvm,
  showCost,
  scopeActions,
  readOnly,
  wipTrendSeriesByStatus,
  onActiveStatusChange,
  facetMatchIds,
}: MobileBoardProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef<(HTMLElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  // Keep the parent's FAB target in sync with the column in view (issue 605).
  // Reports on mount and on every swipe / tap-jump so a create always lands in
  // the visible group. Effect (not inline) so the render stays a pure function.
  useEffect(() => {
    const status = columns[activeIndex]?.status;
    if (status) onActiveStatusChange?.(status);
  }, [activeIndex, columns, onActiveStatusChange]);

  const segments: MobileColumnStripSegment[] = columns.map((col) => ({
    status: col.status,
    label: col.label,
    count: tasksByStatus[col.status]?.length ?? 0,
  }));

  // Track the snapped-to column via IntersectionObserver: whichever column page
  // is most in view drives the strip's active segment. Re-observes when the
  // column set changes (e.g. a column toggled visible in board settings).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Guard for environments without IntersectionObserver (jsdom/unit tests,
    // very old browsers): the strip simply stays on its initial active index
    // and tap-to-jump still works — only the swipe-driven active sync is lost.
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            const idx = columnRefs.current.indexOf(entry.target as HTMLElement);
            if (idx !== -1) setActiveIndex(idx);
          }
        }
      },
      { root: scroller, threshold: [0.6] },
    );
    for (const el of columnRefs.current) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [columns.length]);

  const jumpToColumn = useCallback((index: number) => {
    const el = columnRefs.current[index];
    if (!el) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      inline: 'start',
      block: 'nearest',
    });
    setActiveIndex(index);
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-neutral-surface-sunken">
      <div className="flex-shrink-0 bg-neutral-surface border-b border-neutral-border">
        <MobileColumnStrip segments={segments} activeIndex={activeIndex} onJump={jumpToColumn} />
      </div>
      <div
        ref={scrollerRef}
        data-testid="mobile-board-scroller"
        className="flex-1 flex min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory"
        style={{ scrollbarWidth: 'none' }}
      >
        {columns.map((col, i) => {
          const cards = tasksByStatus[col.status] ?? [];
          // Shared wipState() so the mobile column header shows the at-limit
          // breach chip too, not only over-limit (issue 1358 F6).
          const wipBand = col.wipLimit != null ? wipState(cards.length, col.wipLimit) : 'none';
          return (
            <section
              key={col.status}
              ref={(el) => {
                columnRefs.current[i] = el;
              }}
              data-status={col.status}
              data-mobile-column="true"
              aria-label={`${col.label}, ${cards.length} task${cards.length !== 1 ? 's' : ''}`}
              className="min-w-full snap-start overflow-y-auto px-4 py-3 flex flex-col gap-2.5"
            >
              <div className="flex items-center gap-2 pb-1">
                <h2 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
                  {col.label}
                </h2>
                <span className="text-xs text-neutral-text-disabled tppm-mono">{cards.length}</span>
                {(() => {
                  // WIP-creep arrow (issue 1213) + breach chip share the trailing
                  // cluster on mobile, same left-to-right order as desktop.
                  const trend = wipTrend(wipTrendSeriesByStatus[col.status] ?? [], col.wipLimit);
                  const breached = wipBand === 'over' || wipBand === 'at';
                  if (!trend && !breached) return null;
                  return (
                    <span className="ml-auto flex items-center gap-1.5">
                      {trend && <WipTrendArrow trend={trend} />}
                      {(wipBand === 'over' || wipBand === 'at') && (
                        <WipBreachChip state={wipBand} />
                      )}
                    </span>
                  );
                })()}
              </div>
              {cards.length === 0 ? (
                <div
                  className="flex items-center justify-center py-10 text-sm text-neutral-text-disabled"
                  role="status"
                >
                  Nothing here yet.
                </div>
              ) : (
                cards.map((task) => (
                  <div
                    key={task.id}
                    onPointerDown={() => onCardFocus(task.id, col.status, task.parentId ?? 'root')}
                    onFocusCapture={() => onCardFocus(task.id, col.status, task.parentId ?? 'root')}
                  >
                    <BoardCard
                      task={task}
                      density={density}
                      onMenuMove={onMenuMove}
                      columns={columns}
                      isKeyboardFocused={focusedCardId === task.id}
                      isFilteredOut={facetMatchIds !== null && !facetMatchIds.has(task.id)}
                      onShowDeps={onShowDeps}
                      onShowRisks={onShowRisks}
                      onCardClick={onCardClick}
                      showEvm={showEvm}
                      showCost={showCost}
                      scopeActions={scopeActions}
                      readOnly={readOnly}
                    />
                  </div>
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BoardView
// ---------------------------------------------------------------------------

export function BoardView() {
  usePageTitle('Board');
  const projectId = useProjectId() ?? '';
  // Public board share (#1486): mint/manage is Admin+; the toolbar item is hidden
  // for lower roles and the dialog surfaces the server kill-switch 403 verbatim.
  const { role: currentRole } = useCurrentUserRole(projectId || undefined);
  const canShareBoard = currentRole !== null && currentRole >= ROLE_ADMIN;
  const [shareOpen, setShareOpen] = useState(false);
  const { columns: rawColumns, save: saveBoardConfig } = useBoardConfig(projectId || null);
  const { tasks, isLoading } = useScheduleTasks();
  const updateStatus = useUpdateTaskStatus();
  const updateTask = useUpdateTask();
  const queryClient = useQueryClient();
  // Board offline (ADR-0220): hydrate the offline card-status queue, seed the
  // board from the last cached fetch when opened offline, and flush queued moves
  // on reconnect. Scoped to card-status moves; all other writes keep ADR-0205.
  useBoardOffline(projectId || null);
  const { data: workshopSession } = useWorkshopSession(projectId || null);
  const startWorkshop = useStartWorkshop(projectId || null);
  const endWorkshop = useEndWorkshop(projectId || null);
  const phaseReorder = usePhaseReorder(projectId || null);
  const queueReorder = useQueueReorder(projectId || null);
  const canManageBacklog = useCanManageBacklog(projectId || undefined);
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

  // Board sprint view (#429). The selected sprint scopes the phase columns to a
  // single sprint; `null` = Project view (all committed tasks). Persisted in the
  // `?sprint=` URL param (a distinct, shareable axis from the `?view=` saved
  // views) so a sprint board link can be shared. The backlog band is unaffected
  // — it stays the intake source you drag from.
  const { sprints } = useSprints(projectId || null);
  const selectedSprintId = searchParams.get('sprint');
  const selectedSprint = useMemo(
    () => sprints.find((s) => s.id === selectedSprintId) ?? null,
    [sprints, selectedSprintId],
  );
  // Smart default board scope (#1141): the user's last explicit choice
  // (per-user-per-project, localStorage) or the single ACTIVE sprint. The URL
  // param always wins — `setSelectedSprintId` writes it and also persists the
  // choice so the next visit (without a shared link) restores it.
  const defaultSprint = useDefaultBoardSprint(projectId || undefined);
  const setSelectedSprintId = useCallback(
    (id: string | null) => {
      if (projectId) defaultSprint.persist(projectId, id);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set('sprint', id);
          else next.delete('sprint');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams, defaultSprint, projectId],
  );

  // Seed the board scope once on first load when the URL carries no explicit
  // `?sprint=` (a shared link is authoritative and skips this entirely). Runs
  // after sprints + current user resolve; the ref guard keeps it one-shot so a
  // user who deliberately switches back to Project view isn't re-defaulted.
  const seededDefaultRef = useRef(false);
  useEffect(() => {
    if (seededDefaultRef.current) return;
    if (!projectId || defaultSprint.isLoading) return;
    if (searchParams.has('sprint')) {
      seededDefaultRef.current = true;
      return;
    }
    if (sprints.length === 0) return; // wait for sprints to load before deciding
    seededDefaultRef.current = true;
    const def = defaultSprint.resolveDefault(sprints);
    if (def) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('sprint', def);
          return next;
        },
        { replace: true },
      );
    }
  }, [projectId, defaultSprint, sprints, searchParams, setSearchParams]);

  // A COMPLETED sprint board is a retrospective read (#1141): drag-to-assign is
  // disabled board-wide so a card move never back-dates scope into a closed
  // sprint. Card-open and scroll stay enabled — read is the use case.
  const readOnly = selectedSprint?.state === 'COMPLETED';

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overCell, setOverCell] = useState<string | null>(null); // `${phaseId}:${status}`
  // Scope-injection drop toast (#1140) — set when a drop into the ACTIVE sprint
  // creates a pending scope-change; `BoardDropNotice` auto-dismisses it.
  const [dropNotice, setDropNotice] = useState<{ key: number; text: string } | null>(null);
  const [workshopMode, setWorkshopMode] = useState(false);
  // Open the workshop WS channel while a session is active so participant
  // join/leave events update the banner in real time.
  useWorkshopSocket(projectId || null, workshopMode && !!workshopSession, (event) => {
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
  const myTasksFilter = useMyTasksFilter(projectId || undefined);
  const { resourceId: myResourceId } = useCurrentUserResourceId(projectId || undefined);
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
  const [showSettings, setShowSettings] = useState(false);
  const [depTask, setDepTask] = useState<Task | null>(null);
  const [riskTask, setRiskTask] = useState<Task | null>(null);
  // Card popover (issue #304) — single instance at a time. Anchor is the
  // originating card element; required for desktop placement and for
  // returning focus on close. selectedTaskId drives the TaskDetailDrawer
  // mount (folded #265 in via the popover's "Open detail" CTA).
  const [popoverTask, setPopoverTask] = useState<Task | null>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<HTMLElement | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
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
  // WIP-breach popover anchored in the collapsed-columns banner (issue 1459, VoC:
  // Alex) — surfaces which folded columns are over/at their WIP limit so the
  // breach signal isn't lost when a column is stubbed.
  const [wipPopoverOpen, setWipPopoverOpen] = useState(false);
  // Anchors the WIP popover + its trigger so an outside pointerdown or Escape
  // dismisses it and returns focus to the trigger (ux-review issue 1457 — a11y).
  const wipPopoverRef = useRef<HTMLDivElement>(null);
  const wipTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!wipPopoverOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wipPopoverRef.current?.contains(e.target as Node)) setWipPopoverOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setWipPopoverOpen(false);
        wipTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [wipPopoverOpen]);
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
  const searchActive = searchQuery.trim().length > 0 && searchMatchIds.size > 0;
  const effectiveHighlightIds = searchActive ? searchMatchIds : highlightedTaskIds;

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
    }),
    [sort, showWip, showColTints, evmMode, showCost, riskLinkedOnly, cpOnly, dueSoonDays],
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
    [setSearchParams],
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
  const { data: projectDetail } = useProject(projectId || null);
  const iterationLabel = useIterationLabel(projectId || undefined);

  // WIP-creep trend arrows (issue 1213). The CFD daily per-status counts already
  // carry each column's recent occupancy; read them at board level so the header
  // arrows are always-on (passive creep detection is the point). The default
  // window shares its TanStack Query key with FlowAnalyticsPanel, so opening the
  // panel reuses this cache rather than re-fetching. Suppressed / errored reads
  // yield no series → no arrow (ADR-0104; trend is enhancement-only chrome).
  const { data: flowMetrics } = useFlowMetrics(projectId || null);
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
  const { sprint: activeSprint } = useActiveSprint(projectId || null);
  const canManageScope = useCanManageScope(projectId || undefined);
  const [scopeReviewOpen, setScopeReviewOpen] = useState(false);
  const { acceptOne: acceptScope, rejectOne: rejectScope } = useScopeChangeActions(
    projectId || null,
    activeSprint?.id ?? null,
  );
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
        if (id) acceptScope.mutate(id);
      },
      onReject: (task: Task) => {
        const id = pendingScopeChangeId(task);
        if (id) rejectScope.mutate(id);
      },
    }),
    [canManageScope, pendingScopeChangeId, acceptScope, rejectScope],
  );

  // Space-held click-drag panning of the board grid (issue 1265). While Space is
  // held, `shouldSuppressDrag` gates the pointer sensor so a pointer-down pans
  // the scroll container instead of lifting a card; releasing Space restores
  // normal @dnd-kit drag. `scrollRef` attaches to the desktop grid scroller.
  const {
    scrollRef: boardScrollRef,
    isSpaceHeld: isBoardPanArmed,
    isPanning: isBoardPanning,
    shouldSuppressDrag,
  } = useSpaceDragPan();

  const sensors = useSensors(
    useSensor(SpaceAwarePointerSensor, {
      activationConstraint: { distance: 4 },
      shouldSuppressActivation: shouldSuppressDrag,
    }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const createTask = useCreateTask(projectId || null);

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
  const facetMatchCount = facetMatchIds?.size ?? 0;
  const facetCount = activeFacetCount(facetFilters);
  // Zero-match: facets are active but no committed card matches. Drives the
  // dedicated banner (the board would otherwise show every card dimmed to 30%).
  const facetZeroMatch = facetsActive && facetMatchCount === 0;

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
        projectName: projectDetail?.name ?? 'Board',
        sprintName: selectedSprint?.name ?? null,
        columns: COLUMNS.map((c) => ({ status: c.status, label: c.label })),
        lanes: phases.map((p) => ({ id: p.id, name: p.name, tasks: p.tasks })),
        userName: currentUser?.display_name ?? null,
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
      projectDetail?.name,
      selectedSprint?.name,
      COLUMNS,
      phases,
      currentUser?.display_name,
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
            fileName: boardPdfFileName(projectDetail?.name ?? 'board', new Date().toISOString()),
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
  }, [exportRequested, projectDetail?.name]);

  // Demotion confirmation candidate (ADR-0057, Option C) — set by handleDragEnd
  // when a NOT_STARTED card is dropped on the band; cleared on confirm/cancel.
  const [backlogDemoteCandidate, setBacklogDemoteCandidate] = useState<Task | null>(null);

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

  // Hoisted ahead of `handleDragEnd` / `handleMenuMove` so the WIP-limit
  // guard can read live counts before issuing the move mutation (#232).
  const totalByStatus = useMemo(() => {
    const counts: Record<TaskStatus, number> = {
      BACKLOG: 0,
      NOT_STARTED: 0,
      IN_PROGRESS: 0,
      REVIEW: 0,
      ON_HOLD: 0,
      COMPLETE: 0,
    };
    for (const phase of phases) {
      for (const task of phase.tasks) {
        counts[task.status]++;
      }
    }
    return counts;
  }, [phases]);

  const handleAddPhase = useCallback(() => {
    const name = `Phase ${phases.filter((p) => p.id !== 'root').length + 1}`;
    createTask.mutate({ name, duration: 0, parent_id: null });
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

  // Tasks visible in the queue: applies the same task-level filters as the
  // phase-grid path so layout switching doesn't reveal hidden work. Phase-level
  // filters (e.g. workshop empty-phase preservation) don't apply — the queue
  // is a flat list, not a grid.
  const queueTasks = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const out: Task[] = [];
    for (const t of tasks ?? []) {
      if (t.isSummary) continue;
      if (cpOnly && !(t.isCritical && isTaskScheduled(t))) continue;
      if (dueSoonDays !== null) {
        const finish = new Date(t.finish);
        const diffMs = finish.getTime() - today.getTime();
        if (diffMs < 0 || diffMs > dueSoonDays * 86_400_000) continue;
      }
      if (mineActive) {
        if (myResourceId === null) continue;
        if (!t.assignees.some((a) => a.resourceId === myResourceId)) continue;
      }
      if (riskLinkedOnly && (t.linkedRisksCount ?? 0) === 0) continue;
      if (debtOnly && t.taskType !== 'tech_debt') continue;
      out.push(t);
    }
    return out;
  }, [tasks, cpOnly, dueSoonDays, mineActive, myResourceId, riskLinkedOnly, debtOnly]);

  // Per-phase, per-status task groupings — applies active sort order.
  const phaseTaskMap = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const result = new Map<string, Record<TaskStatus, Task[]>>();
    for (const phase of phases) {
      const byStatus: Record<TaskStatus, Task[]> = {
        BACKLOG: [],
        NOT_STARTED: [],
        IN_PROGRESS: [],
        REVIEW: [],
        ON_HOLD: [],
        COMPLETE: [],
      };
      for (const task of phase.tasks) {
        // Built-in view filters
        // CP-only filter must also exclude uncommitted tasks (issue #332):
        // CPM marks every dated task isCritical, so an unfiltered "CP only"
        // view leaks backlog ideas into the visible set.
        if (cpOnly && !(task.isCritical && isTaskScheduled(task))) continue;
        if (dueSoonDays !== null) {
          const finish = new Date(task.finish);
          const diffMs = finish.getTime() - today.getTime();
          if (diffMs < 0 || diffMs > dueSoonDays * 86_400_000) continue;
        }
        // "My tasks" filter (issue #198): only tasks assigned to the current
        // user's resource. When mineActive but myResourceId is null, drop
        // every task — the empty state below explains why.
        if (mineActive) {
          if (myResourceId === null) continue;
          if (!task.assignees.some((a) => a.resourceId === myResourceId)) continue;
        }
        // Tech-debt lens (ADR-0178, #1076): narrow to remediation work.
        if (debtOnly && task.taskType !== 'tech_debt') continue;
        byStatus[task.status]?.push(task);
      }
      // Apply sort within each status cell
      for (const s of Object.keys(byStatus) as TaskStatus[]) {
        byStatus[s] = sortTasksBy(byStatus[s], sort);
      }
      result.set(phase.id, byStatus);
    }
    return result;
  }, [phases, sort, cpOnly, dueSoonDays, mineActive, myResourceId, debtOnly]);

  // Flat per-status task lists for the mobile snap-scroll board. The
  // phase × status grid collapses on mobile — each status column shows every
  // matching card across all phases as one list. Derived from `phaseTaskMap`
  // so the same task-level filters (cpOnly / dueSoon / mine / debt) and sort
  // already applied per cell carry through; only the phase grouping drops.
  const mobileTasksByStatus = useMemo(() => {
    const out: Record<TaskStatus, Task[]> = {
      BACKLOG: [],
      NOT_STARTED: [],
      IN_PROGRESS: [],
      REVIEW: [],
      ON_HOLD: [],
      COMPLETE: [],
    };
    for (const byStatus of phaseTaskMap.values()) {
      for (const s of Object.keys(out) as TaskStatus[]) {
        const cell = byStatus[s];
        if (cell?.length) out[s].push(...cell);
      }
    }
    // Re-apply the active sort across the merged list so cross-phase order is
    // coherent (per-cell sort alone leaves phase-boundary jumps).
    for (const s of Object.keys(out) as TaskStatus[]) {
      out[s] = sortTasksBy(out[s], sort);
    }
    return out;
  }, [phaseTaskMap, sort]);

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

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const activeIdStr = String(active.id);
      setActiveId(null);
      setOverCell(null);

      // Phase reorder (workshop mode) — active ID is prefixed with 'phase:'
      if (activeIdStr.startsWith('phase:') && over) {
        const overId = String(over.id);
        if (activeIdStr !== overId) {
          const fromPhaseId = activeIdStr.replace('phase:', '');
          const toPhaseId = overId.replace('phase:', '');
          const fromIdx = phaseOrder.indexOf(fromPhaseId);
          const toIdx = phaseOrder.indexOf(toPhaseId);
          if (fromIdx !== -1 && toIdx !== -1) {
            const newOrder = arrayMove(phaseOrder, fromIdx, toIdx);
            const prevOrder = phaseOrder;
            setPhaseOrder(newOrder);
            phaseReorder.mutate(
              newOrder.map((id) => ({
                id,
                serverVersion: taskIndex.get(id)?.serverVersion ?? 0,
              })),
              { onError: () => setPhaseOrder(prevOrder) },
            );
          }
        }
        return;
      }

      // Card status change (and optional phase move in workshop mode)
      const overId = over?.id;
      if (!overId || !activeTask) return;

      // Drop onto the BACKLOG band above the phase grid (ADR-0057).
      if (String(overId) === BACKLOG_BAND_DROPPABLE_ID) {
        // No-op when already in backlog — drag dropped back onto the band.
        if (activeTask.status === 'BACKLOG') return;
        // Lock at IN_PROGRESS+: work has begun (or finished), demoting back to
        // BACKLOG would erase momentum/history. The card simply doesn't move;
        // we announce via the live region so the keyboard/SR path isn't silent.
        if (
          activeTask.status === 'IN_PROGRESS' ||
          activeTask.status === 'REVIEW' ||
          activeTask.status === 'COMPLETE'
        ) {
          if (ariaLiveRef.current) {
            ariaLiveRef.current.textContent = `${activeTask.name} cannot move to backlog — work has already started.`;
          }
          return;
        }
        // NOT_STARTED (TO DO): committed but not started — open the deliberate-
        // decision dialog (VoC outcome, Option C). Sarah's mobile concern is
        // mitigated by a focus-first confirm button + Esc-to-cancel.
        if (activeTask.status === 'NOT_STARTED') {
          setBacklogDemoteCandidate(activeTask);
          return;
        }
        // ON_HOLD (legacy) follows the same guard pattern as a backlog item —
        // it's not a committed delivery, so demote it without confirmation.
        updateStatus.mutate({ projectId, taskId: activeTask.id, status: 'BACKLOG' });
        if (ariaLiveRef.current) {
          ariaLiveRef.current.textContent = `${activeTask.name} moved to Backlog`;
        }
        return;
      }

      const [newPhaseId, newStatus] = String(overId).split(':');
      if (!newStatus) return;
      const currentPhaseId = activeTask.parentId ?? 'root';
      const phaseChanged = workshopMode && newPhaseId !== currentPhaseId;
      // Cross-lane drag under assignee (324) or epic (364) grouping: drag-to-
      // reassign is a deferred follow-up, so a drop into a different assignee or
      // epic lane never changes the assignee or the parent epic. A status
      // (column) change in the same drop still applies; we append a hint
      // pointing at the card's own control for that dimension.
      const reassignDeferred =
        (groupMode === 'assignee' && newPhaseId !== primaryAssigneeLaneId(activeTask)) ||
        (groupMode === 'epic' && newPhaseId !== epicLaneId(activeTask));
      const reassignNoun = groupMode === 'epic' ? 'epic' : 'assignee';
      if (newStatus === activeTask.status && !phaseChanged) {
        if (reassignDeferred && ariaLiveRef.current) {
          ariaLiveRef.current.textContent = `Drag-to-reassign isn't available yet — open ${activeTask.name} to change its ${reassignNoun}.`;
        }
        return;
      }
      // WIP-limit guard (#232): if the destination column is at or over its
      // limit and the task isn't already in that column, prompt before moving.
      if (
        showWip &&
        newStatus !== activeTask.status &&
        !confirmWipMove(COLUMNS, totalByStatus, newStatus as TaskStatus)
      ) {
        return;
      }
      // Sprint view drag-to-assign (#429): dropping a card into a phase while
      // scoped to a PLANNED/ACTIVE sprint it isn't yet in assigns it to that
      // sprint. The backend auto-sets sprint_pending for an ACTIVE sprint
      // (ADR-0102 post-activation injection); PLANNED links are part of the
      // commitment baseline with no pending gate. A COMPLETED sprint view is
      // read-only for assignment — we never back-date scope into a closed sprint.
      const assignSprintId =
        selectedSprint &&
        (selectedSprint.state === 'ACTIVE' || selectedSprint.state === 'PLANNED') &&
        activeTask.sprintId !== selectedSprint.id
          ? selectedSprint.id
          : undefined;
      updateStatus.mutate({
        projectId,
        taskId: activeTask.id,
        status: newStatus as TaskStatus,
        ...(phaseChanged ? { parentId: newPhaseId } : {}),
        ...(assignSprintId ? { sprintId: assignSprintId } : {}),
      });
      if (ariaLiveRef.current) {
        const colLabel = COLUMNS.find((c) => c.status === newStatus)?.label ?? newStatus;
        const intoSprint = assignSprintId ? ` and added to ${selectedSprint?.name}` : '';
        const reassignNote = reassignDeferred ? ' — reassign from the card' : '';
        ariaLiveRef.current.textContent = `${activeTask.name} moved to ${colLabel}${intoSprint}${reassignNote}`;
      }
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
    },
    [
      activeTask,
      projectId,
      updateStatus,
      COLUMNS,
      phaseOrder,
      phaseReorder,
      taskIndex,
      workshopMode,
      selectedSprint,
      showWip,
      totalByStatus,
      iterationLabel,
      groupMode,
    ],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverCell(null);
  }, []);

  const handleMenuMove = useCallback(
    (task: Task, newStatus: TaskStatus) => {
      // A closed-sprint board is read-only: drag is already disabled per card
      // (useSortable disabled), but the keyboard "Move to…" menu is a second
      // write path into the same status mutation. Guard it here so a closed
      // sprint can never be mutated regardless of which affordance triggers the
      // move — the banner alone was purely cosmetic (issue 1512).
      if (readOnly) return;
      if (
        showWip &&
        newStatus !== task.status &&
        !confirmWipMove(COLUMNS, totalByStatus, newStatus)
      ) {
        return;
      }
      updateStatus.mutate({ projectId, taskId: task.id, status: newStatus });
      if (ariaLiveRef.current) {
        const colLabel = COLUMNS.find((c) => c.status === newStatus)?.label ?? newStatus;
        ariaLiveRef.current.textContent = `${task.name} moved to ${colLabel}`;
      }
    },
    [projectId, updateStatus, COLUMNS, showWip, totalByStatus, readOnly],
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

  // While any b3 overlay is open, only Esc → onCloseOverlay should fire; nav keys
  // are suppressed.  When AddTaskModal is open, the modal owns the keyboard.
  const b3OverlayOpen =
    depTask !== null ||
    riskTask !== null ||
    showCheatsheet ||
    popoverTask !== null ||
    editTaskId !== null;

  useBoardKeyboard(
    {
      onMoveCardFocus: b3OverlayOpen ? undefined : moveFocusInColumn,
      onMoveColumnFocus: b3OverlayOpen ? undefined : moveFocusInPhase,
      onShowDeps: !b3OverlayOpen && focusedTask ? () => handleShowDeps(focusedTask) : undefined,
      onShowCheatsheet: b3OverlayOpen ? undefined : () => setShowCheatsheet(true),
      onFocusSearch: b3OverlayOpen ? undefined : () => searchInputRef.current?.focus(),
      onOpenFilter: b3OverlayOpen ? undefined : toggleFilterPanel,
      onCloseOverlay: b3OverlayOpen ? closeAllOverlays : undefined,
    },
    addTaskPhase === null,
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-text-secondary text-sm">
        Loading board…
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
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="relative flex flex-col h-full overflow-hidden bg-app-canvas">
          {/* Board toolbar — calm refactor (issue #382, epic #361 child B). */}
          <CalmToolbar
            projectId={projectId}
            projectName={projectDetail?.name}
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
            evmMode={evmMode}
            onEvmChange={setEvmMode}
            onOpenColumns={() => setShowSettings(true)}
            onOpenCheatsheet={() => setShowCheatsheet(true)}
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
          {/* Active-filter chip bar (issue 1091) — keeps the facet lens
              inescapable when the popover is closed; each chip removes its facet. */}
          <BoardFilterChips
            filters={facetFilters}
            assigneeNameById={assigneeNameById}
            matchCount={facetMatchCount}
            onChange={onFacetsChange}
            onClearAll={onClearAllFacets}
          />
          {/* Off-screen board-export print surface (issue 326). Mounted only
              while an export is in flight so its duplicate projection of the
              board's text never lingers in the DOM. Positioned out of view
              (never display:none — html-to-image must render it) and aria-hidden
              so it's invisible to assistive tech and pointer input. */}
          {exportRequested && (
            <div aria-hidden="true" className="pointer-events-none absolute -left-[99999px] top-0">
              <BoardPrintLayout ref={boardPrintRef} data={boardPrintData} />
            </div>
          )}
          {/* Workshop banner — shown when a session is active (ADR-0046) */}
          {workshopMode && workshopSession && (
            <WorkshopBanner
              session={workshopSession}
              onEnd={() => setShowExitConfirm(true)}
              isEnding={endWorkshop.isPending}
            />
          )}
          {/* Mid-sprint scope-injection banner (ADR-0101 §5) — team-visible
              record that tasks were added to the active sprint after it
              started. Self-hides when there's nothing to report. */}
          <BoardScopeInjectionBanner
            tasks={tasks ?? []}
            pendingCount={activeSprint?.pending_count ?? 0}
            canManageScope={canManageScope}
            onReview={() => setScopeReviewOpen(true)}
          />

          {/* "My tasks" active chip (issue #198) — keeps the filter state
              inescapable so users don't think the board has lost data. */}
          {mineActive && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 text-xs
                bg-brand-primary/5 border-b border-brand-primary/20
                text-brand-primary"
              role="status"
            >
              <span aria-hidden="true">★</span>
              <span>Filter: My tasks</span>
              <button
                type="button"
                onClick={() => myTasksFilter.setEnabled(false)}
                className="ml-1 underline hover:no-underline
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded-control"
              >
                Show all →
              </button>
            </div>
          )}

          {/* "Tech debt" active chip (ADR-0178, #1076) — keeps the lens
              inescapable so a narrowed board doesn't read as "lost tasks". */}
          {debtOnly && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 text-xs
                bg-brand-primary/5 border-b border-brand-primary/20
                text-brand-primary"
              role="status"
            >
              <span aria-hidden="true">⚒</span>
              <span>Filter: Tech debt</span>
              <button
                type="button"
                onClick={() => setDebtOnly(false)}
                className="ml-1 underline hover:no-underline
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded-control"
              >
                Show all →
              </button>
            </div>
          )}

          {/* Sprint header bar (#1138) — name + date range + Day N of M timebox
              + goal + compact burndown. Only when a sprint is selected, and never on a
              continuous-flow Kanban board (ADR-0164, issue 410) — that's sprint chrome. */}
          {selectedSprint && projectId && projectDetail?.board_cadence !== 'continuous' && (
            <BoardSprintHeader
              sprint={selectedSprint}
              projectId={projectId}
              onOpenStandup={openStandup}
            />
          )}
          {/* Closed-sprint read-only banner (#1141) — below the header, above the
              grid; drag-to-assign is disabled board-wide (see `readOnly`). */}
          {readOnly && projectId && <ClosedSprintBanner projectId={projectId} />}

          {/* Phase-lane focus banner (issue 1460, ADR-0192 Part 3) — keeps focus
              mode inescapable (mirrors the My-tasks / Tech-debt filter chips) so
              a board zoomed to one lane never reads as "lost lanes". A stale
              ?focus= for a phase that no longer exists self-hides. */}
          {focusedLanePhaseId && phases.some((p) => p.id === focusedLanePhaseId) && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 text-xs
                bg-brand-primary/5 border-b border-brand-primary/20 text-brand-primary"
              role="status"
              data-testid="focus-banner"
            >
              <svg
                aria-hidden="true"
                width={12}
                height={12}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <circle cx="8" cy="8" r="2.2" />
                <path d="M8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15" strokeLinecap="round" />
              </svg>
              <span>
                Focused on{' '}
                <strong className="font-semibold">
                  {phases.find((p) => p.id === focusedLanePhaseId)?.name}
                </strong>{' '}
                · other lanes hidden
              </span>
              <button
                type="button"
                onClick={exitFocusLane}
                data-testid="exit-focus"
                className="ml-1 underline hover:no-underline
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none rounded-control"
              >
                Exit focus →
              </button>
            </div>
          )}

          {/* Collapsed-columns banner (issue 1459, ADR-0192 Part 2) — count + bulk
              expand, plus a tappable WIP indicator that pops a list of folded
              columns breaching their limit so the breach signal survives the
              collapse (VoC: Alex). */}
          {collapsedColumns.size > 0 &&
            (() => {
              const collapsedList = COLUMNS.filter((c) => collapsedColumns.has(c.status));
              const breaching = collapsedList
                .map((c) => ({ col: c, band: wipState(totalByStatus[c.status], c.wipLimit) }))
                .filter(({ band }) => band === 'at' || band === 'over');
              const overCount = breaching.filter((b) => b.band === 'over').length;
              const atCount = breaching.length - overCount;
              // Tone + wording follow the worst band present (rule 159): any
              // over-limit column → critical red; only at-limit → at-risk amber.
              // The label names the actual band — never call an at-limit column
              // "over" (ux-review issue 1457).
              const worstOver = overCount > 0;
              const breachLabel =
                overCount > 0 && atCount === 0
                  ? `${overCount} over WIP`
                  : atCount > 0 && overCount === 0
                    ? `${atCount} at WIP limit`
                    : `${breaching.length} at/over WIP`;
              return (
                <div
                  ref={wipPopoverRef}
                  className="relative flex items-center gap-2 px-3 py-1.5 text-xs
                    bg-neutral-surface-sunken border-b border-neutral-border/60 text-neutral-text-secondary"
                  role="status"
                  data-testid="collapsed-columns-banner"
                >
                  <span aria-hidden="true">⊟</span>
                  <span>
                    {collapsedColumns.size} column{collapsedColumns.size !== 1 ? 's' : ''} collapsed
                  </span>
                  {breaching.length > 0 && (
                    <button
                      ref={wipTriggerRef}
                      type="button"
                      onClick={() => setWipPopoverOpen((v) => !v)}
                      aria-expanded={wipPopoverOpen}
                      aria-haspopup="dialog"
                      aria-controls="collapsed-wip-popover"
                      data-testid="collapsed-wip-trigger"
                      className={`flex items-center gap-1 px-1.5 py-px rounded-chip border font-medium
                        focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none ${
                          worstOver
                            ? 'border-semantic-critical/40 bg-semantic-critical-bg text-semantic-critical'
                            : 'border-semantic-at-risk/40 bg-semantic-at-risk-bg text-semantic-at-risk'
                        }`}
                    >
                      <span aria-hidden="true">⚠</span>
                      {breachLabel}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={expandAllColumns}
                    data-testid="expand-all-columns"
                    className="ml-auto underline hover:no-underline text-brand-primary
                      focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none rounded-control"
                  >
                    Expand all →
                  </button>
                  {wipPopoverOpen && breaching.length > 0 && (
                    <div
                      id="collapsed-wip-popover"
                      role="dialog"
                      aria-label="Collapsed columns at or over WIP limit"
                      data-testid="collapsed-wip-popover"
                      className="absolute top-[calc(100%+4px)] left-3 z-30 min-w-[200px]
                        rounded-card border border-neutral-border bg-neutral-surface p-2 shadow-pop"
                    >
                      <p className="text-xs font-semibold text-neutral-text-primary mb-1.5">
                        WIP limit status
                      </p>
                      <ul className="flex flex-col gap-1">
                        {breaching.map(({ col, band }) => (
                          <li key={col.status}>
                            <button
                              type="button"
                              onClick={() => {
                                toggleColumn(col.status);
                                setWipPopoverOpen(false);
                              }}
                              aria-label={`Expand ${col.label} column, ${totalByStatus[col.status]} of ${col.wipLimit}, ${
                                band === 'over' ? 'over limit' : 'at limit'
                              }`}
                              className="w-full flex items-center gap-2 px-1.5 py-1 rounded-control text-left
                                hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset focus-visible:outline-none"
                            >
                              <span
                                aria-hidden="true"
                                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                  COLUMN_DOT_CLASS[col.status] ?? 'bg-neutral-text-disabled'
                                }`}
                              />
                              <span className="flex-1 text-neutral-text-primary">{col.label}</span>
                              <span
                                aria-hidden="true"
                                className={`tppm-mono text-xs font-bold ${
                                  band === 'over'
                                    ? 'text-semantic-critical'
                                    : 'text-semantic-at-risk'
                                }`}
                              >
                                {totalByStatus[col.status]}/{col.wipLimit}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })()}

          {/* Zero-match state (issue 1091) — facets are active but no card
              matches. Supersedes the board body (which would otherwise be every
              card dimmed to 30%); offers a one-click clear. */}
          {facetZeroMatch && (
            <div
              className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-text-secondary text-sm"
              role="status"
              data-testid="board-zero-match"
            >
              <p>No cards match these filters.</p>
              <button
                type="button"
                onClick={onClearAllFacets}
                data-testid="board-zero-match-clear"
                className="border border-brand-primary/40 rounded-control px-3 py-1.5 text-xs
                  text-brand-primary font-medium hover:bg-brand-primary/10
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
              >
                Clear filters
              </button>
            </div>
          )}

          {/* Body — backlog surface (rail | drawer | queue) + scrolling phase
              grid. The rail sits left of the grid (flex-row); the drawer sits
              above it (flex-col, full width); the queue replaces both.
              Layout is persisted via `useBoardToolbarPrefs` (ADR-0057 / epic #361). */}
          {!facetZeroMatch && effectiveLayout === 'queue' && (
            <QueueLayout
              tasks={queueTasks}
              phaseNameFor={(parentId) => phaseNameMap.get(parentId ?? 'root') ?? 'Project'}
              phaseColorFor={(parentId) => (parentId ? phaseColor(parentId) : phaseColor('root'))}
              focusedCardId={focusedCardId}
              onCardFocus={handleCardFocus}
              onCardClick={handleCardClick}
              canReorder={canManageBacklog}
              onReorderGroup={(entries) => queueReorder.mutate(entries)}
              header={
                projectId ? (
                  <SprintPanel
                    projectId={projectId}
                    methodology={projectDetail?.methodology}
                    boardCadence={projectDetail?.board_cadence}
                  />
                ) : null
              }
            />
          )}
          {effectiveLayout === 'drawer' && (
            <BacklogDrawer
              tasks={backlogTasks}
              isDragActive={activeId !== null}
              isOver={overCell === BACKLOG_BAND_DROPPABLE_ID}
              density={toolbarPrefs.backlogDensity}
              phaseColorFor={(parentId) => (parentId ? phaseColor(parentId) : phaseColor('root'))}
              focusedCardId={focusedCardId}
              onCardFocus={handleCardFocus}
              onCardClick={handleCardClick}
            />
          )}
          {/* Mobile snap-scroll board (v3 case 8). On phones the phase ×
              status grid is unreadable, so each status column becomes a
              full-width snap page with a dot-strip nav. Gated behind `isMobile`
              so the desktop layout below is unchanged. The backlog band/drawer
              is suppressed here — the FAB + card menus cover capture/move on a
              phone, and the strip owns the horizontal axis. Queue layout keeps
              its own (already mobile-friendly) flat list above. */}
          {!facetZeroMatch && effectiveLayout !== 'queue' && isMobile && (
            <MobileBoard
              columns={COLUMNS}
              tasksByStatus={mobileTasksByStatus}
              density={density}
              onMenuMove={handleMenuMove}
              focusedCardId={focusedCardId}
              onCardFocus={handleCardFocus}
              onShowDeps={handleShowDeps}
              onShowRisks={handleShowRisks}
              onCardClick={handleCardClick}
              showEvm={evmMode}
              showCost={showCost}
              scopeActions={scopeActions}
              readOnly={readOnly}
              wipTrendSeriesByStatus={wipTrendSeriesByStatus}
              onActiveStatusChange={setMobileActiveStatus}
              facetMatchIds={facetMatchIds}
            />
          )}
          {!facetZeroMatch && effectiveLayout !== 'queue' && !isMobile && (
            <div className="flex-1 flex flex-row min-h-0">
              {effectiveLayout === 'rail' && (
                <BacklogBand
                  tasks={backlogTasks}
                  isDragActive={activeId !== null}
                  isOver={overCell === BACKLOG_BAND_DROPPABLE_ID}
                  density={toolbarPrefs.backlogDensity}
                  phaseColorFor={(parentId) =>
                    parentId ? phaseColor(parentId) : phaseColor('root')
                  }
                  focusedCardId={focusedCardId}
                  onCardFocus={handleCardFocus}
                  onCardClick={handleCardClick}
                  onSchedule={projectId ? handleScheduleRequest : undefined}
                  onCaptureIdea={() => handleAddTask('root', 'backlog', true)}
                  isCaptureIdeaPending={false}
                  onOpenCommandPalette={() => openCommandPalette(true)}
                />
              )}

              {/* Board grid — scrollable. `boardScrollRef` + the grab/grabbing
                  cursor classes wire Space-held drag-panning (issue 1265);
                  `select-none` while panning stops text selection mid-drag. */}
              <div
                ref={boardScrollRef}
                data-testid="board-scroll"
                data-space-panning={isBoardPanning ? 'true' : undefined}
                className={`flex-1 overflow-auto min-h-0 bg-neutral-surface-sunken${
                  isBoardPanArmed
                    ? isBoardPanning
                      ? ' cursor-grabbing select-none'
                      : ' cursor-grab'
                    : ''
                }`}
                // Board zoom CSS vars (issue 379) — cascade to the column-header / lane /
                // phase-rail grids and the column card-stacks below.
                style={BOARD_ZOOM_VARS[toolbarPrefs.zoom]}
              >
                {/* Active-sprint summary (ADR-0073) — rendered inside the scroll
                container so the burndown / velocity charts scroll away with
                the board instead of permanently consuming vertical space.
                Hidden entirely on WATERFALL projects and on projects with
                no active sprint. */}
                {projectId && (
                  <SprintPanel
                    projectId={projectId}
                    methodology={projectDetail?.methodology}
                    boardCadence={projectDetail?.board_cadence}
                  />
                )}
                {/* Flow analytics (ADR-0137, issue 1188) — collapsed by default;
                team-private behind the ADR-0104 flow_metrics signal. */}
                {projectId && (
                  <FlowAnalyticsPanel
                    projectId={projectId}
                    boardCadence={projectDetail?.board_cadence}
                  />
                )}
                {/* Sticky 2-tier header (issue 1458, ADR-0192 Part 1). The header row
                    pins on vertical scroll (sticky top); the "Phase" corner cell
                    additionally pins on horizontal scroll (sticky left) so it
                    stays over the lane sidebar. Z-order: corner (z-20) > header
                    row (z-10) > lane sidebar (z-[5]) > body cells. The header
                    stays at z-10 (not higher) so it never paints over the
                    toolbar's portaled menus. `w-max min-w-full` makes the
                    fixed-width tracks overflow the scroll container
                    horizontally rather than squishing. */}
                <div
                  className="grid gap-[var(--board-col-gap,0.5rem)] px-2 py-1.5 border-b-2 border-neutral-border/60 bg-neutral-surface sticky top-0 z-10 w-max min-w-full"
                  style={{
                    gridTemplateColumns: boardGridTemplate(COLUMNS, collapsedColumns, columnWidths),
                  }}
                >
                  <div className="sticky left-0 z-20 bg-neutral-surface text-xs uppercase tracking-wide text-neutral-text-disabled px-2 flex items-center">
                    Phase
                  </div>
                  {COLUMNS.map((col) => {
                    const count = totalByStatus[col.status];
                    // Folded column (issue 1459) — render the narrow stub in place of
                    // the full header cell. The stub carries the WIP-breach tone
                    // so the signal survives collapse.
                    if (collapsedColumns.has(col.status)) {
                      return (
                        <ColumnStub
                          key={col.status}
                          label={col.label}
                          status={col.status}
                          count={count}
                          wipBand={showWip ? wipState(count, col.wipLimit) : 'none'}
                          onExpand={() => toggleColumn(col.status)}
                        />
                      );
                    }
                    const state = showWip ? wipState(count, col.wipLimit) : 'none';
                    // A WIP breach is a signal, not an opt-in detail (issue 1188 /
                    // ADR-0130 D2 / VoC Alex): the breach chip + the column's accessible name
                    // announce it independent of the "Show WIP limits" toggle, which
                    // continues to gate only the numeric N/limit badge. Computed from
                    // the live column count (same source as the tint), so it equals the
                    // server breach verdict without a staler redundant read.
                    const breach = wipState(count, col.wipLimit);
                    const breached = breach === 'at' || breach === 'over';
                    // WIP-state band tint kept on at/over states (issue #232) but
                    // dropped on `none` — epic #361 child E (#385) introduced the
                    // status-dot prefix as the resting signal, so a tint at rest
                    // would compete with the dot.
                    const headerTint =
                      state === 'over'
                        ? 'bg-semantic-critical-bg border-l-2 border-semantic-critical'
                        : state === 'at'
                          ? 'bg-semantic-at-risk-bg border-l-2 border-semantic-at-risk'
                          : '';
                    const dotClass = COLUMN_DOT_CLASS[col.status] ?? 'bg-neutral-text-disabled';
                    return (
                      <div
                        key={col.status}
                        className={`relative flex items-center gap-2 px-2 ${headerTint}`}
                        data-wip-state={state}
                      >
                        <span
                          aria-hidden="true"
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClass}`}
                        />
                        <h2
                          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
                          // The inline WipBadge names the limit state visually; the
                          // header's accessible name must carry it too so a screen
                          // reader hears "at/over limit" on the column itself (#1033).
                          aria-label={
                            breach === 'over'
                              ? `${col.label}, ${count} task${count !== 1 ? 's' : ''}, over limit`
                              : breach === 'at'
                                ? `${col.label}, ${count} task${count !== 1 ? 's' : ''}, at limit`
                                : `${col.label}, ${count} task${count !== 1 ? 's' : ''}`
                          }
                        >
                          {col.label}
                        </h2>
                        <span className="text-xs text-neutral-text-disabled tppm-mono">
                          {count}
                        </span>
                        <span className="ml-auto flex items-center gap-1.5">
                          {(() => {
                            // WIP-creep arrow (issue 1213): reads before the
                            // breach chip so the row scans "heading up → current
                            // breach → number". No series (suppressed / ON_HOLD /
                            // no limit) → wipTrend returns null → nothing renders.
                            const trend = wipTrend(
                              wipTrendSeriesByStatus[col.status] ?? [],
                              col.wipLimit,
                            );
                            return trend ? <WipTrendArrow trend={trend} /> : null;
                          })()}
                          {breached && <WipBreachChip state={breach} />}
                          {showWip && col.wipLimit != null && (
                            <WipBadge count={count} limit={col.wipLimit} />
                          )}
                          {/* Collapse-to-stub control (issue 1459). Folds this column
                              across every lane; the header stub expands it back. */}
                          <button
                            type="button"
                            onClick={() => toggleColumn(col.status)}
                            title={`Collapse ${col.label}`}
                            aria-label={`Collapse ${col.label} column`}
                            data-testid={`collapse-column-${col.status}`}
                            className="relative flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded-control
                              text-neutral-text-disabled hover:text-brand-primary hover:bg-brand-primary/10
                              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                              before:absolute before:inset-[-13px] before:content-['']"
                          >
                            <svg
                              aria-hidden="true"
                              width={11}
                              height={11}
                              viewBox="0 0 12 12"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={1.6}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M7.5 2.5L4 6l3.5 3.5M11 2.5L7.5 6 11 9.5" />
                            </svg>
                          </button>
                        </span>
                        {/* Drag the right edge to resize this column (issue 285). */}
                        <ColumnResizeHandle
                          label={col.label}
                          onResize={(px) => setColumnWidth(col.status, px)}
                        />
                      </div>
                    );
                  })}
                </div>

                {/* Phase lanes */}
                {(() => {
                  const filteredPhases = sortedPhases.filter((phase) => {
                    // Phase-lane focus mode (issue 1460) — when a lane is focused,
                    // render only that lane. Filtering to one lane supersedes
                    // every other lane-visibility rule below. A stale ?focus=
                    // (phase no longer present) falls through and shows all.
                    if (
                      focusedLanePhaseId &&
                      sortedPhases.some((p) => p.id === focusedLanePhaseId)
                    ) {
                      return phase.id === focusedLanePhaseId;
                    }
                    const phaseCells = phaseTaskMap.get(phase.id);
                    // After cpOnly / dueSoonDays / mineActive filtering, hide
                    // phases with no visible tasks. Without this the empty-state
                    // branch below can never render — phases would stay even when
                    // every cell has been emptied by the filter.
                    if (cpOnly || dueSoonDays !== null || mineActive || debtOnly) {
                      const visibleCount = Object.values(phaseCells ?? {}).reduce(
                        (s: number, arr) => s + (arr as unknown[]).length,
                        0,
                      );
                      if (visibleCount === 0) return false;
                    }
                    if (!riskLinkedOnly) return true;
                    return phase.tasks.some((t) => (t.linkedRisksCount ?? 0) > 0);
                  });

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
                    // the per-lane add button in those read-only lenses.
                    onAddTask:
                      groupMode === 'assignee' || groupMode === 'epic' ? undefined : handleAddTask,
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
                    scopeActions,
                    readOnly,
                    workshop: workshopMode,
                    onPhaseRename: workshopMode ? handlePhaseRename : undefined,
                    // Board resize (issue 285): per-column widths + this lane's height.
                    columnWidths,
                    phaseHeight: phaseHeights[phase.id],
                    onResizeHeight: setPhaseHeight,
                  });

                  if (workshopMode) {
                    return (
                      <>
                        <SortableContext
                          items={filteredPhases.map((p) => `phase:${p.id}`)}
                          strategy={verticalListSortingStrategy}
                        >
                          {filteredPhases.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-text-secondary">
                              <p className="text-sm">
                                No phases yet. Add your first phase to start planning.
                              </p>
                              <button
                                type="button"
                                onClick={handleAddPhase}
                                disabled={createTask.isPending}
                                className="border border-brand-primary/40 rounded-control px-4 py-2 text-sm
                              text-brand-primary font-medium
                              hover:bg-brand-primary/10 disabled:opacity-50
                              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
                              >
                                {createTask.isPending ? 'Adding…' : '+ Add Phase'}
                              </button>
                            </div>
                          ) : (
                            filteredPhases.map((phase) => (
                              <SortablePhaseLane key={phase.id} {...laneProps(phase)} />
                            ))
                          )}
                        </SortableContext>
                        {filteredPhases.length > 0 && (
                          <div className="flex justify-start px-4 py-3">
                            <button
                              type="button"
                              onClick={handleAddPhase}
                              disabled={createTask.isPending}
                              className="border border-dashed border-neutral-border rounded-control px-3 py-1.5 text-xs
                            text-neutral-text-secondary hover:border-brand-primary/40
                            hover:text-brand-primary
                            hover:bg-brand-primary/5 disabled:opacity-50
                            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
                            >
                              {createTask.isPending ? 'Adding…' : '+ Add Phase'}
                            </button>
                          </div>
                        )}
                      </>
                    );
                  }

                  if (filteredPhases.length === 0) {
                    if (mineActive) {
                      return (
                        <div
                          className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-text-secondary text-sm"
                          role="status"
                        >
                          <p>No tasks assigned to you in this project yet.</p>
                          <button
                            type="button"
                            onClick={() => myTasksFilter.setEnabled(false)}
                            className="border border-brand-primary/40 rounded-control px-3 py-1.5 text-xs
                          text-brand-primary font-medium
                          hover:bg-brand-primary/10
                          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
                          >
                            Show all tasks
                          </button>
                        </div>
                      );
                    }
                    return (
                      <div
                        className="flex items-center justify-center py-16 text-neutral-text-secondary text-sm"
                        role="status"
                      >
                        No tasks yet. Create tasks to see them on the board.
                      </div>
                    );
                  }

                  return filteredPhases.map((phase) => (
                    <PhaseLane key={phase.id} {...laneProps(phase)} />
                  ));
                })()}
              </div>
            </div>
          )}

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
            border border-brand-primary-dark text-white flex items-center justify-center
            text-2xl font-light md:hidden z-10
            focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2
            focus-visible:ring-offset-brand-primary"
          aria-label="Add task"
        >
          +
        </button>
      )}

      {/* Backlog demote confirm — opens when a NOT_STARTED card drops on the
          band (ADR-0057, Option C). Audit row is captured automatically by
          simple_history on the status field change. */}
      {backlogDemoteCandidate && (
        <BacklogDemoteConfirmDialog
          task={backlogDemoteCandidate}
          onCancel={() => setBacklogDemoteCandidate(null)}
          onConfirm={() => {
            const target = backlogDemoteCandidate;
            setBacklogDemoteCandidate(null);
            updateStatus.mutate({
              projectId,
              taskId: target.id,
              status: 'BACKLOG',
            });
            if (ariaLiveRef.current) {
              ariaLiveRef.current.textContent = `${target.name} moved to Backlog`;
            }
          }}
        />
      )}

      {/* Schedule "…" dialog (#318, rule 135) — keyboard alternative to dragging
          a backlog idea onto the Schedule view's timeline. Opened from a
          BacklogCard's ··· action; issues the same
          { planned_start, status: 'NOT_STARTED' } promote PATCH (decision A2). */}
      {scheduleDialogTask && projectId && (
        <ScheduleTaskDialog
          task={scheduleDialogTask}
          projectId={projectId}
          onClose={handleScheduleDialogClose}
        />
      )}

      {/* Per-phase task create modal (issue #305 — replaced AddTaskModal).
          When the source is the synthetic phase-less Project Tasks lane
          (#387), open with status defaulting to BACKLOG; the modal title
          becomes "Add to backlog" via the lowercased phaseName.

          The `'root'` sentinel is the BoardView's view-layer name for the
          parentless lane — the API expects `parent_id: null` (see
          views.py "null = root level"), so normalize before the modal
          stores it as `selectedParentId`. */}
      {addTaskPhase && projectId && (
        <TaskFormModal
          projectId={projectId}
          task={null}
          phaseName={addTaskPhase.name}
          parentId={addTaskPhase.id === 'root' ? null : addTaskPhase.id}
          defaultStatus={
            // Explicit FAB target (issue 605) wins; else the synthetic backlog
            // lane defaults to BACKLOG and a real phase to NOT_STARTED.
            addTaskPhase.status ?? (addTaskPhase.isSynthetic ? 'BACKLOG' : 'NOT_STARTED')
          }
          isMobile={isMobile}
          onClose={() => setAddTaskPhase(null)}
        />
      )}

      {/* Board batch 3 overlays — at most one open at a time. */}
      {showCheatsheet && <KeyboardCheatsheet onClose={() => setShowCheatsheet(false)} />}
      {shareOpen && projectId && (
        <ShareViewDialog
          projectId={projectId}
          contentKind="board"
          onClose={() => setShareOpen(false)}
        />
      )}
      {showSettings && (
        <BoardSettingsPanel
          columns={rawColumns}
          onSave={saveBoardConfig}
          onClose={() => setShowSettings(false)}
        />
      )}
      {depTask && (
        <DepPopover
          task={depTask}
          taskIndex={taskIndex}
          onClose={() => setDepTask(null)}
          onJumpTo={(taskId) => {
            const target = taskIndex.get(taskId);
            if (target) {
              handleCardFocus(taskId, target.status, target.parentId ?? 'root');
            }
            setDepTask(null);
          }}
        />
      )}
      {riskTask && projectId && (
        <RiskPopover projectId={projectId} task={riskTask} onClose={() => setRiskTask(null)} />
      )}

      {/* Card information popover (issue #304) — primary card-click target.
          "Open detail" hands off to TaskDetailDrawer below; "Edit" routes
          there in edit mode (one-line swap target for #305 modal). */}
      {popoverTask && projectId && (
        <BoardCardPopover
          task={popoverTask}
          projectId={projectId}
          anchor={popoverAnchor}
          isMobile={isMobile}
          onClose={() => {
            // Return focus to the originating card on close (rule 4 / a11y).
            const anchor = popoverAnchor;
            closeCardPopover();
            if (anchor && anchor.isConnected) anchor.focus();
          }}
          onOpenDetail={() => {
            const id = popoverTask.id;
            closeCardPopover();
            setSelectedTaskId(id);
          }}
          onEdit={() => {
            // #305 wired: Edit opens the unified TaskFormModal in edit mode.
            const id = popoverTask.id;
            closeCardPopover();
            setEditTaskId(id);
          }}
        />
      )}

      {/* Task detail drawer — rendered from BoardView for the first time
          (folds in #265). Driven by the popover's "Open detail" action;
          shares the same registry-backed entry path as the Schedule view
          (ADR-0050). Conditionally mounted on selection so a closed
          `role="dialog"` does not collide with the Workshop modal's loose
          `getByRole('dialog')` locator (wave9-workshop e2e). */}
      {projectId && selectedTaskId && (
        <TaskDetailDrawer
          task={taskIndex.get(selectedTaskId) ?? null}
          projectId={projectId}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      {/* Board activity feed (ADR-0160, issue 1261) — a docked right-edge rail
          (overlay on mobile). Clicking an event opens its card via the same
          selectedTaskId drawer; a deleted/absent card is not openable. The panel
          is non-modal, dismissed via its close button or the toolbar toggle. */}
      {projectId && activityOpen && (
        <div className="fixed inset-y-0 right-0 z-30 flex w-full max-w-sm border-l border-neutral-border md:w-80">
          <BoardActivityPanel
            projectId={projectId}
            onClose={toggleActivity}
            onOpenTask={(taskId) => setSelectedTaskId(taskId)}
            isTaskOpenable={(taskId) => taskIndex.has(taskId)}
          />
        </div>
      )}

      {/* Daily standup walk-the-board (ADR-0166, issue 1278) — a focused full-surface mode
          driven by the active sprint's per-person walk; opens the same selectedTaskId
          drawer when a card is clicked. Mounted off ?standup=1. */}
      {projectId && standupOpen && (
        <StandupMode
          projectId={projectId}
          onClose={closeStandup}
          onOpenTask={(taskId) => setSelectedTaskId(taskId)}
        />
      )}

      {/* Task edit modal (issue #305) — opened by the popover's "Edit"
          action. Same component handles create/edit; mode is inferred from
          `task` (null = create, set = edit). */}
      {projectId && editTaskId && (
        <TaskFormModal
          projectId={projectId}
          task={taskIndex.get(editTaskId) ?? null}
          isMobile={isMobile}
          onClose={() => setEditTaskId(null)}
          onDeleted={() => {
            setEditTaskId(null);
            setSelectedTaskId(null);
          }}
        />
      )}

      {/* Workshop exit confirmation dialog (ADR-0046) */}
      {showExitConfirm && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="workshop-exit-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay"
          tabIndex={-1}
          onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Escape') {
              setShowExitConfirm(false);
              workshopToggleRef.current?.focus();
              return;
            }
            // Focus trap: cycle Tab through the dialog's interactive elements.
            if (e.key === 'Tab') {
              const focusable = Array.from(
                e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])'),
              );
              if (focusable.length === 0) return;
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
            }
          }}
        >
          <div className="bg-neutral-surface border border-neutral-border rounded-card p-6 max-w-sm w-full mx-4">
            <h2
              id="workshop-exit-title"
              className="text-sm font-semibold text-neutral-text-primary mb-2"
            >
              End workshop session?
            </h2>
            <p className="text-xs text-neutral-text-secondary mb-4">
              This will end the session for all participants. The board will return to normal mode.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                type="button"
                onClick={() => {
                  setShowExitConfirm(false);
                  workshopToggleRef.current?.focus();
                }}
                className="border border-neutral-border rounded-control px-3 py-1.5 text-xs
                  text-neutral-text-primary hover:bg-neutral-surface-raised
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={endWorkshop.isPending}
                onClick={() => {
                  endWorkshop.mutate(undefined, {
                    onSettled: () => {
                      setWorkshopMode(false);
                      setShowExitConfirm(false);
                      workshopToggleRef.current?.focus();
                    },
                  });
                }}
                className="border border-semantic-critical/40 rounded-control px-3 py-1.5 text-xs
                  text-semantic-critical hover:bg-semantic-critical/10 disabled:opacity-50
                  focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:outline-none"
              >
                {endWorkshop.isPending ? 'Ending…' : 'End Workshop'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sprint scope-injection review slide-over (ADR-0102 §5). Mounted only
          for a team-owned actor (canManageScope); offline disables the
          accept/reject controls — chips still render but no action queues
          (ADR-0102 §6 / frontend rule 152: a stale accept could re-commit
          rejected work, so we never queue these). */}
      {scopeReviewOpen && projectId && activeSprint && canManageScope && (
        <ScopePendingReviewPanel
          projectId={projectId}
          sprintId={activeSprint.id}
          tasks={tasks ?? []}
          offline={typeof navigator !== 'undefined' && !navigator.onLine}
          onClose={() => setScopeReviewOpen(false)}
        />
      )}
    </>
  );
}
