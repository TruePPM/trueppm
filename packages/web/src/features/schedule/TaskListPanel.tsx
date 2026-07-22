import { useCallback, useRef, useState, useEffect, useMemo, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Task } from '@/types';
import { ROW_HEIGHT } from './scheduleConstants';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { useScheduleStore } from '@/stores/scheduleStore';
import { TaskListHeader } from './TaskListHeader';
import { TaskListRow } from './TaskListRow';
import type { PhasePlannedBadge } from './plannedByPhase';

/** Derive WBS nesting level from the dot-separated wbs string (e.g. '1.2.3' → level 3) */
function wbsLevel(wbs: string): number {
  return wbs.split('.').length;
}

/** WBS parent path: '1.2.3' → '1.2', '1' → '' */
function wbsParent(wbs: string): string {
  const parts = wbs.split('.');
  return parts.slice(0, -1).join('.');
}

/**
 * Same-level sibling ids for every task, keyed by task id, in one O(n) pass.
 *
 * WHY: computing this per task by filtering all tasks was O(n²) — ~1M
 * String.split comparisons at 1K tasks, rebuilt on every [tasks] identity
 * change (every refetch / WS splice) (issue 1522). A task's WBS parent path
 * uniquely encodes its level (level = parent-segment-count + 1), so grouping
 * ids by `wbsParent` alone reproduces the exact "same level AND same parent"
 * sibling set. Each task's sibling list is its own group — self included, in
 * task order — matching the previous per-task filter semantics.
 */
export function buildSiblingIdsMap(tasks: Task[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const task of tasks) {
    const parentPath = wbsParent(task.wbs);
    const group = groups.get(parentPath);
    if (group) group.push(task.id);
    else groups.set(parentPath, [task.id]);
  }
  const map = new Map<string, string[]>();
  for (const task of tasks) map.set(task.id, groups.get(wbsParent(task.wbs)) ?? []);
  return map;
}

/** Ancestor summary tasks for a milestone, closest first (up to 3 levels). */
function computeMilestoneParents(
  task: Task,
  allTasks: Task[],
): { name: string; finish?: string }[] {
  const wbsByTask = new Map(allTasks.map((t) => [t.wbs, t]));
  const parts = task.wbs.split('.');
  const parents: { name: string; finish?: string }[] = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    const parentWbs = parts.slice(0, i).join('.');
    const parent = wbsByTask.get(parentWbs);
    if (parent) parents.push({ name: parent.name, finish: parent.finish || undefined });
  }
  return parents.slice(0, 3);
}

/** Deduplicated task name list: milestones first, then all others. */
function computeNameSuggestions(tasks: Task[]): string[] {
  const milestoneNames = tasks.filter((t) => t.isMilestone).map((t) => t.name);
  const otherNames = tasks.filter((t) => !t.isMilestone).map((t) => t.name);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of [...milestoneNames, ...otherNames]) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// PendingTaskRow — shown for tasks created but not yet scheduled (no dates yet)
// ---------------------------------------------------------------------------

function PendingTaskRow({ name }: { name: string }) {
  const [timedOut, setTimedOut] = useState(false);

  // After 8 s without the scheduler responding, swap spinner for a "Pending" label
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      role="row"
      aria-label={`${name}, pending scheduling`}
      className="flex items-center h-[28px] px-2 gap-1 border-b border-neutral-800/50
        bg-white/5 border-l-2 border-brand-primary/40"
      style={{ height: ROW_HEIGHT }}
    >
      {/* Empty checkbox column */}
      <span className="w-6 flex-shrink-0" />
      {/* WBS placeholder */}
      <span className="w-8 flex-shrink-0 text-xs font-mono text-neutral-text-disabled text-right pr-1">
        —
      </span>
      {/* Name */}
      <span className="flex-1 min-w-0 text-xs text-neutral-text-secondary italic truncate pr-2">
        {name}
      </span>
      {/* Scheduling indicator */}
      <span className="flex items-center gap-1 flex-shrink-0 text-xs text-neutral-text-secondary pr-1">
        {timedOut ? (
          <span className="text-semantic-at-risk">Pending schedule</span>
        ) : (
          <>
            <span
              role="status"
              aria-label="Scheduling in progress"
              className="inline-block w-2.5 h-2.5 rounded-full border-2 border-current border-t-transparent animate-spin"
            />
            Scheduling…
          </>
        )}
      </span>
    </div>
  );
}

/** Per-task dep-chip data — computed in ScheduleView, passed down for focus mode. */
export interface TaskDepChips {
  predsCount: number;
  succsCount: number;
  predsCritical: boolean;
  succsCritical: boolean;
}

interface Props {
  tasks: Task[];
  /** Map of taskId → taskName for tasks pending scheduler assignment. */
  pendingTaskIds?: Map<string, string>;
  scrollRef: RefObject<HTMLDivElement | null>;
  widths: ColumnWidths['widths'];
  visible: ColumnWidths['visible'];
  setWidth: ColumnWidths['setWidth'];
  totalWidth: number;
  /** Set of task IDs that have children (are summary tasks). */
  summaryIds: Set<string>;
  /** Set of expanded task IDs for collapse/expand. */
  expandedIds: Set<string>;
  /** Toggle expand/collapse for a task. */
  onToggle: (id: string) => void;
  /**
   * When non-empty, tasks NOT in this set are dimmed to 22% (focus mode).
   * An empty/undefined set means focus mode is off.
   */
  focusChainIds?: Set<string>;
  /**
   * Per-task dep-chip data — shown on the selected task row when focus mode is on.
   */
  depChipsById?: Map<string, TaskDepChips>;
  /** Hover-chain callback (#475) — forwarded to each row. */
  onHoverChange?: (taskId: string | null) => void;
  /** Currently hovered task id (shared with the canvas) — the matching row gets a
   *  wash so the table row and its bar read as one unit (#2096). */
  hoveredTaskId?: string | null;
  /** Dependency picker entry-point (#477) — forwarded to each row's right-click menu. */
  onAddDependencyRequest?: (taskId: string, mode: 'predecessor' | 'successor') => void;
  /**
   * Sprint lookup by id — used by each row's Duplicate action to render the
   * "Added to Sprint X · Undo" toast only when the source sprint is ACTIVE.
   */
  sprintsById?: Map<string, { id: string; name: string; state: string }>;
  /**
   * Rows created via "+ Phase" (issue #1754) that have no structural child
   * yet — each renders the ghost "Add first task to this phase" affordance
   * instead of being indistinguishable from any other childless task.
   */
  phaseInWaitingIds?: Set<string>;
  /** Creates the phase's first structural child (issue #1754). */
  onAddPhaseFirstChild?: (phaseTaskId: string) => void;
  /**
   * Task id that should drop straight into the inline rename input on mount
   * (issue #1754's "+ Phase" flow, outside Build Mode — see ScheduleView's
   * `pendingAutoEditId` comment). Null/undefined most of the time.
   */
  autoEditTaskId?: string | null;
  /** The row matching `autoEditTaskId` calls this once it has started editing. */
  onAutoEditConsumed?: () => void;
  /**
   * Per-phase "N planned" badge model (#1798) — keyed by summary task id. A
   * phase row whose subtree holds sprint-assigned backlog renders the muted
   * badge; a phase with no such work is simply absent from the map.
   */
  plannedByPhase?: Map<string, PhasePlannedBadge>;
}

export function TaskListPanel({
  tasks,
  pendingTaskIds,
  scrollRef,
  widths,
  visible,
  setWidth,
  totalWidth,
  summaryIds,
  expandedIds,
  onToggle,
  focusChainIds,
  depChipsById,
  onHoverChange,
  hoveredTaskId,
  onAddDependencyRequest,
  sprintsById,
  phaseInWaitingIds,
  onAddPhaseFirstChild,
  autoEditTaskId,
  onAutoEditConsumed,
  plannedByPhase,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollToTaskId = useScheduleStore((s) => s.scrollToTaskId);
  const scrollToTask = useScheduleStore((s) => s.scrollToTask);

  // Derived maps computed once per tasks change — passed to each row for #343/#345/#347
  const siblingIdsMap = useMemo(() => buildSiblingIdsMap(tasks), [tasks]);

  // Per-task sibling NAMES (not just ids) — used by the Duplicate action to
  // suffix "(copy)" uniquely without collisions. Cached once per tasks change.
  const siblingNamesMap = useMemo(() => {
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const map = new Map<string, string[]>();
    for (const task of tasks) {
      const sibIds = siblingIdsMap.get(task.id) ?? [];
      map.set(task.id, sibIds.map((id) => taskById.get(id)?.name ?? '').filter(Boolean));
    }
    return map;
  }, [tasks, siblingIdsMap]);

  const nameSuggestions = useMemo(() => computeNameSuggestions(tasks), [tasks]);

  const milestoneParentsMap = useMemo(() => {
    const map = new Map<string, { name: string; finish?: string }[]>();
    for (const task of tasks) {
      if (task.isMilestone) map.set(task.id, computeMilestoneParents(task, tasks));
    }
    return map;
  }, [tasks]);

  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  // Roving-tabindex model for the grid rows (#2204), mirroring ScheduleAriaOverlay:
  // exactly ONE row is Tab-reachable at a time so the grid is a single tab stop
  // rather than dozens. `activeRowId` follows keyboard/click focus; until the user
  // has focused a row it falls back to the first task, so Tab always lands on a
  // real row (WCAG 2.1.1). Arrow Up/Down move the stop via each row's own focus
  // traversal (its onFocus reports back here); Home/End jump to the edges below.
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const activeRowIdResolved = activeRowId ?? tasks[0]?.id ?? null;

  // Deferred focus target for Home/End: the edge row is often outside the
  // virtualized window, so we scroll to it and focus once it mounts. Mirrors the
  // overlay's pendingFocusRef + no-deps effect.
  const pendingFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
    if (el) {
      pendingFocusRef.current = null;
      el.focus();
    }
  });

  // Home/End: move the roving stop to the first/last row, scrolling it into the
  // virtualized window first. The row's onFocus updates `activeRowId`, so the
  // stop persists after the jump.
  const focusEdgeRow = useCallback(
    (edge: 'first' | 'last') => {
      if (tasks.length === 0) return;
      const idx = edge === 'first' ? 0 : tasks.length - 1;
      const id = tasks[idx].id;
      setActiveRowId(id);
      virtualizer.scrollToIndex(idx, { align: edge === 'first' ? 'start' : 'end' });
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
      if (el) el.focus();
      else pendingFocusRef.current = id; // focus once the row mounts (effect above)
    },
    [tasks, virtualizer, scrollRef],
  );

  // Scroll-to-task: triggered by badge popover navigation (issue #32)
  useEffect(() => {
    if (!scrollToTaskId) return;
    const idx = tasks.findIndex((t) => t.id === scrollToTaskId);
    if (idx !== -1) virtualizer.scrollToIndex(idx, { align: 'center' });
    scrollToTask(null);
  }, [scrollToTaskId, tasks, virtualizer, scrollToTask]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      style={{ width: totalWidth }}
      className="flex flex-col flex-shrink-0 border-r border-neutral-border h-full bg-neutral-surface"
      role="grid"
      aria-label="Task list"
      // Header row (row 1) + one row per task, so the count and the 1-based
      // aria-rowindex on each data row (which starts at 2) stay consistent (#2204).
      aria-rowcount={tasks.length + 1}
    >
      <TaskListHeader widths={widths} visible={visible} setWidth={setWidth} />

      {/*
        Scrollable virtualized rows. The scroll wrapper, the sizer, and each
        row's absolute-positioning wrapper are pure layout — mark them
        role="presentation" so they don't sever the grid → row ownership the
        way a bare unroled div between role="grid" and role="row" would (#2204).
      */}
      <div
        ref={scrollRef}
        role="presentation"
        className="flex-1 overflow-y-auto overflow-x-hidden"
        style={{ contain: 'strict' }}
      >
        <div
          ref={containerRef}
          role="presentation"
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
        >
          {items.map((virtualRow) => {
            const task = tasks[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                role="presentation"
                style={{
                  position: 'absolute',
                  top: virtualRow.start,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                }}
              >
                <TaskListRow
                  task={task}
                  // Header is row 1, so data rows are 1-based from 2 (#2204).
                  ariaRowIndex={virtualRow.index + 2}
                  isActiveRow={task.id === activeRowIdResolved}
                  onRowFocus={setActiveRowId}
                  onFocusEdge={focusEdgeRow}
                  level={wbsLevel(task.wbs)}
                  widths={widths}
                  visible={visible}
                  hasChildren={summaryIds.has(task.id)}
                  isExpanded={expandedIds.has(task.id)}
                  onToggleId={onToggle}
                  prevTaskId={virtualRow.index > 0 ? tasks[virtualRow.index - 1].id : null}
                  nextTaskId={
                    virtualRow.index < tasks.length - 1 ? tasks[virtualRow.index + 1].id : null
                  }
                  dimmed={
                    focusChainIds !== undefined &&
                    focusChainIds.size > 0 &&
                    !focusChainIds.has(task.id)
                  }
                  depChips={depChipsById?.get(task.id)}
                  siblingIds={siblingIdsMap.get(task.id)}
                  siblingNames={siblingNamesMap.get(task.id)}
                  nameSuggestions={nameSuggestions}
                  milestoneParents={milestoneParentsMap.get(task.id)}
                  onHoverChange={onHoverChange}
                  isHovered={hoveredTaskId === task.id}
                  onAddDependencyRequest={onAddDependencyRequest}
                  sourceSprint={task.sprintId ? (sprintsById?.get(task.sprintId) ?? null) : null}
                  phaseInWaiting={phaseInWaitingIds?.has(task.id) ?? false}
                  onAddPhaseFirstChild={onAddPhaseFirstChild}
                  startInlineEditOnMount={autoEditTaskId === task.id}
                  onAutoEditConsumed={onAutoEditConsumed}
                  plannedBadge={plannedByPhase?.get(task.id)}
                />
              </div>
            );
          })}
        </div>

        {/* Pending rows — non-virtualised; appear below scheduled tasks until CPM runs */}
        {pendingTaskIds && pendingTaskIds.size > 0 && (
          <div role="presentation">
            {Array.from(pendingTaskIds.entries()).map(([id, name]) => (
              <PendingTaskRow key={id} name={name} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
