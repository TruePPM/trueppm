import { useRef, useCallback, useState, useEffect, useMemo, type PointerEvent } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import type { GanttEngine, GanttScaleData } from './engine';
import { dateToLeft, leftToDate } from './engine';
import { HEADER_HEIGHT, ROW_HEIGHT } from './scheduleConstants';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useRescheduleTask } from '@/hooks/useTaskMutations';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useWbsStore } from '@/stores/wbsStore';
import { useDragCpm } from '@/hooks/useDragCpm';
import { useKeyboardReschedule } from '@/hooks/useKeyboardReschedule';
import { useDragStore } from '@/stores/dragStore';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { buildWbsTree, flattenVisible, collectAllIds } from '@/features/grid/buildWbsTree';
import { formatToggleAnnouncement } from './wbsAnnouncement';
import { TaskListPanel, type TaskDepChips } from './TaskListPanel';
import { CanvasScheduleTimeline } from './CanvasScheduleTimeline';
import { ZoomControl } from './ZoomControl';
import { ScheduleToolbarToggle } from './ScheduleToolbarToggle';
import { ScheduleSummaryChip } from './ScheduleSummaryChip';
import { ScheduleAddMilestoneButton } from './ScheduleAddMilestoneButton';
import { MilestonePulseOverlay } from './MilestonePulseOverlay';
import { ScheduleLegend } from './ScheduleLegend';
import { useScheduleKeyboard } from './useScheduleKeyboard';
import { inferNearestSummaryParent } from './inferMilestoneParent';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { MonteCarloRow } from './MonteCarloRow';
import { MonteCarloGanttMarkers } from './MonteCarloGanttMarkers';
import { MobileMonteCarloCard } from './MobileMonteCarloCard';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { MilestoneDeltaTooltip } from './MilestoneDeltaTooltip';
import { DateInputPopover } from './DateInputPopover';
import { TaskFormModal } from '@/features/board/TaskFormModal';
import { RecalculatingBadge } from '@/features/project/RecalculatingBadge';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { UnscheduledGutter } from './UnscheduledGutter';
import { useUnscheduledTasks } from '@/hooks/useUnscheduledTasks';
import type { Task } from '@/types';
import { useFeatureFlag } from '@/lib/featureFlags';
import { useDependencyHover } from './useDependencyHover';
import { ScheduleDependencyPicker } from './ScheduleDependencyPicker';
import { useSprints } from '@/hooks/useSprints';
import {
  useScheduleFocus,
  BuildModeProvider,
  BuildModeHintStrip,
  BuildModeCheatsheet,
  BuildModeEmptyState,
  BuildModePill,
  type BuildModeApi,
} from './buildMode';
import {
  useIndentTask,
  useOutdentTask,
  useUpdateTask,
  useDeleteTask,
  useCreateTask,
} from '@/hooks/useTaskMutations';

// ---------------------------------------------------------------------------
// ScheduleEmptyState — shown when tasks.length === 0 (rule 78)
// ---------------------------------------------------------------------------

function ScheduleEmptyState() {
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
// ScheduleActionToastRenderer — action toast surface for the Duplicate Undo
// affordance (#477) and any future mutation that needs a follow-up button.
// Auto-dismisses on the toast's `durationMs` (default 6000); explicit
// dismissal on Esc and on Undo click.
// ---------------------------------------------------------------------------

function ScheduleActionToastRenderer() {
  const toast = useScheduleStore((s) => s.scheduleActionToast);
  const setToast = useScheduleStore((s) => s.setScheduleActionToast);

  // Auto-dismiss timer — restarts whenever the toast identity changes.
  useEffect(() => {
    if (!toast) return;
    const duration = toast.durationMs ?? 6000;
    const handle = window.setTimeout(() => setToast(null), duration);
    return () => window.clearTimeout(handle);
  }, [toast, setToast]);

  // Dismiss on Escape (consistent with other transient surfaces).
  useEffect(() => {
    if (!toast) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setToast(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toast, setToast]);

  if (!toast) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-14 left-1/2 -translate-x-1/2 z-[60] min-w-[280px] max-w-[420px] px-4 py-2 rounded-md border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary flex items-center gap-3"
    >
      <span className="flex-1">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="text-brand-primary font-medium hover:underline focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none rounded"
          onClick={() => {
            toast.action!.onClick();
            // The handler is responsible for replacing or clearing the toast;
            // if it doesn't replace, fall through to clearing so we don't
            // leave a stuck "Undo" affordance after the action has fired.
            if (useScheduleStore.getState().scheduleActionToast === toast) {
              setToast(null);
            }
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleFallbackTable — shown when canvas 2D is not supported (rule 79)
// ---------------------------------------------------------------------------

interface ScheduleFallbackTableProps {
  tasks: Task[];
}

function ScheduleFallbackTable({ tasks }: ScheduleFallbackTableProps) {
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
// ScheduleView
// ---------------------------------------------------------------------------

export function ScheduleView() {
  const projectId = useProjectId() ?? null;
  const { tasks: rawTasks, links: rawLinks, isLoading, error } = useScheduleTasks();
  const { data: mcResult } = useMonteCarloResult(projectId ?? undefined);
  const allTasks          = useMemo(() => rawTasks ?? [], [rawTasks]);
  const allLinks          = useMemo(() => rawLinks ?? [], [rawLinks]);
  const { expandedIds, toggle: toggleExpandRaw, expandAll } = useWbsStore();

  // Sprint lookup for the Duplicate Undo affordance (#477).
  const { sprints } = useSprints(projectId);
  const sprintsById = useMemo(() => {
    const m = new Map<string, { id: string; name: string; state: string }>();
    for (const s of sprints) m.set(s.id, { id: s.id, name: s.name, state: s.state });
    return m;
  }, [sprints]);

  // Hover-chain state (#475) — driven by TaskListRow.onMouseEnter / onFocus.
  // `useDependencyHover` coalesces through rAF and resolves predecessor +
  // successor sets via BFS over the unfiltered link graph.
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const hoverChain = useDependencyHover(hoveredTaskId, allLinks);

  // Focus mode and CP-only filter (issue #131)
  const [focusModeEnabled, setFocusModeEnabled] = useState(false);
  const [showCpOnly, setShowCpOnly] = useState(false);

  // Render filters (#248) — toggle which bar types are drawn on the canvas.
  // Both keep summary tasks visible so the WBS hierarchy doesn't collapse.
  const [showCriticalOnly, setShowCriticalOnly] = useState(false);
  const [showMilestonesOnly, setShowMilestonesOnly] = useState(false);

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
    // Render filters (#248) — keep summaries so the WBS hierarchy stays intact;
    // only filter leaf rows. When both toggles are on we OR (matching either).
    let filtered = visible;
    if (showCriticalOnly || showMilestonesOnly) {
      filtered = visible.filter((t) => {
        if (t.isSummary) return true;
        if (showCriticalOnly && t.isCritical) return true;
        if (showMilestonesOnly && t.isMilestone) return true;
        return false;
      });
    }
    return { visibleTasks: filtered, summaryIds: sIds, childCountById: counts };
  }, [allTasks, expandedIds, showCriticalOnly, showMilestonesOnly]);

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

  const unscheduledTasks = useUnscheduledTasks(allTasks);

  const zoomLevel         = useScheduleStore((s) => s.zoomLevel);
  const selectedTaskId    = useScheduleStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
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

    // Hover wins over selection-driven focus mode (ADR-0066 Q7) — when a row
    // is hovered, the chain follows the hover origin even if the user also
    // has selection-based focus mode toggled on.
    if (hoverChain.hoveredId) {
      return { focusChainIds: hoverChain.chain as Set<string>, depChipsById: chipsById };
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
  }, [focusModeEnabled, selectedTaskId, allLinks, hoverChain]);

  const [showAddForm, setShowAddForm] = useState(false);
  const [showAddMilestone, setShowAddMilestone] = useState(false);
  const [showColMenu, setShowColMenu] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);

  // Mobile breakpoint detection for the unified task form modal — matches the
  // pattern in BoardView's useBoardDensity (matchMedia at < md / 768px).
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

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

  // Push the hover chain to the canvas whenever it changes — drives dep-arrow
  // recoloring (blue/green) and out-of-chain bar dimming (#475).
  useEffect(() => {
    if (!engine) return;
    if (hoverChain.hoveredId) {
      engine.setHoverChain({
        hoveredId: hoverChain.hoveredId,
        predecessors: hoverChain.predecessors,
        successors: hoverChain.successors,
      });
    } else {
      engine.setHoverChain(null);
    }
  }, [engine, hoverChain]);

  // Canvas-side hover (#475): the engine fires `task-hover` when the pointer
  // moves across a bar / milestone / summary endcap on the timeline. Wire it
  // into the same state used by the task-list rows so both surfaces drive
  // the chain identically.
  useEffect(() => {
    if (!engine) return;
    const off = engine.on('task-hover', ({ taskId }) => setHoveredTaskId(taskId));
    return off;
  }, [engine]);

  // Dependency picker state (#477) — opened from TaskListRow.onAddDependencyRequest.
  const [depPickerState, setDepPickerState] = useState<
    { task: Task; mode: 'predecessor' | 'successor' } | null
  >(null);

  const handleAddDependencyRequest = useCallback(
    (taskId: string, mode: 'predecessor' | 'successor') => {
      const task = allTasks.find((t) => t.id === taskId);
      if (task) setDepPickerState({ task, mode });
    },
    [allTasks],
  );

  // Existing dependencies for the open task — pass to the picker to exclude
  // tasks already linked in that direction.
  const depPickerExcludedIds = useMemo(() => {
    if (!depPickerState) return new Set<string>();
    const ids = new Set<string>();
    for (const link of allLinks) {
      if (depPickerState.mode === 'predecessor' && link.targetId === depPickerState.task.id) {
        ids.add(link.sourceId);
      }
      if (depPickerState.mode === 'successor' && link.sourceId === depPickerState.task.id) {
        ids.add(link.targetId);
      }
    }
    return ids;
  }, [depPickerState, allLinks]);
  // Reactive scales — updated via scales-change so totalCanvasWidth stays in sync
  // when setTasks rebuilds the scale after a project switch or task edit (issue #96).
  const [scheduleScales, setScheduleScales] = useState<GanttScaleData | null>(null);
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

  // Increments on any successful task reschedule/resize — signals MonteCarloRow to show stale state.
  const [mcMutationVersion, setMcMutationVersion] = useState(0);

  // CPM finish for Monte Carlo delta — max finish across all scheduled non-milestone tasks.
  const cpmFinish = useMemo<string | null>(() => {
    const finishes = allTasks
      .filter((t) => !t.isMilestone && t.finish)
      .map((t) => t.finish);
    if (finishes.length === 0) return null;
    return finishes.reduce((a, b) => (a > b ? a : b));
  }, [allTasks]);

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
      rescheduleTask.mutate(
        { id, projectId, planned_start: newStartIso, optimistic: { start: newStartIso, finish: newFinishIso } },
        { onSuccess: () => setMcMutationVersion((v) => v + 1) },
      );
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
      rescheduleTask.mutate(
        { id, projectId, duration: newDuration, optimistic: { finish: newFinishIso, duration: newDuration } },
        { onSuccess: () => setMcMutationVersion((v) => v + 1) },
      );
    });
  }, [engine, projectId, allTasks, rescheduleTask]);

  const dragPhase = useDragStore((s) => s.phase);
  const scheduleError = useScheduleStore((s) => s.scheduleError);

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
    setScheduleScales(engine.scales);
    return engine.on('scales-change', ({ scales }) => setScheduleScales(scales));
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
  // We pass canvasScrollRef as containerRef for CanvasScheduleTimeline.
  // The engine's scroll events come from canvasScrollRef, not the engine.on('scroll').
  // We attach a DOM scroll listener instead.

  // Canvas support check (rule 79)
  const canvasSupported = typeof document !== 'undefined' ? canvasIsSupported() : true;

  // ──────────────────────────────────────────────────────────────────────
  // Build-mode (issues #338/#339/#341/#342, gated by #349)
  // Hooks must be declared above all early returns. The provider + UI only
  // mount when the flag is on AND we are on the desktop happy path.
  // ──────────────────────────────────────────────────────────────────────
  const buildModeFlag = useFeatureFlag('schedule_build_mode_v1');
  const buildModeActive = buildModeFlag && !isMobile;

  // Role gate for milestone insert (#340) — VIEWER (0) cannot author.
  const { role: currentRole } = useCurrentUserRole(projectId ?? undefined);
  const readOnly = currentRole !== null && currentRole < 1;
  const focus = useScheduleFocus();
  const indentTask = useIndentTask(projectId ?? null);
  const outdentTask = useOutdentTask(projectId ?? null);
  const updateTaskMut = useUpdateTask();
  const deleteTaskMut = useDeleteTask(projectId ?? null);
  const createTaskMut = useCreateTask(projectId ?? null);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);

  const buildModeApi = useMemo<BuildModeApi>(() => ({
    focus,
    indent: (taskId) => indentTask.mutate(taskId),
    outdent: (taskId) => outdentTask.mutate(taskId),
    insertBelow: (_taskId) => {
      // Sibling-of insert is a server-side concern (parent inferred from current
      // row's parent_id, position from current row's position + 1). For v1, fall
      // back to "create at root" — the user can indent the new row immediately.
      // Tracked as a follow-up: a positioned-insert API needs `parent_id` + `after_id`.
      if (!projectId) return;
      createTaskMut.mutate({ name: '', duration: 1 });
    },
    convertToMilestone: (taskId) => {
      if (!projectId) return;
      updateTaskMut.mutate({ id: taskId, projectId, duration: 0 });
    },
    deleteTask: (taskId) => deleteTaskMut.mutate(taskId),
    isMutationPending: (taskId) =>
      (indentTask.isPending && indentTask.variables === taskId) ||
      (outdentTask.isPending && outdentTask.variables === taskId),
  }), [focus, indentTask, outdentTask, updateTaskMut, deleteTaskMut, createTaskMut, projectId]);

  // Pulse trigger for the most recently inserted milestone (#340). Cleared
  // automatically by MilestonePulseOverlay after 1.5 s.
  const [pulsingMilestoneId, setPulsingMilestoneId] = useState<string | null>(null);
  const [pulsingMilestoneAt, setPulsingMilestoneAt] = useState<{ x: number; y: number }>(
    { x: 0, y: 0 },
  );

  // View-scoped keyboard bindings (#340 + A1's `?` migration).
  // Parent inference uses build-mode focus when active, otherwise the row the
  // user clicked (selectedTaskId). Either way the new row lands inside the
  // nearest enclosing summary so "+ Task / + Milestone under the highlighted
  // phase" matches user intent rather than always appending at root.
  const buildModeFocusedRowId = focus.state.rowId;
  const insertParentSourceId = buildModeFocusedRowId ?? selectedTaskId;
  const inferredParentId = useMemo(
    () => inferNearestSummaryParent(insertParentSourceId, visibleTasks),
    [insertParentSourceId, visibleTasks],
  );
  const inferredParentName = useMemo(
    () => (inferredParentId ? (allTasks.find((t) => t.id === inferredParentId)?.name ?? null) : null),
    [inferredParentId, allTasks],
  );
  // Open the milestone-create dialog. The dialog handles the actual POST and
  // calls handleMilestoneCreated via TaskFormModal's onCreated callback once
  // the milestone is in the cache, which is when the pulse/announce should
  // run. Keeping that side-effect path off the eager-create path means it
  // stays correct regardless of which date or parent the user picks.
  const handleAddMilestone = useCallback(() => {
    if (!projectId || readOnly) return;
    setShowAddMilestone(true);
  }, [projectId, readOnly]);

  // Fired by TaskFormModal.onCreated after a milestone is successfully saved.
  // Replays the pre-#240 side effects: pulse the diamond on the canvas and
  // announce the insertion to the aria-live region. The new task is already
  // in the React Query cache (createTask invalidates `tasks` on success), so
  // we look up the saved task by id to read its actual planned_start — the
  // user may have picked a date other than today.
  const handleMilestoneCreated = useCallback(
    (taskId: string) => {
      const created = allTasks.find((t) => t.id === taskId);
      const dateIso = created?.plannedStart ?? new Date().toISOString().slice(0, 10);
      if (ariaLiveRef.current) {
        ariaLiveRef.current.textContent = `Milestone ${created?.name || 'untitled'} inserted at ${dateIso}`;
      }
      if (scheduleScales) {
        try {
          const x = dateToLeft(dateIso, scheduleScales);
          const rowIdx = visibleTasks.findIndex((t) => t.id === taskId);
          const idx = rowIdx >= 0 ? rowIdx : visibleTasks.length;
          const y = HEADER_HEIGHT + idx * ROW_HEIGHT + ROW_HEIGHT / 2;
          setPulsingMilestoneAt({ x, y });
        } catch {
          // dateToLeft can throw on out-of-range dates — silently skip pulse.
        }
      }
      setPulsingMilestoneId(taskId);
      if (buildModeActive) {
        focus.focusRow(taskId);
      }
    },
    [allTasks, scheduleScales, visibleTasks, buildModeActive, focus],
  );

  const keyBindings = useMemo<Record<string, (e: KeyboardEvent) => void>>(() => {
    const out: Record<string, (e: KeyboardEvent) => void> = {};
    out['mod+m'] = (e) => {
      if (!projectId || readOnly) return;
      e.preventDefault();
      handleAddMilestone();
    };
    if (buildModeActive) {
      out['?'] = (e) => {
        e.preventDefault();
        setCheatsheetOpen((open) => !open);
      };
    }
    return out;
  }, [projectId, readOnly, handleAddMilestone, buildModeActive]);
  useScheduleKeyboard(keyBindings);

  const handleAddFirstTask = useCallback(() => {
    if (!projectId) return;
    // Per ux-design: the new row enters RowFocused immediately, then auto-
    // transitions to CellEdit on the Name column — saves the user one keystroke
    // vs. requiring F2 after the row appears.
    // Placeholder `name` matches the milestone path; the server CharField does
    // not allow blank, and the cell editor opens immediately for overwrite.
    createTaskMut.mutate(
      { name: 'New task', duration: 1 },
      {
        onSuccess: (data) => {
          focus.focusRow(data.id);
          focus.enterCellEdit(data.id, 'name');
        },
      },
    );
  }, [projectId, createTaskMut, focus]);

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
      <div className="flex h-full bg-neutral-surface" aria-busy="true" aria-label="Loading Schedule">
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
          <ScheduleFallbackTable tasks={visibleTasks} />
        </div>
      </div>
    );
  }

  const totalCanvasWidth = scheduleScales?.totalWidth ?? 0;

  const mainView = (
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
        {/* "+ Milestone" peer button (#340) — same gate as "+ Task" */}
        {projectId && (
          <ScheduleAddMilestoneButton
            onAddMilestone={handleAddMilestone}
            disabled={readOnly}
            pending={createTaskMut.isPending}
          />
        )}
        {buildModeActive && (
          <BuildModePill onShowCheatsheet={() => setCheatsheetOpen(true)} />
        )}
        <RecalculatingBadge isVisible={pendingTaskIds.size > 0} />

        {/* View filter group (#248) — restyled from plain checkboxes */}
        <div
          role="group"
          aria-label="Schedule view filters"
          className="flex items-center rounded border border-neutral-border overflow-hidden"
        >
          <ScheduleToolbarToggle
            pressed={showCpOnly}
            onToggle={setShowCpOnly}
            label="CP only"
            ariaLabel="Show critical path only"
          />
          <ScheduleToolbarToggle
            pressed={focusModeEnabled}
            onToggle={setFocusModeEnabled}
            label="Focus chain"
            ariaLabel="Focus chain on selected task"
          />
        </div>

        {/* Render filter group (#248) — filter what bars draw on the canvas */}
        <div
          role="group"
          aria-label="Schedule render filters"
          className="flex items-center rounded border border-neutral-border overflow-hidden"
        >
          <ScheduleToolbarToggle
            pressed={showCriticalOnly}
            onToggle={setShowCriticalOnly}
            label="Critical path"
            ariaLabel="Show only critical-path tasks"
          />
          <ScheduleToolbarToggle
            pressed={showMilestonesOnly}
            onToggle={setShowMilestonesOnly}
            label="Milestones"
            ariaLabel="Show only milestones"
          />
        </div>

        <div className="flex-1" />

        {/* Project-health summary chip (#248) */}
        <ScheduleSummaryChip visibleTasks={visibleTasks} />

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

      {/* Task creation modal — replaces the inline AddTaskForm strip
          (issue #305 / ADR-0052). The unified TaskFormModal handles both
          create and edit flows; here it always opens in create mode. */}
      {showAddForm && projectId && (
        <TaskFormModal
          projectId={projectId}
          task={null}
          parentId={inferredParentId}
          phaseName={inferredParentName ?? undefined}
          isMobile={isMobile}
          onClose={() => setShowAddForm(false)}
        />
      )}

      {/* Milestone creation modal — same TaskFormModal in milestone mode.
          The user picks name, date, and parent up front instead of editing
          a placeholder row in the drawer (was: insert-then-edit-name path). */}
      {showAddMilestone && projectId && (
        <TaskFormModal
          projectId={projectId}
          task={null}
          parentId={inferredParentId}
          phaseName={inferredParentName ?? undefined}
          isMilestone
          isMobile={isMobile}
          onCreated={handleMilestoneCreated}
          onClose={() => setShowAddMilestone(false)}
        />
      )}

      <div className="relative flex flex-1 overflow-hidden" ref={timelineContainerRef}>
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
          onHoverChange={setHoveredTaskId}
          onAddDependencyRequest={handleAddDependencyRequest}
          sprintsById={sprintsById}
        />
        {/* Panel splitter — drag to resize task list width */}
        <PanelSplitter currentTaskWidth={widths.task} setWidth={setWidth} />

        {visibleTasks.length === 0 ? (
          buildModeActive ? (
            <BuildModeEmptyState onAddFirstTask={handleAddFirstTask} />
          ) : (
            <ScheduleEmptyState />
          )
        ) : (
          <div
            ref={canvasScrollRef}
            data-testid="schedule-canvas-scroll"
            className="flex-1 min-w-0 overflow-auto relative z-0"
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
                <CanvasScheduleTimeline
                  tasks={visibleTasks}
                  links={links ?? []}
                  zoomLevel={zoomLevel}
                  containerRef={canvasScrollRef}
                  onEngineReady={handleEngineReady}
                />
                {/* P50/P80/P95 vertical markers — scroll-synced via DOM ref writes (#333) */}
                <MonteCarloGanttMarkers
                  result={mcResult ?? null}
                  scaleData={scheduleScales}
                  canvasScrollRef={canvasScrollRef}
                />
              </div>
            </div>

          </div>
        )}

        {/* Floating legend overlay (#474, ADR-0064) — anchored to the bottom-left of
            the canvas viewport. Hidden below `lg` per design rule 12. */}
        <ScheduleLegend taskListWidth={totalWidth} />
      </div>

      {/* Unscheduled gutter — tasks with no planned/CPM dates (#213) */}
      {projectId && (
        <UnscheduledGutter
          tasks={unscheduledTasks}
          projectId={projectId}
          scaleData={scheduleScales}
          canvasScrollRef={canvasScrollRef}
          taskListWidth={totalWidth}
        />
      )}

      {buildModeActive && (
        <BuildModeHintStrip
          mode={focus.state.mode}
          onShowCheatsheet={() => setCheatsheetOpen(true)}
        />
      )}

      {(currentRole === null || currentRole >= 1) && (
        <MonteCarloRow
          engine={engine}
          projectId={projectId ?? undefined}
          taskListWidth={totalWidth}
          cpmFinish={cpmFinish}
          mutationVersion={mcMutationVersion}
          tasks={allTasks}
        />
      )}

      {/* Mobile MC card — md:hidden; desktop uses MonteCarloRow above (issue #33) */}
      <MobileMonteCarloCard projectId={projectId ?? undefined} />

      {/* Milestone delta tooltip — at ScheduleView level to escape overflow:hidden (rule 31) */}
      <MilestoneDeltaTooltip milestoneLeft={null} timelineTop={timelineTop} />

      {/* Milestone pulse animation (#340) — fires after a successful insert.
          dateToLeft returns canvas-origin coordinates (renderer rule §57); the
          overlay is positioned in viewport space, so subtract scrollLeft to
          keep the pulse anchored on the actual diamond when the timeline has
          been scrolled away from origin. */}
      <MilestonePulseOverlay
        x={pulsingMilestoneAt.x + totalWidth - (canvasScrollRef.current?.scrollLeft ?? 0)}
        y={pulsingMilestoneAt.y + (timelineTop ?? 0)}
        triggerId={pulsingMilestoneId}
      />

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

      {/* Progress-anchor gate toast (#362) */}
      {scheduleError && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded border border-neutral-border bg-neutral-surface text-sm text-neutral-text-primary"
        >
          {scheduleError}
        </div>
      )}

      {/* Sprint Undo toast (#477 / ADR-0066 Q2) — fires after Duplicate inherits
          an ACTIVE sprint, gives the PM a one-click escape hatch. */}
      <ScheduleActionToastRenderer />

      {/* Dependency picker modal (#477) — opened from the right-click menu. */}
      {depPickerState && projectId && (
        <ScheduleDependencyPicker
          task={depPickerState.task}
          mode={depPickerState.mode}
          projectId={projectId}
          allTasks={allTasks}
          excludedIds={depPickerExcludedIds}
          onClose={() => setDepPickerState(null)}
        />
      )}

      {/* Task detail drawer — sections fetch their own data via the registry (ADR-0050). */}
      {projectId && (
        <TaskDetailDrawer
          task={selectedTask}
          projectId={projectId}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      {buildModeActive && (
        <BuildModeCheatsheet
          open={cheatsheetOpen}
          onClose={() => setCheatsheetOpen(false)}
        />
      )}
    </div>
  );

  return buildModeActive ? (
    <BuildModeProvider api={buildModeApi}>{mainView}</BuildModeProvider>
  ) : (
    mainView
  );
}

