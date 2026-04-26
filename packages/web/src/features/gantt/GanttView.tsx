import { useRef, useCallback, useState, useEffect, useMemo, type PointerEvent } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import type { GanttEngine, GanttScaleData } from './engine';
import { dateToLeft, leftToDate } from './engine';
import { HEADER_HEIGHT, ROW_HEIGHT } from './ganttConstants';
import { useGanttTasks } from '@/hooks/useGanttTasks';
import { useCreateTask, useRescheduleTask } from '@/hooks/useTaskMutations';
import { useGanttStore } from '@/stores/ganttStore';
import { useWbsStore } from '@/stores/wbsStore';
import { useDragCpm } from '@/hooks/useDragCpm';
import { useKeyboardReschedule } from '@/hooks/useKeyboardReschedule';
import { useDragStore } from '@/stores/dragStore';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { buildWbsTree, flattenVisible, collectAllIds } from '@/features/wbs/buildWbsTree';
import { formatToggleAnnouncement } from './wbsAnnouncement';
import { TaskListPanel, type TaskDepChips } from './TaskListPanel';
import { CanvasGanttTimeline } from './CanvasGanttTimeline';
import { ZoomControl } from './ZoomControl';
import { MonteCarloRow } from './MonteCarloRow';
import { MobileMonteCarloCard } from './MobileMonteCarloCard';
import { MilestoneDeltaTooltip } from './MilestoneDeltaTooltip';
import { DateInputPopover } from './DateInputPopover';
import { AddTaskForm, type AddTaskFormHandle } from '@/features/project/AddTaskForm';
import { RecalculatingBadge } from '@/features/project/RecalculatingBadge';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import type { Task } from '@/types';

// ---------------------------------------------------------------------------
// GanttEmptyState — shown when tasks.length === 0 (rule 78)
// ---------------------------------------------------------------------------

function GanttEmptyState() {
  return (
    <div
      role="status"
      className="flex flex-1 h-full items-center justify-center bg-neutral-surface"
    >
      <p className="text-sm text-neutral-text-secondary">No tasks yet. Add a task to get started.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GanttFallbackTable — shown when canvas 2D is not supported (rule 79)
// ---------------------------------------------------------------------------

interface GanttFallbackTableProps {
  tasks: Task[];
}

function GanttFallbackTable({ tasks }: GanttFallbackTableProps) {
  return (
    <div className="flex-1 overflow-auto p-4">
      <table className="w-full text-sm text-neutral-text-primary border-collapse">
        <thead>
          <tr className="border-b border-neutral-border">
            <th className="text-left py-1 pr-4 font-medium">Task</th>
            <th className="text-left py-1 pr-4 font-medium">Start</th>
            <th className="text-left py-1 pr-4 font-medium">Finish</th>
            <th className="text-left py-1 font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className="border-b border-neutral-border/50">
              <td className="py-1 pr-4">{t.name}</td>
              <td className="py-1 pr-4">{t.start}</td>
              <td className="py-1 pr-4">{t.finish}</td>
              <td className="py-1">{t.duration}d</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Canvas support check
// ---------------------------------------------------------------------------

function canvasIsSupported(): boolean {
  try {
    const c = document.createElement('canvas');
    return c.getContext('2d') !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PanelSplitter — drag handle between task list and timeline
// ---------------------------------------------------------------------------

interface PanelSplitterProps {
  currentTaskWidth: number;
  setWidth: (col: 'task', width: number) => void;
}

function PanelSplitter({ currentTaskWidth, setWidth }: PanelSplitterProps) {
  const startXRef = useRef<number | null>(null);
  const startWidthRef = useRef<number>(currentTaskWidth);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = currentTaskWidth;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (startXRef.current === null) return;
    const delta = e.clientX - startXRef.current;
    setWidth('task', startWidthRef.current + delta);
  }

  function onPointerUp() {
    startXRef.current = null;
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize task list panel"
      className="w-1 flex-shrink-0 cursor-col-resize bg-brand-primary/10 hover:bg-brand-primary/60 transition-colors z-10"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

// ---------------------------------------------------------------------------
// GanttView
// ---------------------------------------------------------------------------

export function GanttView() {
  const projectId = useProjectId() ?? null;
  const { tasks: rawTasks, links: rawLinks, isLoading, error } = useGanttTasks();
  const allTasks          = useMemo(() => rawTasks ?? [], [rawTasks]);
  const allLinks          = useMemo(() => rawLinks ?? [], [rawLinks]);
  const { expandedIds, toggle: toggleExpandRaw, expandAll } = useWbsStore();

  // Focus mode and CP-only filter (issue #131)
  const [focusModeEnabled, setFocusModeEnabled] = useState(false);
  const [showCpOnly, setShowCpOnly] = useState(false);

  // Filter links to critical-path only when showCpOnly is active
  const links = useMemo(
    () => (showCpOnly ? allLinks.filter((l) => l.isCritical) : allLinks),
    [allLinks, showCpOnly],
  );

  // aria-live (polite) — drag announcements via DOM ref (rule 30)
  const ariaLiveRef = useRef<HTMLDivElement>(null);
  // aria-live (assertive) — keyboard nudge announcements; must interrupt immediately (rule 53)
  const ariaAssertiveRef = useRef<HTMLDivElement>(null);

  // Build tree and compute visible tasks for collapse/expand
  const { visibleTasks, summaryIds, childCountById } = useMemo(() => {
    if (allTasks.length === 0)
      return {
        visibleTasks: allTasks,
        summaryIds: new Set<string>(),
        childCountById: new Map<string, { name: string; count: number }>(),
      };
    const tree = buildWbsTree(allTasks);
    const sIds = new Set(allTasks.filter((t) => t.isSummary).map((t) => t.id));
    const visible = flattenVisible(tree, expandedIds).map((n) => n.task);
    // Count descendants per summary — used for aria-live announcements
    const counts = new Map<string, { name: string; count: number }>();
    const walk = (nodes: ReturnType<typeof buildWbsTree>): number => {
      let total = 0;
      for (const n of nodes) {
        const descendants = walk(n.children);
        total += 1 + descendants;
        if (n.task.isSummary) counts.set(n.task.id, { name: n.task.name, count: descendants });
      }
      return total;
    };
    walk(tree);
    return { visibleTasks: visible, summaryIds: sIds, childCountById: counts };
  }, [allTasks, expandedIds]);

  // Wrap toggle to announce the new state to the polite aria-live region.
  // Written via DOM ref (rule 30) — avoids a state-driven re-render on every toggle.
  const toggleExpand = useCallback(
    (id: string) => {
      const wasExpanded = expandedIds.has(id);
      toggleExpandRaw(id);
      const meta = childCountById.get(id);
      if (meta && ariaLiveRef.current) {
        ariaLiveRef.current.textContent = formatToggleAnnouncement(
          wasExpanded,
          meta.name,
          meta.count,
        );
      }
    },
    [expandedIds, toggleExpandRaw, childCountById],
  );

  // Auto-expand root-level summary nodes on first load
  useEffect(() => {
    if (allTasks.length === 0) return;
    const tree = buildWbsTree(allTasks);
    const rootSummaryIds = tree.filter((n) => n.task.isSummary).map((n) => n.task.id);
    if (rootSummaryIds.length > 0) {
      expandAll(collectAllIds(tree));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTasks.length]);

  const zoomLevel         = useGanttStore((s) => s.zoomLevel);
  const selectedTaskId    = useGanttStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useGanttStore((s) => s.setSelectedTaskId);
  const selectedTask      = selectedTaskId
    ? (allTasks.find((t) => t.id === selectedTaskId) ?? null)
    : null;

  // Focus chain: all predecessor + successor task IDs reachable from the selected task.
  // Used to dim rows not in the chain when focus mode is on (issue #131).
  const { focusChainIds, depChipsById } = useMemo((): {
    focusChainIds: Set<string> | undefined;
    depChipsById: Map<string, TaskDepChips>;
  } => {
    // Build per-task dep chip data and adjacency lists in a single pass over
    // allLinks — reused by the BFS below so traversal is O(V + E), not O(V · E).
    const chipsById = new Map<string, TaskDepChips>();
    const succs = new Map<string, string[]>();
    const preds = new Map<string, string[]>();
    for (const link of allLinks) {
      const srcChip = chipsById.get(link.sourceId) ?? { predsCount: 0, succsCount: 0, predsCritical: false, succsCritical: false };
      srcChip.succsCount++;
      if (link.isCritical) srcChip.succsCritical = true;
      chipsById.set(link.sourceId, srcChip);

      const tgtChip = chipsById.get(link.targetId) ?? { predsCount: 0, succsCount: 0, predsCritical: false, succsCritical: false };
      tgtChip.predsCount++;
      if (link.isCritical) tgtChip.predsCritical = true;
      chipsById.set(link.targetId, tgtChip);

      (succs.get(link.sourceId) ?? succs.set(link.sourceId, []).get(link.sourceId)!).push(link.targetId);
      (preds.get(link.targetId) ?? preds.set(link.targetId, []).get(link.targetId)!).push(link.sourceId);
    }

    if (!focusModeEnabled || !selectedTaskId) {
      return { focusChainIds: undefined, depChipsById: chipsById };
    }

    // BFS via adjacency maps — visits each node once, each edge twice.
    const chain = new Set<string>([selectedTaskId]);
    const queue = [selectedTaskId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const next of succs.get(id) ?? []) {
        if (!chain.has(next)) {
          chain.add(next);
          queue.push(next);
        }
      }
      for (const prev of preds.get(id) ?? []) {
        if (!chain.has(prev)) {
          chain.add(prev);
          queue.push(prev);
        }
      }
    }
    return { focusChainIds: chain, depChipsById: chipsById };
  }, [focusModeEnabled, selectedTaskId, allLinks]);

  const [showAddForm, setShowAddForm] = useState(false);
  const addFormRef = useRef<AddTaskFormHandle>(null);
  const [showColMenu, setShowColMenu] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);
  const createTask = useCreateTask(projectId);

  // Tracks tasks created but not yet scheduled (null dates filtered from Gantt).
  // Entries are removed when the task appears in the scheduled tasks list.
  const [pendingTaskIds, setPendingTaskIds] = useState<Map<string, string>>(new Map());

  // Remove pending entries once the scheduler assigns them dates
  useEffect(() => {
    if (!rawTasks || pendingTaskIds.size === 0) return;
    const taskIds = new Set(rawTasks.map((t) => t.id));
    setPendingTaskIds((prev) => {
      const next = new Map(prev);
      for (const id of prev.keys()) {
        if (taskIds.has(id)) next.delete(id);
      }
      return next;
    });
  }, [rawTasks, pendingTaskIds.size]);

  const taskListScrollRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<GanttEngine | null>(null);
  // Reactive scales — updated via scales-change so totalCanvasWidth stays in sync
  // when setTasks rebuilds the scale after a project switch or task edit (issue #96).
  const [ganttScales, setGanttScales] = useState<GanttScaleData | null>(null);
  const { widths, visible, setWidth, toggleColumn, totalWidth } = useColumnWidths();

  // Ref to the split-pane container for MilestoneDeltaTooltip positioning (rule 31)
  const timelineContainerRef = useRef<HTMLDivElement>(null);

  // Scrollable container that the canvases sit inside
  const canvasScrollRef = useRef<HTMLDivElement>(null);

  // Ref set true while keyboard reschedule mode is active — read by useDragCpm
  // to prevent its Escape handler from double-cancelling (issue #34)
  const keyboardModeRef = useRef<boolean>(false);

  // Task shown in the date input popover (null = popover closed)
  const [datePopoverTask, setDatePopoverTask] = useState<Task | null>(null);

  // Sync vertical scroll between task list and canvas container
  const isSyncingRef = useRef(false);

  const handleCanvasScroll = useCallback(() => {
    if (isSyncingRef.current) return;
    const canvasContainer = canvasScrollRef.current;
    const taskList = taskListScrollRef.current;
    if (!canvasContainer || !taskList) return;
    isSyncingRef.current = true;
    taskList.scrollTop = canvasContainer.scrollTop;
    isSyncingRef.current = false;
  }, []);

  // Wire task list → canvas vertical scroll sync (rule 10: no row height)
  useEffect(() => {
    const taskList = taskListScrollRef.current;
    if (!taskList) return;
    const handler = () => {
      if (isSyncingRef.current) return;
      const canvasContainer = canvasScrollRef.current;
      if (!canvasContainer) return;
      isSyncingRef.current = true;
      canvasContainer.scrollTop = taskList.scrollTop;
      isSyncingRef.current = false;
    };
    taskList.addEventListener('scroll', handler, { passive: true });
    return () => taskList.removeEventListener('scroll', handler);
  }, []);

  const handleEngineReady = useCallback((eng: GanttEngine) => {
    setEngine(eng);

    // Initial viewport: today at 25% from left (rule 81)
    const scales = eng.scales;
    const container = canvasScrollRef.current;
    if (scales && container) {
      const today = new Date().toISOString().slice(0, 10);
      const todayX = dateToLeft(today, scales);
      const targetScrollLeft = Math.max(0, todayX - container.clientWidth * 0.25);
      container.scrollLeft = targetScrollLeft;
    }
  }, []);

  // Drag CPM preview — wires engine events + Web Worker (issue #19)
  useDragCpm({
    engine,
    tasks: allTasks,
    links: links ?? [],
    ariaLiveRef,
    keyboardModeRef,
  });

  // Keyboard rescheduling — Enter/Arrow/d/Escape (issue #34)
  const handleOpenDatePopover = useCallback(
    (taskId: string) => {
      const task = allTasks.find((t) => t.id === taskId) ?? null;
      setDatePopoverTask(task);
    },
    [allTasks],
  );

  useKeyboardReschedule({
    engine,
    tasks: allTasks,
    links: links ?? [],
    ariaLiveRef,
    ariaAssertiveRef,
    keyboardModeRef,
    onOpenDatePopover: handleOpenDatePopover,
  });

  // Bar drag — convert canvas-origin left-x to planned_start and PATCH
  const rescheduleTask = useRescheduleTask();
  useEffect(() => {
    if (!engine || !projectId) return;
    return engine.on('drag-task-end', ({ id, left, cancelled }) => {
      if (cancelled) return;
      if (!navigator.onLine) return; // offline case handled by useDragCpm
      const scales = engine.scales;
      if (!scales) return;
      const task = allTasks.find((t) => t.id === id);
      if (!task) return;
      const newStartIso = leftToDate(left, scales).toISOString().slice(0, 10);
      if (newStartIso === task.start) return;
      // Approximate finish keeps the bar width; CPM recomputes the real value
      const newFinishIso = new Date(
        new Date(newStartIso + 'T00:00:00Z').getTime() + task.duration * 86_400_000,
      ).toISOString().slice(0, 10);
      rescheduleTask.mutate({
        id,
        projectId,
        planned_start: newStartIso,
        optimistic: { start: newStartIso, finish: newFinishIso },
      });
    });
  }, [engine, projectId, allTasks, rescheduleTask]);

  // Bar resize — convert canvas-origin right-x to new finish date and PATCH
  useEffect(() => {
    if (!engine || !projectId) return;
    return engine.on('resize-task-end', ({ id, right, cancelled }) => {
      if (cancelled) return;
      const scales = engine.scales;
      if (!scales) return;
      const task = allTasks.find((t) => t.id === id);
      if (!task?.start) return;
      const newFinish = leftToDate(right, scales);
      const newFinishIso = newFinish.toISOString().slice(0, 10);
      const startMs = new Date(task.start + 'T00:00:00Z').getTime();
      const newDuration = Math.max(1, Math.round((newFinish.getTime() - startMs) / 86_400_000));
      if (newDuration === task.duration) return;
      rescheduleTask.mutate({
        id,
        projectId,
        duration: newDuration,
        optimistic: { finish: newFinishIso, duration: newDuration },
      });
    });
  }, [engine, projectId, allTasks, rescheduleTask]);

  const dragPhase = useDragStore((s) => s.phase);

  const timelineTop = timelineContainerRef.current
    ? timelineContainerRef.current.getBoundingClientRect().top
    : 0;

  const handleDatePopoverConfirm = useCallback(
    (newStart: string) => {
      setDatePopoverTask(null);
      const { commitDrag } = useDragStore.getState();
      commitDrag(newStart);
      keyboardModeRef.current = false;
      if (ariaAssertiveRef.current) {
        ariaAssertiveRef.current.textContent = 'Reschedule confirmed.';
      }
    },
    [],
  );

  const handleDatePopoverClose = useCallback(() => {
    setDatePopoverTask(null);
  }, []);

  // Subscribe to scales-change so totalCanvasWidth stays current when tasks update (issue #96)
  useEffect(() => {
    if (!engine) return;
    setGanttScales(engine.scales);
    return engine.on('scales-change', ({ scales }) => setGanttScales(scales));
  }, [engine]);

  // "Today" button handler (rule 82)
  // Close column-visibility menu when clicking outside it
  useEffect(() => {
    if (!showColMenu) return;
    function handleOutsideClick(e: MouseEvent) {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) {
        setShowColMenu(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [showColMenu]);

  const handleScrollToToday = useCallback(() => {
    if (!engine) return;
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    engine.scrollToDate(new Date().toISOString().slice(0, 10), reducedMotion ? 'instant' : 'smooth');
  }, [engine]);

  // Engine scroll → task list sync
  // We pass canvasScrollRef as containerRef for CanvasGanttTimeline.
  // The engine's scroll events come from canvasScrollRef, not the engine.on('scroll').
  // We attach a DOM scroll listener instead.

  // Canvas support check (rule 79)
  const canvasSupported = typeof document !== 'undefined' ? canvasIsSupported() : true;

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-surface">
        <p className="text-sm text-semantic-critical">
          Couldn&apos;t load tasks.{' '}
          <button
            type="button"
            className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </p>
      </div>
    );
  }

  if (isLoading || !rawTasks) {
    return (
      <div className="flex h-full bg-neutral-surface" aria-busy="true" aria-label="Loading Gantt">
        <div className="w-[280px] flex-shrink-0 border-r border-white/10 p-2 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-7 rounded animate-pulse bg-brand-primary/10" />
          ))}
        </div>
        <div className="flex-1 bg-neutral-surface" />
      </div>
    );
  }

  if (!canvasSupported) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-end px-4 h-10 border-b border-neutral-border bg-neutral-surface-raised flex-shrink-0">
          <ZoomControl />
        </div>

        <div className="flex flex-1 overflow-hidden">
          <TaskListPanel
            tasks={visibleTasks}
            scrollRef={taskListScrollRef}
            widths={widths}
            visible={visible}
            setWidth={setWidth}
            totalWidth={totalWidth}
            summaryIds={summaryIds}
            expandedIds={expandedIds}
            onToggle={toggleExpand}
          />
          <GanttFallbackTable tasks={visibleTasks} />
        </div>
      </div>
    );
  }

  const totalCanvasWidth = ganttScales?.totalWidth ?? 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Gantt-specific toolbar — Today + Zoom + Add Task */}
      <div className="flex items-center gap-2 px-4 h-10 border-b border-neutral-border bg-neutral-surface-raised flex-shrink-0">
        {/* "+ Task" button — only shown when a project is selected */}
        {projectId && (
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            aria-label="Add task"
            aria-expanded={showAddForm}
            className="border border-neutral-border rounded h-7 px-3 text-xs font-medium
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
              hover:border-brand-primary hover:text-brand-primary"
          >
            + Task
          </button>
        )}
        <RecalculatingBadge isVisible={pendingTaskIds.size > 0} />

        {/* Focus-mode controls — CP-only filter + chain-dim toggle (issue #131) */}
        <label className="flex items-center gap-1.5 text-xs text-neutral-text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showCpOnly}
            onChange={(e) => setShowCpOnly(e.target.checked)}
            className="accent-brand-primary"
            aria-label="Show critical path only"
          />
          CP only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-neutral-text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={focusModeEnabled}
            onChange={(e) => setFocusModeEnabled(e.target.checked)}
            className="accent-brand-primary"
            aria-label="Focus chain on selected task"
          />
          Focus chain
        </label>

        <div className="flex-1" />

        {/* Column visibility toggle */}
        <div className="relative" ref={colMenuRef}>
          <button
            type="button"
            onClick={() => setShowColMenu((v) => !v)}
            aria-expanded={showColMenu}
            aria-haspopup="menu"
            className="border border-neutral-border rounded h-7 px-3 text-xs font-medium
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
              hover:border-brand-primary hover:text-brand-primary"
          >
            Columns
          </button>
          {showColMenu && (
            <div
              className="absolute right-0 top-8 z-30 bg-neutral-surface border border-neutral-border
                rounded py-1 min-w-[120px]"
              aria-label="Toggle column visibility"
            >
              {(['dur', 'start', 'finish', 'progress'] as const).map((col) => (
                <label
                  key={col}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs text-neutral-text-primary
                    cursor-pointer hover:bg-neutral-surface-raised select-none"
                >
                  <input
                    type="checkbox"
                    checked={visible[col]}
                    onChange={() => toggleColumn(col)}
                    className="accent-brand-primary"
                  />
                  {col === 'dur' ? 'Dur' : col === 'start' ? 'Start' : col === 'finish' ? 'Finish' : '%'}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* "Today" button (rule 82) */}
        <button
          type="button"
          onClick={handleScrollToToday}
          className="border border-neutral-border rounded h-7 px-3 text-xs font-medium focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
        >
          Today
        </button>
        <ZoomControl />
      </div>

      {/* Inline task-creation form — stays open for rapid entry; closed by Cancel/Escape */}
      {showAddForm && (
        <AddTaskForm
          ref={addFormRef}
          isPending={createTask.isPending}
          onSubmit={(name, duration) => {
            createTask.mutate(
              { name, duration },
              {
                onSuccess: (data) => {
                  // Keep form open, clear fields, track as pending until scheduler assigns dates
                  addFormRef.current?.reset();
                  setPendingTaskIds((prev) => new Map(prev).set(data.id, data.name));
                  if (ariaLiveRef.current) {
                    ariaLiveRef.current.textContent =
                      `Task "${data.name}" added — recalculating schedule.`;
                  }
                },
              },
            );
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <div className="flex flex-1 overflow-hidden" ref={timelineContainerRef}>
        <TaskListPanel
          tasks={visibleTasks}
          pendingTaskIds={pendingTaskIds}
          scrollRef={taskListScrollRef}
          widths={widths}
          visible={visible}
          setWidth={setWidth}
          totalWidth={totalWidth}
          summaryIds={summaryIds}
          expandedIds={expandedIds}
          onToggle={toggleExpand}
          focusChainIds={focusChainIds}
          depChipsById={depChipsById}
        />
        {/* Panel splitter — drag to resize task list width */}
        <PanelSplitter currentTaskWidth={widths.task} setWidth={setWidth} />

        {visibleTasks.length === 0 ? (
          <GanttEmptyState />
        ) : (
          <div
            ref={canvasScrollRef}
            className="flex-1 min-w-0 overflow-auto relative"
            onScroll={handleCanvasScroll}
          >
            {/* Scrollable content area sized to the full canvas width.
                minWidth:'100%' ensures the timeline fills the viewport even when
                the task date range is narrower than the available panel width (#92). */}
            <div
              style={{
                width: totalCanvasWidth > 0 ? totalCanvasWidth : '100%',
                minWidth: '100%',
                height: HEADER_HEIGHT + visibleTasks.length * ROW_HEIGHT,
                position: 'relative',
              }}
            >
              {/* Canvas layers fill the viewport.
                  width/height driven by --gantt-vw/vh CSS vars set by the engine
                  on _applyDpr(). Using 100% here would resolve to totalCanvasWidth
                  (the scroll spacer's width), making position:sticky left:0 impossible
                  to satisfy — the element is as wide as its containing block and cannot
                  move left to "stick" (issue #96). */}
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  left: 0,
                  width: 'var(--gantt-vw, 100%)',
                  height: 'var(--gantt-vh, 100%)',
                  pointerEvents: 'none',
                }}
              >
                <CanvasGanttTimeline
                  tasks={visibleTasks}
                  links={links ?? []}
                  zoomLevel={zoomLevel}
                  containerRef={canvasScrollRef}
                  onEngineReady={handleEngineReady}
                />
              </div>
            </div>

          </div>
        )}
      </div>

      <MonteCarloRow engine={engine} taskListWidth={totalWidth} />

      {/* Mobile MC card — md:hidden; desktop uses MonteCarloRow above (issue #33) */}
      <MobileMonteCarloCard projectId={projectId ?? undefined} />

      {/* Milestone delta tooltip — at GanttView level to escape overflow:hidden (rule 31) */}
      <MilestoneDeltaTooltip milestoneLeft={null} timelineTop={timelineTop} />

      {/* Date input popover for keyboard reschedule (issue #34, rule 31 pattern) */}
      <DateInputPopover
        task={datePopoverTask}
        onConfirm={handleDatePopoverConfirm}
        onClose={handleDatePopoverClose}
      />

      {/* aria-live (polite) — drag milestone announcements via DOM ref (rule 30) */}
      <div ref={ariaLiveRef} aria-live="polite" aria-atomic="true" className="sr-only" />

      {/* aria-live (assertive) — keyboard nudge announcements (rule 53) */}
      <div ref={ariaAssertiveRef} aria-live="assertive" aria-atomic="true" className="sr-only" />

      {/* Offline error toast (rule 29) */}
      {dragPhase === 'error' && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded border border-neutral-border bg-neutral-surface text-sm text-neutral-text-primary"
        >
          You&apos;re offline — change not saved.
        </div>
      )}

      {/* Task detail drawer — predecessor/successor management (rule 89 pattern) */}
      {projectId && (
        <TaskDetailDrawer
          task={selectedTask}
          tasks={allTasks}
          links={links ?? []}
          projectId={projectId}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </div>
  );
}

