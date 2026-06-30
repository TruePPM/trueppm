import {
  useRef,
  useCallback,
  useState,
  useEffect,
  useMemo,
  type PointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { GanttEngine, GanttScaleData } from './engine';
import { dateToLeft, ZOOM_STEP_FACTOR } from './engine';
import { HEADER_HEIGHT, ROW_HEIGHT } from './scheduleConstants';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
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
import { QuarterModeControl } from './QuarterModeControl';
import { ScheduleViewModeToggle } from './ScheduleViewModeToggle';
import { ScheduleToolbarToggle } from './ScheduleToolbarToggle';
import { useFiscalYearStartMonth } from '@/hooks/useFiscalYearStartMonth';
import { ScheduleSummaryChip } from './ScheduleSummaryChip';
import { ScheduleAddMilestoneButton } from './ScheduleAddMilestoneButton';
import { MilestonePulseOverlay } from './MilestonePulseOverlay';
import { ScheduleLegend } from './ScheduleLegend';
import { useScheduleKeyboard } from './useScheduleKeyboard';
import { inferNearestSummaryParent } from './inferMilestoneParent';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN, ROLE_MEMBER } from '@/lib/roles';
import { ScheduleForecastBar } from './ScheduleForecastBar';
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
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  ToolbarOverflowMenu,
  type ToolbarOverflowItem,
} from '@/components/toolbar/ToolbarOverflowMenu';
import { ImportModal } from '@/components/import/ImportModal';
import { EmptyState } from '@/components/EmptyState';
import { GanttIcon } from '@/components/Icons';
import { useExportMsProject } from '@/hooks/useMsProjectImportExport';
import type { Task } from '@/types';
import { useFeatureFlag } from '@/lib/featureFlags';
import { useDependencyHover } from './useDependencyHover';
import { ScheduleDependencyPicker } from './ScheduleDependencyPicker';
import { ScheduleCommitPopover } from './ScheduleCommitPopover';
import { BeforeProjectStartDialog } from './BeforeProjectStartDialog';
import { useScheduleCommit } from './useScheduleCommit';
import { useProject } from '@/hooks/useProject';
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
    <EmptyState
      className="h-full bg-neutral-surface"
      icon={GanttIcon}
      title="No tasks yet"
      description="Add tasks to lay out your schedule — the timeline, critical path, and forecast appear as soon as there's work to plan."
    />
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
      className="fixed bottom-14 left-1/2 -translate-x-1/2 z-[60] min-w-[280px] max-w-[420px] px-4 py-2 rounded-card border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary flex items-center gap-3"
    >
      <span className="flex-1">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="text-brand-primary font-medium hover:underline focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none rounded-control"
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

  // Keyboard-operable alternative to pointer drag (WCAG 2.1.1). Arrow keys nudge
  // by 16px, Home/End jump to the soft min/max. Lower bound matches the store's
  // MIN_COL_WIDTHS.task clamp; the 600 upper bound is keyboard-only guidance.
  const MIN = 120;
  const MAX = 600;
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = currentTaskWidth - 16;
    else if (e.key === 'ArrowRight') next = currentTaskWidth + 16;
    else if (e.key === 'Home') next = MIN;
    else if (e.key === 'End') next = MAX;
    if (next === null) return;
    e.preventDefault();
    setWidth('task', Math.min(MAX, Math.max(MIN, next)));
  }

  // WAI-ARIA window-splitter pattern: a `separator` exposing aria-valuenow is a
  // focusable, keyboard-operable control (the standard resizable-pane idiom).
  // jsx-a11y models `separator` as static, so its focusability rules are disabled
  // for this element with intent rather than degrading the ARIA semantics.
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize task list panel"
      tabIndex={0}
      aria-valuenow={Math.round(currentTaskWidth)}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      aria-valuetext={`Task list ${Math.round(currentTaskWidth)} pixels`}
      className="w-1 flex-shrink-0 cursor-col-resize bg-brand-primary/10 hover:bg-brand-primary/60 focus-visible:bg-brand-primary focus-visible:outline-none transition-colors z-10"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}

// ---------------------------------------------------------------------------
// ScheduleView
// ---------------------------------------------------------------------------

export function ScheduleView() {
  usePageTitle('Schedule');
  const projectId = useProjectId() ?? null;
  const { tasks: rawTasks, links: rawLinks, isLoading, error } = useScheduleTasks();
  const { data: mcResult } = useMonteCarloResult(projectId ?? undefined);
  const allTasks = useMemo(() => rawTasks ?? [], [rawTasks]);
  const allLinks = useMemo(() => rawLinks ?? [], [rawLinks]);
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

  // #806: if the currently-hovered task is removed from the list (delete,
  // server-side prune, etc.), React's `onMouseLeave` never fires on the
  // unmounted row, so `hoveredTaskId` stays pinned to the dead id. That keeps
  // `focusChainIds = {deletedId}` active and every other row renders with
  // `dimmed` (opacity-0.22 + pointer-events-none) until the next mouse move.
  // Result: right-click on the next row is silently swallowed. Clear the hover
  // explicitly whenever its target task disappears.
  useEffect(() => {
    if (hoveredTaskId && !allTasks.some((t) => t.id === hoveredTaskId)) {
      setHoveredTaskId(null);
    }
  }, [hoveredTaskId, allTasks]);

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

  const zoomLevel = useScheduleStore((s) => s.zoomLevel);
  const selectedTaskId = useScheduleStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const quarterMode = useScheduleStore((s) => s.quarterMode);
  const setQuarterMode = useScheduleStore((s) => s.setQuarterMode);
  const viewMode = useScheduleStore((s) => s.viewMode);
  const fiscalStartMonth = useFiscalYearStartMonth();
  const selectedTask = selectedTaskId
    ? (allTasks.find((t) => t.id === selectedTaskId) ?? null)
    : null;

  // Adjacency + per-task dep-chip data — only depends on `allLinks`, so the
  // identity stays stable across hover transitions. This matters for
  // TaskListRow's React.memo: the `depChips` prop must not get a fresh
  // object identity on every hover change or every row re-renders.
  const { chipsById, succs, preds } = useMemo(() => {
    const c = new Map<string, TaskDepChips>();
    const s = new Map<string, string[]>();
    const p = new Map<string, string[]>();
    for (const link of allLinks) {
      const srcChip = c.get(link.sourceId) ?? {
        predsCount: 0,
        succsCount: 0,
        predsCritical: false,
        succsCritical: false,
      };
      srcChip.succsCount++;
      if (link.isCritical) srcChip.succsCritical = true;
      c.set(link.sourceId, srcChip);

      const tgtChip = c.get(link.targetId) ?? {
        predsCount: 0,
        succsCount: 0,
        predsCritical: false,
        succsCritical: false,
      };
      tgtChip.predsCount++;
      if (link.isCritical) tgtChip.predsCritical = true;
      c.set(link.targetId, tgtChip);

      (s.get(link.sourceId) ?? s.set(link.sourceId, []).get(link.sourceId)!).push(link.targetId);
      (p.get(link.targetId) ?? p.set(link.targetId, []).get(link.targetId)!).push(link.sourceId);
    }
    return { chipsById: c, succs: s, preds: p };
  }, [allLinks]);

  // Focus chain — hover wins over selection-driven focus mode (ADR-0066 Q7).
  // Only depends on the chain-driving inputs, so when the user is just
  // sweeping the cursor across rows the depChipsById identity above stays
  // stable (no row re-render on chip prop).
  const focusChainIds = useMemo<Set<string> | undefined>(() => {
    if (hoverChain.hoveredId) return hoverChain.chain as Set<string>;
    if (!focusModeEnabled || !selectedTaskId) return undefined;
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
    return chain;
  }, [focusModeEnabled, selectedTaskId, hoverChain, succs, preds]);
  const depChipsById = chipsById;

  const [showAddForm, setShowAddForm] = useState(false);
  const [showAddMilestone, setShowAddMilestone] = useState(false);
  const [showColMenu, setShowColMenu] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);

  // Mobile breakpoint detection for the unified task form modal — matches the
  // pattern in BoardView's useBoardDensity (matchMedia at < md / 768px).
  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
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

  // Canvas double-click opens the task detail drawer. The bar cursor is `grab`
  // (rule 84), so the timeline reads as drag-only; double-click is the
  // affordance for "show me the details" (single-click stays selection-only,
  // drawing the ring + dependency chain). The engine emits a typed `task-open`
  // on dblclick over any bar/milestone/summary; route it into the same
  // `selectedTaskId` store the drawer renders from, and select the bar so its
  // ring is visible behind the open drawer.
  useEffect(() => {
    if (!engine) return;
    const off = engine.on('task-open', ({ id }) => {
      setSelectedTaskId(id);
      engine.selectTask(id);
    });
    return off;
  }, [engine, setSelectedTaskId]);

  // Dependency picker state (#477) — opened from TaskListRow.onAddDependencyRequest.
  const [depPickerState, setDepPickerState] = useState<{
    task: Task;
    mode: 'predecessor' | 'successor';
  } | null>(null);

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

  // Increments on any successful task reschedule/resize — signals ScheduleForecastBar to show stale state.
  const [mcMutationVersion, setMcMutationVersion] = useState(0);

  // CPM finish for Monte Carlo delta. The server owns this value and returns it
  // on the MC latest payload (#987 — `cpm_finish` is the deterministic project
  // finish, max early-finish of committed tasks). Prefer it so the panel/row
  // deltas line up exactly with the server-computed `delta_vs_cpm`. Fall back to
  // the client max(task.finish) only when no MC result is available yet, so the
  // schedule still shows a finish before the first simulation run.
  const cpmFinish = useMemo<string | null>(() => {
    if (mcResult?.cpmFinish) return mcResult.cpmFinish;
    const finishes = allTasks.filter((t) => !t.isMilestone && t.finish).map((t) => t.finish);
    if (finishes.length === 0) return null;
    return finishes.reduce((a, b) => (a > b ? a : b));
  }, [mcResult?.cpmFinish, allTasks]);

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
    // Re-attach when the task list remounts (Timeline→Grid toggle, issue 1221): the
    // panel unmounts in Timeline mode, so the listener must bind to the new node.
  }, [viewMode]);

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

  // Pull-to-commit gate (ADR-0067 / #492). Drag-end and resize-end no longer
  // fire the PATCH directly: the bar visually moves via engine.updateTask, and
  // the popover holds the change until Confirm. Cancel/Esc/click-outside revert.
  // Project start date feeds the project-start floor prompt (#868) — a reschedule
  // before this date opens snap/move/cancel instead of silently clamping.
  const { data: projectDetail } = useProject(projectId ?? undefined);
  const projectStartDate = projectDetail?.start_date ?? null;
  // Effective floor = first working day >= start_date (#884). Falls back to the
  // literal start when the detail field is absent (older payloads / list cache).
  const effectiveFloorDate = projectDetail?.start_floor ?? projectStartDate;

  const scheduleCommit = useScheduleCommit({
    engine,
    projectId,
    projectStartDate,
    effectiveFloorDate,
    visibleTasks,
    allTasks,
    sprints,
    canvasContainerRef: canvasScrollRef,
    ariaAssertiveRef,
    onCommitSuccess: () => setMcMutationVersion((v) => v + 1),
  });

  const dragPhase = useDragStore((s) => s.phase);
  const scheduleError = useScheduleStore((s) => s.scheduleError);

  const timelineTop = timelineContainerRef.current
    ? timelineContainerRef.current.getBoundingClientRect().top
    : 0;

  const handleDatePopoverConfirm = useCallback((newStart: string) => {
    setDatePopoverTask(null);
    const { commitDrag } = useDragStore.getState();
    commitDrag(newStart);
    keyboardModeRef.current = false;
    if (ariaAssertiveRef.current) {
      ariaAssertiveRef.current.textContent = 'Reschedule confirmed.';
    }
  }, []);

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
    engine.scrollToDate(
      new Date().toISOString().slice(0, 10),
      reducedMotion ? 'instant' : 'smooth',
    );
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

  // Toolbar responsive tier (issue #568, rules 110–112).
  //   lg → all toggles show full labels
  //   md → secondary toggles render icon-only via `hideLabel`
  //   sm → secondary toggles collapse into the shared ToolbarOverflowMenu
  const breakpoint = useBreakpoint();
  const toolbarHideLabel = breakpoint === 'md';
  const toolbarShowSecondaryInline = breakpoint !== 'sm';

  // Role gate for milestone insert (#340) — VIEWER cannot author.
  const { role: currentRole } = useCurrentUserRole(projectId ?? undefined);
  const readOnly = currentRole !== null && currentRole < ROLE_MEMBER;
  const focus = useScheduleFocus();
  const indentTask = useIndentTask(projectId ?? null);
  const outdentTask = useOutdentTask(projectId ?? null);
  const updateTaskMut = useUpdateTask();
  const deleteTaskMut = useDeleteTask(projectId ?? null);
  const createTaskMut = useCreateTask(projectId ?? null);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);

  // MS Project import/export (#68). Import is gated on Project Admin to match
  // the server; export is allowed for any member. Admin is a high bar, so we
  // hide Import pessimistically while the role loads (currentRole === null) to
  // avoid flashing a forbidden action to the non-admin majority — per the
  // useCurrentUserRole pessimistic-gating contract. The server is authoritative.
  const [importOpen, setImportOpen] = useState(false);
  const canImport = currentRole !== null && currentRole >= ROLE_ADMIN;
  const { exportProject, isExporting, error: exportError } = useExportMsProject(projectId);

  const buildModeApi = useMemo<BuildModeApi>(
    () => ({
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
      // #806: include deleteTask so the row gets the "in-flight" treatment during
      // delete and downstream guards (context-menu suppression, auto-close of an
      // already-open menu) fire. Without delete here, the row unmounts on cache
      // invalidation while its BuildModeRowMenu portal still has a live menuAnchor,
      // which orphans the menu's global Escape/click-outside listeners and blocks
      // subsequent right-clicks until a full page refresh.
      isMutationPending: (taskId) =>
        (indentTask.isPending && indentTask.variables === taskId) ||
        (outdentTask.isPending && outdentTask.variables === taskId) ||
        (deleteTaskMut.isPending && deleteTaskMut.variables === taskId),
    }),
    [focus, indentTask, outdentTask, updateTaskMut, deleteTaskMut, createTaskMut, projectId],
  );

  // Pulse trigger for the most recently inserted milestone (#340). Cleared
  // automatically by MilestonePulseOverlay after 1.5 s.
  const [pulsingMilestoneId, setPulsingMilestoneId] = useState<string | null>(null);
  const [pulsingMilestoneAt, setPulsingMilestoneAt] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });

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
    () =>
      inferredParentId ? (allTasks.find((t) => t.id === inferredParentId)?.name ?? null) : null,
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
    // Esc reverts the schedule to a chain-free state. Clears hover (#475),
    // turns off selection-driven focus mode (#131), and deselects the row
    // (which also closes the drawer if open). Drawer Esc has its own listener
    // that stopPropagation()s before the window-level handler — that path
    // is independently wired in onClose below so both routes clear hover.
    // Tell the engine directly too so the canvas doesn't have to wait two
    // React render cycles for the React-state → useEffect propagation to
    // reach `engine.setHoverChain`.
    //
    // Bail when a context menu is open in the DOM — the `BuildModeRowMenu`
    // has its own window-level Esc listener that closes the menu by setting
    // `menuAnchor=null`; running this handler in parallel races with that
    // close and leaves the menu visible (e2e/schedule-build-mode.spec.ts
    // regression). Let the menu close first; user can press Esc a second
    // time to clear hover / selection if needed.
    out['escape'] = () => {
      if (document.querySelector('[role="menu"][aria-label="Row actions"]')) return;
      setHoveredTaskId(null);
      setFocusModeEnabled(false);
      setSelectedTaskId(null);
      engine?.setHoverChain(null);
      // The engine maintains its own `_selectedTaskIds` set (clicked bars get
      // the brand-primary selection ring on their connected dep arrows). React's
      // selectedTaskId is the Zustand store for the drawer; the engine's is
      // separate. Clear both so the canvas reverts fully.
      engine?.selectTask(null);
    };
    if (buildModeActive) {
      out['?'] = (e) => {
        e.preventDefault();
        setCheatsheetOpen((open) => !open);
      };
    }
    // Continuous zoom shortcuts (#351). ⌘=/⌘- step geometrically through the
    // store (→ engine.setPxPerDay with viewport-center anchor, rule 80); ⌘0
    // fits the project (rule 126). Read pxPerDay fresh via getState so the
    // bindings don't churn on every wheel tick. preventDefault stops the
    // browser's native page zoom.
    out['mod+='] = (e) => {
      e.preventDefault();
      const { pxPerDay, setPxPerDay } = useScheduleStore.getState();
      setPxPerDay(pxPerDay * ZOOM_STEP_FACTOR);
    };
    out['mod+-'] = (e) => {
      e.preventDefault();
      const { pxPerDay, setPxPerDay } = useScheduleStore.getState();
      setPxPerDay(pxPerDay / ZOOM_STEP_FACTOR);
    };
    out['mod+0'] = (e) => {
      e.preventDefault();
      engine?.fitToProject();
    };
    return out;
  }, [projectId, readOnly, handleAddMilestone, buildModeActive, engine, setSelectedTaskId]);
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
            className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface"
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
      <div
        className="flex h-full bg-neutral-surface"
        aria-busy="true"
        aria-label="Loading Schedule"
      >
        <div className="w-[280px] flex-shrink-0 border-r border-white/10 p-2 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-7 rounded-card animate-pulse bg-brand-primary/10" />
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
          <ZoomControl onFit={() => engine?.fitToProject()} />
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
  // Horizontal anchor for canvas overlays (legend, unscheduled gutter, milestone
  // pulse). In Timeline mode (issue 1221) the task-list panel is hidden, so the canvas
  // starts at the container's left edge and these overlays must offset by 0.
  const panelWidth = viewMode === 'timeline' ? 0 : totalWidth;

  const mainView = (
    <div className="flex flex-col h-full overflow-hidden">
      <h1 className="sr-only">Schedule</h1>
      {/* Gantt-specific toolbar — Today + Zoom + Add Task.
          Responsive collapse rules per issue #568 / CLAUDE.md rules 110–112:
          primary controls stay visible at every width; the four secondary
          analysis toggles render icon-only at md and move into the shared
          ToolbarOverflowMenu below md. Root is `flex-nowrap` (rule 113) so a
          missing collapse rule surfaces as a clipped row, never a stacked one. */}
      <div
        role="toolbar"
        aria-label="Schedule toolbar"
        className="flex flex-nowrap items-center gap-2 px-4 h-10 border-b border-neutral-border bg-neutral-surface-raised flex-shrink-0"
      >
        {/* "+ Task" button — only shown when a project is selected */}
        {projectId && (
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            aria-label="Add task"
            aria-expanded={showAddForm}
            className="border border-neutral-border rounded-control h-7 px-3 text-xs font-medium flex-shrink-0
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
        {buildModeActive && <BuildModePill onShowCheatsheet={() => setCheatsheetOpen(true)} />}
        {/* Show the badge for in-flight optimistic edits, and also while a
            freshly-imported sample's first post-import CPM pass is still pending
            (recalculated_at null) so the demo never reads as broken with
            uncomputed dates (#1053). */}
        <RecalculatingBadge
          isVisible={
            pendingTaskIds.size > 0 ||
            (projectDetail?.is_sample === true && projectDetail?.recalculated_at == null)
          }
        />

        {toolbarShowSecondaryInline && (
          <>
            {/* View filter group (#248) — restyled from plain checkboxes */}
            <div
              role="group"
              aria-label="Schedule view filters"
              className="flex items-center rounded-control border border-neutral-border overflow-hidden flex-shrink-0"
            >
              <ScheduleToolbarToggle
                pressed={showCpOnly}
                onToggle={setShowCpOnly}
                label="CP only"
                ariaLabel="Show critical path only"
                hideLabel={toolbarHideLabel}
                icon="C"
              />
              <ScheduleToolbarToggle
                pressed={focusModeEnabled}
                onToggle={setFocusModeEnabled}
                label="Focus chain"
                ariaLabel="Focus chain on selected task"
                hideLabel={toolbarHideLabel}
                icon="F"
              />
            </div>

            {/* Render filter group (#248) — filter what bars draw on the canvas */}
            <div
              role="group"
              aria-label="Schedule render filters"
              className="flex items-center rounded-control border border-neutral-border overflow-hidden flex-shrink-0"
            >
              <ScheduleToolbarToggle
                pressed={showCriticalOnly}
                onToggle={setShowCriticalOnly}
                label="Critical path"
                ariaLabel="Show only critical-path tasks"
                hideLabel={toolbarHideLabel}
                icon="!"
              />
              <ScheduleToolbarToggle
                pressed={showMilestonesOnly}
                onToggle={setShowMilestonesOnly}
                label="Milestones"
                ariaLabel="Show only milestones"
                hideLabel={toolbarHideLabel}
                icon="◆"
              />
            </div>
          </>
        )}

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
            className="border border-neutral-border rounded-control h-7 px-3 text-xs font-medium
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
              hover:border-brand-primary hover:text-brand-primary"
          >
            Columns
          </button>
          {showColMenu && (
            <div
              role="menu"
              className="absolute right-0 top-8 z-30 bg-neutral-surface border border-neutral-border
                rounded-card py-1 min-w-[120px]"
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
                  {col === 'dur'
                    ? 'Dur'
                    : col === 'start'
                      ? 'Start'
                      : col === 'finish'
                        ? 'Finish'
                        : '%'}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Grid↔Timeline layout toggle (issue 1221) — primary control: Grid keeps the
            WBS table beside the timeline, Timeline hides it for a full-width canvas. */}
        <ScheduleViewModeToggle />
        {/* "Today" button (rule 82) */}
        <button
          type="button"
          onClick={handleScrollToToday}
          className="border border-neutral-border rounded-control h-7 px-3 text-xs font-medium flex-shrink-0 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
        >
          Today
        </button>
        <ZoomControl onFit={() => engine?.fitToProject()} />
        {/* Fiscal/calendar quarter toggle (#755) — inline next to zoom at md+,
            folded into the overflow menu at sm. Self-hides off quarter/year
            zoom and when the workspace fiscal year starts in January. */}
        {toolbarShowSecondaryInline && <QuarterModeControl />}
        {/* Project actions (···) — always present so Import/Export are
            discoverable at every width. The secondary analysis toggles fold in
            here only at the narrowest breakpoint; at md+ they render inline. */}
        {(projectId || breakpoint === 'sm') && (
          <ToolbarOverflowMenu
            triggerAriaLabel="Project actions"
            items={
              [
                ...(projectId && canImport
                  ? [
                      {
                        kind: 'action' as const,
                        id: 'import-msproject',
                        label: 'Import from MS Project…',
                        onSelect: () => setImportOpen(true),
                      },
                    ]
                  : []),
                ...(projectId
                  ? [
                      {
                        kind: 'action' as const,
                        id: 'export-msproject',
                        label: isExporting ? 'Exporting…' : 'Export to MS Project (.xml)',
                        disabled: isExporting,
                        onSelect: () => {
                          void exportProject();
                        },
                      },
                    ]
                  : []),
                ...(breakpoint === 'sm'
                  ? [
                      ...((zoomLevel === 'quarter' || zoomLevel === 'year') &&
                      fiscalStartMonth !== 1
                        ? [
                            {
                              kind: 'checkbox' as const,
                              id: 'fiscal-quarters',
                              label: 'Fiscal quarters',
                              checked: quarterMode === 'fiscal',
                              onChange: (next: boolean) =>
                                setQuarterMode(next ? 'fiscal' : 'calendar'),
                            },
                          ]
                        : []),
                      {
                        kind: 'checkbox' as const,
                        id: 'cp-only',
                        label: 'CP only',
                        checked: showCpOnly,
                        onChange: setShowCpOnly,
                      },
                      {
                        kind: 'checkbox' as const,
                        id: 'focus-chain',
                        label: 'Focus chain',
                        checked: focusModeEnabled,
                        onChange: setFocusModeEnabled,
                      },
                      {
                        kind: 'checkbox' as const,
                        id: 'critical-path',
                        label: 'Critical path only',
                        checked: showCriticalOnly,
                        onChange: setShowCriticalOnly,
                      },
                      {
                        kind: 'checkbox' as const,
                        id: 'milestones',
                        label: 'Milestones only',
                        checked: showMilestonesOnly,
                        onChange: setShowMilestonesOnly,
                      },
                    ]
                  : []),
              ] as ToolbarOverflowItem[]
            }
          />
        )}
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
        {/* Grid mode shows the WBS task-list table + resize splitter; Timeline
            mode (issue 1221) hides both for a full-width canvas (task names render
            inline on the bars). */}
        {viewMode === 'grid' && (
          <>
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
          </>
        )}

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
        <ScheduleLegend taskListWidth={panelWidth} />
      </div>

      {/* Unscheduled gutter — tasks with no planned/CPM dates (#213) */}
      {projectId && (
        <UnscheduledGutter
          tasks={unscheduledTasks}
          projectId={projectId}
          scaleData={scheduleScales}
          canvasScrollRef={canvasScrollRef}
          taskListWidth={panelWidth}
        />
      )}

      {/* Contextual hint strip (#1250, web rule 194): render only while the user
          is actively engaged (RowFocused / CellEdit). When idle (NoSelection) the
          strip is unmounted so ScheduleForecastBar sits flush at the bottom and the
          P50/P80/P95 signal isn't subordinated by always-on discoverability chrome.
          The always-on BuildModePill in the toolbar remains the discovery affordance. */}
      {buildModeActive && focus.state.mode !== 'NoSelection' && (
        <BuildModeHintStrip
          mode={focus.state.mode}
          onShowCheatsheet={() => setCheatsheetOpen(true)}
        />
      )}

      {/* Single consolidated forecast surface (ADR-0144, web rule 189) — one
          docked bottom bar owns the percentiles (rendered once), the histogram,
          the sensitivity tornado, and the run-history disclosure. Replaces the
          former MonteCarloRow + ScheduleInsightsBar two-surface split that
          rendered the percentiles up to three times and disagreed on the day. */}
      {(currentRole === null || currentRole >= ROLE_MEMBER) && (
        <ScheduleForecastBar
          projectId={projectId ?? undefined}
          cpmFinish={cpmFinish}
          mutationVersion={mcMutationVersion}
          tasks={allTasks}
        />
      )}

      {/* Mobile MC card — md:hidden; desktop uses ScheduleForecastBar above (issue #33) */}
      <MobileMonteCarloCard projectId={projectId ?? undefined} />

      {/* Milestone delta tooltip — at ScheduleView level to escape overflow:hidden (rule 31) */}
      <MilestoneDeltaTooltip milestoneLeft={null} timelineTop={timelineTop} />

      {/* Milestone pulse animation (#340) — fires after a successful insert.
          dateToLeft returns canvas-origin coordinates (renderer rule §57); the
          overlay is positioned in viewport space, so subtract scrollLeft to
          keep the pulse anchored on the actual diamond when the timeline has
          been scrolled away from origin. */}
      <MilestonePulseOverlay
        x={pulsingMilestoneAt.x + panelWidth - (canvasScrollRef.current?.scrollLeft ?? 0)}
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

      {/* Pull-to-commit popover (ADR-0067 / #492) — replaces the silent PATCH
          that fired on pointerup. Stays open until Confirm/Cancel/Esc/click-outside. */}
      {scheduleCommit.state && (
        <ScheduleCommitPopover
          anchor={scheduleCommit.state.anchor}
          activeSprintName={scheduleCommit.state.activeSprintName}
          action={scheduleCommit.state.action}
          isPending={scheduleCommit.isPending}
          error={scheduleCommit.state.error}
          onConfirm={scheduleCommit.handleConfirm}
          onCancel={scheduleCommit.handleCancel}
          onDismissByOutsideClick={scheduleCommit.handleDismissByOutsideClick}
        />
      )}

      {/* Project-start floor prompt (#868) — replaces the silent clamp when a
          reschedule lands before the project start. "Move project start" is
          gated to Admin/Owner (server-enforced); lower roles see snap + cancel. */}
      {scheduleCommit.beforeStartPrompt && (
        <BeforeProjectStartDialog
          projectStartDate={scheduleCommit.beforeStartPrompt.projectStartDate}
          effectiveFloorDate={scheduleCommit.beforeStartPrompt.effectiveFloorDate}
          attemptedStart={scheduleCommit.beforeStartPrompt.attemptedStart}
          canMoveStart={currentRole !== null && currentRole >= ROLE_ADMIN}
          error={scheduleCommit.beforeStartPrompt.error}
          isPending={scheduleCommit.beforeStartPending}
          onSnap={scheduleCommit.handleSnapToProjectStart}
          onMoveStart={scheduleCommit.handleMoveProjectStart}
          onCancel={scheduleCommit.handleCancelBeforeStart}
        />
      )}

      {/* Offline error toast (rule 29) */}
      {dragPhase === 'error' && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-card border border-neutral-border bg-neutral-surface text-sm text-neutral-text-primary"
        >
          You&apos;re offline — change not saved.
        </div>
      )}

      {/* Progress-anchor gate toast (#362) */}
      {scheduleError && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-card border border-neutral-border bg-neutral-surface text-sm text-neutral-text-primary"
        >
          {scheduleError}
        </div>
      )}

      {/* Sprint Undo toast (#477 / ADR-0066 Q2) — fires after Duplicate inherits
          an ACTIVE sprint, gives the PM a one-click escape hatch. */}
      <ScheduleActionToastRenderer />

      {/* MS Project import modal (#68) — opened from the Project actions menu. */}
      {importOpen && projectId && (
        <ImportModal projectId={projectId} onClose={() => setImportOpen(false)} />
      )}

      {/* Export status toast (#68) — "Preparing…" while in flight, error after. */}
      {(isExporting || exportError) && (
        <div
          role={exportError ? 'alert' : 'status'}
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-card border border-neutral-border bg-neutral-surface text-sm text-neutral-text-primary"
        >
          {exportError ?? 'Preparing your export…'}
        </div>
      )}

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
          onClose={() => {
            setSelectedTaskId(null);
            // Drawer Esc closes the drawer with stopPropagation (drawer's own
            // listener at document level), which means the window-level Esc
            // binding in useScheduleKeyboard never fires to clear the hover
            // chain. Tie hover-clear to the drawer's close path so closing
            // via Esc, X, or click-outside all revert the canvas highlights.
            setHoveredTaskId(null);
            engine?.setHoverChain(null);
            // Also clear the engine's selection ring on connected arrows.
            engine?.selectTask(null);
          }}
        />
      )}

      {buildModeActive && (
        <BuildModeCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
      )}
    </div>
  );

  return buildModeActive ? (
    <BuildModeProvider api={buildModeApi}>{mainView}</BuildModeProvider>
  ) : (
    mainView
  );
}
