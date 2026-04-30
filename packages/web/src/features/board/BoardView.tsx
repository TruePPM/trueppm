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
import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
import { useUpdateTaskStatus } from '@/hooks/useBoardTasks';
import { useBoardConfig } from '@/hooks/useBoardConfig';
import { useBoardKeyboard } from '@/hooks/useBoardKeyboard';
import { useBoardOverallocation } from '@/hooks/useBoardOverallocation';
import { type BoardSortKey, type BoardViewConfig } from '@/hooks/useBoardSavedViews';
import { useTaskDependencies } from '@/hooks/useTaskDependencies';
import { useWorkshopSession, useStartWorkshop, useEndWorkshop } from '@/hooks/useWorkshopSession';
import { usePhaseReorder } from '@/hooks/usePhaseReorder';
import { useWorkshopSocket } from '@/hooks/useWorkshopSocket';
import { useCreateTask, useUpdateTask } from '@/hooks/useTaskMutations';
import type { Task, TaskStatus } from '@/types';
import { BoardCard, type BoardDensity, type EvmMode } from './BoardCard';
import { BoardViewDropdown } from './BoardViewDropdown';
import { LaneMeta } from './LaneMeta';
import { WorkshopBanner } from './WorkshopBanner';
import { AddTaskModal } from './AddTaskModal';
import { PhaseMilestoneRail } from './PhaseMilestoneRail';
import { KeyboardCheatsheet } from './KeyboardCheatsheet';
import { BoardSettingsPanel } from './BoardSettingsPanel';
import { DepPopover } from './DepPopover';
import { RiskPopover } from './RiskPopover';
import { phaseColor } from './phaseColors';

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
  id: string;     // summary task ID, or 'root' for ungrouped
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
  if (tasks.length === 0) return 0;
  return Math.round(tasks.reduce((s, t) => s + t.progress, 0) / tasks.length);
}

// ---------------------------------------------------------------------------
// WIP badge
// ---------------------------------------------------------------------------

interface WipBadgeProps {
  count: number;
  limit: number | null | undefined;
}

function WipBadge({ count, limit }: WipBadgeProps) {
  if (limit == null) {
    return (
      <span className="ml-1.5 text-xs text-neutral-text-disabled font-medium">
        {count}
      </span>
    );
  }
  const over = count > limit;
  return (
    <span
      className={[
        'ml-1.5 text-xs font-medium px-1 py-0.5 rounded border',
        over
          ? 'bg-semantic-at-risk/10 border-semantic-at-risk/40 text-semantic-at-risk'
          : 'bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary',
      ].join(' ')}
      aria-label={`${count} tasks${limit !== undefined ? `, WIP limit ${limit}${over ? ', over limit' : ''}` : ''}`}
    >
      {count} · WIP {limit}{over ? ' ⚠' : ''}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Phase summary chips
// ---------------------------------------------------------------------------

function PhaseSummaryChips({ phase }: { phase: Phase }) {
  const cpCount = phase.tasks.filter((t) => t.isCritical).length;
  const doneCount = phase.tasks.filter((t) => t.status === 'COMPLETE').length;
  const allDone = doneCount === phase.tasks.length && phase.tasks.length > 0;

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {allDone && (
        <span className="text-xs px-1 py-px rounded bg-semantic-on-track/10 border border-semantic-on-track/30 text-semantic-on-track font-medium">
          {doneCount} done
        </span>
      )}
      {cpCount > 0 && (
        <span className="text-xs px-1 py-px rounded bg-semantic-critical/10 border border-semantic-critical/30 text-semantic-critical font-medium">
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
  showEvm: EvmMode;
  showCost: boolean;
}

// Subtle status tints per column (issue #211).
// Applied to the resting state only — drag-over overrides with brand-primary/5.
// Done=green/4%, Review=amber/5%, Backlog=disabled-grey/5% (spec: mockups-pages.jsx lines 1095–1108).
const COLUMN_TINT: Partial<Record<TaskStatus, string>> = {
  COMPLETE: 'bg-semantic-on-track/5',
  REVIEW:   'bg-brand-accent/5',
  BACKLOG:  'bg-neutral-text-disabled/5',
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
  showEvm,
  showCost,
}: BoardCellProps) {
  const droppableId = `${phaseId}:${status}`;
  const { setNodeRef } = useDroppable({ id: droppableId });
  const over = isOver && isDragActive;
  const wip = showWip && wipLimit != null && tasks.length > wipLimit;
  const restingBg = showColTints
    ? (COLUMN_TINT[status] ?? 'bg-neutral-surface-sunken')
    : 'bg-neutral-surface-sunken';

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
            showEvm={showEvm}
            showCost={showCost}
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
  columns: { status: TaskStatus; label: string; wipLimit: number | null; color: string | null; slaDays?: number }[];
  tasksByStatus: Record<TaskStatus, Task[]>;
  milestones: Task[];
  overCell: string | null;  // `${phaseId}:${status}` or null
  isDragActive: boolean;
  showWip: boolean;
  showColTints: boolean;
  density: BoardDensity;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  onAddTask: (phaseId: string, phaseName: string) => void;
  focusedCardId: string | null;
  highlightedTaskIds: Set<string> | null;
  overallocByResourcePerTask: Map<string, Map<string, number>>;
  onCardFocus: (taskId: string, status: TaskStatus, phaseId: string) => void;
  onShowDeps: (task: Task) => void;
  onShowRisks: (task: Task) => void;
  onChainHover: (taskId: string | null) => void;
  onOpenMilestone: (task: Task) => void;
  showEvm: EvmMode;
  showCost: boolean;
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
  onOpenMilestone,
  showEvm,
  showCost,
  workshop = false,
  onPhaseRename,
  dragHandleListeners,
}: PhaseLaneProps) {
  const avg = avgProgress(phase.tasks);
  const color = phaseColor(phase.id);
  const colCount = columns.length;

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
  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === '[' && !collapsed) { e.preventDefault(); onToggleCollapse(); }
    if (e.key === ']' && collapsed) { e.preventDefault(); onToggleCollapse(); }
  }, [collapsed, onToggleCollapse]);

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
            railColor={color}
            workshop={workshop}
            onPhaseRename={onPhaseRename ? (name) => onPhaseRename(phase.id, name) : undefined}
            dragHandleListeners={dragHandleListeners}
            onAddTask={() => onAddTask(phase.id, phase.name)}
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
        {collapsed ? (
          columns.map((col) => {
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
        ) : (
          columns.map((col) => (
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
              showEvm={showEvm}
              showCost={showCost}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sortable phase lane — workshop mode drag-to-reorder wrapper
// ---------------------------------------------------------------------------

function SortablePhaseLane(props: PhaseLaneProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `phase:${props.phase.id}` });

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

  const toggle = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, [storageKey]);

  const collapseAll = useCallback((ids: string[]) => {
    const next = new Set(ids);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* ignore */ }
    setCollapsedIds(next);
  }, [storageKey]);

  const expandAll = useCallback(() => {
    try { localStorage.setItem(storageKey, JSON.stringify([])); } catch { /* ignore */ }
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
    } catch { /* ignore */ }
    return 'comfortable';
  });

  // Session-only override applied when the user manually changes density on mobile.
  // Cleared when the viewport grows past md so desktop preference resumes.
  const [mobileOverride, setMobileOverride] = useState<BoardDensity | null>(null);

  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
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

  const setDensity = useCallback((d: BoardDensity) => {
    if (isMobile) {
      setMobileOverride(d);
    } else {
      try { localStorage.setItem(storageKey, d); } catch { /* ignore */ }
      setStoredDensity(d);
    }
  }, [isMobile, storageKey]);

  return { density, setDensity };
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
  const { data: workshopSession } = useWorkshopSession(projectId || null);
  const startWorkshop = useStartWorkshop(projectId || null);
  const endWorkshop = useEndWorkshop(projectId || null);
  const phaseReorder = usePhaseReorder(projectId || null);
  const COLUMNS = rawColumns.filter((c) => c.visible);
  const [searchParams, setSearchParams] = useSearchParams();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overCell, setOverCell] = useState<string | null>(null); // `${phaseId}:${status}`
  const [workshopMode, setWorkshopMode] = useState(false);
  // Open the workshop WS channel while a session is active so participant
  // join/leave events reach the banner in real time.
  useWorkshopSocket(projectId || null, workshopMode && !!workshopSession, () => {});
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const workshopToggleRef = useRef<HTMLButtonElement>(null);
  const [phaseOrder, setPhaseOrder] = useState<string[]>([]);
  const [sort, setSort] = useState<BoardSortKey>('priority');
  const [showWip, setShowWip] = useState(true);
  const [showColTints, setShowColTints] = useState(true);
  const [addTaskPhase, setAddTaskPhase] = useState<{ id: string; name: string } | null>(null);
  const [riskLinkedOnly, setRiskLinkedOnly] = useState(false);
  const [evmMode, setEvmMode] = useState<EvmMode>('off');
  const [showCost, setShowCost] = useState(false);
  // Built-in view filter state (issue #191)
  const [cpOnly, setCpOnly] = useState(false);
  const [dueSoonDays, setDueSoonDays] = useState<number | null>(null);
  // Active saved/built-in view ID — synced to ?view= URL param
  const [activeViewId, setActiveViewId] = useState<string | null>(
    () => searchParams.get('view')
  );
  // Keyboard focus (issue #195) — focused card + last-focused column for L/H traversal.
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [focusedColumn, setFocusedColumn] = useState<TaskStatus | null>(null);
  const [focusedPhaseId, setFocusedPhaseId] = useState<string | null>(null);
  // Overlay state — only one is open at a time.
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [depTask, setDepTask] = useState<Task | null>(null);
  const [riskTask, setRiskTask] = useState<Task | null>(null);
  // Dim non-connected cards (#182) — null means no highlight active.
  const [highlightedTaskIds, setHighlightedTaskIds] = useState<Set<string> | null>(null);
  const [chainHoverTaskId, setChainHoverTaskId] = useState<string | null>(null);
  const ariaLiveRef = useRef<HTMLDivElement>(null);

  // Snapshot of current toolbar state for "Save view" — keeps the dropdown in sync.
  const currentViewConfig: BoardViewConfig = useMemo(() => ({
    sort,
    showWip,
    showColTints,
    evmMode,
    showCost,
    riskLinkedOnly,
    cpOnly: cpOnly || undefined,
    dueSoonDays: dueSoonDays ?? undefined,
  }), [sort, showWip, showColTints, evmMode, showCost, riskLinkedOnly, cpOnly, dueSoonDays]);

  const applyViewConfig = useCallback((config: Partial<BoardViewConfig>, viewId: string | null) => {
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
      setSearchParams((prev: URLSearchParams) => { prev.set('view', viewId); return prev; }, { replace: true });
    } else {
      setSearchParams((prev: URLSearchParams) => { prev.delete('view'); return prev; }, { replace: true });
    }
  }, [setSearchParams]);

  const { collapsedIds, toggle: toggleCollapse, collapseAll, expandAll } = useBoardCollapsedLanes(projectId);
  const { density, setDensity } = useBoardDensity();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const createTask = useCreateTask(projectId || null);
  const phases = useMemo(() => buildPhases(tasks ?? [], workshopMode), [tasks, workshopMode]);

  const handleAddPhase = useCallback(() => {
    const name = `Phase ${phases.filter((p) => p.id !== 'root').length + 1}`;
    createTask.mutate({ name, duration: 0, parent_id: null });
  }, [createTask, phases]);

  // Keep phaseOrder in sync with server data; only reset when the phase set changes.
  const phaseIdKey = phases.map((p) => p.id).join(',');
  useEffect(() => {
    setPhaseOrder(phases.map((p) => p.id));
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
  }, [chainHoverTaskId, chainHoverDeps.isLoading, chainHoverDeps.predecessors, chainHoverDeps.successors]);

  const activeTask = useMemo(
    () => (activeId ? tasks?.find((t) => t.id === activeId) ?? null : null),
    [activeId, tasks],
  );

  const focusedTask = focusedCardId ? taskIndex.get(focusedCardId) : null;

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
        if (cpOnly && !task.isCritical) continue;
        if (dueSoonDays !== null) {
          const finish = new Date(task.finish);
          const diffMs = finish.getTime() - today.getTime();
          if (diffMs < 0 || diffMs > dueSoonDays * 86_400_000) continue;
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
  }, [phases, sort, cpOnly, dueSoonDays]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const overId = event.over?.id;
      if (!overId) { setOverCell(null); return; }
      const cellId = String(overId); // `${phaseId}:${status}`
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

      // Card status change
      const overId = over?.id;
      if (!overId || !activeTask) return;
      const [, newStatus] = String(overId).split(':');
      if (!newStatus || newStatus === activeTask.status) return;
      updateStatus.mutate({ projectId, taskId: activeTask.id, status: newStatus as TaskStatus });
      if (ariaLiveRef.current) {
        const colLabel = COLUMNS.find((c) => c.status === newStatus)?.label ?? newStatus;
        ariaLiveRef.current.textContent = `${activeTask.name} moved to ${colLabel}`;
      }
    },
    [activeTask, projectId, updateStatus, COLUMNS, phaseOrder, phaseReorder],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverCell(null);
  }, []);

  const handleMenuMove = useCallback(
    (task: Task, newStatus: TaskStatus) => {
      updateStatus.mutate({ projectId, taskId: task.id, status: newStatus });
      if (ariaLiveRef.current) {
        const colLabel = COLUMNS.find((c) => c.status === newStatus)?.label ?? newStatus;
        ariaLiveRef.current.textContent = `${task.name} moved to ${colLabel}`;
      }
    },
    [projectId, updateStatus, COLUMNS],
  );

  const handleAddTask = useCallback((phaseId: string, phaseName: string) => {
    setAddTaskPhase({ id: phaseId, name: phaseName });
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

  const handleShowDeps = useCallback((task: Task) => {
    setRiskTask(null);
    setShowCheatsheet(false);
    setDepTask(task);
    handleCardFocus(task.id, task.status, task.parentId ?? 'root');
  }, [handleCardFocus]);

  const handleShowRisks = useCallback((task: Task) => {
    setDepTask(null);
    setShowCheatsheet(false);
    setRiskTask(task);
    handleCardFocus(task.id, task.status, task.parentId ?? 'root');
  }, [handleCardFocus]);

  const handleChainHover = useCallback((taskId: string | null) => {
    setChainHoverTaskId(taskId);
  }, []);

  const closeAllOverlays = useCallback(() => {
    setDepTask(null);
    setRiskTask(null);
    setShowCheatsheet(false);
  }, []);

  // Keyboard navigation — J/K within column (across phases), L/H across columns
  // within phase (#195).  Wraps; skips empty cells.  See ADR-0035 §Q3.
  const moveFocusInColumn = useCallback((direction: 'up' | 'down') => {
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
      idx = direction === 'down' ? (idx + 1) % flat.length : (idx - 1 + flat.length) % flat.length;
    }
    const next = flat[idx];
    setFocusedCardId(next.taskId);
    setFocusedPhaseId(next.phaseId);
  }, [focusedColumn, focusedCardId, phases, phaseTaskMap]);

  const moveFocusInPhase = useCallback((direction: 'left' | 'right') => {
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
  }, [COLUMNS, focusedColumn, focusedPhaseId, phases, phaseTaskMap]);

  // While any b3 overlay is open, only Esc → onCloseOverlay should fire; nav keys
  // are suppressed.  When AddTaskModal is open, the modal owns the keyboard.
  const b3OverlayOpen = depTask !== null || riskTask !== null || showCheatsheet;

  useBoardKeyboard(
    {
      onMoveCardFocus: b3OverlayOpen ? undefined : moveFocusInColumn,
      onMoveColumnFocus: b3OverlayOpen ? undefined : moveFocusInPhase,
      onShowDeps:
        !b3OverlayOpen && focusedTask ? () => handleShowDeps(focusedTask) : undefined,
      onShowCheatsheet: b3OverlayOpen ? undefined : () => setShowCheatsheet(true),
      onCloseOverlay: b3OverlayOpen ? closeAllOverlays : undefined,
    },
    addTaskPhase === null,
  );

  // Total per-column counts across all phases (for column header WIP badges)
  const totalByStatus = useMemo(() => {
    const counts: Record<TaskStatus, number> = {
      BACKLOG: 0, NOT_STARTED: 0, IN_PROGRESS: 0, REVIEW: 0, ON_HOLD: 0, COMPLETE: 0,
    };
    for (const phase of phases) {
      for (const task of phase.tasks) {
        counts[task.status]++;
      }
    }
    return counts;
  }, [phases]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-text-secondary text-sm">
        Loading board…
      </div>
    );
  }

  const toolbarBtnClass =
    'border border-neutral-border rounded px-2 py-0.5 text-neutral-text-primary ' +
    'hover:bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary ' +
    'focus-visible:outline-none';

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

          {/* Board toolbar */}
          <div className="flex-shrink-0 border-b border-neutral-border bg-neutral-surface px-4 py-2 flex items-center gap-4 text-xs text-neutral-text-secondary flex-wrap">
            {/* View dropdown — issue #191 */}
            <BoardViewDropdown
              projectId={projectId}
              currentConfig={currentViewConfig}
              activeViewId={activeViewId}
              onApply={applyViewConfig}
            />
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              Lane:
              <select className="border border-neutral-border rounded px-1.5 py-0.5 text-neutral-text-primary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none">
                <option>Phase (WBS rollup)</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              Sort:
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as BoardSortKey)}
                className="border border-neutral-border rounded px-1.5 py-0.5 text-neutral-text-primary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
                aria-label="Sort tasks by"
              >
                <option value="priority">Priority rank</option>
                <option value="start_date">Start date</option>
                <option value="percent_complete">% complete</option>
              </select>
            </label>
            {/* Card density — issue #193 */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              Density:
              <select
                value={density}
                onChange={(e) => setDensity(e.target.value as BoardDensity)}
                className="border border-neutral-border rounded px-1.5 py-0.5 text-neutral-text-primary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
                aria-label="Card density"
              >
                <option value="compact">Compact</option>
                <option value="comfortable">Comfortable</option>
                <option value="detailed">Detailed</option>
              </select>
            </label>
            {/* Collapse all / Expand all — issue #190 */}
            <button
              type="button"
              className={toolbarBtnClass}
              onClick={() => collapseAll(phases.map((p) => p.id))}
              aria-label="Collapse all lanes"
            >
              Collapse all
            </button>
            <button
              type="button"
              className={toolbarBtnClass}
              onClick={expandAll}
              aria-label="Expand all lanes"
            >
              Expand all
            </button>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showWip}
                onChange={(e) => setShowWip(e.target.checked)}
                className="accent-brand-primary"
                aria-label="Show WIP limits"
              />
              Show WIP limits
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showColTints}
                onChange={(e) => setShowColTints(e.target.checked)}
                className="accent-brand-primary"
                aria-label="Show column tints"
              />
              Column tints
            </label>
            {/* EVM indicators toggle — SPI/CPI chips (issue #185) */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              EVM:
              <select
                value={evmMode}
                onChange={(e) => setEvmMode(e.target.value as EvmMode)}
                className="border border-neutral-border rounded px-1.5 py-0.5 text-neutral-text-primary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
                aria-label="EVM indicators"
              >
                <option value="off">Off</option>
                <option value="spi">SPI</option>
                <option value="cpi">CPI</option>
                <option value="both">Both</option>
              </select>
            </label>
            {/* Cost toggle — phase row + card cost chips (issue #189) */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showCost}
                onChange={(e) => setShowCost(e.target.checked)}
                className="accent-brand-primary"
                aria-label="Show cost"
              />
              Show cost
            </label>
            {/* Risk-linked filter pill — issue #188 */}
            <button
              type="button"
              onClick={() => setRiskLinkedOnly((v) => !v)}
              aria-pressed={riskLinkedOnly}
              className={[
                'border rounded px-2 py-0.5 inline-flex items-center gap-1',
                'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none',
                riskLinkedOnly
                  ? 'bg-brand-accent/10 border-brand-accent/40 text-brand-accent-dark dark:text-brand-accent'
                  : 'border-neutral-border text-neutral-text-primary hover:bg-neutral-surface-raised',
              ].join(' ')}
            >
              <span aria-hidden="true">⚠</span>
              Risk-linked only
            </button>
            {/* Column settings — issue #170 */}
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className={`${toolbarBtnClass} inline-flex items-center gap-1`}
              aria-label="Open board column settings"
              title="Column settings"
            >
              <span aria-hidden="true">⚙</span>
              Columns
            </button>
            {/* Keyboard shortcuts hint — issue #195 */}
            <button
              type="button"
              onClick={() => setShowCheatsheet(true)}
              className={`${toolbarBtnClass} inline-flex items-center gap-1`}
              aria-label="Show keyboard shortcuts"
              title="Show keyboard shortcuts (?)"
            >
              <kbd className="bg-neutral-surface-raised border border-neutral-border rounded px-1 tppm-mono text-xs">?</kbd>
            </button>

            {/* Workshop mode toggle (ADR-0046) */}
            <button
              ref={workshopToggleRef}
              type="button"
              onClick={() => {
                if (workshopMode) {
                  setShowExitConfirm(true);
                } else {
                  startWorkshop.mutate(undefined, {
                    onSuccess: () => setWorkshopMode(true),
                  });
                }
              }}
              disabled={startWorkshop.isPending}
              aria-pressed={workshopMode}
              className={[
                'border rounded px-2 py-0.5 hidden md:inline-flex items-center gap-1',
                'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none',
                workshopMode
                  ? 'bg-brand-primary/10 border-brand-primary/40 text-brand-primary-dark dark:text-brand-primary'
                  : 'border-neutral-border text-neutral-text-primary hover:bg-neutral-surface-raised',
              ].join(' ')}
              aria-label={workshopMode ? 'Exit workshop mode' : 'Start workshop session'}
            >
              {workshopMode ? '◎ In Workshop' : '◎ Workshop'}
            </button>
          </div>

          {/* Workshop banner — shown when a session is active (ADR-0046) */}
          {workshopMode && workshopSession && (
            <WorkshopBanner
              session={workshopSession}
              onEnd={() => setShowExitConfirm(true)}
              isEnding={endWorkshop.isPending}
            />
          )}

          {/* Board grid — scrollable */}
          <div className="flex-1 overflow-auto min-h-0 bg-neutral-surface-sunken">
            {/* Sticky column headers */}
            <div
              className="grid gap-2 px-2 py-1.5 border-b-2 border-neutral-border/60 bg-neutral-surface sticky top-0 z-10"
              style={{ gridTemplateColumns: `188px repeat(${COLUMNS.length}, minmax(0, 1fr))` }}
            >
              <div className="text-xs uppercase tracking-wide text-neutral-text-disabled px-2">
                Phase
              </div>
              {COLUMNS.map((col) => (
                <div key={col.status} className="flex items-center px-2">
                  <h2
                    className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
                    aria-label={`${col.label}, ${totalByStatus[col.status]} task${totalByStatus[col.status] !== 1 ? 's' : ''}`}
                  >
                    {col.label}
                  </h2>
                  {showWip ? (
                    <WipBadge count={totalByStatus[col.status]} limit={col.wipLimit} />
                  ) : (
                    <span className="ml-1.5 text-xs text-neutral-text-disabled">
                      {totalByStatus[col.status]}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Phase lanes */}
            {(() => {
              const filteredPhases = sortedPhases.filter((phase) => {
                const phaseCells = phaseTaskMap.get(phase.id);
                // After cpOnly/dueSoonDays filtering, hide phases with no visible tasks.
                if (cpOnly || dueSoonDays !== null) {
                  const visibleCount = Object.values(phaseCells ?? {}).reduce(
                    (s: number, arr) => s + (arr as unknown[]).length, 0,
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
                  BACKLOG: [], NOT_STARTED: [], IN_PROGRESS: [], REVIEW: [], ON_HOLD: [], COMPLETE: [],
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
                onOpenMilestone: (t: Task) => {
                  handleCardFocus(t.id, t.status, t.parentId ?? 'root');
                },
                showEvm: evmMode,
                showCost,
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
                          <p className="text-sm">No phases yet. Add your first phase to start planning.</p>
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

        {/* Drag overlay — floating card follows the pointer */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <BoardCard
              task={activeTask}
              isOverlay
              onMenuMove={() => {}}
              columns={COLUMNS}
            />
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

      {/* Per-phase add task modal (issue #208) */}
      {addTaskPhase && (
        <AddTaskModal
          phaseId={addTaskPhase.id}
          phaseName={addTaskPhase.name}
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
        <RiskPopover
          projectId={projectId}
          task={riskTask}
          onClose={() => setRiskTask(null)}
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
    </>
  );
}
