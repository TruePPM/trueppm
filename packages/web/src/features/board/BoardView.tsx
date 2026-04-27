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
import { useState, useEffect, useRef, useCallback, useMemo, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
} from '@dnd-kit/core';
import { useGanttTasks } from '@/hooks/useGanttTasks';
import { useUpdateTaskStatus } from '@/hooks/useBoardTasks';
import { useBoardConfig } from '@/hooks/useBoardConfig';
import type { Task, TaskStatus } from '@/types';
import { BoardCard, type BoardDensity } from './BoardCard';
import { LaneMeta } from './LaneMeta';
import { AddTaskModal } from './AddTaskModal';
import { phaseColor } from './phaseColors';

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
 */
function buildPhases(allTasks: Task[]): Phase[] {
  const summaryById = new Map<string, Task>();
  const summaryOrder: string[] = [];

  for (const t of allTasks) {
    if (t.isSummary) {
      summaryById.set(t.id, t);
      summaryOrder.push(t.id);
    }
  }

  const byPhase = new Map<string, Task[]>();
  const rootTasks: Task[] = [];

  for (const t of allTasks) {
    if (t.isSummary) continue;
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
    .filter((p) => p.tasks.length > 0); // hide empty phases

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
  limit?: number;
}

function WipBadge({ count, limit }: WipBadgeProps) {
  if (limit === undefined) {
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
  wipLimit?: number;
  isDragActive: boolean;
  showColTints: boolean;
  density: BoardDensity;
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  columns: { status: TaskStatus; label: string }[];
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
}: BoardCellProps) {
  const droppableId = `${phaseId}:${status}`;
  const { setNodeRef } = useDroppable({ id: droppableId });
  const over = isOver && isDragActive;
  const wip = showWip && wipLimit !== undefined && tasks.length > wipLimit;
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
          WIP limit: {wipLimit} — {tasks.length - wipLimit} over
        </div>
      )}
      {tasks.map((task) => (
        <BoardCard
          key={task.id}
          task={task}
          density={density}
          onMenuMove={(newStatus) => onMenuMove(task, newStatus)}
          columns={columns}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase lane row
// ---------------------------------------------------------------------------

interface PhaseLaneProps {
  phase: Phase;
  columns: { status: TaskStatus; label: string; wipLimit?: number }[];
  tasksByStatus: Record<TaskStatus, Task[]>;
  overCell: string | null;  // `${phaseId}:${status}` or null
  isDragActive: boolean;
  showWip: boolean;
  showColTints: boolean;
  density: BoardDensity;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  onAddTask: (phaseId: string, phaseName: string) => void;
}

function PhaseLane({
  phase,
  columns,
  tasksByStatus,
  overCell,
  isDragActive,
  showWip,
  showColTints,
  density,
  collapsed,
  onToggleCollapse,
  onMenuMove,
  onAddTask,
}: PhaseLaneProps) {
  const avg = avgProgress(phase.tasks);
  const color = phaseColor(phase.id);
  const colCount = columns.length;

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
            onAddTask={() => onAddTask(phase.id, phase.name)}
            collapseToggle={collapseToggle}
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
            />
          ))
        )}
      </div>
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
  const { columns: rawColumns } = useBoardConfig(projectId || null);
  const { tasks, isLoading } = useGanttTasks();
  const updateStatus = useUpdateTaskStatus();
  const COLUMNS = rawColumns.filter((c) => c.visible);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overCell, setOverCell] = useState<string | null>(null); // `${phaseId}:${status}`
  const [showWip, setShowWip] = useState(true);
  const [showColTints, setShowColTints] = useState(true);
  const [addTaskPhase, setAddTaskPhase] = useState<{ id: string; name: string } | null>(null);
  const ariaLiveRef = useRef<HTMLDivElement>(null);

  const { collapsedIds, toggle: toggleCollapse, collapseAll, expandAll } = useBoardCollapsedLanes(projectId);
  const { density, setDensity } = useBoardDensity();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const phases = useMemo(() => buildPhases(tasks ?? []), [tasks]);

  const activeTask = useMemo(
    () => (activeId ? tasks?.find((t) => t.id === activeId) ?? null : null),
    [activeId, tasks],
  );

  // Per-phase, per-status task groupings
  const phaseTaskMap = useMemo(() => {
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
        byStatus[task.status]?.push(task);
      }
      result.set(phase.id, byStatus);
    }
    return result;
  }, [phases]);

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
      const overId = event.over?.id;
      setActiveId(null);
      setOverCell(null);
      if (!overId || !activeTask) return;
      const [, newStatus] = String(overId).split(':');
      if (!newStatus || newStatus === activeTask.status) return;
      updateStatus.mutate({ projectId, taskId: activeTask.id, status: newStatus as TaskStatus });
      if (ariaLiveRef.current) {
        const colLabel = COLUMNS.find((c) => c.status === newStatus)?.label ?? newStatus;
        ariaLiveRef.current.textContent = `${activeTask.name} moved to ${colLabel}`;
      }
    },
    [activeTask, projectId, updateStatus, COLUMNS],
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

  if (!tasks || tasks.filter((t) => !t.isSummary).length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-text-secondary text-sm" role="status">
        No tasks yet. Create tasks to see them on the board.
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
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              Lane:
              <select className="border border-neutral-border rounded px-1.5 py-0.5 text-neutral-text-primary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none">
                <option>Phase (WBS rollup)</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              Sort:
              <select className="border border-neutral-border rounded px-1.5 py-0.5 text-neutral-text-primary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none">
                <option>Priority rank</option>
                <option>Start date</option>
                <option>% complete</option>
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
          </div>

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
            {phases.map((phase) => (
              <PhaseLane
                key={phase.id}
                phase={phase}
                columns={COLUMNS}
                tasksByStatus={phaseTaskMap.get(phase.id) ?? {
                  BACKLOG: [], NOT_STARTED: [], IN_PROGRESS: [], REVIEW: [], ON_HOLD: [], COMPLETE: [],
                }}
                overCell={overCell}
                isDragActive={activeId !== null}
                showWip={showWip}
                showColTints={showColTints}
                density={density}
                collapsed={collapsedIds.has(phase.id)}
                onToggleCollapse={() => toggleCollapse(phase.id)}
                onMenuMove={handleMenuMove}
                onAddTask={handleAddTask}
              />
            ))}
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
    </>
  );
}
