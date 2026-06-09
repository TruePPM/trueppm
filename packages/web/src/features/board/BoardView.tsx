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
import {
  DndContext,
  PointerSensor,
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
import { useMyTasksFilter } from '@/hooks/useMyTasksFilter';
import { useCurrentUserResourceId } from '@/hooks/useCurrentUserResourceId';
import { useBoardKeyboard } from '@/hooks/useBoardKeyboard';
import { useBoardOverallocation } from '@/hooks/useBoardOverallocation';
import { type BoardSortKey, type BoardViewConfig } from '@/hooks/useBoardSavedViews';
import { wipState } from './wip';
import { useTaskDependencies } from '@/hooks/useTaskDependencies';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkshopSession, useStartWorkshop, useEndWorkshop } from '@/hooks/useWorkshopSession';
import { usePhaseReorder } from '@/hooks/usePhaseReorder';
import { useWorkshopSocket } from '@/hooks/useWorkshopSocket';
import { useCreateTask, useUpdateTask } from '@/hooks/useTaskMutations';
import type { Task, TaskStatus } from '@/types';
import { BoardCard, type BoardDensity, type EvmMode } from './BoardCard';
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
import { BacklogDrawer } from './BacklogDrawer';
import { QueueLayout } from './QueueLayout';
import { BacklogDemoteConfirmDialog } from './BacklogDemoteConfirmDialog';
import { ScheduleTaskDialog } from '@/features/schedule/ScheduleTaskDialog';
import { CalmToolbar } from './CalmToolbar';
import { SprintPanel } from './SprintPanel';
import { useBoardToolbarPrefs } from '@/hooks/useBoardToolbarPrefs';
import { useProject } from '@/hooks/useProject';
import { useActiveSprint } from '@/hooks/useSprints';
import { useCanManageScope } from '@/hooks/useCanManageScope';
import { useScopeChangeActions } from '@/hooks/useScopeChangeActions';
import { ScopePendingReviewPanel } from '@/features/sprints/ScopePendingReviewPanel';
import type { BoardCardScopeActions } from './BoardCard';

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
        className="ml-1.5 text-xs font-medium px-1 py-0.5 rounded border bg-semantic-critical-bg border-semantic-critical/40 text-semantic-critical tppm-mono"
        aria-label={`${count} of ${limit} WIP limit, over limit`}
      >
        {count}/{limit} — over WIP limit
      </span>
    );
  }
  if (count >= limit) {
    return (
      <span
        className="ml-1.5 text-xs font-medium px-1 py-0.5 rounded border bg-semantic-at-risk-bg border-semantic-at-risk/40 text-semantic-at-risk tppm-mono"
        aria-label={`${count} of ${limit} WIP limit, at limit`}
      >
        {count}/{limit} WIP
      </span>
    );
  }
  return (
    <span
      className="ml-1.5 text-xs font-medium px-1 py-0.5 rounded border bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary tppm-mono"
      aria-label={`${count} of ${limit} WIP limit`}
    >
      {count}/{limit}
    </span>
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
        <span className="text-xs px-1 py-px rounded bg-semantic-on-track-bg border border-semantic-on-track/30 text-semantic-on-track font-medium">
          {doneCount} done
        </span>
      )}
      {cpCount > 0 && (
        <span className="text-xs px-1 py-px rounded bg-semantic-critical-bg border border-semantic-critical/30 text-semantic-critical font-medium">
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

function BoardCell({
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
}: BoardCellProps) {
  const droppableId = `${phaseId}:${status}`;
  const { setNodeRef } = useDroppable({ id: droppableId });
  const over = isOver && isDragActive;
  const wip = showWip && wipLimit != null && tasks.length > wipLimit;
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
        'rounded-lg p-2 min-h-[120px] flex flex-col gap-1.5 transition-colors duration-100',
        over
          ? 'bg-brand-primary/5 border-l-2 border-brand-primary'
          : `${restingBg} border-l-2 border-transparent`,
      ].join(' ')}
    >
      {wip && (
        <div className="text-xs text-semantic-at-risk font-semibold px-1">
          WIP limit: {wipLimit} — {tasks.length - (wipLimit ?? 0)} over
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
            onMenuMove={(newStatus) => onMenuMove(task, newStatus)}
            columns={columns}
            isKeyboardFocused={focusedCardId === task.id}
            isDimmed={highlightedTaskIds !== null && !highlightedTaskIds.has(task.id)}
            overallocByResource={overallocByResourcePerTask.get(task.id)}
            onShowDeps={() => onShowDeps(task)}
            onShowRisks={() => onShowRisks(task)}
            onChainHoverEnter={() => onChainHover(task.id)}
            onChainHoverLeave={() => onChainHover(null)}
            onCardClick={onCardClick}
            showEvm={showEvm}
            showCost={showCost}
            scopeActions={scopeActions}
          />
        </div>
      ))}
    </div>
  );
}

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
  overCell: string | null; // `${phaseId}:${status}` or null
  isDragActive: boolean;
  showWip: boolean;
  showColTints: boolean;
  density: BoardDensity;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  onAddTask: (phaseId: string, phaseName: string, isSynthetic?: boolean) => void;
  focusedCardId: string | null;
  highlightedTaskIds: Set<string> | null;
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
  /** Workshop mode: editable names, drag handle, tinted bg. */
  workshop?: boolean;
  onPhaseRename?: (phaseId: string, newName: string) => void;
  dragHandleListeners?: Record<string, unknown>;
}

function PhaseLane({
  phase,
  columns,
  tasksByStatus,
  milestones,
  overCell,
  isDragActive,
  showWip,
  showColTints,
  density,
  collapsed,
  onToggleCollapse,
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
  workshop = false,
  onPhaseRename,
  dragHandleListeners,
}: PhaseLaneProps) {
  const avg = avgProgress(phase.tasks);
  const committedTaskCount = phase.tasks.filter(isTaskScheduled).length;
  const color = phaseColor(phase.id);
  const colCount = columns.length;
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
        onToggleCollapse();
      }
      if (e.key === ']' && collapsed) {
        e.preventDefault();
        onToggleCollapse();
      }
    },
    [collapsed, onToggleCollapse],
  );

  const collapseToggle = (
    <button
      type="button"
      onClick={onToggleCollapse}
      onKeyDown={handleKeyDown}
      title={collapsed ? 'Expand lane  ]' : 'Collapse lane  ['}
      className="flex-shrink-0 text-neutral-text-secondary text-xs select-none
        focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded"
      aria-expanded={!collapsed}
      aria-controls={`phase-${phase.id}-content`}
      aria-label={collapsed ? `Expand ${phase.name}` : `Collapse ${phase.name}`}
    >
      {collapsed ? '▸' : '▾'}
    </button>
  );

  return (
    <div
      role="group"
      aria-label={`${phase.name} swimlane`}
      className="border-b border-neutral-border/60 last:border-b-0"
    >
      {!collapsed && milestones.length > 0 && (
        <PhaseMilestoneRail
          milestones={milestones}
          columns={columns}
          onOpenTask={onOpenMilestone}
        />
      )}
      <div
        id={`phase-${phase.id}-content`}
        className="grid gap-2 p-2"
        style={{ gridTemplateColumns: `188px repeat(${colCount}, minmax(0, 1fr))` }}
      >
        {/* Phase meta — LaneMeta atom (issue #208) */}
        <div className="rounded-lg overflow-hidden border border-neutral-border/40 min-w-0">
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
            onAddTask={() => onAddTask(phase.id, phase.name, isSynthetic)}
            addTaskLabel={isSynthetic ? 'Add to backlog' : undefined}
            collapseToggle={collapseToggle}
            showCost={showCost}
            phaseBudgetAtCompletion={phaseBudgetAtCompletion}
            phaseActualCost={phaseActualCost}
          />
          <div className="px-[11px] pb-2">
            <PhaseSummaryChips phase={phase} />
          </div>
        </div>

        {/* Column cells */}
        {collapsed
          ? columns.map((col) => {
              const count = tasksByStatus[col.status]?.length ?? 0;
              return (
                <div
                  key={col.status}
                  className="bg-neutral-surface-sunken rounded-lg p-2 min-h-[56px] flex items-center justify-center"
                >
                  <span className="text-xs text-neutral-text-disabled">
                    {count > 0 ? `${count} task${count !== 1 ? 's' : ''}` : '—'}
                  </span>
                </div>
              );
            })
          : columns.map((col) => (
              <BoardCell
                key={col.status}
                phaseId={phase.id}
                status={col.status}
                tasks={tasksByStatus[col.status] ?? []}
                isOver={overCell === `${phase.id}:${col.status}`}
                isDragActive={isDragActive}
                showWip={showWip}
                showColTints={showColTints}
                density={density}
                wipLimit={col.wipLimit}
                onMenuMove={onMenuMove}
                columns={columns}
                focusedCardId={focusedCardId}
                highlightedTaskIds={highlightedTaskIds}
                overallocByResourcePerTask={overallocByResourcePerTask}
                onCardFocus={onCardFocus}
                onShowDeps={onShowDeps}
                onShowRisks={onShowRisks}
                onChainHover={onChainHover}
                onCardClick={onCardClick}
                showEvm={showEvm}
                showCost={showCost}
                scopeActions={scopeActions}
              />
            ))}
      </div>
    </div>
  );
}

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
// BoardView
// ---------------------------------------------------------------------------

export function BoardView() {
  const projectId = useProjectId() ?? '';
  const { columns: rawColumns, save: saveBoardConfig } = useBoardConfig(projectId || null);
  const { tasks, isLoading } = useScheduleTasks();
  const updateStatus = useUpdateTaskStatus();
  const updateTask = useUpdateTask();
  const queryClient = useQueryClient();
  const { data: workshopSession } = useWorkshopSession(projectId || null);
  const startWorkshop = useStartWorkshop(projectId || null);
  const endWorkshop = useEndWorkshop(projectId || null);
  const phaseReorder = usePhaseReorder(projectId || null);
  // BACKLOG cards live in the band above the phase grid (ADR-0057), not in an
  // inline column inside each phase. The visible-column list excludes BACKLOG
  // even when the saved board config marks it visible — that flag governs the
  // (now-deprecated) inline column, not the band.
  const COLUMNS = rawColumns.filter((c) => c.visible && c.status !== 'BACKLOG');
  const [searchParams, setSearchParams] = useSearchParams();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overCell, setOverCell] = useState<string | null>(null); // `${phaseId}:${status}`
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
  } | null>(null);
  const [riskLinkedOnly, setRiskLinkedOnly] = useState(false);
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
  // editTaskId opens the unified TaskFormModal in edit mode (issue #305).
  // The popover's "Edit" footer action sets this; the modal owns the rest.
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  // Dim non-connected cards (#182) — null means no highlight active.
  const [highlightedTaskIds, setHighlightedTaskIds] = useState<Set<string> | null>(null);
  const [chainHoverTaskId, setChainHoverTaskId] = useState<string | null>(null);
  const ariaLiveRef = useRef<HTMLDivElement>(null);

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
  const { density, setDensity, isMobile } = useBoardDensity();
  const toolbarPrefs = useBoardToolbarPrefs();
  const { data: projectDetail } = useProject(projectId || null);

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const createTask = useCreateTask(projectId || null);

  // Partition BACKLOG cards out of the phase tree (ADR-0057). Summary tasks
  // never have BACKLOG status, so the isSummary check is defensive — it would
  // otherwise be unreachable. The committed half drives buildPhases; the
  // backlog half drives the BacklogBand above the grid.
  const { committedTasks, backlogTasks } = useMemo(() => {
    const committed: Task[] = [];
    const backlog: Task[] = [];
    for (const t of tasks ?? []) {
      if (t.status === 'BACKLOG' && !t.isSummary) {
        backlog.push(t);
      } else {
        committed.push(t);
      }
    }
    return { committedTasks: committed, backlogTasks: backlog };
  }, [tasks]);

  const phases = useMemo(() => {
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
  }, [committedTasks, workshopMode, backlogTasks.length]);

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
      out.push(t);
    }
    return out;
  }, [tasks, cpOnly, dueSoonDays, mineActive, myResourceId, riskLinkedOnly]);

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
        byStatus[task.status]?.push(task);
      }
      // Apply sort within each status cell
      for (const s of Object.keys(byStatus) as TaskStatus[]) {
        byStatus[s] = sortTasksBy(byStatus[s], sort);
      }
      result.set(phase.id, byStatus);
    }
    return result;
  }, [phases, sort, cpOnly, dueSoonDays, mineActive, myResourceId]);

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
      if (newStatus === activeTask.status && !phaseChanged) return;
      // WIP-limit guard (#232): if the destination column is at or over its
      // limit and the task isn't already in that column, prompt before moving.
      if (
        showWip &&
        newStatus !== activeTask.status &&
        !confirmWipMove(COLUMNS, totalByStatus, newStatus as TaskStatus)
      ) {
        return;
      }
      updateStatus.mutate({
        projectId,
        taskId: activeTask.id,
        status: newStatus as TaskStatus,
        ...(phaseChanged ? { parentId: newPhaseId } : {}),
      });
      if (ariaLiveRef.current) {
        const colLabel = COLUMNS.find((c) => c.status === newStatus)?.label ?? newStatus;
        ariaLiveRef.current.textContent = `${activeTask.name} moved to ${colLabel}`;
      }
    },
    [activeTask, projectId, updateStatus, COLUMNS, phaseOrder, phaseReorder, workshopMode],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverCell(null);
  }, []);

  const handleMenuMove = useCallback(
    (task: Task, newStatus: TaskStatus) => {
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
    [projectId, updateStatus, COLUMNS, showWip, totalByStatus],
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
      const visibleColumns = COLUMNS.map((c) => c.status);
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
    [COLUMNS, focusedColumn, focusedPhaseId, phases, phaseTaskMap],
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

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex flex-col h-full overflow-hidden">
          {/* Board toolbar — calm refactor (issue #382, epic #361 child B). */}
          <CalmToolbar
            projectId={projectId}
            projectName={projectDetail?.name}
            activeCount={committedTasks.filter((t) => !t.isSummary).length}
            backlogCount={backlogTasks.length}
            currentViewConfig={currentViewConfig}
            activeViewId={activeViewId}
            onApplyView={applyViewConfig}
            groupBy="Phase (WBS rollup)"
            sort={sort}
            onSortChange={setSort}
            density={density}
            onDensityChange={setDensity}
            backlogDensity={toolbarPrefs.backlogDensity}
            onBacklogDensityChange={toolbarPrefs.setBacklogDensity}
            layout={toolbarPrefs.layout}
            onLayoutChange={toolbarPrefs.setLayout}
            myTasksEnabled={myTasksFilter.enabled}
            myTasksLoading={myTasksFilter.isLoading}
            onMyTasksToggle={() => myTasksFilter.setEnabled(!myTasksFilter.enabled)}
            riskLinkedOnly={riskLinkedOnly}
            onRiskLinkedToggle={() => setRiskLinkedOnly((v) => !v)}
            showCost={showCost}
            onShowCostToggle={() => setShowCost((v) => !v)}
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
                text-brand-primary-dark dark:text-brand-primary"
              role="status"
            >
              <span aria-hidden="true">★</span>
              <span>Filter: My tasks</span>
              <button
                type="button"
                onClick={() => myTasksFilter.setEnabled(false)}
                className="ml-1 underline hover:no-underline
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded"
              >
                Show all →
              </button>
            </div>
          )}

          {/* Body — backlog surface (rail | drawer | queue) + scrolling phase
              grid. The rail sits left of the grid (flex-row); the drawer sits
              above it (flex-col, full width); the queue replaces both.
              Layout is persisted via `useBoardToolbarPrefs` (ADR-0057 / epic #361). */}
          {toolbarPrefs.layout === 'queue' && (
            <QueueLayout
              tasks={queueTasks}
              phaseNameFor={(parentId) => phaseNameMap.get(parentId ?? 'root') ?? 'Project'}
              phaseColorFor={(parentId) => (parentId ? phaseColor(parentId) : phaseColor('root'))}
              focusedCardId={focusedCardId}
              onCardFocus={handleCardFocus}
              onCardClick={handleCardClick}
              header={
                projectId ? (
                  <SprintPanel projectId={projectId} methodology={projectDetail?.methodology} />
                ) : null
              }
            />
          )}
          {toolbarPrefs.layout === 'drawer' && (
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
          {toolbarPrefs.layout !== 'queue' && (
            <div className="flex-1 flex flex-row min-h-0">
              {toolbarPrefs.layout === 'rail' && (
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
                />
              )}

              {/* Board grid — scrollable */}
              <div className="flex-1 overflow-auto min-h-0 bg-neutral-surface-sunken">
                {/* Active-sprint summary (ADR-0073) — rendered inside the scroll
                container so the burndown / velocity charts scroll away with
                the board instead of permanently consuming vertical space.
                Hidden entirely on WATERFALL projects and on projects with
                no active sprint. */}
                {projectId && (
                  <SprintPanel projectId={projectId} methodology={projectDetail?.methodology} />
                )}
                {/* Sticky column headers */}
                <div
                  className="grid gap-2 px-2 py-1.5 border-b-2 border-neutral-border/60 bg-neutral-surface sticky top-0 z-10"
                  style={{ gridTemplateColumns: `188px repeat(${COLUMNS.length}, minmax(0, 1fr))` }}
                >
                  <div className="text-xs uppercase tracking-wide text-neutral-text-disabled px-2">
                    Phase
                  </div>
                  {COLUMNS.map((col) => {
                    const count = totalByStatus[col.status];
                    const state = showWip ? wipState(count, col.wipLimit) : 'none';
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
                        className={`flex items-center gap-2 px-2 ${headerTint}`}
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
                            state === 'over'
                              ? `${col.label}, ${count} task${count !== 1 ? 's' : ''}, over limit`
                              : state === 'at'
                                ? `${col.label}, ${count} task${count !== 1 ? 's' : ''}, at limit`
                                : `${col.label}, ${count} task${count !== 1 ? 's' : ''}`
                          }
                        >
                          {col.label}
                        </h2>
                        <span className="text-xs text-neutral-text-disabled tppm-mono">
                          {count}
                        </span>
                        {showWip && col.wipLimit != null && (
                          <span className="ml-auto">
                            <WipBadge count={count} limit={col.wipLimit} />
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Phase lanes */}
                {(() => {
                  const filteredPhases = sortedPhases.filter((phase) => {
                    const phaseCells = phaseTaskMap.get(phase.id);
                    // After cpOnly / dueSoonDays / mineActive filtering, hide
                    // phases with no visible tasks. Without this the empty-state
                    // branch below can never render — phases would stay even when
                    // every cell has been emptied by the filter.
                    if (cpOnly || dueSoonDays !== null || mineActive) {
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
                    tasksByStatus: phaseTaskMap.get(phase.id) ?? {
                      BACKLOG: [],
                      NOT_STARTED: [],
                      IN_PROGRESS: [],
                      REVIEW: [],
                      ON_HOLD: [],
                      COMPLETE: [],
                    },
                    milestones: milestonesByPhase.get(phase.id) ?? [],
                    overCell,
                    isDragActive: activeId !== null,
                    showWip,
                    showColTints,
                    density,
                    collapsed: collapsedIds.has(phase.id),
                    onToggleCollapse: () => toggleCollapse(phase.id),
                    onMenuMove: handleMenuMove,
                    onAddTask: handleAddTask,
                    focusedCardId,
                    highlightedTaskIds,
                    overallocByResourcePerTask,
                    onCardFocus: handleCardFocus,
                    onShowDeps: handleShowDeps,
                    onShowRisks: handleShowRisks,
                    onChainHover: handleChainHover,
                    onCardClick: handleCardClick,
                    onOpenMilestone: (t: Task) => {
                      handleCardFocus(t.id, t.status, t.parentId ?? 'root');
                    },
                    showEvm: evmMode,
                    showCost,
                    scopeActions,
                    workshop: workshopMode,
                    onPhaseRename: workshopMode ? handlePhaseRename : undefined,
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
                                className="border border-brand-primary/40 rounded px-4 py-2 text-sm
                              text-brand-primary-dark dark:text-brand-primary font-medium
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
                              className="border border-dashed border-neutral-border rounded px-3 py-1.5 text-xs
                            text-neutral-text-secondary hover:border-brand-primary/40
                            hover:text-brand-primary-dark dark:hover:text-brand-primary
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
                            className="border border-brand-primary/40 rounded px-3 py-1.5 text-xs
                          text-brand-primary-dark dark:text-brand-primary font-medium
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
        </div>

        {/* Drag overlay — floating card follows the pointer */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <BoardCard task={activeTask} isOverlay onMenuMove={() => {}} columns={COLUMNS} />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Mobile FAB — creates task in the first visible column (rule 104) */}
      <button
        type="button"
        className="fixed bottom-16 right-4 w-14 h-14 rounded-full bg-brand-primary
          border border-brand-primary-dark text-white flex items-center justify-center
          text-2xl font-light md:hidden z-10
          focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2
          focus-visible:ring-offset-brand-primary"
        aria-label="Add task"
      >
        +
      </button>

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
          defaultStatus={addTaskPhase.isSynthetic ? 'BACKLOG' : 'NOT_STARTED'}
          isMobile={isMobile}
          onClose={() => setAddTaskPhase(null)}
        />
      )}

      {/* Board batch 3 overlays — at most one open at a time. */}
      {showCheatsheet && <KeyboardCheatsheet onClose={() => setShowCheatsheet(false)} />}
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
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
          <div className="bg-neutral-surface border border-neutral-border rounded-lg p-6 max-w-sm w-full mx-4">
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
                className="border border-neutral-border rounded px-3 py-1.5 text-xs
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
                className="border border-semantic-critical/40 rounded px-3 py-1.5 text-xs
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
