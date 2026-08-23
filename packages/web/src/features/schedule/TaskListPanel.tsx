import { useCallback, useRef, useState, useEffect, useMemo, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ProjectResource, Task } from '@/types';
import { useRowMetrics } from '@/hooks/useRowHeight';
import {
  resolveOutlineGripReserve,
  resolveOutlineNudgeReserve,
  resolveOutlineLeftReserve,
} from './scheduleConstants';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { useScheduleStore } from '@/stores/scheduleStore';
import { TaskListHeader } from './TaskListHeader';
import { TaskListRow } from './TaskListRow';
import { BlankOutlineDraftRow } from './buildMode/BlankOutlineDraftRow';
import { ScheduleAppendTaskFooter } from './ScheduleAppendTaskFooter';
import type { PhasePlannedBadge } from './plannedByPhase';
import type { RowMode } from './deliveryModePresentation';
import { OutlineDropIndicator } from './OutlineDropIndicator';
import { useOutlineDrag } from './useOutlineDrag';
import type { OutlineDragRow, OutlineMovePlan } from './outlineDrag';

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

/**
 * Ancestor summary tasks for a milestone, closest first (up to 3 levels).
 *
 * Takes the WBS index rather than the task array: building it here made the
 * whole thing O(milestones × tasks) — ~100k Map insertions on a 1000-task plan
 * with 100 gates, rebuilt on every expand/collapse because the memo is keyed on
 * `tasks` identity. Latent while only the Grid mounted this panel; #2960 put it
 * on the Timeline too.
 */
function computeMilestoneParents(
  task: Task,
  wbsByTask: ReadonlyMap<string, Task>,
): { name: string; finish?: string }[] {
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

function PendingTaskRow({ name, leftReserve }: { name: string; leftReserve: number }) {
  const { rowHeight } = useRowMetrics();
  const [timedOut, setTimedOut] = useState(false);

  // After 8 s without the scheduler responding, swap spinner for a "Pending" label
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      role="row"
      // Pending rows aren't placed in the WBS tree yet — level 1 (top of the
      // treegrid) until the scheduler assigns them a real position.
      aria-level={1}
      aria-label={`${name}, pending scheduling`}
      className="flex items-center px-2 gap-1 border-b border-neutral-800/50
        bg-white/5 border-l-2 border-brand-primary/40"
      style={{ height: rowHeight }}
    >
      {leftReserve > 0 && (
        <span aria-hidden="true" className="shrink-0" style={{ width: leftReserve }} />
      )}
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
  /**
   * Rows in each summary's SUBTREE — what the fold caret and the row's own
   * statement render as "N inside" / "N hidden" (#2956, #3025).
   *
   * Descendants, not direct children, and the distinction is the point: folding
   * a phase hides its whole subtree, so "4 hidden" on a phase with two children
   * and two grandchildren is the honest number and "2 hidden" would be a
   * confident wrong one. `ScheduleView`'s `walk()` is where it is counted; this
   * docstring said "direct" for as long as nothing rendered the value, which is
   * how the two got to disagree unnoticed.
   *
   * Optional so callers that do not compute it (the print layout) keep working —
   * a row with no entry states no count rather than claiming zero.
   */
  childCountById?: ReadonlyMap<string, { name: string; count: number }>;
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
  /**
   * Commit the blank-project draft row as a real task (#2733). Omitted for
   * read-only roles — the draft row then renders as a static line rather than an
   * input, because a caret in a field that cannot save is worse than no caret.
   */
  onCommitDraftRow?: (name: string, opts?: { onError?: () => void }) => void;
  /**
   * Project resource roster — the only index the `@owner` authoring token resolves
   * against (ADR-0774, #2718). Owned by ScheduleView, which already runs the project's
   * queries; this panel stays presentational so it is renderable without a query client.
   */
  resourcePool?: ProjectResource[];
  /**
   * Resolved delivery mode per task (#2737), keyed by task id. Computed by
   * ScheduleView with `computeRowModes` over the **whole** task list rather
   * than per row: a phase's mode is a function of its descendants, so a row
   * cannot answer the question from its own fields.
   */
  rowModes?: Map<string, RowMode>;
  /**
   * Open the classification popover on a row (#2736). Omitted outside Author
   * mode / for read-only roles, which removes the row-menu entry entirely.
   */
  onClassifyRequest?: (taskId: string) => void;
  /**
   * Commit a pointer-drag rearrangement (#2954). Owned by `ScheduleView`,
   * because the plan names a *position anchor* and only the view holds every
   * task — the rows this panel renders are the visible ones, and the reorder
   * endpoint rejects a partial sibling list.
   *
   * Absent disables the gesture entirely, which is what keeps this panel
   * renderable without a query client.
   */
  onMoveRow?: (plan: OutlineMovePlan) => void;
  /** Open the "Move to…" destination picker — the drag's no-drag twin (#2954). */
  onMoveToRequest?: (taskId: string) => void;
  /**
   * Polite live-region sink for what the drop would do, spoken as the pointer
   * moves. The visual chip rides the target row; this is the same claim for a
   * reader who is not looking at it.
   */
  onAnnounce?: (sentence: string) => void;
  /**
   * Append a task at the end of the outline, at the TOP level (#2957).
   *
   * Omitted for a reader with no edit rights, which removes the footer row
   * entirely — absence, not a disabled control (web rule 302). An editor who
   * chose Read keeps the row and gets `appendAtEndReadOnly`, because one key
   * gets them back.
   *
   * It is deliberately NOT the same callback as the toolbar's or the row-edge
   * `+`'s: each of the three affordances lands where its own position implies,
   * and collapsing them into one handler is the bug #2957 exists to undo.
   */
  onAppendTaskAtEnd?: () => void;
  /** Read mode (#2949): the footer stays present and inert. */
  appendAtEndReadOnly?: boolean;
  /**
   * Upper bound on the Task column, resolved by the host from the measured split
   * pane and shared with `ScheduleView`'s `PanelSplitter` (#2960).
   *
   * The header's own Task resize handle is a **second writer** of the same
   * persisted `widths.task`, and on the Timeline — where Task is the last
   * column — its 12px hit zone sits directly against the splitter's 4px one. Two
   * controls over one value must enforce and announce the same range, or the
   * narrower one is a decorative promise and the wider one is the escape hatch.
   * Omitted by hosts with no splitter (the no-canvas fallback, the print
   * layout), which fall back to the header's own column ceiling.
   */
  maxTaskWidth?: number;
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
  childCountById,
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
  resourcePool,
  onCommitDraftRow,
  rowModes,
  onClassifyRequest,
  onMoveRow,
  onMoveToRequest,
  onAnnounce,
  onAppendTaskAtEnd,
  appendAtEndReadOnly = false,
  maxTaskWidth,
}: Props) {
  // 28px on a mouse, 44px on a coarse pointer (#2997). This is the DOM half of
  // the pitch the canvas engine paints on; both resolve from one binding.
  const { rowHeight, coarse } = useRowMetrics();
  /**
   * The ⋮⋮ grip's lane (#2997) — panel-level, never per-row.
   *
   * `onMoveRow` is the panel's own "can anything commit a move?" gate, and it is
   * undefined for a read-only viewer and outside build mode. Deriving the lane
   * from it keeps two things true at once: a viewer does not give up 44px of a
   * ~280px name column to a control that is not rendered (web rule 302 makes the
   * apparatus absent, not disabled), and the header, the rows, the pending rows
   * and the draft row all reserve the *same* number — a lane that varies row to
   * row is a table whose columns do not line up.
   *
   * Resolved through the shared helper rather than inline (#2960) because
   * `ScheduleView` has to add the same number to this panel's `totalWidth` and
   * to the canvas overlay offsets — the lane is rendered *inside* the panel's
   * fixed-width box and subtracted from no column.
   */
  const gripReserve = resolveOutlineGripReserve(coarse, onMoveRow !== undefined);
  /**
   * The ⇤/⇥ structural-nudge lane (#3026) — panel-level for exactly the reasons
   * above, and gated on the same question.
   *
   * The pair used to live inside the WBS cell, which made it conditional on
   * `visible.wbs` — a Display ▸ Columns preference. Hiding an unrelated column
   * therefore removed indent and outdent from every row and left right-click as
   * the only pointer route. A lane of its own is the structural fix: a column
   * choice can no longer decide whether a control exists.
   */
  const nudgeReserve = resolveOutlineNudgeReserve(coarse, onMoveRow !== undefined);
  /** Both lanes — what anything positioning against "where the columns start" reads. */
  const leftReserve = resolveOutlineLeftReserve(coarse, onMoveRow !== undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollToTaskId = useScheduleStore((s) => s.scrollToTaskId);
  const scrollToTask = useScheduleStore((s) => s.scrollToTask);

  // Derived maps computed once per tasks change — passed to each row for #343/#345/#347
  const siblingIdsMap = useMemo(() => buildSiblingIdsMap(tasks), [tasks]);

  // Full visible row order (#2727 multi-select) — Shift+↑/↓ selection-extend
  // and ⌘A's "whole tree" expansion are computed against this.
  const visibleTaskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

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

  /**
   * Candidates for the `>predecessor` and `[phase]` authoring tokens (#2722).
   *
   * Derived here rather than fetched, because this panel already holds the whole
   * task list — and scoping both lists to it is what keeps a token from binding
   * across a project boundary the author cannot see. Phases are the summary rows:
   * only a task with children is something another row can be filed under.
   */
  const authoringCandidates = useMemo(
    () => ({
      tasks: tasks.map((t) => ({ id: t.id, name: t.name, wbs: t.wbs ?? '' })),
      phases: tasks
        .filter((t) => summaryIds?.has(t.id) ?? t.isSummary)
        .map((t) => ({ id: t.id, name: t.name })),
    }),
    [tasks, summaryIds],
  );

  const milestoneParentsMap = useMemo(() => {
    const map = new Map<string, { name: string; finish?: string }[]>();
    // One index for the whole pass — see computeMilestoneParents.
    const wbsByTask = new Map(tasks.map((t) => [t.wbs, t]));
    for (const task of tasks) {
      if (task.isMilestone) map.set(task.id, computeMilestoneParents(task, wbsByTask));
    }
    return map;
  }, [tasks]);

  /**
   * The rows the drop model reasons over (#2954) — the *visible* ones, in
   * outline order, which is exactly the set a pointer can land on. Collapsed
   * and filtered-out rows are correctly invisible to the drag: you cannot drop
   * between two rows you cannot see.
   */
  const dragRows = useMemo<OutlineDragRow[]>(
    () =>
      tasks.map((t) => ({
        id: t.id,
        name: t.name,
        wbs: t.wbs,
        parentId: t.parentId ?? null,
        isMilestone: t.isMilestone,
        // The band rule (web rule 309(c)): prefer the server's verdict, fall
        // back to the structural-child test. `isSummary` alone is true for a
        // leaf whose only children are drawer subtasks, and "becomes a phase"
        // must not be suppressed for one of those.
        hasChildren: t.isPhase ?? summaryIds.has(t.id),
      })),
    [tasks, summaryIds],
  );

  const { session: dragSession, startDrag } = useOutlineDrag({
    rows: dragRows,
    rowHeight,
    // Re-read per move: the list scrolls under the pointer, so a cached top is
    // wrong the moment an autoscroll or a wheel event lands.
    getRowsTop: useCallback(
      () => containerRef.current?.getBoundingClientRect().top ?? null,
      [],
    ),
    onMove: onMoveRow,
    announce: onAnnounce,
  });

  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 5,
  });

  // The virtualizer caches every row's measured size, so changing `estimateSize`
  // alone leaves the old pitch in place — rows would keep their 28px offsets
  // while each row's own box grew to 44, and they would overlap. Re-measuring is
  // what actually moves them, and it must happen on a pointer-class flip
  // (a tablet gaining a keyboard), not only on first mount (#2997).
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

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

  // The append-at-the-end footer (#2957) is a real treegrid row, so it counts
  // toward `aria-rowcount`. Suppressed on a blank project: `BlankOutlineDraftRow`
  // already holds the caret there (#2733), and a second "add something" control
  // under a list of one live row is clutter rather than a second place to act.
  const showAppendFooter = onAppendTaskAtEnd !== undefined && tasks.length > 0;

  return (
    <div
      style={{ width: totalWidth }}
      className="flex flex-col flex-shrink-0 border-r border-neutral-border h-full bg-neutral-surface"
      // treegrid, not grid (#2727, ADR-0776 §"Treegrid ARIA"): rows carry a
      // real aria-level (WBS depth) and aria-expanded (summary rows only) —
      // the semantics `grid` doesn't define but `treegrid` does.
      role="treegrid"
      aria-label="Task list"
      // Header row (row 1) + one row per task, so the count and the 1-based
      // aria-rowindex on each data row (which starts at 2) stay consistent (#2204).
      aria-rowcount={tasks.length + 1 + (showAppendFooter ? 1 : 0)}
    >
      <TaskListHeader
        widths={widths}
        visible={visible}
        setWidth={setWidth}
        gripReserve={gripReserve}
        nudgeReserve={nudgeReserve}
        maxTaskWidth={maxTaskWidth}
      />

      {/* Blank project (#2733): the outline opens with a LIVE row and the caret
          already in it, instead of a "No tasks yet" card the user has to get past.
          Rendered here rather than inside the virtualizer because there is nothing
          to virtualize — it is exactly one row, and it must not be unmounted by a
          scroll measurement while somebody is typing into it. */}
      {tasks.length === 0 && (
        <BlankOutlineDraftRow
            onCommit={onCommitDraftRow}
            nameWidth={widths.task}
            leftReserve={leftReserve}
          />
      )}

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
                  height: rowHeight,
                }}
              >
                <TaskListRow
                  gripReserve={gripReserve}
                  nudgeReserve={nudgeReserve}
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
                  childCount={childCountById?.get(task.id)?.count ?? 0}
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
                  visibleTaskIds={visibleTaskIds}
                  siblingNames={siblingNamesMap.get(task.id)}
                  nameSuggestions={nameSuggestions}
                  resourcePool={resourcePool}
                  authoringCandidates={authoringCandidates}
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
                  rowMode={rowModes?.get(task.id)}
                  onClassifyRequest={onClassifyRequest}
                  onOutlineDragStart={onMoveRow ? startDrag : undefined}
                  isDragSource={dragSession?.draggedId === task.id}
                  onMoveToRequest={onMoveToRequest}
                />
              </div>
            );
          })}

          {/* What the drag promises before release (#2954). Inside the sizer so
              its offsets are the same coordinate space the virtual rows use, and
              so it scrolls with them; pointer-events-none and aria-hidden, with
              the claim spoken through the schedule's polite region instead. */}
          {dragSession?.active && (
            <OutlineDropIndicator
              intent={dragSession.intent}
              rows={dragRows}
              draggedId={dragSession.draggedId}
              rowHeight={rowHeight}
              leftInset={leftReserve}
            />
          )}
        </div>

        {/* Pending rows — non-virtualised; appear below scheduled tasks until CPM runs */}
        {pendingTaskIds && pendingTaskIds.size > 0 && (
          <div role="presentation">
            {Array.from(pendingTaskIds.entries()).map(([id, name]) => (
              <PendingTaskRow key={id} name={name} leftReserve={leftReserve} />
            ))}
          </div>
        )}

        {/* Append-at-the-end (#2957). Inside the scroller and after every other
            row on purpose: the control sits at the end of the plan because that
            is where its row lands. It is the last thing you reach by scrolling
            down, which is the same gesture as "put one more at the bottom". */}
        {showAppendFooter && onAppendTaskAtEnd && (
          <ScheduleAppendTaskFooter
            onAppend={onAppendTaskAtEnd}
            readOnly={appendAtEndReadOnly}
            ariaRowIndex={tasks.length + 2}
          />
        )}
      </div>
    </div>
  );
}
