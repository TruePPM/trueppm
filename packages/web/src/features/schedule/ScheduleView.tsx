import {
  useRef,
  useCallback,
  useState,
  useEffect,
  useMemo,
  type ComponentProps,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  type PointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { setSearchParam } from '@/hooks/useUrlSelectedId';
import {
  AUTHOR_PARAM,
  AUTHOR_PARENT_PARAM,
  parseAuthorIntent,
  type AuthorIntent,
} from './authorParam';
import { findUndatedRow } from './buildMode/undatedNav';
import { ancestorIdsOf } from './unscheduledSelection';
import type { GanttEngine, GanttScaleData } from './engine';
import { dateToLeft, leftToDate, ZOOM_STEP_FACTOR } from './engine';
import { computeInitialFraming, type RowBar } from './scheduleUtils';
import { HEADER_HEIGHT, ROW_HEIGHT } from './scheduleConstants';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useProjectResourcePool } from '@/hooks/useProjectResourcePool';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useWbsStore } from '@/stores/wbsStore';
import { useDragCpm } from '@/hooks/useDragCpm';
import { useKeyboardReschedule } from '@/hooks/useKeyboardReschedule';
import { useDragStore } from '@/stores/dragStore';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { useScheduleChartPrefs, hiddenChartCountForView } from '@/hooks/useScheduleChartPrefs';
import {
  buildWbsTree,
  flattenVisible,
  collectAllIds,
  collectSubtree,
} from '@/features/grid/buildWbsTree';
import { formatToggleAnnouncement } from './wbsAnnouncement';
import { TaskListPanel, type TaskDepChips } from './TaskListPanel';
import { CanvasScheduleTimeline } from './CanvasScheduleTimeline';
import { timelineRowIndexAt } from './timelineRowHitTest';
import { useBuildMode } from './buildMode/BuildModeContext';
import { BuildModeRowMenu, type RowMenuItem } from './buildMode';
import { ZoomControl } from './ZoomControl';
import { QuarterModeControl } from './QuarterModeControl';
import { ScheduleViewModeToggle } from './ScheduleViewModeToggle';
import { ScheduleDisplayMenu } from './ScheduleDisplayMenu';
import { ScheduleSummaryChip } from './ScheduleSummaryChip';
import { ScheduleAddMilestoneButton } from './ScheduleAddMilestoneButton';
import { ScheduleAddPhaseButton } from './ScheduleAddPhaseButton';
import { ScheduleViewOnlyBadge } from './ScheduleViewOnlyBadge';
import { MilestonePulseOverlay } from './MilestonePulseOverlay';
import { ScheduleLegend } from './ScheduleLegend';
import { useScheduleKeyboard } from './useScheduleKeyboard';
import { claimHelpShortcut, isUndoShortcutClaimed } from '@/hooks/useGlobalShortcut';
import { inferNearestSummaryParent } from './inferMilestoneParent';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useBaselines, useCreateBaseline } from '@/hooks/useBaselines';
import { useSurfaceVisibility } from '@/hooks/useSurfaceVisibility';
import { ROLE_ADMIN, ROLE_SCHEDULER, canEditTask } from '@/lib/roles';
import { BaselineManagerModal } from './BaselineManagerModal';
import { TaskTrashDialog } from '@/features/project/TaskTrashDialog';
import { CaptureBaselineConfirmDialog } from './CaptureBaselineConfirmDialog';
import { SubtreeDeleteConfirmDialog } from './SubtreeDeleteConfirmDialog';
import { ScheduleForecastBar } from './ScheduleForecastBar';
import { ScheduleReconcileStrip } from './reconcile/ScheduleReconcileStrip';
import { useScheduleReconciliation } from './reconcile/useScheduleReconciliation';
import { reviewableTaskIds } from './reconcile/reconcileState';
import { MON_FRI_MASK } from './reconcile/reconcileCopy';
import { useReconcileStore } from '@/stores/reconcileStore';
import { MonteCarloGanttMarkers } from './MonteCarloGanttMarkers';
import { MobileMonteCarloCard } from './MobileMonteCarloCard';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { MilestoneDeltaTooltip } from './MilestoneDeltaTooltip';
import { DateInputPopover } from './DateInputPopover';
import { TaskFormModal } from '@/features/board/TaskFormModal';
import { RecalculatingBadge } from '@/features/project/RecalculatingBadge';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { UnscheduledGutter } from './UnscheduledGutter';
import { MobileSchedule } from './mobile/MobileSchedule';
import { useUnscheduledTasks } from '@/hooks/useUnscheduledTasks';
import { computePlannedByPhase, type PhasePlannedBadge } from './plannedByPhase';
import { computeRowModes, type RowMode } from './deliveryModePresentation';
import { ClassificationPopover } from './classification/ClassificationPopover';
import { BulkEditSheet } from './buildMode/bulkEdit/BulkEditSheet';
import { useBulkEdit } from './buildMode/bulkEdit/useBulkEdit';
import { useClassifySubtree, type ClassificationApply } from '@/hooks/useTaskClassification';
import { useUndoCascadeClassificationOperation, describeUndo } from '@/hooks/useBatchOperations';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  ToolbarOverflowMenu,
  type ToolbarOverflowItem,
} from '@/components/toolbar/ToolbarOverflowMenu';
import { ImportModal } from '@/components/import/ImportModal';
import { CsvImportWizard } from '@/components/import/CsvImportWizard';
import { EmptyState } from '@/components/EmptyState';
import { MethodologyEmptyState } from '@/features/shell/MethodologyEmptyState';
import { Button } from '@/components/Button';
import { QueryErrorState } from '@/components/QueryErrorState';
import { GanttIcon, FilePdfIcon } from '@/components/Icons';
import { useExportMsProject } from '@/hooks/useMsProjectImportExport';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { Methodology, Task } from '@/types';
import { useDependencyHover } from './useDependencyHover';
import { ScheduleDependencyPicker } from './ScheduleDependencyPicker';
import { PendingCrossProjectReview } from './PendingCrossProjectReview';
import { SeedBanner } from './SeedBanner';
import { NextStrip } from './NextStrip';
import { ScheduleCommitPopover } from './ScheduleCommitPopover';
import { BeforeProjectStartDialog } from './BeforeProjectStartDialog';
import { useScheduleCommit } from './useScheduleCommit';
import { useProject } from '@/hooks/useProject';
import { useSprints } from '@/hooks/useSprints';
import { computeSprintBands } from './sprintBands';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { SchedulePrintLayout } from './export/SchedulePrintLayout';
import { useScheduleExport } from './export/useScheduleExport';
import { ScheduleExportDialog } from './export/ScheduleExportDialog';
import { ShareViewDialog } from '@/features/share/ShareViewDialog';
import {
  useScheduleFocus,
  BuildModeProvider,
  BuildModeHintStrip,
  BuildModeCheatsheet,
  BlankProjectCanvas,
  BuildModePill,
  AuthorModePill,
  hasUnresolvedOwnerToken,
  findRowByPredicate,
  usePasteMany,
  PasteReceiptStrip,
  PasteColumnMappingDialog,
  isMultiRowPaste,
  type BuildModeApi,
} from './buildMode';
import { useScheduleAuthorMode, type ScheduleAuthorMode } from '@/hooks/useScheduleAuthorMode';
import {
  useScheduleDisplayOptions,
  type ScheduleDisplayOptions,
  type ScheduleDisplayOptionKey,
} from '@/hooks/useScheduleDisplayOptions';
import { ScheduleCoachBar } from './buildMode/ScheduleCoachBar';
import { ConversionNotice } from './buildMode/ConversionNotice';
import { ReforecastPanel } from './reforecast/ReforecastPanel';
import { ineligiblePredecessorIds } from './deps/cycleSafety';
import {
  useIndentTask,
  useOutdentTask,
  useUpdateTask,
  useDeleteTask,
  useRestoreTask,
  useCreateTask,
  useReorderTasks,
  useAddDependency,
  parseCyclicDependencyError,
  buildCopyName,
} from '@/hooks/useTaskMutations';
import { toast } from '@/components/Toast';
import { wbsParentPath, siblingIdsOf } from './buildMode/insertBelow';
import { isPhaseTask } from '@/lib/isPhaseTask';
import {
  indentSentence,
  outdentSentence,
  deleteSentence,
  milestoneSentence,
  type ActRow,
} from './trail/structuralActs';
import { useTrailStore } from './trail/trailStore';
import { SessionTrail } from './trail/SessionTrail';

// ---------------------------------------------------------------------------
// ScheduleEmptyState — shown when tasks.length === 0 (rule 78)
// ---------------------------------------------------------------------------

export function ScheduleEmptyState({ onAddTask }: { onAddTask?: () => void }) {
  return (
    <EmptyState
      className="h-full bg-neutral-surface"
      icon={GanttIcon}
      title="No tasks yet"
      description="Add tasks to lay out your schedule — the timeline, critical path, and forecast appear as soon as there's work to plan."
      // A discoverable create CTA (#2044) — mirrors Board's empty state so a new
      // user is never left hunting for the small toolbar "+ Task" button. Omitted
      // for read-only roles (Viewer), who have no create affordance to offer.
      action={
        onAddTask ? (
          <Button variant="primary" onClick={onAddTask}>
            + Add task
          </Button>
        ) : undefined
      }
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
  // SSR / no-DOM: treat as supported so the desktop canvas branch renders once
  // hydrated (matches the previous `typeof document !== 'undefined' ? … : true`).
  if (typeof document === 'undefined') return true;
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

// Display-menu labels for the toggleable task-list columns (#2097). The `task`
// column is always visible (locked) so it is deliberately absent.
const COLUMN_MENU_LABELS: Record<
  'wbs' | 'dur' | 'start' | 'finish' | 'progress' | 'owner',
  string
> = {
  wbs: 'WBS',
  dur: 'Duration',
  start: 'Start',
  finish: 'Finish',
  progress: '% Complete',
  owner: 'Owner',
};

// ---------------------------------------------------------------------------
// ScheduleView — extracted callback bodies (#2081). Moving the branch-heavy
// effect/handler logic to module scope keeps ScheduleView's own cognitive
// complexity in budget; behavior is verbatim.
// ---------------------------------------------------------------------------

type DomRef = { current: HTMLDivElement | null };
type AddDependencyMutation = ReturnType<typeof useAddDependency>;

/**
 * Horizontal offset for canvas overlays: 0 in Timeline mode (or the mobile
 * full-width override) where the task-list panel is hidden, else the panel's
 * total width so overlays clear the WBS table (#1221 / #1670).
 */
function schedulePanelWidth(effectiveViewMode: 'grid' | 'timeline', totalWidth: number): number {
  return effectiveViewMode === 'timeline' ? 0 : totalWidth;
}

/**
 * Focus a row by id once it mounts, retrying across animation frames — F8 /
 * Shift+F8 (#2727, ADR-0776 §3) can jump to a row far outside the
 * virtualized window, so a single `querySelector` right after triggering the
 * scroll usually misses (the row hasn't rendered yet). Bounded to ~10 frames
 * (~160ms at 60fps) so a stale/removed id can't spin forever.
 */
function focusRowByIdSoon(id: string, attemptsLeft = 10): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
    if (el) {
      el.focus();
      return;
    }
    if (attemptsLeft > 0) focusRowByIdSoon(id, attemptsLeft - 1);
  });
}

/**
 * The view mode to actually paint. Below md the desktop split-pane is unusable,
 * so phones are forced to full-width Timeline (#1670) without mutating the stored
 * `viewMode` — a rotate back to desktop restores the user's Grid/Timeline choice.
 */
function resolveEffectiveViewMode(
  isMobile: boolean,
  viewMode: 'grid' | 'timeline',
): 'grid' | 'timeline' {
  return isMobile ? 'timeline' : viewMode;
}

/** Project start + effective scheduling floor for the before-start prompt (#868/#884). */
function resolveProjectFloor(projectDetail: ReturnType<typeof useProject>['data']): {
  projectStartDate: string | null;
  effectiveFloorDate: string | null;
} {
  const projectStartDate = projectDetail?.start_date ?? null;
  return { projectStartDate, effectiveFloorDate: projectDetail?.start_floor ?? projectStartDate };
}

/**
 * Commit a canvas drag-to-link gesture (#1666) as an FS/0-lag dependency. Reads
 * the latest tasks + role from a ref so the effect can subscribe once per engine.
 * Server enforces cycle detection (400 cyclic_dependency) and self-link rejection.
 */
function commitCreateLink(
  { sourceId, targetId }: { sourceId: string; targetId: string },
  ctx: {
    createLinkStateRef: { current: { tasks: Task[]; readOnly: boolean } };
    addDep: AddDependencyMutation;
    ariaLiveRef: DomRef;
  },
) {
  const { tasks, readOnly: ro } = ctx.createLinkStateRef.current;
  if (ro) return; // viewers can't mutate — silently ignore
  const nameOf = (id: string) => tasks.find((t) => t.id === id)?.name ?? 'task';
  const sourceName = nameOf(sourceId);
  const targetName = nameOf(targetId);
  // Offline guard (rule 29): skip the mutation, stay calm — the preview was
  // already cleared on pointerup. One info toast, no arrow.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    toast.info('You’re offline — link not saved.');
    return;
  }
  ctx.addDep.mutate(
    { predecessor: sourceId, successor: targetId, dep_type: 'FS', lag: 0 },
    {
      onSuccess: () => {
        // Success is confirmed by the arrow itself (no visual toast); the
        // aria-live status is the accessible equivalent (rule 30).
        if (ctx.ariaLiveRef.current) {
          ctx.ariaLiveRef.current.textContent = `Linked ${sourceName} → ${targetName}.`;
        }
      },
      onError: (err) => {
        const cyc = parseCyclicDependencyError(err);
        if (cyc) {
          toast.error('Can’t link these — it would create a circular dependency.');
          if (ctx.ariaLiveRef.current) {
            ctx.ariaLiveRef.current.textContent = 'Could not link — circular dependency.';
          }
        } else {
          toast.error('Could not create the link. Try again.');
        }
      },
    },
  );
}

/**
 * Deep-link scroll + pulse (issue 734). Scrolls the `#task-<id>` target into view
 * (horizontally to its date, vertically to its row) and fires the milestone pulse.
 * Guarded by a ref so it fires once per hash, only after tree + scales are ready.
 */
function runTaskHashDeepLink(ctx: {
  hash: string;
  engine: GanttEngine | null;
  scheduleScales: GanttScaleData | null;
  visibleTasks: Task[];
  allTasks: Task[];
  canvasScrollRef: DomRef;
  handledHashRef: { current: string | null };
  setPulsingMilestoneAt: (v: { x: number; y: number }) => void;
  setPulsingMilestoneId: (id: string) => void;
}) {
  const match = /^#task-(.+)$/.exec(ctx.hash);
  if (!match) {
    ctx.handledHashRef.current = null;
    return;
  }
  if (ctx.handledHashRef.current === ctx.hash) return;
  if (!ctx.engine || !ctx.scheduleScales) return;
  const taskId = match[1];
  const rowIdx = ctx.visibleTasks.findIndex((t) => t.id === taskId);
  if (rowIdx < 0) return; // task/tree not loaded yet — retry on next render
  const target = ctx.allTasks.find((t) => t.id === taskId);
  const dateIso = target?.plannedStart ?? target?.finish ?? null;
  // Latch now so a later visibleTasks identity change can't re-fire the pulse.
  ctx.handledHashRef.current = ctx.hash;

  // Vertical: center the target row in the scroll viewport. Instant so the
  // pulse coordinates below read the settled scrollTop (a smooth animation
  // would leave the diamond ring anchored on a stale row position).
  const canvas = ctx.canvasScrollRef.current;
  let scrollTop = 0;
  if (canvas) {
    scrollTop = Math.max(0, rowIdx * ROW_HEIGHT + ROW_HEIGHT / 2 - canvas.clientHeight / 2);
    canvas.scrollTop = scrollTop;
  }

  // Horizontal + pulse: center the target date and ring the diamond. Instant
  // horizontal scroll keeps scrollLeft settled before the pulse re-renders
  // (the overlay subtracts scrollLeft at render time, rule §57).
  if (dateIso) {
    ctx.engine.scrollToDate(dateIso, 'instant');
    try {
      const x = dateToLeft(dateIso, ctx.scheduleScales);
      const y = HEADER_HEIGHT + rowIdx * ROW_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
      ctx.setPulsingMilestoneAt({ x, y });
      ctx.setPulsingMilestoneId(taskId);
    } catch {
      // dateToLeft can throw on out-of-range dates — skip the pulse.
    }
  }
}

/**
 * `?task=<id>` deep-link → open-drawer consume (issues #2031, #2232). Opens +
 * scrolls to a task the live param names when it isn't already the selection,
 * latching on `lastConsumedTaskParamRef` so a just-closed drawer never reopens.
 */
function consumeTaskParam(ctx: {
  taskParam: string | null;
  selectedTaskId: string | null;
  allTasks: Task[];
  lastConsumedTaskParamRef: { current: string | null };
  setSelectedTaskId: (id: string | null) => void;
  scrollToTask: (id: string) => void;
}) {
  const { taskParam } = ctx;
  if (!taskParam) {
    // Param cleared (drawer closed) — reset so a later re-link to the SAME
    // task is treated as a fresh deep-link and opens again.
    ctx.lastConsumedTaskParamRef.current = null;
    return;
  }
  if (taskParam === ctx.selectedTaskId) {
    // Drawer already reflects the param (mount consume, or our own mirror
    // after an in-app selection). Record it so the close→null transition
    // below doesn't reopen it.
    ctx.lastConsumedTaskParamRef.current = taskParam;
    return;
  }
  if (taskParam === ctx.lastConsumedTaskParamRef.current) return; // handled already
  // Wait for the task tree to load before deciding the id is unknown.
  if (ctx.allTasks.length === 0) return;
  ctx.lastConsumedTaskParamRef.current = taskParam;
  if (ctx.allTasks.some((t) => t.id === taskParam)) {
    ctx.setSelectedTaskId(taskParam);
    ctx.scrollToTask(taskParam);
  }
  // Unknown id: latch (don't retry) and leave the drawer closed.
}

// ---------------------------------------------------------------------------
// ScheduleView
// ---------------------------------------------------------------------------

export function ScheduleView() {
  // document.title for this route is set at the router level (router.tsx
  // `handle.title`) — see RouteTitle (issue 1915, completes #1327 A4).
  const projectId = useProjectId() ?? null;
  // `string | undefined` variant reused by the many hooks/props that want an
  // optional (rather than nullable) project id — computed once so each call site
  // isn't its own `?? undefined` expression.
  const projectIdUndef = projectId ?? undefined;
  const { tasks: rawTasks, links: rawLinks, isLoading, error } = useScheduleTasks();
  const { data: mcResult } = useMonteCarloResult(projectIdUndef);
  const allTasks = useMemo(() => rawTasks ?? [], [rawTasks]);
  const allLinks = useMemo(() => rawLinks ?? [], [rawLinks]);
  const { expandedIds, toggle: toggleExpandRaw, expandAll, expand } = useWbsStore();

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

  // URL-synced view state (issue #2046). Zoom/view-mode/column-widths already
  // persist (rule 43) but the display filters below were session-ephemeral — so
  // "send the stakeholder the critical-path-only view" was impossible as a link.
  // The display filters are mirrored into shareable query params; `?task=` (the
  // open drawer, issue #2031) round-trips through the same params object below.
  const [searchParams, setSearchParams] = useSearchParams();

  // Focus mode and CP-only filter (issue #131) — seeded from / mirrored to URL.
  const [focusModeEnabled, setFocusModeEnabled] = useState(() => searchParams.get('focus') === '1');
  const [showCpOnly, setShowCpOnly] = useState(() => searchParams.get('cp') === '1');

  // Render filters (#248) — toggle which bar types are drawn on the canvas.
  // Both keep summary tasks visible so the WBS hierarchy doesn't collapse.
  const [showCriticalOnly, setShowCriticalOnly] = useState(() => searchParams.get('crit') === '1');
  const [showMilestonesOnly, setShowMilestonesOnly] = useState(
    () => searchParams.get('ms') === '1',
  );
  // Mirror the display filters back into the URL so the filtered view is
  // shareable. Booleans are presence-encoded (`?cp=1`); false drops the key.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const setFlag = (key: string, on: boolean) => {
          if (on) next.set(key, '1');
          else next.delete(key);
        };
        setFlag('focus', focusModeEnabled);
        setFlag('cp', showCpOnly);
        setFlag('crit', showCriticalOnly);
        setFlag('ms', showMilestonesOnly);
        return next;
      },
      { replace: true },
    );
  }, [focusModeEnabled, showCpOnly, showCriticalOnly, showMilestonesOnly, setSearchParams]);

  // Chart presentation prefs (#2097) — dependency-line visibility, on-bar task
  // name placement, and progress-pill visibility. localStorage-backed, never URL
  // (URL stays reserved for shareable *data* filters focus/cp/crit/ms).
  const {
    prefs: chartPrefs,
    setDependencyLinesVisible,
    setTaskNamePlacement,
    setProgressPillsVisible,
    setSprintBandsVisible,
  } = useScheduleChartPrefs();

  // Filter links to critical-path only when showCpOnly is active, and drop them
  // entirely when the Chart menu hides dependency lines (#2097) — passing [] also
  // removes hidden arrows from hit-testing, not just paint.
  const links = useMemo(() => {
    if (!chartPrefs.dependencyLinesVisible) return [];
    return showCpOnly ? allLinks.filter((l) => l.isCritical) : allLinks;
  }, [allLinks, showCpOnly, chartPrefs.dependencyLinesVisible]);

  const recordTrailAct = useTrailStore((st) => st.record);

  // aria-live (polite) — drag announcements via DOM ref (rule 30)
  const ariaLiveRef = useRef<HTMLDivElement>(null);
  // aria-live (assertive) — keyboard nudge announcements; must interrupt immediately (rule 53)
  const ariaAssertiveRef = useRef<HTMLDivElement>(null);

  // Server-reconciliation markers (ADR-0784, #2725). The hook feeds the
  // full-snapshot path; the WebSocket delta path is wired in useProjectWebSocket.
  useScheduleReconciliation(projectId, allTasks);
  const reviewFilterActive = useReconcileStore((s) => s.reviewFilterActive);
  const reconcileEntries = useReconcileStore((s) => s.entries);
  // Dismissal is per-recompute: a new divergence re-opens the panel rather than
  // staying hidden because the planner closed the last one (#2965).
  const [reforecastDismissed, setReforecastDismissed] = useState(false);
  const setWorkingDaysMask = useReconcileStore((s) => s.setWorkingDaysMask);
  const setReviewFilter = useReconcileStore((s) => s.setReviewFilter);
  const reviewTaskIds = useMemo(() => reviewableTaskIds(reconcileEntries), [reconcileEntries]);

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
    // "Show N changes" (ADR-0784 §D8) — narrow to rows the server moved or
    // refused. Applied AFTER the render filters and, like them, keeping
    // summaries so the WBS hierarchy a reviewed row sits in stays legible.
    if (reviewFilterActive && reviewTaskIds.size > 0) {
      filtered = filtered.filter((t) => t.isSummary || reviewTaskIds.has(t.id));
    }
    return { visibleTasks: filtered, summaryIds: sIds, childCountById: counts };
  }, [
    allTasks,
    expandedIds,
    showCriticalOnly,
    showMilestonesOnly,
    reviewFilterActive,
    reviewTaskIds,
  ]);

  /**
   * Sprint-window bands for the canvas (#2738, ADR-0803).
   *
   * Computed from `visibleTasks` — the SAME array handed to the engine — because
   * bands are addressed by row index. Deriving them from `allTasks` would put a
   * band over the wrong rows the moment a filter, a collapsed phase, or the
   * milestones-only view changes what the canvas is actually drawing.
   *
   * Memoized so the identity is stable between renders: the engine compares by
   * reference and would otherwise restart the fade on every unrelated re-render.
   */
  const sprintBands = useMemo(
    () => computeSprintBands(visibleTasks, sprints),
    [visibleTasks, sprints],
  );

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

  // "N planned" phase badges (#1798). Attribute the sprint-assigned backlog
  // subset of the unscheduled set to its ancestor phase rows, then resolve
  // sprint ids to display names ordered to match the gutter's group ordering
  // (earliest-starting sprint first, so the badge's click target is the topmost
  // group). A phase with no such work is absent from the map → no badge.
  const plannedByPhase = useMemo(() => {
    const planned = unscheduledTasks.filter((t) => t.sprintId);
    const raw = computePlannedByPhase(planned, allTasks);
    const startOf = (id: string) => sprints.find((s) => s.id === id)?.start_date ?? '￿';
    const nameOf = (id: string) => sprintsById.get(id)?.name ?? 'Sprint';
    const out = new Map<string, PhasePlannedBadge>();
    for (const [phaseId, info] of raw) {
      const ordered = [...info.sprintIds].sort((a, b) => startOf(a).localeCompare(startOf(b)));
      out.set(phaseId, {
        count: info.count,
        primarySprintId: ordered[0] ?? null,
        sprintNames: ordered.map(nameOf),
      });
    }
    return out;
  }, [unscheduledTasks, allTasks, sprints, sprintsById]);

  // Delivery-mode gutters and chips (#2737). Computed over `allTasks`, not the
  // visible slice: a phase's mode is the union of its descendants' modes, so a
  // collapsed subtree still has to be walked or the parent would read as the
  // mode of whatever happens to be expanded.
  const rowModes = useMemo(() => computeRowModes(allTasks), [allTasks]);

  const zoomLevel = useScheduleStore((s) => s.zoomLevel);
  const selectedTaskId = useScheduleStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const scrollToTask = useScheduleStore((s) => s.scrollToTask);
  const viewMode = useScheduleStore((s) => s.viewMode);

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

  // Mobile Schedule layout (#1670): below md the desktop split-pane Gantt is
  // unusable — the ~220px task-list table crowds the canvas off the right edge.
  // Force full-width Timeline mode on phones (task names render inline on the
  // bars) so the canvas owns the whole width. This is a render-time layout
  // override only; it deliberately does not mutate the stored `viewMode`, so a
  // rotate back to desktop restores the user's Grid/Timeline preference. A
  // dedicated mobile-first surface is tracked in #1671.
  const effectiveViewMode = resolveEffectiveViewMode(isMobile, viewMode);

  // On-bar task-name placement is independent per view (#2107): resolve the
  // active view's choice here, then hand a single scalar to the engine and the
  // Display menu. (`effectiveViewMode`, not the stored `viewMode`, so mobile's
  // forced-Timeline layout paints and edits Timeline's placement.)
  const activeNamePlacement = chartPrefs.taskNamePlacementByView[effectiveViewMode];
  const hiddenChartCount = hiddenChartCountForView(
    chartPrefs,
    effectiveViewMode,
    sprintBands.length > 0,
  );

  // Engine chart options (name placement + progress pills). Dependency-line
  // visibility is handled by the `links` filter above, not here. The gutter is
  // drawn only in Timeline mode (table hidden) with the "Aligned left" choice —
  // in Grid mode the task table already carries the names.
  const chartOptions = useMemo(
    () => ({
      taskNamePlacement: activeNamePlacement,
      showProgressPills: chartPrefs.progressPillsVisible,
      showNameGutter: effectiveViewMode === 'timeline' && activeNamePlacement === 'left',
      showSprintBands: chartPrefs.sprintBandsVisible,
    }),
    [
      activeNamePlacement,
      chartPrefs.progressPillsVisible,
      chartPrefs.sprintBandsVisible,
      effectiveViewMode,
    ],
  );

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
    // Structural ineligibility (#2958): the row itself, its own subtree, and
    // anything that would close a loop — INCLUDING through the implicit edges a
    // gate and a phase carry, which have no dependency row to walk. Previously
    // the picker offered these and the server's cycle-detection 400 was the
    // first the user heard of it, with no way to tell which options were real.
    if (depPickerState.mode === 'predecessor') {
      for (const id of ineligiblePredecessorIds(
        depPickerState.task,
        allTasks,
        allLinks.map((l) => ({ sourceId: l.sourceId, targetId: l.targetId })),
      )) {
        ids.add(id);
      }
    }
    return ids;
  }, [depPickerState, allLinks, allTasks]);
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
    // Seeded with the first element (guaranteed present by the guard above) so
    // the max-fold never runs against an empty array.
    return finishes.reduce((a, b) => (a > b ? a : b), finishes[0]);
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
    // Re-attach when the task list remounts (Timeline→Grid toggle, issue 1221; or
    // the mobile full-width override, #1670): the panel unmounts in Timeline mode,
    // so the listener must bind to the new node.
  }, [effectiveViewMode]);

  // The canvas engine mounts only on the desktop branch (below `md` the
  // dedicated MobileSchedule surface renders instead, #1671/ADR-0348), so the
  // former #1787 mobile fitToProject special case is gone with the mobile canvas.
  //
  // Initial viewport framing (today at 25% from left, rule 81) is NOT done here.
  // onEngineReady fires at engine-construction time — before the React-driven
  // scroll spacer (`totalCanvasWidth`, from `scheduleScales`) has grown to its
  // full width — so `scrollWidth ≈ clientWidth`, `maxScroll` is ~0, and the
  // browser clamped the assignment to 0: the schedule opened at the project
  // start with all current/upcoming work scrolled off the right edge (#2004).
  // The framing now runs in a dedicated once-per-project effect below, gated on
  // `scheduleScales` (i.e. the spacer at full width).
  const handleEngineReady = useCallback((eng: GanttEngine) => {
    setEngine(eng);
  }, []);

  // Re-arm the one-shot initial framing whenever the project changes, so
  // switching projects re-frames on today rather than inheriting the prior
  // project's scroll (or a stale "already framed" flag).
  const didInitialFrameRef = useRef(false);
  useEffect(() => {
    didInitialFrameRef.current = false;
  }, [projectId]);

  // Apply the rule-81 "today at 25% from left" framing exactly once, after the
  // scale is built AND the scroll spacer has reached its full width. Keying on
  // `scheduleScales` guarantees the container is scrollable before we assign
  // `scrollLeft` (otherwise the browser clamps it to 0 — the #2004 race). The
  // ref makes it one-shot per project, so later `scales-change` emits (zoom,
  // pan) never yank the user back to today.
  useEffect(() => {
    if (didInitialFrameRef.current) return;
    if (!engine || !scheduleScales) return;
    const container = canvasScrollRef.current;
    if (!container) return;

    // Two readiness gates, both of which must leave the effect ARMED rather than
    // decide on incomplete input — deciding early and disarming would frame the
    // wrong way permanently, and deciding early without disarming is the race
    // that let a late fitToProject() yank a viewport the user had already zoomed.
    //
    // 1. Not scrollable yet: the scroll spacer has not reached full width (#2004),
    //    so maxScroll reads 0 and every offset would clamp to it.
    const maxScroll = container.scrollWidth - container.clientWidth;
    if (maxScroll <= 0) return;
    // 2. No tasks yet: coverage is a statement about the rows the user will see,
    //    which cannot be judged against an empty grid.
    if (visibleTasks.length === 0) return;

    const todayX = dateToLeft(new Date().toISOString().slice(0, 10), scheduleScales);

    // The rows that will actually be on screen at scrollTop = 0 — the ones whose
    // emptiness the user reads as "the schedule is broken" (#2423).
    const rowsInView = Math.max(
      1,
      Math.ceil((container.clientHeight - HEADER_HEIGHT) / ROW_HEIGHT),
    );
    const bars: (RowBar | null)[] = visibleTasks.slice(0, rowsInView).map((t) => {
      if (!t.start || !t.finish) return null;
      return { x0: dateToLeft(t.start, scheduleScales), x1: dateToLeft(t.finish, scheduleScales) };
    });

    const framing = computeInitialFraming(todayX, container.clientWidth, maxScroll, bars);

    // Past the gates every outcome is a real decision, so disarm before acting on
    // it: a later `visibleTasks` change must not re-frame and steal a viewport the
    // user has since zoomed or panned.
    didInitialFrameRef.current = true;

    // 'none' → today is entirely off the chart (a finished project); leave the
    // default project-start view.
    if (framing.kind === 'none') return;
    if (framing.kind === 'fit') {
      // Framing on today would have opened on mostly-empty canvas, so show the
      // project instead. fitToProject drives the engine's own scale, so the
      // container's scrollLeft is not ours to set here.
      engine.fitToProject();
    } else {
      container.scrollLeft = framing.scrollLeft;
    }
  }, [engine, scheduleScales, visibleTasks]);

  // Fetched ahead of the two preview hooks below because both need the
  // project's data date. Project start date also feeds the project-start floor
  // prompt (#868) — a reschedule before that date opens snap/move/cancel
  // instead of silently clamping.
  const { data: projectDetail } = useProject(projectIdUndef);
  // ADR-0132's data date (#2813): the floor the server applies to every
  // not-yet-finished task on the next CPM run. Resolved HERE rather than inside
  // the preview engine — the `?? today` half of the server's
  // `resolve_cpm_status_date()` — so the engine stays a pure function of its
  // inputs and its unit tests do not decay against the wall clock.
  const statusDate = projectDetail?.status_date ?? new Date().toISOString().slice(0, 10);

  // Drag CPM preview — wires engine events + Web Worker (issue #19). Uses the
  // full dependency graph (`allLinks`), NOT the paint-filtered `links`: the live
  // CPM ripple is a function of the real schedule, so hiding dependency lines or
  // applying CP-only (both presentation) must not blank the cascade preview (#2097).
  useDragCpm({
    engine,
    tasks: allTasks,
    links: allLinks,
    ariaLiveRef,
    keyboardModeRef,
    statusDate,
  });

  // Keyboard rescheduling — Enter/Arrow/d/Escape (issue #34)
  const handleOpenDatePopover = useCallback(
    (taskId: string) => {
      const task = allTasks.find((t) => t.id === taskId) ?? null;
      setDatePopoverTask(task);
    },
    [allTasks],
  );

  // Uses the full `allLinks` graph (not the paint-filtered `links`) so keyboard
  // rescheduling cascades through every real dependency regardless of view filters.
  useKeyboardReschedule({
    engine,
    tasks: allTasks,
    links: allLinks,
    ariaLiveRef,
    ariaAssertiveRef,
    keyboardModeRef,
    statusDate,
    onOpenDatePopover: handleOpenDatePopover,
  });

  // Pull-to-commit gate (ADR-0067 / #492). Drag-end and resize-end no longer
  // fire the PATCH directly: the bar visually moves via engine.updateTask, and
  // the popover holds the change until Confirm. Cancel/Esc/click-outside revert.
  // `projectStartDate` feeds the floor prompt; `effectiveFloorDate` is the first
  // working day >= start_date (#884), falling back to the literal start when the
  // detail field is absent (older payloads / list cache).
  const { projectStartDate, effectiveFloorDate } = resolveProjectFloor(projectDetail);
  // Server-resolved preset (web-rule 196) — AGILE hides this view's nav entry
  // (methodologyTabs.ts), but the route stays reachable by direct URL on purpose
  // (issue #2619). Drives the explanatory empty state below.
  const effectiveMethodology = projectDetail?.effective_methodology ?? 'HYBRID';

  // Publish the project's weekday mask to the reconciliation store so the two
  // leaf date cells can reach it without a prop chain through TaskListRow. It is
  // the only cause the client can actually prove (ADR-0784 §D5).
  const reconcileMask = projectDetail?.effective_calendar?.working_days ?? MON_FRI_MASK;
  useEffect(() => {
    setWorkingDaysMask(reconcileMask);
  }, [reconcileMask, setWorkingDaysMask]);

  const scheduleCommit = useScheduleCommit({
    engine,
    projectId,
    projectStartDate,
    effectiveFloorDate,
    // #2561: the resize popover's working-day count and its no-op guard need the
    // project's real weekday mask (ADR-0441 / #1987), not a Mon–Fri constant.
    workingDaysMask: projectDetail?.effective_calendar?.working_days ?? null,
    visibleTasks,
    allTasks,
    sprints,
    canvasContainerRef: canvasScrollRef,
    ariaAssertiveRef,
    onCommitSuccess: () => setMcMutationVersion((v) => v + 1),
  });

  const dragPhase = useDragStore((s) => s.phase);
  const scheduleError = useScheduleStore((s) => s.scheduleError);

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
  const canvasSupported = canvasIsSupported();

  // ──────────────────────────────────────────────────────────────────────
  // Build-mode (issues #338/#339/#341/#342, default since #2682/ADR-0054)
  // Hooks must be declared above all early returns. The provider + UI mount
  // whenever we are on the desktop happy path — mobile keeps the legacy
  // tap-to-edit surface (build mode's keyboard model doesn't map to touch).
  // ──────────────────────────────────────────────────────────────────────
  const buildModeActive = !isMobile;

  // Roster for the `@owner` authoring token (ADR-0774, #2718). Fetched only while build
  // mode is active — passing '' disables the query, so a plain read of the schedule does
  // not pay for a roster it has no surface to use. The rows resolve `@ana` against this
  // and nothing else: the scoping is what stops a name typed here binding work to
  // somebody who is a member of no project the author can see.
  const { data: resourcePool } = useProjectResourcePool(buildModeActive ? (projectId ?? '') : '');

  // Toolbar responsive tier (issue #568 / #1741, rules 110–114).
  //   lg → the Display trigger shows its full "Display ▾" label
  //   md/sm → the Display trigger collapses to icon-only (`iconOnly`)
  // The filters + column visibility live in the Display popover at every width
  // (web rule 243); only the Display trigger label collapses.
  const breakpoint = useBreakpoint();

  // Role gate for milestone insert (#340) — VIEWER cannot author.
  const {
    role: currentRole,
    isLoading: roleLoading,
    isError: roleError,
  } = useCurrentUserRole(projectIdUndef);
  // Pessimistic while the role loads (#2145): `canEditTask(null)` is false, so
  // every create control (+ Task / + Milestone / + Phase) stays disabled until
  // the role resolves — matching the pessimistic `canImport`/`canShare`/
  // `canCaptureBaseline` gates below rather than flashing enabled for the
  // non-member majority. The server is authoritative; this is the UX gate.
  // Alt+A Author/Read toggle (#2727, ADR-0776 §5) — a client-only, per-user
  // per-project preference layered on top of the server role gate below, not
  // a replacement for it. "Read" mode forces readOnly regardless of role.
  const authorMode = useScheduleAuthorMode(projectIdUndef);
  const { options: displayOptions, toggle: toggleDisplayOption } =
    useScheduleDisplayOptions(projectIdUndef);
  const { toggle: toggleAuthorMode } = authorMode;
  //
  // Two states that must never collapse into one (#2949, design handoff
  // "No edit rights"):
  //
  //   hasEditRights=false  a viewer. There is no mode to be in, because nothing
  //                        is on offer — the authoring apparatus is ABSENT, not
  //                        disabled, and a refused gesture stays silent.
  //   hasEditRights=true,  an editor who pressed ⌥A. The apparatus is PRESENT
  //   mode==='read'        and inert, and one key gets them back.
  //
  // Offering a control and then refusing it teaches a viewer the product is
  // broken; explaining a refusal to someone who never should have seen the
  // button is noise. `readOnly` still governs BEHAVIOR for both — this is
  // presentation only, and the server remains the thing that actually refuses.
  const hasEditRights = canEditTask(currentRole);
  const readOnly = !hasEditRights || authorMode.mode === 'read';
  // Per-project leaf-surface visibility (ADR-0193, issue 956): the in-Schedule
  // Monte-Carlo sub-surface reads the server-resolved values. Hide-only
  // (ADR-0041) — a false value hides the chrome; the underlying data is still computed
  // and the section stays reachable by direct URL.
  const surfaces = useSurfaceVisibility(projectIdUndef);
  const focus = useScheduleFocus();
  const setScheduleActionToast = useScheduleStore((s) => s.setScheduleActionToast);
  // Classification popover (#2736). `anchor` is captured from the row's own
  // rect at open time rather than tracked live: the popover is modalless but
  // short-lived, and re-anchoring it on every scroll tick would make it chase
  // the row out from under the cursor mid-choice.
  const [classifyState, setClassifyState] = useState<{
    taskId: string;
    anchor: { x: number; y: number };
  } | null>(null);
  const classifyMut = useClassifySubtree();
  const { reset: resetClassifyMut } = classifyMut;
  const undoClassifyMut = useUndoCascadeClassificationOperation(projectId);
  const indentTask = useIndentTask(projectId);
  const outdentTask = useOutdentTask(projectId);
  const updateTaskMut = useUpdateTask();
  const deleteTaskMut = useDeleteTask(projectId);
  const restoreTaskMut = useRestoreTask(projectId);
  const createTaskMut = useCreateTask(projectId);
  const reorderTaskMut = useReorderTasks(projectId);
  // Drag-to-link (#1666): the canvas `create-link` gesture lands here as an
  // FS/0-lag dependency create. Server enforces cycle detection (400
  // cyclic_dependency) and self-link rejection (ADR-0055); the arrow appears
  // via the mutation's cache invalidation, not an optimistic canvas draw.
  const addDep = useAddDependency(projectId);

  // Drag-to-link commit (#1666). The engine emits `create-link` on a valid
  // drop; turn it into an FS/0-lag dependency. Reads resolve from the latest
  // task list + role via a ref so the effect subscribes once per engine and
  // never goes stale.
  const createLinkStateRef = useRef({ tasks: allTasks, readOnly });
  createLinkStateRef.current = { tasks: allTasks, readOnly };
  useEffect(() => {
    if (!engine) return;
    return engine.on('create-link', (payload) =>
      commitCreateLink(payload, { createLinkStateRef, addDep, ariaLiveRef }),
    );
  }, [engine, addDep]);

  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);

  // MS Project import/export (#68). Import is gated on Project Admin to match
  // the server; export is allowed for any member. Admin is a high bar, so we
  // hide Import pessimistically while the role loads (currentRole === null) to
  // avoid flashing a forbidden action to the non-admin majority — per the
  // useCurrentUserRole pessimistic-gating contract. The server is authoritative.
  const [importOpen, setImportOpen] = useState(false);
  const canImport = currentRole !== null && currentRole >= ROLE_ADMIN;
  // CSV/Excel import (#746) is gated one rung lower than MS Project — at
  // Scheduler — because that is what ITS server requires (IsProjectScheduler,
  // ADR-0632). Same "match the server" rule as above, different server floor:
  // gating the wizard at Admin would hide it from Schedulers the API accepts.
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const canImportCsv = currentRole !== null && currentRole >= ROLE_SCHEDULER;
  // `?import=csv` deep link (#2710) — how "Create & import spreadsheet" in the
  // new-project flow lands the user in the wizard instead of on an empty project.
  //
  // An effect rather than a useState initializer, because the permission gate is
  // the point: `currentRole` is null on first render, so an initializer would
  // either open the wizard before the role is known or need the same gate anyway.
  // Waiting for the role means a pasted link cannot get a Viewer past
  // `canImportCsv` — the deep link is a shortcut through the *navigation*, never
  // through the authorization (the server gate at IsProjectScheduler is the real
  // boundary; this keeps the UI from disagreeing with it).
  //
  // The ref makes it one-shot: without it, closing the wizard while the param is
  // still in the URL for a commit would immediately reopen it — the same trap
  // `?task=` documents just below.
  const importParamConsumedRef = useRef(false);
  useEffect(() => {
    if (importParamConsumedRef.current) return;
    if (searchParams.get('import') !== 'csv') return;
    if (currentRole === null) return; // role still resolving — decide, don't guess
    importParamConsumedRef.current = true;
    if (canImportCsv) setCsvImportOpen(true);
    // Strip the param either way, so a refresh (or a back-navigation after the
    // import finishes) does not reopen the wizard, and a denied link does not
    // sit in the URL looking like it might still work.
    setSearchParam(setSearchParams, 'import', null);
  }, [searchParams, currentRole, canImportCsv, setSearchParams]);

  // `?templateApplication=` deep link (#2731, ADR-0799 §1) — how a waterfall/
  // hybrid template apply lands the user on the Schedule with the seed banner
  // already polling, instead of the CSV wizard's Overview fallback. One-shot,
  // same reasoning as the `?import=csv` param above: consumed into local state
  // once, then stripped so a refresh does not reopen a banner for an apply the
  // user may have already dismissed or undone.
  const [seedApplicationId, setSeedApplicationId] = useState<string | null>(null);
  const seedParamConsumedRef = useRef(false);
  useEffect(() => {
    if (seedParamConsumedRef.current) return;
    const applicationId = searchParams.get('templateApplication');
    if (!applicationId) return;
    seedParamConsumedRef.current = true;
    setSeedApplicationId(applicationId);
    setSearchParam(setSearchParams, 'templateApplication', null);
  }, [searchParams, setSearchParams]);
  // Public share links (#1486): mint/manage is Admin+ (mirrors board sharing). The
  // instance/workspace kill switch is enforced server-side — the dialog surfaces the
  // verbatim 403 detail if sharing is off, so the button never silently no-ops.
  const [shareOpen, setShareOpen] = useState(false);
  const canShare = currentRole !== null && currentRole >= ROLE_ADMIN;

  // Baselines (#1864, ADR-0376) — capture is an Admin+ Actions-menu action;
  // the manager (list/activate/delete) is reachable by any project member. The
  // client gate is UX only; the server is authoritative (create → IsProjectAdmin).
  const [baselineManagerOpen, setBaselineManagerOpen] = useState(false);
  const [captureBaselineConfirmOpen, setCaptureBaselineConfirmOpen] = useState(false);
  // "Recently deleted" task Trash (#2494, ADR-0689) — the durable counterpart to the
  // delete Undo toast. Any member may open it; per-row Restore is server-gated.
  const [taskTrashOpen, setTaskTrashOpen] = useState(false);
  const canCaptureBaseline = currentRole !== null && currentRole >= ROLE_ADMIN;
  const createBaselineMut = useCreateBaseline(projectIdUndef);
  // Name of the current active baseline (if any) so the capture confirm dialog
  // tells the truth: the FIRST baseline auto-activates, but capturing while one
  // is already active is a plain snapshot that does not reactivate (#2215).
  const { data: baselines } = useBaselines(projectIdUndef);
  const activeBaselineName = baselines?.find((b) => b.is_active)?.name;
  const handleCaptureBaseline = useCallback(() => {
    // The overflow menu closes on select, so the educational confirm dialog
    // (not the menu item) carries the in-flight "Capturing…" state (web-rule
    // 209); the toast carries the end state (web-rule 183).
    if (!navigator.onLine) {
      toast.info("You're offline — reconnect to capture a baseline.");
      return;
    }
    createBaselineMut.mutate(
      {},
      {
        onSuccess: (b) => {
          toast.success(`Captured ${b.name}`);
          setCaptureBaselineConfirmOpen(false);
        },
        onError: () => toast.error("Couldn't capture baseline — try again."),
      },
    );
  }, [createBaselineMut]);
  const { exportProject, isExporting, error: exportError } = useExportMsProject(projectId);

  // Schedule PDF export (issue 1438, ADR-0233; builds on issue 1437). The button,
  // options dialog, and generation states live in `useScheduleExport`; ScheduleView
  // only renders them and the off-screen print surface below. Options thread into
  // the same buildSchedulePrintData / SchedulePrintLayout / exportSchedulePdf
  // pipeline — no re-fetch, no new compute (ADR-0188).
  const { user: currentUser } = useCurrentUser();

  // "Visible window" range: clip the export to whatever is scrolled into view when
  // Export is opened, derived from the engine scale + the scroll-container width
  // (no engine method needed, ADR-0233 §4).
  const getVisibleWindow = useCallback(() => {
    const eng = engine;
    const el = canvasScrollRef.current;
    if (!eng?.scales || !el) return null;
    const width = el.clientWidth;
    if (width <= 0) return null;
    return {
      start: leftToDate(eng.scrollLeft, eng.scales).toISOString().slice(0, 10),
      end: leftToDate(eng.scrollLeft + width, eng.scales)
        .toISOString()
        .slice(0, 10),
    };
  }, [engine]);

  const scheduleExport = useScheduleExport({
    projectName: projectDetail?.name ?? 'Schedule',
    projectKey: projectDetail?.code || null,
    workspaceUrl: typeof window !== 'undefined' ? window.location.origin : null,
    userName: currentUser?.display_name ?? null,
    tasks: allTasks,
    links: allLinks,
    sprints,
    forecast: mcResult ?? null,
    getVisibleWindow,
    visibleWindowAvailable: engine?.scales != null,
    // WYSIWYG: if dependency lines are hidden in-app, open export with arrows off (#2097).
    initialArrows: chartPrefs.dependencyLinesVisible,
  });
  const { openDialog: openExportDialog, canExport: canExportSchedule } = scheduleExport;

  // ⌘⇧E / Ctrl+Shift+E opens the export dialog. Ignored while typing in a field
  // and below `md` (export is a desk task, hidden on phones).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'e' || e.key === 'E'))) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }
      if (breakpoint === 'sm' || !canExportSchedule) return;
      e.preventDefault();
      openExportDialog();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [breakpoint, canExportSchedule, openExportDialog]);

  // Subtree-delete confirm (#2029). Deleting a summary/phase row takes its whole
  // WBS subtree with it, and the Undo below can only recover the row itself —
  // never its descendants — so a one-key Backspace on a phase is unrecoverable.
  // Gate that specific case behind a confirm that names the descendant count.
  const [pendingSubtreeDelete, setPendingSubtreeDelete] = useState<{
    id: string;
    name: string;
    count: number;
  } | null>(null);

  // The Undo handler for a build-mode delete, extracted so the delete toast's
  // onClick is a single call rather than a mutate-inside-onClick-inside-onSuccess
  // stack (keeps the callback nesting shallow).
  //
  // Faithful restore (#2078, ADR-0494): the server un-tombstones the whole graph
  // — the task under its original id, its is_subtask subtree, its dependency edges,
  // and its assignments — so Undo is truthful and the copy is a plain "Restored"
  // regardless of subtree size (no more create-a-new-row approximation or the
  // "subtasks were not recovered" caveat).
  const undoBuildModeDelete = useCallback(
    (taskId: string) => {
      restoreTaskMut.mutate(taskId, {
        onSuccess: () => {
          focus.focusRow(taskId);
          setScheduleActionToast({ message: 'Restored', durationMs: 2000 });
        },
        onError: () => {
          setScheduleActionToast({ message: 'Couldn’t restore the task.' });
        },
      });
    },
    [restoreTaskMut, focus, setScheduleActionToast],
  );

  /**
   * Say what a structural act did — once, to both audiences (#2948).
   *
   * The screen reader hears it through the existing polite region (rule 30 —
   * deliberately reusing that channel rather than adding a second one, which
   * would double-announce), and it joins the session trail so the change is
   * still there to inspect after three more edits.
   *
   * One helper rather than a call at each site precisely so the two can never
   * drift: an act that announces but leaves no trail entry, or the reverse, is
   * the failure this is meant to prevent.
   */
  const recordAct = useCallback(
    (sentence: string) => {
      if (ariaLiveRef.current) ariaLiveRef.current.textContent = sentence;
      if (projectId) recordTrailAct(projectId, sentence);
    },
    [projectId, recordTrailAct],
  );

  /** A row reduced to what a sentence needs: its name and what travels with it. */
  const actRow = useCallback(
    (taskId: string): ActRow => {
      const task = allTasks.find((t) => t.id === taskId);
      return {
        name: task?.name ?? '',
        descendantCount: childCountById.get(taskId)?.count ?? 0,
      };
    },
    [allTasks, childCountById],
  );

  // The actual build-mode delete + Undo toast, factored out so both the fast
  // path (leaf rows, no confirm) and the confirmed subtree path share it.
  // `descendantCount` only sizes the "Deleted X and its N subtasks" message; the
  // Undo itself is a faithful server restore (#2078), so the recovery copy is a
  // plain "Restored" whether or not a subtree was involved.
  const performBuildModeDelete = useCallback(
    (taskId: string, descendantCount: number, onDeleted?: () => void) => {
      if (!projectId) {
        deleteTaskMut.mutate(taskId);
        return;
      }
      const snapshot = allTasks.find((t) => t.id === taskId);
      deleteTaskMut.mutate(taskId, {
        onSuccess: () => {
          onDeleted?.();
          if (!snapshot) return;
          // The trail entry is written on SUCCESS, not on the click: a delete
          // that the server refused must not leave a record claiming it
          // happened (#2948).
          recordAct(
            deleteSentence({ name: snapshot.name, descendantCount: descendantCount }),
          );
          const label = snapshot.name || 'Untitled task';
          const subtaskSuffix =
            descendantCount > 0
              ? ` and its ${descendantCount} subtask${descendantCount === 1 ? '' : 's'}`
              : '';
          setScheduleActionToast({
            message: `Deleted “${label}”${subtaskSuffix}`,
            action: {
              label: 'Undo',
              onClick: () => undoBuildModeDelete(taskId),
            },
          });
        },
      });
    },
    [projectId, allTasks, deleteTaskMut, undoBuildModeDelete, setScheduleActionToast, recordAct],
  );

  // The one task, if any, that `insertBelow`/`insertAbove`/`insertChild` just
  // created and whose Name cell hasn't been touched yet — see
  // `isPristineNewRow` on BuildModeApi.
  const [pristineNewRowId, setPristineNewRowId] = useState<string | null>(null);

  // The one task, if any, whose Name cell should focus with the caret at the
  // END of its text rather than the usual select-all — set right after
  // `mergeIntoPreviousRow` deletes an empty row and lands here (#2727).
  const [caretAtEndRowId, setCaretAtEndRowId] = useState<string | null>(null);

  // Shared create step for the three Enter variants (#2727). Non-blank
  // placeholder name (mirrors handleAddFirstTask / handleAddPhaseFirstChild):
  // the API rejects a blank name at create (Task.name has no blank=True) —
  // a blank-name payload made Enter silently create nothing against a real
  // backend (#2682 follow-up finding). Inherits the source row's delivery
  // mode so the new row doesn't silently fall back to the server default; a
  // per-task calendar override doesn't exist on the wire today, so there is
  // nothing to inherit there (ADR-0776).
  const createNewTask = useCallback(
    (
      parentId: string | null,
      sourceTask: Task | undefined,
      onCreated?: (created: { id: string }) => void,
    ) => {
      createTaskMut.mutate(
        {
          name: 'New task',
          duration: 1,
          parent_id: parentId,
          ...(sourceTask?.deliveryMode ? { delivery_mode: sourceTask.deliveryMode } : {}),
        },
        {
          // Drop straight into the new row's Name cell in edit mode so Enter
          // always ends with the cursor in an editable Name cell. The row
          // mounts after the tasks cache invalidates; the focus reducer state
          // is applied when TaskListRow renders and reads it.
          onSuccess: (created) => {
            focus.focusRow(created.id);
            focus.enterCellEdit(created.id, 'name');
            setPristineNewRowId(created.id);
            onCreated?.(created);
          },
          onError: () => toast.error("Couldn't add a new task — try again."),
        },
      );
    },
    [createTaskMut, focus],
  );

  const buildModeApi = useMemo<BuildModeApi>(
    () => ({
      focus,
      indent: (taskId) => {
        // Capture BEFORE the mutation: the sentence describes the tree as it
        // was, and whether the row above is about to change identity is only
        // knowable from the pre-move state.
        const row = actRow(taskId);
        const idx = allTasks.findIndex((t) => t.id === taskId);
        const prev = idx > 0 ? allTasks[idx - 1] : undefined;
        const prevBecomesPhase = prev != null && !prev.isSummary;
        indentTask.mutate(taskId);
        if (prev) {
          recordAct(indentSentence(row, { name: prev.name }, prevBecomesPhase));
        }
      },
      outdent: (taskId) => {
        const row = actRow(taskId);
        const parent = allTasks.find((t) => t.id === allTasks.find((x) => x.id === taskId)?.parentId);
        outdentTask.mutate(taskId);
        if (parent) recordAct(outdentSentence(row, { name: parent.name }));
      },
      insertBelow: (taskId) => {
        // Enter creates a SIBLING of the focused row — same parent, same depth
        // (#1666). The previous behavior ignored the arg and created at the WBS
        // root, which was the "broken Enter binding" this fixes. Position within
        // the parent is append-only for v1: the server appends the new row at the
        // end of the parent's children (no `after_id` positioning yet) — which is
        // where a plain "below" sibling belongs anyway, no reorder needed.
        if (!projectId) return;
        const focused = allTasks.find((t) => t.id === taskId);
        const parentId = focused?.parentId ?? null;
        createNewTask(parentId, focused);
      },
      insertAbove: (taskId) => {
        // Shift+Enter (#2727): same depth as insertBelow, but the new row must
        // land immediately BEFORE the focused row. The create endpoint only
        // appends at the end of the parent's children (v1, no `after_id`), so
        // this composes create + the existing reorder endpoint — same pattern
        // Alt+↑/↓ already uses for moving a row among its siblings.
        if (!projectId) return;
        const focused = allTasks.find((t) => t.id === taskId);
        if (!focused) return;
        const parentId = focused.parentId ?? null;
        const siblingIdsBeforeCreate = siblingIdsOf(allTasks, parentId);
        createNewTask(parentId, focused, (created) => {
          const idx = siblingIdsBeforeCreate.indexOf(taskId);
          const ordered =
            idx === -1
              ? [...siblingIdsBeforeCreate, created.id]
              : [
                  ...siblingIdsBeforeCreate.slice(0, idx),
                  created.id,
                  ...siblingIdsBeforeCreate.slice(idx),
                ];
          reorderTaskMut.mutate({ parent_path: wbsParentPath(focused.wbs), ordered_ids: ordered });
        });
      },
      insertChild: (taskId) => {
        // ⌘/Ctrl+Enter (#2727): one level deeper than the focused row, which
        // becomes that child's parent. The focused row becomes a summary as a
        // side effect of gaining a child — `isSummary` is server-derived from
        // having children, not a settable flag, so nothing else to toggle.
        if (!projectId) return;
        const focused = allTasks.find((t) => t.id === taskId);
        createNewTask(taskId, focused);
      },
      isPristineNewRow: (taskId) => taskId === pristineNewRowId,
      clearPristineNewRow: (taskId) => setPristineNewRowId((cur) => (cur === taskId ? null : cur)),
      convertToMilestone: (taskId) => {
        if (!projectId) return;
        const row = actRow(taskId);
        updateTaskMut.mutate({ id: taskId, projectId, duration: 0 });
        recordAct(milestoneSentence(row, true));
      },
      duplicateSubtree: (taskId) => {
        // ⌘D / Ctrl+D / row menu Duplicate (#2727, ADR-0776 §2, amending
        // ADR-0066 §Q1). Multi-select: duplicate every top-level selected
        // node as its own subtree root — a selected node whose ancestor is
        // also selected is skipped, since it's already covered by that
        // ancestor's walk.
        if (!projectId) return;
        const tree = buildWbsTree(allTasks);
        const taskById = new Map(allTasks.map((t) => [t.id, t]));
        const selected = focus.state.selectedIds;
        const hasAncestorSelected = (id: string): boolean => {
          let cur = taskById.get(id)?.parentId ?? null;
          while (cur) {
            if (selected?.has(cur)) return true;
            cur = taskById.get(cur)?.parentId ?? null;
          }
          return false;
        };
        const rootIds =
          selected && selected.size > 1 && selected.has(taskId)
            ? [...selected].filter((id) => !hasAncestorSelected(id))
            : [taskId];

        void (async () => {
          for (const rootId of rootIds) {
            const subtree = collectSubtree(tree, rootId);
            if (subtree.length === 0) continue;
            const [rootNode, ...descendants] = subtree;
            const rootSiblingNames = allTasks
              .filter((t) => t.parentId === rootNode.task.parentId)
              .map((t) => t.name);
            // Dependencies are never cloned — extended uniformly to every
            // duplicated node, including edges internal to the duplicated
            // subtree (ADR-0066 §Q1, amended here rather than special-cased
            // away). Only the root's name gets the "(copy)" suffix;
            // descendants move with the subtree unchanged.
            const idMap = new Map<string, string>();
            try {
              const rootCreated = await createTaskMut.mutateAsync({
                name: buildCopyName(rootNode.task.name, rootSiblingNames),
                duration: rootNode.task.duration,
                parent_id: rootNode.task.parentId,
                sprint: rootNode.task.sprintId ?? null,
                is_milestone: rootNode.task.isMilestone,
                ...(rootNode.task.deliveryMode
                  ? { delivery_mode: rootNode.task.deliveryMode }
                  : {}),
              });
              idMap.set(rootNode.task.id, rootCreated.id);
              const rootSprint = rootNode.task.sprintId
                ? sprintsById.get(rootNode.task.sprintId)
                : undefined;
              if (rootSprint && rootSprint.state === 'ACTIVE') {
                setScheduleActionToast({
                  message: `Added to ${rootSprint.name}`,
                  action: {
                    label: 'Undo',
                    onClick: () => {
                      updateTaskMut.mutate({ id: rootCreated.id, projectId, sprint: null });
                      setScheduleActionToast({ message: 'Moved to backlog', durationMs: 2000 });
                    },
                  },
                });
              }
              for (const node of descendants) {
                if (!node.task.parentId) continue; // unreachable — every descendant has a parent within the subtree
                const newParentId = idMap.get(node.task.parentId);
                if (!newParentId) continue;
                const created = await createTaskMut.mutateAsync({
                  name: node.task.name,
                  duration: node.task.duration,
                  parent_id: newParentId,
                  sprint: node.task.sprintId ?? null,
                  is_milestone: node.task.isMilestone,
                  ...(node.task.deliveryMode ? { delivery_mode: node.task.deliveryMode } : {}),
                });
                idMap.set(node.task.id, created.id);
              }
            } catch {
              toast.error("Couldn't duplicate the task — try again.");
              return;
            }
          }
        })();
      },
      deleteTask: (taskId) => {
        // Leaf rows delete immediately with the Undo safety net (#1762) — the
        // fast daily build path. But a summary/phase row carries a WBS subtree
        // that Undo cannot bring back, so gate that case behind a confirm that
        // names the descendant count (#2029). `childCountById` only holds
        // summaries, so a plain leaf never trips the guard.
        const summary = childCountById.get(taskId);
        if (summary && summary.count > 0) {
          setPendingSubtreeDelete({
            id: taskId,
            name: summary.name || 'Untitled task',
            count: summary.count,
          });
          return;
        }
        performBuildModeDelete(taskId, 0);
      },
      mergeIntoPreviousRow: (taskId) => {
        // Backspace on an empty row (#2727): delete it and land the caret at
        // the end of the previous VISIBLE row's Name cell — the outliner
        // "backspace merges into the line above" convention. No-op if this is
        // already the first visible row (nothing above to merge into). A
        // blank-named row that still carries a subtree falls back to the
        // ordinary subtree-confirm gate (the merge is skipped, not the
        // delete) — the same safe default `deleteTask` already uses.
        const idx = visibleTasks.findIndex((t) => t.id === taskId);
        if (idx <= 0) return;
        const prevTask = visibleTasks[idx - 1];
        const summary = childCountById.get(taskId);
        if (summary && summary.count > 0) {
          setPendingSubtreeDelete({
            id: taskId,
            name: summary.name || 'Untitled task',
            count: summary.count,
          });
          return;
        }
        performBuildModeDelete(taskId, 0, () => {
          focus.focusRow(prevTask.id);
          focus.enterCellEdit(prevTask.id, 'name');
          setCaretAtEndRowId(prevTask.id);
        });
      },
      isCaretAtEndRow: (taskId) => taskId === caretAtEndRowId,
      clearCaretAtEndRow: (taskId) => setCaretAtEndRowId((cur) => (cur === taskId ? null : cur)),
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
    [
      focus,
      indentTask,
      outdentTask,
      updateTaskMut,
      deleteTaskMut,
      createNewTask,
      reorderTaskMut,
      projectId,
      allTasks,
      visibleTasks,
      childCountById,
      performBuildModeDelete,
      pristineNewRowId,
      caretAtEndRowId,
      createTaskMut,
      sprintsById,
      setScheduleActionToast,
      actRow,
      recordAct,
    ],
  );

  // Paste-many (#2724): spreadsheet rows pasted into the outline, hierarchy
  // read from leading indentation. Scoped to the row the author is sitting on
  // — same "sibling, same depth" target `insertBelow` uses for Enter.
  const pasteMany = usePasteMany({
    projectId,
    resourcePool: resourcePool ?? [],
    allTasks,
    focusedRowId: focus.state.rowId,
    onFocusRow: focus.focusRow,
  });

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
  const inferredParentId = useMemo(
    () => inferNearestSummaryParent(buildModeFocusedRowId ?? selectedTaskId, visibleTasks),
    [buildModeFocusedRowId, selectedTaskId, visibleTasks],
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

  // "+ Phase" (epic #1752, issue #1754, ADR-0293): the create-empty-then-nest
  // flow decided in ux-design. A phase is emergent — it becomes true only once
  // the row has a structural (non-subtask) child — so a freshly inserted
  // summary row is a "phase-in-waiting" until then. Track those ids for this
  // session (sessionStorage, project-scoped) so the row can render the ghost
  // "Add first task to this phase" affordance; a reload before adding a child
  // just shows a normal (legitimately childless) row — no functional loss,
  // per the ux-design decision that an empty phase-in-waiting persists fine.
  const phaseInWaitingKey = projectId ? `trueppm.schedule.phaseInWaiting.${projectId}` : null;
  const [phaseInWaitingIds, setPhaseInWaitingIds] = useState<Set<string>>(() => {
    if (!phaseInWaitingKey) return new Set();
    try {
      const raw = window.sessionStorage.getItem(phaseInWaitingKey);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    if (!phaseInWaitingKey) return;
    try {
      window.sessionStorage.setItem(
        phaseInWaitingKey,
        JSON.stringify(Array.from(phaseInWaitingIds)),
      );
    } catch {
      // sessionStorage may be disabled — in-memory state still governs the hint.
    }
  }, [phaseInWaitingKey, phaseInWaitingIds]);

  // Drop an id once it becomes a real phase (gained a structural child) or was
  // deleted — keeps the persisted set from growing unbounded across a session.
  useEffect(() => {
    if (phaseInWaitingIds.size === 0) return;
    setPhaseInWaitingIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        const t = allTasks.find((x) => x.id === id);
        if (!t || isPhaseTask(t, allTasks)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTasks]);

  // Rows still awaiting their first structural child — the set the row
  // renders the ghost affordance from (already filtered to "still waiting",
  // so TaskListRow only needs a plain `.has(id)` check).
  const visiblePhaseInWaitingIds = useMemo(() => {
    const out = new Set<string>();
    for (const id of phaseInWaitingIds) {
      const t = allTasks.find((x) => x.id === id);
      if (t && !isPhaseTask(t, allTasks)) out.add(id);
    }
    return out;
  }, [phaseInWaitingIds, allTasks]);

  // The row's inline rename input (TaskListRow's local `isEditing`, the
  // always-available "double-click to rename" path) is what actually drops a
  // freshly created row into edit mode on mobile, where build mode is not
  // active — `focus.enterCellEdit` below only does anything when the
  // `BuildModeProvider` is mounted (buildModeActive, i.e. desktop).
  // Tracking one pending id here (rather than relying on focus.enterCellEdit
  // alone) is what makes "+ Phase" work on mobile too, not just on desktop.
  // Cleared as soon as the matching row consumes it so scrolling a
  // virtualized row back into view can never re-trigger edit mode.
  const [pendingAutoEditId, setPendingAutoEditId] = useState<string | null>(null);

  const handleAddPhase = useCallback(() => {
    if (!projectId || readOnly) return;
    // Same insertion point as "+ Task" / "+ Milestone" (inferredParentId) — a
    // phase can itself nest inside another phase. Non-blank placeholder name
    // (mirrors handleAddFirstTask below): the API rejects a blank name at
    // create, so the row opens straight into cell-edit for the user to
    // overwrite.
    //
    // "Untitled phase", not "New phase" (#2952 vocabulary lock). The word is
    // transient — the row opens select-all in cell-edit — but if the user
    // abandons the edit it becomes a real committed name, and "Untitled" reads
    // as the state it is rather than as a name someone might mistake for their
    // own.
    createTaskMut.mutate(
      { name: 'Untitled phase', duration: 1, parent_id: inferredParentId },
      {
        onSuccess: (data) => {
          setPhaseInWaitingIds((prev) => {
            const next = new Set(prev);
            next.add(data.id);
            return next;
          });
          focus.focusRow(data.id);
          focus.enterCellEdit(data.id, 'name');
          if (!buildModeActive) setPendingAutoEditId(data.id);
        },
      },
    );
  }, [projectId, readOnly, createTaskMut, inferredParentId, focus, buildModeActive]);

  // Ghost "⊕ Add first task to this phase" affordance (phase-in-waiting hint,
  // TaskListRow). Creates a structural (is_subtask: false, the default)
  // child nested one WBS level under the phase row — the first such child is
  // what flips `isPhaseTask` true and retires the hint.
  const handleAddPhaseFirstChild = useCallback(
    (phaseTaskId: string) => {
      if (!projectId) return;
      createTaskMut.mutate(
        { name: 'New task', duration: 1, parent_id: phaseTaskId },
        {
          onSuccess: (data) => {
            focus.focusRow(data.id);
            focus.enterCellEdit(data.id, 'name');
            if (!buildModeActive) setPendingAutoEditId(data.id);
          },
        },
      );
    },
    [projectId, createTaskMut, focus, buildModeActive],
  );

  // `?author=task|milestone` deep link (#2952, design case 18). The demotion of
  // the seven creation surfaces: each stays an entry point and each lands HERE,
  // with the caret in a new row, instead of owning its own modal form.
  //
  // One-shot via a ref for the same reason `?import=csv` and
  // `?templateApplication=` are: without it, a refresh — or a back-navigation
  // after the user has already named the row — creates a SECOND row. That is
  // worse than the reopened-dialog case those two guard against, because this
  // param's effect is a write.
  //
  // Waits for `readOnly` to be decided rather than guessing. `readOnly` is
  // derived from a role query that has not resolved on first paint, so acting
  // immediately would create nothing for an editor and silently swallow the
  // link. Deciding late is correct; deciding wrong is not.
  const authorParamConsumedRef = useRef(false);
  const [authorParamSpent, setAuthorParamSpent] = useState(false);
  useEffect(() => {
    if (authorParamConsumedRef.current) return;
    const intent: AuthorIntent | null = parseAuthorIntent(searchParams.get(AUTHOR_PARAM));
    if (!intent) return;
    // Gate on `isLoading`/`isError`, NOT on `currentRole === null`. The two are
    // different questions and only one of them means "wait": a NON-MEMBER also
    // has a null role, forever, so gating on the value would leave `?author=`
    // in their URL permanently, re-arming on every navigation. A failed role
    // read is not a permission verdict either (#2909, #2961) — `retry: false`
    // means an editor's blipped request would otherwise settle to `isLoading:
    // false` and get read as "resolved: read-only", silently spending the
    // param and creating nothing. Leaving it unconsumed on error costs one
    // fresh attempt on the next mount instead of losing the link outright.
    if (roleLoading || roleError) return; // unsettled — decide, don't guess
    authorParamConsumedRef.current = true;
    // Spend the param either way — including when the answer is "you may not
    // author here". A link that resolved to a refusal must not sit in the URL
    // looking like it might still work.
    setAuthorParamSpent(true);
    if (readOnly) return;
    if (intent === 'milestone') {
      setShowAddMilestone(true);
      return;
    }
    // `under` when the caller named a container, otherwise the outline's own
    // insertion point — the shell's context-free "+ New task" states intent, it
    // does not override where a row belongs.
    createNewTask(searchParams.get(AUTHOR_PARENT_PARAM) ?? inferredParentId, undefined);
  }, [
    searchParams,
    roleLoading,
    roleError,
    readOnly,
    createNewTask,
    inferredParentId,
    setShowAddMilestone,
  ]);

  // Strip in a LATER commit, and both keys in ONE updater. Two traps, both live:
  //
  //  * A `setSearchParams` issued from the same commit that consumed the param
  //    is silently lost. The display-filter mirror effect above writes
  //    focus/cp/crit/ms on the mount pass, and react-router resolves each
  //    updater's `prev` from the live location rather than from a queue — so
  //    within one commit the later write wins outright and restores the
  //    pre-strip params, `author` included. This is the #2031 class, and
  //    `setSearchParam`'s "functional updaters compose" only holds across
  //    commits, not within one.
  //  * For the same reason, two `setSearchParam` calls for two keys in one
  //    commit lose the first. Hence one updater deleting both.
  useEffect(() => {
    if (!authorParamSpent) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(AUTHOR_PARAM);
        next.delete(AUTHOR_PARENT_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [authorParamSpent, setSearchParams]);

  // Deep-link scroll + pulse (issue 734). The sprint→schedule bridge link
  // (AdvancingToMilestoneCard) navigates to `/projects/:id/schedule#task-{id}`.
  // On arrival, scroll the target task into view — horizontally to its date,
  // vertically to its row — and fire the milestone pulse so the one
  // cross-surface jump lands on a visibly highlighted diamond rather than an
  // arbitrary scroll position. Guarded by a ref so it fires once per hash and
  // only after the task tree + scales are ready (it re-attempts on the render
  // where they load, then latches).
  const { hash } = useLocation();
  const handledHashRef = useRef<string | null>(null);
  useEffect(() => {
    runTaskHashDeepLink({
      hash,
      engine,
      scheduleScales,
      visibleTasks,
      allTasks,
      canvasScrollRef,
      handledHashRef,
      setPulsingMilestoneAt,
      setPulsingMilestoneId,
    });
  }, [hash, engine, scheduleScales, visibleTasks, allTasks]);

  // `?task=<id>` deep-link ⇄ open-drawer round-trip (issues #2031, #2232).
  // Notifications and My Work rows navigate to `/projects/:id/schedule?task=<id>`.
  // The LIVE query param — not just its mount-time value — is the source of
  // truth for the drawer: whenever it names a task that isn't the current
  // selection, open + scroll to it. Reading the live param (rather than a
  // captured mount ref) is what makes the link work when the user is ALREADY on
  // the schedule and clicks a notification for another task (#2232): the earlier
  // mount-ref version never re-consumed the new param, and the mirror below then
  // stripped it back to a bare `/schedule`.
  const taskParam = searchParams.get('task') || null;
  // The id of the last `?task=` value we acted on. Keying the consume on this
  // (not just `param !== selection`) is what stops the effect from *reopening* a
  // task the user just closed: on close, `selectedTaskId` drops to null while
  // the URL param still reads `<id>` for one commit, so a bare disagreement
  // check would re-open it (#2232 regression the direct-mount test caught).
  const lastConsumedTaskParamRef = useRef<string | null>(null);
  useEffect(() => {
    consumeTaskParam({
      taskParam,
      selectedTaskId,
      allTasks,
      lastConsumedTaskParamRef,
      setSelectedTaskId,
      scrollToTask,
    });
  }, [taskParam, selectedTaskId, allTasks, setSelectedTaskId, scrollToTask]);
  // Mirror an explicit drawer-selection change back into `?task=` so a refresh
  // or link-copy round-trips. Fire ONLY on a real selection transition (tracked
  // via a ref) — never on a navigation that merely changed `setSearchParams`
  // identity, which would strip a fresh deep-link param before the consume
  // effect above (possibly still waiting on the task tree) can open it (#2232).
  const mirroredSelectionRef = useRef(selectedTaskId);
  useEffect(() => {
    if (mirroredSelectionRef.current === selectedTaskId) return;
    mirroredSelectionRef.current = selectedTaskId;
    setSearchParam(setSearchParams, 'task', selectedTaskId);
  }, [selectedTaskId, setSearchParams]);

  // #2736. Anchored to the row's own DOM rect so the popover opens beside what
  // it is about to classify; falls back to the viewport's top-left quadrant
  // when the row is virtualized out (⌘⇧M can fire on a row scrolled off-screen).
  const handleClassifyRequest = useCallback(
    (taskId: string) => {
      if (readOnly) return;
      resetClassifyMut();
      const row = document.querySelector<HTMLElement>(`[data-row-id="${taskId}"]`);
      const rect = row?.getBoundingClientRect();
      setClassifyState({
        taskId,
        anchor: rect ? { x: rect.left + 24, y: rect.bottom + 4 } : { x: 120, y: 160 },
      });
    },
    [readOnly, resetClassifyMut],
  );

  const closeClassify = useCallback(() => setClassifyState(null), []);

  const classifyTarget = useMemo(
    () => (classifyState ? (allTasks.find((t) => t.id === classifyState.taskId) ?? null) : null),
    [classifyState, allTasks],
  );

  /**
   * Render the server's own report, not the client's preview.
   *
   * The preview predicted what would happen; this states what did. They agree
   * in every case the mirror is correct, and when they don't, the receipt is
   * the one that is true — which is why the toast is built from `report` and
   * never from the popover's state.
   */
  // ADR-0810 (#2756): reverses one cascade via its operation ledger — the server
  // skips any row reclassified again since (e.g. a second cascade, or a person
  // hand-editing the axis) rather than blindly stomping it.
  const undoClassify = useCallback(
    (operationId: string) => {
      undoClassifyMut.mutate(operationId, {
        onSuccess: (data) => setScheduleActionToast({ message: describeUndo(data.undo) }),
        onError: () => setScheduleActionToast({ message: "Couldn't undo the cascade." }),
      });
    },
    [undoClassifyMut, setScheduleActionToast],
  );

  const handleClassifyApply = useCallback(
    (spec: ClassificationApply) => {
      if (!projectId) return;
      classifyMut.mutate(
        { projectId, ...spec },
        {
          onSuccess: (report) => {
            setClassifyState(null);
            const parts: string[] = [];
            if (report.governance) parts.push(`governance → ${report.governance.requested}`);
            if (report.delivery_mode) parts.push(`delivery → ${report.delivery_mode.requested}`);
            const written =
              (report.governance?.applied ?? 0) + (report.delivery_mode?.applied ?? 0);
            const kept = report.governance?.overrides_kept ?? 0;
            const detail = [
              `${written} field${written === 1 ? '' : 's'} written across ${report.matched} row${report.matched === 1 ? '' : 's'}`,
              kept > 0 ? `${kept} governance override${kept === 1 ? '' : 's'} kept` : null,
              report.skipped.length > 0
                ? `${report.skipped.length} milestone${report.skipped.length === 1 ? '' : 's'} left alone`
                : null,
            ]
              .filter(Boolean)
              .join(' · ');
            const operationId = report.operation_id;
            setScheduleActionToast({
              message: `Classified: ${parts.join(', ')} — ${detail}.`,
              durationMs: 8000,
              action: operationId
                ? { label: 'Undo', onClick: () => undoClassify(operationId) }
                : undefined,
            });
          },
        },
      );
    },
    [projectId, classifyMut, setScheduleActionToast, undoClassify],
  );

  // ⌘⇧K bulk-edit sheet (#2756 pt.2, ADR-0810) — acts on exactly the rows
  // #2727's selection holds, never their descendants (that scope is ⌘⇧M).
  const bulkEdit = useBulkEdit({
    projectId,
    focus,
    visibleTasks,
    readOnly,
    focusRowById: focusRowByIdSoon,
  });

  /**
   * Schedule many unscheduled rows at once — the gutter's "Schedule N…" button
   * (#2987). The tray names the problem with a count; this is the route from
   * that count to the sheet that already knows how to write dates in one batch.
   *
   * The three steps before the selection are not optional. `selectedTasks`
   * resolves against `visibleTasks`, which is the WBS tree flattened through
   * `expandedIds` and then narrowed by the render filters — so a target row in a
   * collapsed phase, or one hidden by an active critical/milestone/review
   * filter, is absent from that array and would be dropped from the batch
   * silently. "Selected 18, edited 4" is the failure this prevents.
   *
   * Clearing a filter the user switched on is a state change they did not ask
   * for, so it is announced rather than done quietly.
   */
  const handleScheduleMany = useCallback(
    (taskIds: string[]) => {
      if (readOnly || !projectId || taskIds.length === 0) return;

      const ancestors = ancestorIdsOf(allTasks, taskIds);
      if (ancestors.length > 0) expand(ancestors);

      const filtersWereActive = showCriticalOnly || showMilestonesOnly || reviewFilterActive;
      if (filtersWereActive) {
        setShowCriticalOnly(false);
        setShowMilestonesOnly(false);
        setReviewFilter(false);
      }

      // Order is load-bearing, in both directions.
      //
      // `focusRow` FIRST: `SELECT_IDS` returns the state untouched when the mode
      // is `NoSelection` or no row is focused, and it anchors the selection on
      // `state.rowId`. Clicking the tray's button from an idle Schedule is
      // exactly that state, so selecting before focusing is a silent no-op.
      //
      // `selectIds` SECOND: `FOCUS_ROW` sets `selectedIds: null` by design — a
      // plain focus collapses a multi-row selection, which is how a planner
      // escapes one. Focusing after selecting would throw the batch away and
      // open the sheet over a single row.
      //
      // Deliberately NOT `focusRowByIdSoon`: that helper retries `el.focus()`
      // across ~10 animation frames, so on the branch this handler exists to
      // serve (a row inside a collapsed phase, mounting a frame or two after the
      // expand) it lands *after* the sheet's focus trap has seated focus and
      // drags focus out of an open modal.
      focus.focusRow(taskIds[0]);
      focus.selectIds(taskIds);
      // `openForIds`, not `open`: `open` guards on the selection captured in this
      // render's closure, which predates the `selectIds` dispatch above.
      bulkEdit.openForIds(taskIds);

      if (ariaLiveRef.current) {
        const n = taskIds.length;
        const selected = `${n} unscheduled ${n === 1 ? 'row' : 'rows'} selected.`;
        ariaLiveRef.current.textContent = filtersWereActive
          ? `Render filters cleared so all ${n} rows are selectable. ${selected}`
          : selected;
      }
    },
    [
      readOnly,
      projectId,
      allTasks,
      expand,
      showCriticalOnly,
      showMilestonesOnly,
      reviewFilterActive,
      setReviewFilter,
      focus,
      bulkEdit,
    ],
  );

  const keyBindings = useMemo<Record<string, (e: KeyboardEvent) => void>>(() => {
    const out: Record<string, (e: KeyboardEvent) => void> = {};
    out['mod+m'] = (e) => {
      if (!projectId || readOnly) return;
      e.preventDefault();
      handleAddMilestone();
    };
    out['mod+p'] = (e) => {
      if (!projectId || readOnly) return;
      e.preventDefault();
      handleAddPhase();
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
      // Alt+A Author/Read toggle (#2727, ADR-0776 §5).
      out['alt+a'] = (e) => {
        e.preventDefault();
        toggleAuthorMode();
      };
      // ⌘⇧M / Ctrl+Shift+M (#2736): declare the hybrid split for the focused
      // row's subtree. Targets the FOCUSED row, not the multi-row selection:
      // the cascade endpoint takes one subtree root and resolves descendants
      // itself, so an arbitrary selection has no single root to name. The
      // popover's own "Cascade to descendants" toggle is the scope control.
      out['mod+shift+m'] = (e) => {
        if (readOnly) return;
        const rowId = focus.state.rowId;
        if (!rowId) return;
        e.preventDefault();
        handleClassifyRequest(rowId);
      };
      // ⌘⇧K (#2756 pt.2): bulk-edit every selected row. Build-mode only — the
      // selection it acts on only exists there. `open` is a no-op with nothing
      // selected and nothing focused, so the key never opens an empty sheet.
      out['mod+shift+k'] = (e) => {
        if (readOnly) return;
        e.preventDefault();
        bulkEdit.open();
      };
      // F8 / Shift+F8 (#2727, ADR-0776 §3; extended by #2724): jump to the
      // next/previous visible row that needs attention — an unresolved
      // @owner token, or (while a paste-many receipt is showing) a row that
      // paste couldn't resolve a duration for. No-op when nothing matches.
      // Non-destructive — this only moves focus.
      out['f8'] = (e) => {
        e.preventDefault();
        const target = findRowByPredicate(
          visibleTasks,
          focus.state.rowId,
          'forward',
          (task) =>
            hasUnresolvedOwnerToken(task.name, resourcePool ?? []) ||
            pasteMany.needsDurationIds.has(task.id),
        );
        if (!target) return;
        focus.focusRow(target.id);
        useScheduleStore.getState().scrollToTask(target.id);
        focusRowByIdSoon(target.id);
      };
      out['shift+f8'] = (e) => {
        e.preventDefault();
        const target = findRowByPredicate(
          visibleTasks,
          focus.state.rowId,
          'backward',
          (task) =>
            hasUnresolvedOwnerToken(task.name, resourcePool ?? []) ||
            pasteMany.needsDurationIds.has(task.id),
        );
        if (!target) return;
        focus.focusRow(target.id);
        useScheduleStore.getState().scrollToTask(target.id);
        focusRowByIdSoon(target.id);
      };
      // F7 / Shift+F7 (#2733): jump to the next/previous visible row that still
      // needs a committed date, wrapping around. Rows without dates are legal, so
      // this is navigation, not error triage — it just makes the "needs dates"
      // count actionable instead of decorative.
      //
      // F7 rather than the F8 the design handoff names: F8 is already "next
      // unresolved @owner" (#2727, ADR-0776 §3), shipped and in the cheatsheet.
      // The handoff predates it. See undatedNav.ts.
      out['f7'] = (e) => {
        e.preventDefault();
        const target = findUndatedRow(visibleTasks, focus.state.rowId, 'forward');
        if (!target) return;
        focus.focusRow(target.id);
        useScheduleStore.getState().scrollToTask(target.id);
        focusRowByIdSoon(target.id);
      };
      out['shift+f7'] = (e) => {
        e.preventDefault();
        const target = findUndatedRow(visibleTasks, focus.state.rowId, 'backward');
        if (!target) return;
        focus.focusRow(target.id);
        useScheduleStore.getState().scrollToTask(target.id);
        focusRowByIdSoon(target.id);
      };
      // ⌘Z / Ctrl+Z (#2724): undo the most recent paste-many batch while its
      // receipt strip is still up. Claimed only while a receipt is showing —
      // otherwise this falls through to the browser's ordinary undo so a
      // build-mode session with no pending paste never loses that behavior.
      if (pasteMany.receipt) {
        out['mod+z'] = (e) => {
          // Yield to a nearer claimant (#2892): the CSV import wizard renders as a
          // sibling of the receipt strip and binds ⌘Z to its own destructive undo.
          // Registration order and `preventDefault()` cannot arbitrate between two
          // listeners on different targets — the claim registry can.
          if (isUndoShortcutClaimed()) return;
          e.preventDefault();
          pasteMany.undo();
        };
      }
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
  }, [
    projectId,
    readOnly,
    handleAddMilestone,
    handleAddPhase,
    buildModeActive,
    toggleAuthorMode,
    focus,
    visibleTasks,
    resourcePool,
    engine,
    setSelectedTaskId,
    pasteMany,
    handleClassifyRequest,
    bulkEdit,
  ]);
  useScheduleKeyboard(keyBindings);

  // Paste-many (#2724): a multi-row clipboard paste while sitting on a row
  // (not mid cell-edit, which keeps its own single-value paste) is intercepted
  // and routed through usePasteMany instead of the browser default, which
  // would otherwise try to paste into whatever's focused — usually nothing,
  // since a row-focused element isn't itself editable.
  useEffect(() => {
    if (!buildModeActive || readOnly) return;
    const handlePasteEvent = (e: ClipboardEvent) => {
      if (focus.state.mode === 'CellEdit') return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!isMultiRowPaste(text)) return;
      e.preventDefault();
      pasteMany.handlePaste(text);
    };
    window.addEventListener('paste', handlePasteEvent);
    return () => window.removeEventListener('paste', handlePasteEvent);
  }, [buildModeActive, readOnly, focus.state.mode, pasteMany]);

  // In build mode the Schedule binds `?` to its own cheatsheet; claim `?` so the
  // global help hotkey (useHelpShortcut) yields here and the two never both open
  // (#2058). Outside build mode the Schedule has no `?` binding, so the global
  // modal remains reachable.
  useEffect(() => {
    if (!buildModeActive) return;
    return claimHelpShortcut();
  }, [buildModeActive]);

  // Blank project (#2733): commit the outline's live draft row. Unlike
  // handleAddFirstTask below this does NOT open the cell editor afterwards — the
  // draft input keeps the caret itself so a second row can be typed immediately,
  // and stealing focus into a freshly-created row's editor would interrupt that.
  const handleCommitDraftRow = useCallback(
    (name: string) => {
      if (!projectId || readOnly) return;
      createTaskMut.mutate({ name, duration: 1 });
    },
    [projectId, readOnly, createTaskMut],
  );

  // The project's stated facts, shown beside the horizon so the ruler is legible
  // — gridlines with no named calendar behind them explain nothing (#2733).
  const blankProjectFacts = useMemo(
    () => ({
      startDate: projectDetail?.start_date ?? null,
      calendarName: projectDetail?.effective_calendar?.name ?? null,
      defaultMode: projectDetail?.effective_methodology ?? null,
      views: projectDetail?.default_view ? [projectDetail.default_view] : [],
    }),
    [projectDetail],
  );

  // Mobile owns its own error/loading/empty states inside MobileSchedule
  // (#1671), so these desktop-only early returns are skipped below md — the
  // mobile branch in `mainView` renders the phone skeleton/error instead.
  if (error && !isMobile) {
    return <QueryErrorState message="Couldn't load tasks." />;
  }

  if ((isLoading || !rawTasks) && !isMobile) {
    return (
      <div
        className="flex h-full bg-neutral-surface"
        aria-busy="true"
        aria-label="Loading Schedule"
      >
        <div className="w-[280px] flex-shrink-0 border-r border-white/10 p-2 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-7 rounded-card motion-safe:animate-pulse bg-brand-primary/10"
            />
          ))}
        </div>
        <div className="flex-1 bg-neutral-surface" />
      </div>
    );
  }

  if (!canvasSupported && !isMobile) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-end px-4 h-10 border-b border-neutral-border bg-neutral-surface-raised flex-shrink-0">
          <ZoomControl onFit={() => engine?.fitToProject()} />
        </div>

        <div className="flex flex-1 overflow-hidden">
          <TaskListPanel
            childCountById={childCountById}
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

  // Horizontal anchor for canvas overlays (legend, unscheduled gutter, milestone
  // pulse). In Timeline mode (issue 1221) — or the mobile full-width override
  // (#1670) — the task-list panel is hidden, so the canvas starts at the
  // container's left edge and these overlays must offset by 0.
  const panelWidth = schedulePanelWidth(effectiveViewMode, totalWidth);

  const mainView = (
    <div className="flex flex-col h-full overflow-hidden">
      <h1 className="sr-only">Schedule</h1>
      <ScheduleToolbar
        hasEditRights={hasEditRights}
        displayOptions={displayOptions}
        onToggleDisplayOption={toggleDisplayOption}
        isMobile={isMobile}
        projectId={projectId}
        readOnly={readOnly}
        showAddForm={showAddForm}
        setShowAddForm={setShowAddForm}
        handleAddMilestone={handleAddMilestone}
        handleAddPhase={handleAddPhase}
        createPending={createTaskMut.isPending}
        buildModeActive={buildModeActive}
        authorMode={authorMode.mode}
        onToggleAuthorMode={authorMode.toggle}
        setCheatsheetOpen={setCheatsheetOpen}
        pendingCount={pendingTaskIds.size}
        projectDetail={projectDetail}
        visibleTasks={visibleTasks}
        effectiveViewMode={effectiveViewMode}
        showCpOnly={showCpOnly}
        setShowCpOnly={setShowCpOnly}
        focusModeEnabled={focusModeEnabled}
        setFocusModeEnabled={setFocusModeEnabled}
        showCriticalOnly={showCriticalOnly}
        setShowCriticalOnly={setShowCriticalOnly}
        showMilestonesOnly={showMilestonesOnly}
        setShowMilestonesOnly={setShowMilestonesOnly}
        visible={visible}
        toggleColumn={toggleColumn}
        chartPrefs={chartPrefs}
        setDependencyLinesVisible={setDependencyLinesVisible}
        activeNamePlacement={activeNamePlacement}
        setTaskNamePlacement={setTaskNamePlacement}
        setProgressPillsVisible={setProgressPillsVisible}
        // Offered only when the project actually has a window to draw — an
        // inert checkbox on a pure waterfall plan is a control that lies (#2738).
        setSprintBandsVisible={sprintBands.length > 0 ? setSprintBandsVisible : undefined}
        hiddenChartCount={hiddenChartCount}
        breakpoint={breakpoint}
        handleScrollToToday={handleScrollToToday}
        engine={engine}
        canImport={canImport}
        isExporting={isExporting}
        exportProject={exportProject}
        scheduleExport={scheduleExport}
        canShare={canShare}
        canCaptureBaseline={canCaptureBaseline}
        setImportOpen={setImportOpen}
        canImportCsv={canImportCsv}
        setCsvImportOpen={setCsvImportOpen}
        setShareOpen={setShareOpen}
        setCaptureBaselineConfirmOpen={setCaptureBaselineConfirmOpen}
        setBaselineManagerOpen={setBaselineManagerOpen}
        setTaskTrashOpen={setTaskTrashOpen}
      />

      {/* Downstream consent banner (ADR-0120 D2, #1480): shows only when another
          team has proposed inert cross-project links against this project's
          tasks. Renders nothing otherwise — safe to mount unconditionally. */}
      {projectId && <PendingCrossProjectReview projectId={projectId} currentRole={currentRole} />}

      {/* Seed banner (#2731, ADR-0799 §1) — the plan and the fastest way to
          disagree with it, mounted the moment a waterfall/hybrid template apply
          lands here via `?templateApplication=`. Renders nothing while the
          application is still pending/running or once undone — safe to mount
          unconditionally ahead of that gate. */}
      {projectId && seedApplicationId && (
        <SeedBanner
          projectId={projectId}
          applicationId={seedApplicationId}
          tasks={allTasks}
          currentRole={currentRole}
          onDismiss={() => setSeedApplicationId(null)}
        />
      )}

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

      <ScheduleMainArea
        isMobile={isMobile}
        allTasks={allTasks}
        projectId={projectId}
        readOnly={readOnly}
        isLoading={isLoading}
        error={error}
        setShowAddForm={setShowAddForm}
        timelineContainerRef={timelineContainerRef}
        effectiveViewMode={effectiveViewMode}
        visibleTasks={visibleTasks}
        pendingTaskIds={pendingTaskIds}
        taskListScrollRef={taskListScrollRef}
        widths={widths}
        visible={visible}
        setWidth={setWidth}
        totalWidth={totalWidth}
        summaryIds={summaryIds}
        expandedIds={expandedIds}
        toggleExpand={toggleExpand}
        focusChainIds={focusChainIds}
        depChipsById={depChipsById}
        setHoveredTaskId={setHoveredTaskId}
        hoveredTaskId={hoveredTaskId}
        handleAddDependencyRequest={handleAddDependencyRequest}
        sprintsById={sprintsById}
        visiblePhaseInWaitingIds={visiblePhaseInWaitingIds}
        handleAddPhaseFirstChild={handleAddPhaseFirstChild}
        pendingAutoEditId={pendingAutoEditId}
        setPendingAutoEditId={setPendingAutoEditId}
        plannedByPhase={plannedByPhase}
        resourcePool={resourcePool}
        buildModeActive={buildModeActive}
        handleCommitDraftRow={handleCommitDraftRow}
        handleImportFile={() => setCsvImportOpen(true)}
        blankProjectFacts={blankProjectFacts}
        canvasScrollRef={canvasScrollRef}
        handleCanvasScroll={handleCanvasScroll}
        links={links}
        sprintBands={sprintBands}
        zoomLevel={zoomLevel}
        chartOptions={chartOptions}
        handleEngineReady={handleEngineReady}
        mcResult={mcResult}
        scheduleScales={scheduleScales}
        panelWidth={panelWidth}
        unscheduledTasks={unscheduledTasks}
        sprints={sprints}
        effectiveMethodology={effectiveMethodology}
        rowModes={rowModes}
        onClassifyRequest={readOnly ? undefined : handleClassifyRequest}
        onScheduleMany={readOnly ? undefined : handleScheduleMany}
      />

      {/* Contextual hint strip (#1250, web rule 194): render only while the user
          is actively engaged (RowFocused / CellEdit). When idle (NoSelection) the
          strip is unmounted so ScheduleForecastBar sits flush at the bottom and the
          P50/P80/P95 signal isn't subordinated by always-on discoverability chrome.
          The always-on BuildModePill in the toolbar remains the discovery affordance. */}
      {/* The coach teaches the gestures a static screen cannot show — the row
          controls only appear on hover, so nothing else can announce them
          (#2959). Dismissible, and restorable from Display options; the strip it
          replaces could only ever be dismissed. */}
      {/* One line, once per row, when a task's identity changes under its author
          (#2951). The parked estimate is real (ADR-0844) but invisible without
          this. */}
      {hasEditRights && <ConversionNotice tasks={allTasks} />}

      {/* What moved and why (#2965) — the question a planner has after the
          per-row markers (#2725) tell them THAT something changed. */}
      {!reforecastDismissed && (
        <ReforecastPanel
          entries={reconcileEntries}
          links={allLinks}
          tasks={allTasks}
          cpmFinish={cpmFinish}
          p80={mcResult?.p80 ?? null}
          onDismiss={() => setReforecastDismissed(true)}
        />
      )}

      {buildModeActive && hasEditRights && displayOptions.coach && (
        <ScheduleCoachBar
          onDismiss={() => toggleDisplayOption('coach')}
          onShowCheatsheet={() => setCheatsheetOpen(true)}
        />
      )}

      {buildModeActive && focus.state.mode !== 'NoSelection' && (
        <BuildModeHintStrip
          mode={focus.state.mode}
          selectionCount={focus.state.selectedIds?.size ?? 0}
          onShowCheatsheet={() => setCheatsheetOpen(true)}
        />
      )}

      {/* Single consolidated forecast surface (ADR-0144, web rule 189) — one
          docked bottom bar owns the percentiles (rendered once), the histogram,
          the sensitivity tornado, and the run-history disclosure. Replaces the
          former MonteCarloRow + ScheduleInsightsBar two-surface split that
          rendered the percentiles up to three times and disagreed on the day. */}
      {/* No role gate (#2492). The forecast is a read surface: the server grants
          it to any project member (Viewer+ — `IsProjectMember` on run_monte_carlo
          and MonteCarloHistoryView), and MobileMonteCarloCard below is ungated.
          A Member+ gate here denied a Viewer on desktop the one number they came
          for, while a phone showed it. Scheduler+ still governs *writing* the
          attributed MonteCarloRun history row (#1502) — that is enforced server-
          side and is not a surface gate. */}
      {/* Reconciliation review strip (ADR-0784, #2725). Deliberately its own
          strip and deliberately UNGATED: the forecast bar below is behind
          `surfaces.monte_carlo`, renders an empty state when no simulation has
          run, and is `hidden md:flex`. Folding the "N dates changed"
          announcement into it would mean a project with Monte Carlo off — or
          simply never run — never learns the server moved its dates. */}
      <ScheduleReconcileStrip workingDaysMask={reconcileMask} projectFinish={cpmFinish} />

      {/* Next strip (#2731, ADR-0799 §4) — a few things worth doing, derived from
          the plan rather than a static checklist. Renders nothing once nothing
          untouched-seeded is worth flagging — safe to mount unconditionally,
          same idiom as the reconcile strip above it. */}
      <NextStrip tasks={allTasks} links={allLinks} />

      {surfaces.monte_carlo && (
        <ScheduleForecastBar
          projectId={projectIdUndef}
          cpmFinish={cpmFinish}
          mutationVersion={mcMutationVersion}
          tasks={allTasks}
        />
      )}

      {/* Mobile MC card — md:hidden; desktop uses ScheduleForecastBar above (issue #33) */}
      {surfaces.monte_carlo && <MobileMonteCarloCard projectId={projectIdUndef} />}

      <ScheduleOverlayLayer
        timelineContainerRef={timelineContainerRef}
        pulsingMilestoneAt={pulsingMilestoneAt}
        panelWidth={panelWidth}
        canvasScrollRef={canvasScrollRef}
        pulsingMilestoneId={pulsingMilestoneId}
        datePopoverTask={datePopoverTask}
        onDatePopoverConfirm={handleDatePopoverConfirm}
        onDatePopoverClose={handleDatePopoverClose}
        ariaLiveRef={ariaLiveRef}
        ariaAssertiveRef={ariaAssertiveRef}
        scheduleCommit={scheduleCommit}
        currentRole={currentRole}
        dragPhase={dragPhase}
        scheduleError={scheduleError}
        projectId={projectId}
        importOpen={importOpen}
        setImportOpen={setImportOpen}
        csvImportOpen={csvImportOpen}
        setCsvImportOpen={setCsvImportOpen}
        shareOpen={shareOpen}
        setShareOpen={setShareOpen}
        baselineManagerOpen={baselineManagerOpen}
        setBaselineManagerOpen={setBaselineManagerOpen}
        taskTrashOpen={taskTrashOpen}
        setTaskTrashOpen={setTaskTrashOpen}
        captureBaselineConfirmOpen={captureBaselineConfirmOpen}
        setCaptureBaselineConfirmOpen={setCaptureBaselineConfirmOpen}
        activeBaselineName={activeBaselineName}
        createBaselineMut={createBaselineMut}
        onCaptureBaseline={handleCaptureBaseline}
        pendingSubtreeDelete={pendingSubtreeDelete}
        setPendingSubtreeDelete={setPendingSubtreeDelete}
        performBuildModeDelete={performBuildModeDelete}
        isExporting={isExporting}
        exportError={exportError}
        depPickerState={depPickerState}
        setDepPickerState={setDepPickerState}
        programId={projectDetail?.program ?? null}
        allTasks={allTasks}
        depPickerExcludedIds={depPickerExcludedIds}
        selectedTaskId={selectedTaskId}
        setSelectedTaskId={setSelectedTaskId}
        setHoveredTaskId={setHoveredTaskId}
        engine={engine}
        buildModeActive={buildModeActive}
        cheatsheetOpen={cheatsheetOpen}
        setCheatsheetOpen={setCheatsheetOpen}
        scheduleExport={scheduleExport}
        pasteMany={pasteMany}
        classifyState={classifyState}
        classifyTarget={classifyTarget}
        classifyPending={classifyMut.isPending}
        classifyFailed={classifyMut.error !== null}
        onClassifyApply={handleClassifyApply}
        onClassifyClose={closeClassify}
      />

      {/* Bulk-edit sheet (#2756 pt.2) — ⌘⇧K. Mounted here rather than threaded
          through ScheduleOverlayLayer because it portals to document.body, so
          its position in the tree buys nothing and would cost two more props on
          an already-wide interface. */}
      {bulkEdit.isOpen && bulkEdit.selectedTasks.length > 0 && (
        <BulkEditSheet
          tasks={bulkEdit.selectedTasks}
          resourcePool={resourcePool ?? []}
          isPending={bulkEdit.isPending}
          error={bulkEdit.error}
          result={bulkEdit.result}
          skippedLocallyCount={bulkEdit.skippedLocallyCount}
          onApply={bulkEdit.apply}
          onReviewFailed={bulkEdit.reviewFailed}
          onClose={bulkEdit.close}
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

// ---------------------------------------------------------------------------
// ScheduleOverlayLayer — the docked/floating overlay cluster that trails the
// main schedule surface: pulse + tooltip, keyboard-reschedule popover, the two
// aria-live regions, commit/before-start prompts, toasts, and every modal
// (import/share/baseline/subtree-delete/export/dependency-picker/drawer).
// Extracted from ScheduleView's return (#2081) — markup and guards are verbatim;
// only the enclosing function boundary is new, which is what keeps ScheduleView
// within the cognitive-complexity budget.
// ---------------------------------------------------------------------------

interface ScheduleOverlayLayerProps {
  timelineContainerRef: RefObject<HTMLDivElement | null>;
  pulsingMilestoneAt: { x: number; y: number };
  panelWidth: number;
  canvasScrollRef: DomRef;
  pulsingMilestoneId: string | null;
  datePopoverTask: Task | null;
  onDatePopoverConfirm: (newStart: string) => void;
  onDatePopoverClose: () => void;
  ariaLiveRef: DomRef;
  ariaAssertiveRef: DomRef;
  scheduleCommit: ReturnType<typeof useScheduleCommit>;
  currentRole: number | null;
  dragPhase: string;
  scheduleError: string | null;
  projectId: string | null;
  importOpen: boolean;
  setImportOpen: (v: boolean) => void;
  csvImportOpen: boolean;
  setCsvImportOpen: (v: boolean) => void;
  shareOpen: boolean;
  setShareOpen: (v: boolean) => void;
  baselineManagerOpen: boolean;
  setBaselineManagerOpen: (v: boolean) => void;
  taskTrashOpen: boolean;
  setTaskTrashOpen: (v: boolean) => void;
  captureBaselineConfirmOpen: boolean;
  setCaptureBaselineConfirmOpen: (v: boolean) => void;
  activeBaselineName: string | undefined;
  createBaselineMut: ReturnType<typeof useCreateBaseline>;
  onCaptureBaseline: () => void;
  pendingSubtreeDelete: { id: string; name: string; count: number } | null;
  setPendingSubtreeDelete: Dispatch<
    SetStateAction<{ id: string; name: string; count: number } | null>
  >;
  performBuildModeDelete: (taskId: string, descendantCount: number) => void;
  isExporting: boolean;
  exportError: string | null;
  depPickerState: { task: Task; mode: 'predecessor' | 'successor' } | null;
  setDepPickerState: Dispatch<
    SetStateAction<{ task: Task; mode: 'predecessor' | 'successor' } | null>
  >;
  programId: string | null;
  allTasks: Task[];
  depPickerExcludedIds: Set<string>;
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
  setHoveredTaskId: (id: string | null) => void;
  engine: GanttEngine | null;
  buildModeActive: boolean;
  cheatsheetOpen: boolean;
  setCheatsheetOpen: (v: boolean) => void;
  scheduleExport: ReturnType<typeof useScheduleExport>;
  pasteMany: ReturnType<typeof usePasteMany>;
  /** Classification popover (#2736) — null when closed. */
  classifyState: { taskId: string; anchor: { x: number; y: number } } | null;
  classifyTarget: Task | null;
  classifyPending: boolean;
  classifyFailed: boolean;
  onClassifyApply: (spec: ClassificationApply) => void;
  onClassifyClose: () => void;
}

function ScheduleOverlayLayer({
  timelineContainerRef,
  pulsingMilestoneAt,
  panelWidth,
  canvasScrollRef,
  pulsingMilestoneId,
  datePopoverTask,
  onDatePopoverConfirm,
  onDatePopoverClose,
  ariaLiveRef,
  ariaAssertiveRef,
  scheduleCommit,
  currentRole,
  dragPhase,
  scheduleError,
  projectId,
  importOpen,
  csvImportOpen,
  setCsvImportOpen,
  setImportOpen,
  shareOpen,
  setShareOpen,
  baselineManagerOpen,
  setBaselineManagerOpen,
  taskTrashOpen,
  setTaskTrashOpen,
  captureBaselineConfirmOpen,
  setCaptureBaselineConfirmOpen,
  activeBaselineName,
  createBaselineMut,
  onCaptureBaseline,
  pendingSubtreeDelete,
  setPendingSubtreeDelete,
  performBuildModeDelete,
  isExporting,
  exportError,
  depPickerState,
  setDepPickerState,
  programId,
  allTasks,
  depPickerExcludedIds,
  selectedTaskId,
  setSelectedTaskId,
  setHoveredTaskId,
  engine,
  buildModeActive,
  cheatsheetOpen,
  setCheatsheetOpen,
  scheduleExport,
  pasteMany,
  classifyState,
  classifyTarget,
  classifyPending,
  classifyFailed,
  onClassifyApply,
  onClassifyClose,
}: ScheduleOverlayLayerProps) {
  const selectedTask = selectedTaskId
    ? (allTasks.find((t) => t.id === selectedTaskId) ?? null)
    : null;
  const timelineTop = timelineContainerRef.current
    ? timelineContainerRef.current.getBoundingClientRect().top
    : 0;
  return (
    <>
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
        onConfirm={onDatePopoverConfirm}
        onClose={onDatePopoverClose}
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

      {/* Classification popover (#2736) — ⌘⇧M or the row menu. Declares the
          hybrid split for a subtree on both axes, with a footer that names
          exactly what the cascade will and will not touch. */}
      {classifyState && classifyTarget && (
        <ClassificationPopover
          anchor={classifyState.anchor}
          target={classifyTarget}
          tasks={allTasks}
          isPending={classifyPending}
          error={classifyFailed ? 'Could not apply the classification.' : null}
          onApply={onClassifyApply}
          onClose={onClassifyClose}
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

      {/* Paste-many receipt (#2724) — stays up until Undo/Keep/remap, not on a
          timer, since its needs-a-duration count stays F8-walkable while shown. */}
      {pasteMany.receipt && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-xl px-4">
          <PasteReceiptStrip
            summary={pasteMany.receipt.summary}
            isUndoing={pasteMany.isUndoing}
            onUndo={pasteMany.undo}
            onKeep={pasteMany.keep}
            onMapColumns={pasteMany.openMapColumns}
          />
        </div>
      )}
      {pasteMany.mappingDialogOpen && pasteMany.receipt && (
        <PasteColumnMappingDialog
          columns={pasteMany.receipt.columns}
          onCancel={pasteMany.closeMapColumns}
          onConfirm={pasteMany.applyColumnMapping}
        />
      )}

      {/* MS Project import modal (#68) — opened from the Project actions menu. */}
      {importOpen && projectId && (
        <ImportModal projectId={projectId} onClose={() => setImportOpen(false)} />
      )}

      {/* CSV/Excel import wizard (#746) — 3-step upload → map → confirm. */}
      {csvImportOpen && projectId && (
        <CsvImportWizard projectId={projectId} onClose={() => setCsvImportOpen(false)} />
      )}

      {/* Public schedule share dialog (#1486) — create/reveal/manage in one surface. */}
      {shareOpen && projectId && (
        <ShareViewDialog
          projectId={projectId}
          contentKind="schedule"
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* "Recently deleted" task Trash (#2494, ADR-0689) — recovery that outlives the
          delete Undo toast, opened from the Project actions (···) menu. */}
      {taskTrashOpen && projectId && (
        <TaskTrashDialog projectId={projectId} onClose={() => setTaskTrashOpen(false)} />
      )}

      {/* Baseline manager (#1864, ADR-0376) — list / activate / delete. */}
      {baselineManagerOpen && projectId && (
        <BaselineManagerModal
          projectId={projectId}
          currentRole={currentRole}
          onClose={() => setBaselineManagerOpen(false)}
        />
      )}

      {/* "You're about to baseline" educational confirm for the quick-capture path (#1864). */}
      {captureBaselineConfirmOpen && projectId && (
        <CaptureBaselineConfirmDialog
          activeBaselineName={activeBaselineName}
          isPending={createBaselineMut.isPending}
          onCancel={() => {
            if (!createBaselineMut.isPending) setCaptureBaselineConfirmOpen(false);
          }}
          onConfirm={onCaptureBaseline}
        />
      )}

      {/* Subtree-delete confirm (#2029) — only raised for summary rows with
          descendants; leaf deletes stay confirm-free. */}
      {pendingSubtreeDelete && (
        <SubtreeDeleteConfirmDialog
          name={pendingSubtreeDelete.name}
          count={pendingSubtreeDelete.count}
          onCancel={() => setPendingSubtreeDelete(null)}
          onConfirm={() => {
            performBuildModeDelete(pendingSubtreeDelete.id, pendingSubtreeDelete.count);
            setPendingSubtreeDelete(null);
          }}
        />
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
          programId={programId}
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
          // Keep-editing on a dirty swap: the bar click already moved selection
          // to the new task; restore selection (and the canvas ring) to the task
          // the drawer is still showing so the two stay in sync (#1978).
          onSwapCanceled={(keptId) => {
            setSelectedTaskId(keptId);
            engine?.selectTask(keptId);
          }}
        />
      )}

      {buildModeActive && (
        <BuildModeCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
      )}

      {/* Schedule-export options + generation dialog (issue 1438, ADR-0233). */}
      {scheduleExport.open && (
        <ScheduleExportDialog
          phase={scheduleExport.phase}
          options={scheduleExport.options}
          setOption={scheduleExport.setOption}
          filteredCount={scheduleExport.filteredCount}
          estimateMs={scheduleExport.estimateMs}
          progress={scheduleExport.progress}
          result={scheduleExport.result}
          error={scheduleExport.error}
          visibleWindowAvailable={scheduleExport.visibleWindowAvailable}
          onExport={scheduleExport.startExport}
          onCancelGenerating={scheduleExport.cancel}
          onReset={scheduleExport.reset}
          onOpenInViewer={scheduleExport.openInViewer}
          onClose={scheduleExport.closeDialog}
        />
      )}

      {/* Off-screen schedule-export print surface (issue 1438, ADR-0233). Mounted
          only while generating so its duplicate projection of every activity name
          never lingers in the DOM to collide with the live grid's text nodes.
          Positioned out of view (never display:none — html-to-image must render it)
          and aria-hidden. It reflects the chosen paper + include options. */}
      {scheduleExport.printSurfaceMounted && (
        <div aria-hidden="true" className="pointer-events-none absolute -left-[99999px] top-0">
          <SchedulePrintLayout
            ref={scheduleExport.printRef}
            data={scheduleExport.printData}
            paper={scheduleExport.options.paper}
            dataDate={scheduleExport.printDataDate || undefined}
            includeArrows={scheduleExport.options.includeArrows}
            includeOwnerColumn={scheduleExport.options.includeOwnerColumn}
            includeCpSummary={scheduleExport.options.includeCpSummary}
          />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ScheduleToolbar — the desktop Gantt toolbar (add controls, health chip,
// view/display/time clusters, and the Project-actions overflow menu). Extracted
// from ScheduleView's return (#2081); markup and guards are verbatim.
// ---------------------------------------------------------------------------

type ChartPrefsHook = ReturnType<typeof useScheduleChartPrefs>;
type ColWidthsHook = ReturnType<typeof useColumnWidths>;
type NamePlacement = ChartPrefsHook['prefs']['taskNamePlacementByView']['grid'];

/**
 * Build the Project-actions (···) overflow items. Each entry is conditional on
 * the project id plus the relevant capability/breakpoint (#1741) — extracted so
 * the spread-ternaries live outside the toolbar's render.
 */
function buildProjectActionsItems(ctx: {
  projectId: string | null;
  canImport: boolean;
  canShare: boolean;
  canCaptureBaseline: boolean;
  isExporting: boolean;
  exportProject: ReturnType<typeof useExportMsProject>['exportProject'];
  setImportOpen: (v: boolean) => void;
  canImportCsv: boolean;
  setCsvImportOpen: (v: boolean) => void;
  setShareOpen: (v: boolean) => void;
  setCaptureBaselineConfirmOpen: (v: boolean) => void;
  setBaselineManagerOpen: (v: boolean) => void;
  setTaskTrashOpen: (v: boolean) => void;
}): ToolbarOverflowItem[] {
  const { projectId, isExporting, exportProject } = ctx;
  return [
    ...(projectId && ctx.canImport
      ? [
          {
            kind: 'action' as const,
            id: 'import-msproject',
            label: 'Import from MS Project…',
            onSelect: () => ctx.setImportOpen(true),
          },
        ]
      : []),
    ...(projectId && ctx.canImportCsv
      ? [
          {
            kind: 'action' as const,
            id: 'import-csv',
            label: 'Import from spreadsheet (CSV/Excel)…',
            onSelect: () => ctx.setCsvImportOpen(true),
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
    // Schedule PDF export (issue 1438) moved out of this menu and into a
    // dedicated, primary toolbar button (#2703) — it is a weekly-cadence,
    // client-facing task for the PM/PMO personas, not a secondary action, and
    // this codebase's convention (rule 243: the Display popover, Today, Zoom)
    // is one home per control, not a toolbar+overflow duplicate. See
    // `ScheduleToolbar`'s render for the button.
    // Share (#1486) — Admin+ only.
    ...(projectId && ctx.canShare
      ? [
          {
            kind: 'action' as const,
            id: 'share-schedule',
            label: 'Share this schedule…',
            onSelect: () => ctx.setShareOpen(true),
          },
        ]
      : []),
    // Baselines (#1864) — capture (Admin+) then the manager.
    ...(projectId && ctx.canCaptureBaseline
      ? [
          {
            kind: 'action' as const,
            id: 'capture-baseline',
            label: 'Capture baseline',
            onSelect: () => ctx.setCaptureBaselineConfirmOpen(true),
          },
        ]
      : []),
    ...(projectId
      ? [
          {
            kind: 'action' as const,
            id: 'manage-baselines',
            label: 'Baselines…',
            onSelect: () => ctx.setBaselineManagerOpen(true),
          },
        ]
      : []),
    // Recently deleted (#2494) — offered to every member, not just those who can
    // restore: seeing that a task still exists is the recovery, and each row
    // carries its own server-decided `can_restore`.
    ...(projectId
      ? [
          {
            kind: 'action' as const,
            id: 'task-trash',
            label: 'Recently deleted…',
            onSelect: () => ctx.setTaskTrashOpen(true),
          },
        ]
      : []),
  ] as ToolbarOverflowItem[];
}

interface ScheduleToolbarProps {
  /** Per-person outline chrome (#2959) — surfaced in the Display menu. */
  displayOptions: ScheduleDisplayOptions;
  onToggleDisplayOption: (key: ScheduleDisplayOptionKey) => void;
  /**
   * Whether this user may author at all — distinct from `readOnly`, which is
   * also true for an editor who chose Read. Without rights the authoring
   * apparatus is absent rather than disabled (#2949).
   */
  hasEditRights: boolean;
  isMobile: boolean;
  projectId: string | null;
  readOnly: boolean;
  showAddForm: boolean;
  setShowAddForm: Dispatch<SetStateAction<boolean>>;
  handleAddMilestone: () => void;
  handleAddPhase: () => void;
  createPending: boolean;
  buildModeActive: boolean;
  authorMode: ScheduleAuthorMode;
  onToggleAuthorMode: () => void;
  setCheatsheetOpen: Dispatch<SetStateAction<boolean>>;
  pendingCount: number;
  projectDetail: ReturnType<typeof useProject>['data'];
  visibleTasks: Task[];
  effectiveViewMode: 'grid' | 'timeline';
  showCpOnly: boolean;
  setShowCpOnly: Dispatch<SetStateAction<boolean>>;
  focusModeEnabled: boolean;
  setFocusModeEnabled: Dispatch<SetStateAction<boolean>>;
  showCriticalOnly: boolean;
  setShowCriticalOnly: Dispatch<SetStateAction<boolean>>;
  showMilestonesOnly: boolean;
  setShowMilestonesOnly: Dispatch<SetStateAction<boolean>>;
  visible: ColWidthsHook['visible'];
  toggleColumn: ColWidthsHook['toggleColumn'];
  chartPrefs: ChartPrefsHook['prefs'];
  setDependencyLinesVisible: ChartPrefsHook['setDependencyLinesVisible'];
  activeNamePlacement: NamePlacement;
  setTaskNamePlacement: ChartPrefsHook['setTaskNamePlacement'];
  setProgressPillsVisible: ChartPrefsHook['setProgressPillsVisible'];
  /** Undefined when the project has no sprint window to draw (#2738). */
  setSprintBandsVisible: ChartPrefsHook['setSprintBandsVisible'] | undefined;
  hiddenChartCount: number;
  breakpoint: ReturnType<typeof useBreakpoint>;
  handleScrollToToday: () => void;
  engine: GanttEngine | null;
  canImport: boolean;
  isExporting: boolean;
  exportProject: ReturnType<typeof useExportMsProject>['exportProject'];
  scheduleExport: ReturnType<typeof useScheduleExport>;
  canShare: boolean;
  canCaptureBaseline: boolean;
  setImportOpen: Dispatch<SetStateAction<boolean>>;
  canImportCsv: boolean;
  setCsvImportOpen: Dispatch<SetStateAction<boolean>>;
  setShareOpen: Dispatch<SetStateAction<boolean>>;
  setCaptureBaselineConfirmOpen: Dispatch<SetStateAction<boolean>>;
  setBaselineManagerOpen: Dispatch<SetStateAction<boolean>>;
  setTaskTrashOpen: Dispatch<SetStateAction<boolean>>;
}

function ScheduleToolbar(props: ScheduleToolbarProps) {
  const {
    isMobile,
    projectId,
    readOnly,
    displayOptions,
    onToggleDisplayOption,
    hasEditRights,
    showAddForm,
    setShowAddForm,
    handleAddMilestone,
    handleAddPhase,
    createPending,
    buildModeActive,
    authorMode,
    onToggleAuthorMode,
    setCheatsheetOpen,
    pendingCount,
    projectDetail,
    visibleTasks,
    effectiveViewMode,
    showCpOnly,
    setShowCpOnly,
    focusModeEnabled,
    setFocusModeEnabled,
    showCriticalOnly,
    setShowCriticalOnly,
    showMilestonesOnly,
    setShowMilestonesOnly,
    visible,
    toggleColumn,
    chartPrefs,
    setDependencyLinesVisible,
    activeNamePlacement,
    setTaskNamePlacement,
    setProgressPillsVisible,
    setSprintBandsVisible,
    hiddenChartCount,
    breakpoint,
    handleScrollToToday,
    engine,
    canImport,
    isExporting,
    exportProject,
    scheduleExport,
    canShare,
    canCaptureBaseline,
    setImportOpen,
    canImportCsv,
    setCsvImportOpen,
    setShareOpen,
    setCaptureBaselineConfirmOpen,
    setBaselineManagerOpen,
    setTaskTrashOpen,
  } = props;

  // The whole toolbar is desktop-only (mobile is forced to full-width Timeline,
  // #1670), so it renders nothing on a phone.
  if (isMobile) return null;

  return (
    <div
      role="toolbar"
      aria-label="Schedule toolbar"
      className="flex flex-nowrap items-center gap-2 px-4 h-10 border-b border-neutral-border bg-neutral-surface-raised flex-shrink-0"
    >
      {/* "+ Task" button — shown when a project is selected AND the user may
          author. A viewer never sees it (#2949); an editor who chose Read sees
          it disabled, on the same `readOnly` gate as its "+ Milestone" /
          "+ Phase" peers (#2145). */}
      {projectId && hasEditRights && (
        <button
          type="button"
          onClick={() => setShowAddForm((v) => !v)}
          disabled={readOnly}
          aria-label="Add task"
          aria-expanded={showAddForm}
          title={readOnly ? 'Read-only access' : undefined}
          className="border border-neutral-border rounded-control h-7 px-3 text-xs font-medium flex-shrink-0
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
              hover:border-brand-primary hover:text-brand-primary
              disabled:bg-neutral-surface-sunken disabled:text-neutral-text-disabled disabled:border-neutral-border disabled:cursor-not-allowed"
        >
          + Task
        </button>
      )}
      {/* "+ Milestone" peer button (#340). Absent without edit rights (#2949),
          disabled for an editor who chose Read — the two are different states. */}
      {projectId && hasEditRights && (
        <ScheduleAddMilestoneButton
          onAddMilestone={handleAddMilestone}
          disabled={readOnly}
          pending={createPending}
        />
      )}
      {/* "+ Phase" peer button (epic #1752, issue #1754) — same gate as
          "+ Task" / "+ Milestone". */}
      {projectId && hasEditRights && (
        <ScheduleAddPhaseButton
          onAddPhase={handleAddPhase}
          disabled={readOnly}
          pending={createPending}
        />
      )}
      {buildModeActive && hasEditRights && (
        <BuildModePill onShowCheatsheet={() => setCheatsheetOpen(true)} />
      )}
      {/* The Read/Author toggle is meaningless without rights: there is no mode
          to leave. It goes, and the View-only badge takes its place. */}
      {buildModeActive && hasEditRights && (
        <AuthorModePill mode={authorMode} onToggle={onToggleAuthorMode} />
      )}
      {buildModeActive && !hasEditRights && <ScheduleViewOnlyBadge />}
      {/* Session trail (#2948). Lives in the toolbar rather than the Forecast
          strip the prototype drew it in: that strip early-returns whenever there
          is no Monte Carlo result yet, which is exactly the fresh project where
          someone is authoring structure. It renders null with no acts, so a
          viewer never sees it. */}
      <SessionTrail />
      {/* Show the badge for in-flight optimistic edits, and also while a
          freshly-imported sample's first post-import CPM pass is still pending
          (recalculated_at null) so the demo never reads as broken (#1053). */}
      <RecalculatingBadge
        isVisible={
          pendingCount > 0 ||
          (projectDetail?.is_sample === true && projectDetail?.recalculated_at == null)
        }
      />

      <div className="flex-1" />

      {/* Project-health summary chip (#248) — standalone read-only status. */}
      <ScheduleSummaryChip visibleTasks={visibleTasks} />

      <div aria-hidden="true" className="mx-0.5 h-5 w-px bg-neutral-border shrink-0" />

      {/* Grid↔Timeline layout toggle (issue 1221). */}
      <ScheduleViewModeToggle />

      {/* Show cluster (#1741) — the Display popover is the single home for the
          four view/render filters plus (in Grid mode) column visibility. */}
      <ScheduleDisplayMenu
        displayOptions={displayOptions}
        onToggleDisplayOption={onToggleDisplayOption}
        showCpOnly={showCpOnly}
        setShowCpOnly={setShowCpOnly}
        focusModeEnabled={focusModeEnabled}
        setFocusModeEnabled={setFocusModeEnabled}
        showCriticalOnly={showCriticalOnly}
        setShowCriticalOnly={setShowCriticalOnly}
        showMilestonesOnly={showMilestonesOnly}
        setShowMilestonesOnly={setShowMilestonesOnly}
        columns={
          effectiveViewMode === 'grid'
            ? (['wbs', 'dur', 'start', 'finish', 'progress', 'owner'] as const).map((col) => ({
                id: col,
                label: COLUMN_MENU_LABELS[col],
                checked: visible[col],
                onChange: () => toggleColumn(col),
              }))
            : null
        }
        chart={{
          dependencyLinesVisible: chartPrefs.dependencyLinesVisible,
          setDependencyLinesVisible,
          viewMode: effectiveViewMode,
          taskNamePlacement: activeNamePlacement,
          setTaskNamePlacement: (v) => setTaskNamePlacement(effectiveViewMode, v),
          progressPillsVisible: chartPrefs.progressPillsVisible,
          setProgressPillsVisible,
          sprintBandsVisible: chartPrefs.sprintBandsVisible,
          setSprintBandsVisible,
        }}
        hiddenChartCount={hiddenChartCount}
        iconOnly={breakpoint !== 'lg'}
      />

      <div aria-hidden="true" className="mx-0.5 h-5 w-px bg-neutral-border shrink-0" />

      {/* Time cluster (#1741) — timeline navigation: jump-to-today, zoom, quarter toggle. */}
      <div role="group" aria-label="Timeline navigation" className="flex items-center gap-1">
        {/* "Today" button (rule 82) */}
        <button
          type="button"
          onClick={handleScrollToToday}
          className="border border-neutral-border rounded-control h-7 px-3 text-xs font-medium flex-shrink-0 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
        >
          Today
        </button>
        <ZoomControl onFit={() => engine?.fitToProject()} />
        <QuarterModeControl />
      </div>

      {/* Schedule PDF export (#2703) — a dedicated, primary toolbar button.
          Previously buried in the ⋯ overflow and hidden below `md` entirely;
          the client-ready PDF is a weekly-cadence, client-facing task for the
          PM/PMO personas (steering pack, exec prep), not a secondary action.
          Primary classification (rule 110): visible with a short label at
          every width the toolbar itself renders (≥ md — the toolbar is
          desktop-only, see `isMobile` above), full label at lg — same
          treatment as the "Today" / "Fit to project" buttons in the Time
          cluster. Disabled (not hidden) when nothing is exportable so it
          stays discoverable, matching the disabled-not-hidden convention the
          overflow entry used. */}
      {projectId && (
        <button
          type="button"
          onClick={scheduleExport.openDialog}
          disabled={!scheduleExport.canExport}
          aria-label="Export schedule as PDF"
          title="Export schedule as PDF (⌘⇧E)"
          className="inline-flex items-center gap-1.5 border border-neutral-border rounded-control h-7 px-3 text-xs font-medium flex-shrink-0
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
            focus-visible:ring-offset-neutral-surface
            focus-visible:outline-none hover:border-brand-primary hover:text-brand-primary
            disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-neutral-border disabled:hover:text-inherit"
        >
          <FilePdfIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          Export<span className="hidden lg:inline"> PDF</span>
        </button>
      )}

      <div aria-hidden="true" className="mx-0.5 h-5 w-px bg-neutral-border shrink-0" />
      {/* Project actions (···) — always present so Import/Export are discoverable
          at every width. */}
      {(projectId || breakpoint === 'sm') && (
        <ToolbarOverflowMenu
          triggerAriaLabel="Project actions"
          items={buildProjectActionsItems({
            projectId,
            canImport,
            canShare,
            canCaptureBaseline,
            isExporting,
            exportProject,
            setImportOpen,
            canImportCsv,
            setCsvImportOpen,
            setShareOpen,
            setCaptureBaselineConfirmOpen,
            setBaselineManagerOpen,
            setTaskTrashOpen,
          })}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleMainArea — the central surface below the toolbar: the mobile
// list-timeline on phones, else the desktop split-pane (WBS table + splitter in
// Grid mode) with the canvas timeline / empty state, the floating legend, and
// the unscheduled gutter. Extracted from ScheduleView's return (#2081); markup,
// ternaries, and guards are verbatim.
// ---------------------------------------------------------------------------

interface ScheduleMainAreaProps {
  isMobile: boolean;
  allTasks: Task[];
  projectId: string | null;
  readOnly: boolean;
  isLoading: boolean;
  error: ReturnType<typeof useScheduleTasks>['error'];
  setShowAddForm: Dispatch<SetStateAction<boolean>>;
  timelineContainerRef: RefObject<HTMLDivElement | null>;
  effectiveViewMode: 'grid' | 'timeline';
  visibleTasks: Task[];
  pendingTaskIds: Map<string, string>;
  taskListScrollRef: RefObject<HTMLDivElement | null>;
  widths: ColWidthsHook['widths'];
  visible: ColWidthsHook['visible'];
  setWidth: ColWidthsHook['setWidth'];
  totalWidth: number;
  summaryIds: Set<string>;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  focusChainIds: Set<string> | undefined;
  depChipsById: Map<string, TaskDepChips>;
  setHoveredTaskId: (id: string | null) => void;
  hoveredTaskId: string | null;
  handleAddDependencyRequest: (taskId: string, mode: 'predecessor' | 'successor') => void;
  sprintsById: ComponentProps<typeof TaskListPanel>['sprintsById'];
  visiblePhaseInWaitingIds: Set<string>;
  handleAddPhaseFirstChild: (phaseTaskId: string) => void;
  pendingAutoEditId: string | null;
  setPendingAutoEditId: Dispatch<SetStateAction<string | null>>;
  plannedByPhase: ComponentProps<typeof TaskListPanel>['plannedByPhase'];
  resourcePool: ComponentProps<typeof TaskListPanel>['resourcePool'];
  buildModeActive: boolean;
  handleCommitDraftRow: (name: string) => void;
  handleImportFile: () => void;
  blankProjectFacts: ComponentProps<typeof BlankProjectCanvas>['facts'];
  canvasScrollRef: RefObject<HTMLDivElement | null>;
  handleCanvasScroll: () => void;
  links: ComponentProps<typeof CanvasScheduleTimeline>['links'];
  /** Sprint-window bands for the canvas (#2738), row-indexed against visibleTasks. */
  sprintBands: ComponentProps<typeof CanvasScheduleTimeline>['sprintBands'];
  zoomLevel: ComponentProps<typeof CanvasScheduleTimeline>['zoomLevel'];
  chartOptions: ComponentProps<typeof CanvasScheduleTimeline>['chartOptions'];
  handleEngineReady: (eng: GanttEngine) => void;
  mcResult: ReturnType<typeof useMonteCarloResult>['data'];
  scheduleScales: GanttScaleData | null;
  panelWidth: number;
  unscheduledTasks: Task[];
  sprints: ComponentProps<typeof UnscheduledGutter>['sprints'];
  effectiveMethodology: Methodology;
  /** Resolved delivery mode per task id (#2737). */
  rowModes: Map<string, RowMode>;
  /** Opens the classification popover on a row (#2736); omitted when read-only. */
  onClassifyRequest?: (taskId: string) => void;
  /** Selects the tray's rows in the outline and opens the bulk-edit sheet
   *  (#2987); omitted when read-only, so the button is absent not disabled. */
  onScheduleMany?: (taskIds: string[]) => void;
}

/**
 * Row-menu items for a Timeline right-click (#2978).
 *
 * Deliberately a SHORTER menu than the Grid's. The Grid builder needs a context
 * object assembled from a dozen row-local values (editing state, dep chips,
 * sprint membership, classification) that simply do not exist in Timeline, where
 * there is no DOM row. Rather than fabricate that context, this offers the
 * structural operations `BuildModeApi` exposes directly — which are the ones a
 * right-click on a bar is actually reaching for.
 *
 * Anything absent here is still reachable from the Grid. A short menu that works
 * beats a long one assembled from placeholder state.
 */
function timelineRowMenuItems(buildMode: BuildModeApi, taskId: string): RowMenuItem[] {
  return [
    {
      key: 'indent',
      label: 'Indent',
      onSelect: () => buildMode.indent(taskId),
    },
    {
      key: 'outdent',
      label: 'Outdent',
      onSelect: () => buildMode.outdent(taskId),
    },
    {
      key: 'insert-below',
      label: 'Insert item below',
      onSelect: () => buildMode.insertBelow(taskId),
    },
    {
      key: 'milestone',
      label: 'Make a milestone',
      onSelect: () => buildMode.convertToMilestone(taskId),
    },
    {
      key: 'duplicate',
      label: 'Duplicate',
      onSelect: () => buildMode.duplicateSubtree(taskId),
    },
    {
      key: 'delete',
      label: 'Delete',
      destructive: true,
      onSelect: () => buildMode.deleteTask(taskId),
    },
  ];
}

function ScheduleMainArea(props: ScheduleMainAreaProps) {
  // Timeline right-click (#2978). In Timeline mode there is NO DOM row — the
  // canvas is full-width and the task-list panel is not rendered (#1221) — so a
  // right-click landed on the <canvas> and produced the browser's "Save Image
  // As…" menu. The row is resolved from the pointer's y instead.
  //
  // Deliberately NOT by re-enabling pointer events on ScheduleAriaOverlay: that
  // `pointerEvents: 'none'` is load-bearing (the canvas beneath needs the
  // pointer for drag-to-reschedule and drag-to-link), and the overlay's rows sit
  // at the BAR, so they could never cover the left-hand name gutter — which is
  // exactly where the names render under "Aligned left", and the spot that most
  // looks like the Grid outline.
  const timelineBuildMode = useBuildMode();
  const [timelineMenu, setTimelineMenu] = useState<{
    anchor: { x: number; y: number };
    taskId: string;
  } | null>(null);

  const {
    isMobile,
    allTasks,
    projectId,
    readOnly,
    isLoading,
    error,
    setShowAddForm,
    timelineContainerRef,
    effectiveViewMode,
    visibleTasks,
    pendingTaskIds,
    taskListScrollRef,
    widths,
    visible,
    setWidth,
    totalWidth,
    summaryIds,
    expandedIds,
    toggleExpand,
    focusChainIds,
    depChipsById,
    setHoveredTaskId,
    hoveredTaskId,
    handleAddDependencyRequest,
    sprintsById,
    visiblePhaseInWaitingIds,
    handleAddPhaseFirstChild,
    pendingAutoEditId,
    setPendingAutoEditId,
    plannedByPhase,
    resourcePool,
    buildModeActive,
    handleCommitDraftRow,
    handleImportFile,
    blankProjectFacts,
    canvasScrollRef,
    handleCanvasScroll,
    links,
    sprintBands,
    zoomLevel,
    chartOptions,
    handleEngineReady,
    mcResult,
    scheduleScales,
    panelWidth,
    unscheduledTasks,
    sprints,
    effectiveMethodology,
    rowModes,
    onClassifyRequest,
    onScheduleMany,
  } = props;

  const itl = useIterationLabel(projectId ?? undefined);
  const totalCanvasWidth = scheduleScales?.totalWidth ?? 0;

  if (isMobile) {
    // Dedicated mobile-first Schedule surface (#1671, ADR-0348) — a DOM
    // list-timeline that replaces the desktop canvas below md. Owns its own
    // loading/error/empty states; edits delegate to the shared TaskDetailDrawer
    // (mounted below) via scheduleStore.selectedTaskId.
    return (
      <MobileSchedule
        tasks={allTasks}
        projectId={projectId}
        readOnly={readOnly}
        isLoading={isLoading}
        error={error}
        onAddTask={() => setShowAddForm(true)}
        effectiveMethodology={effectiveMethodology}
      />
    );
  }

  return (
    <>
      <div className="relative flex flex-1 overflow-hidden" ref={timelineContainerRef}>
        {/* Grid mode shows the WBS task-list table + resize splitter; Timeline
            mode (issue 1221) hides both for a full-width canvas (task names render
            inline on the bars). */}
        {effectiveViewMode === 'grid' && (
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
              hoveredTaskId={hoveredTaskId}
              onAddDependencyRequest={handleAddDependencyRequest}
              sprintsById={sprintsById}
              phaseInWaitingIds={visiblePhaseInWaitingIds}
              onAddPhaseFirstChild={handleAddPhaseFirstChild}
              autoEditTaskId={pendingAutoEditId}
              onAutoEditConsumed={() => setPendingAutoEditId(null)}
              plannedByPhase={plannedByPhase}
              resourcePool={resourcePool}
              onCommitDraftRow={readOnly ? undefined : handleCommitDraftRow}
              rowModes={rowModes}
              onClassifyRequest={onClassifyRequest}
            />
            {/* Panel splitter — drag to resize task list width */}
            <PanelSplitter currentTaskWidth={widths.task} setWidth={setWidth} />
          </>
        )}

        {visibleTasks.length === 0 ? (
          effectiveMethodology === 'AGILE' ? (
            // AGILE hides this view's nav entry (methodologyTabs.ts), but the route
            // stays reachable by direct URL on purpose (issue #2619). This
            // methodology mismatch takes priority over build mode — an AGILE
            // project has no schedule to build regardless of surface.
            <MethodologyEmptyState
              className="h-full bg-neutral-surface"
              projectId={projectId}
              icon={GanttIcon}
              title="Schedule isn't part of this project's workflow"
              description={`This project runs on ${itl.lowerPlural}, not a phase-gated schedule. If a full CPM schedule fits better here, switch the methodology in Settings.`}
              primaryLabel={`Go to ${itl.plural}`}
              primaryTo={projectId ? `/projects/${projectId}/sprints` : '#'}
            />
          ) : buildModeActive ? (
            // #2733: a blank project is a canvas, not a card. The horizon draws
            // against the chosen calendar so an empty project reads as a plan
            // surface, and the fill options sit quietly at the edge so they do not
            // compete with the live row already holding the caret in the outline.
            <BlankProjectCanvas
              facts={blankProjectFacts}
              onImportFile={readOnly ? undefined : handleImportFile}
            />
          ) : (
            <ScheduleEmptyState onAddTask={readOnly ? undefined : () => setShowAddForm(true)} />
          )
        ) : (
          <div
            ref={canvasScrollRef}
            data-testid="schedule-canvas-scroll"
            className="flex-1 min-w-0 overflow-auto relative z-0"
            onScroll={handleCanvasScroll}
            onContextMenu={(e) => {
              if (!timelineBuildMode) return;
              const box = e.currentTarget.getBoundingClientRect();
              const index = timelineRowIndexAt(
                e.clientY - box.top,
                e.currentTarget.scrollTop,
                visibleTasks.length,
              );
              if (index === null) return;
              const task = visibleTasks[index];
              if (!task) return;
              // Only now: leaving preventDefault to the miss case would suppress
              // the browser menu over the ruler and empty space too, where there
              // is nothing of ours to offer instead.
              e.preventDefault();
              timelineBuildMode.focus.focusRow(task.id);
              setTimelineMenu({ anchor: { x: e.clientX, y: e.clientY }, taskId: task.id });
            }}
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
              {/* Canvas layers fill the viewport. width/height driven by
                  --gantt-vw/vh CSS vars set by the engine on _applyDpr(). Using
                  100% here would resolve to totalCanvasWidth (the scroll spacer's
                  width), making position:sticky left:0 impossible to satisfy (#96). */}
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
                  sprintBands={sprintBands}
                  zoomLevel={zoomLevel}
                  chartOptions={chartOptions}
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

        {/* Timeline row menu (#2978) — the same portal the Grid opens, reached by
            hit-testing the pointer's row rather than by a DOM row that does not
            exist in this view. */}
        {timelineMenu && timelineBuildMode && (
          <BuildModeRowMenu
            anchor={timelineMenu.anchor}
            items={timelineRowMenuItems(timelineBuildMode, timelineMenu.taskId)}
            onClose={() => setTimelineMenu(null)}
          />
        )}

        {/* Floating legend overlay (#474, ADR-0064) — anchored to the bottom-left of
            the canvas viewport. Hidden below `lg` per design rule 12. */}
        <ScheduleLegend taskListWidth={panelWidth} />
      </div>

      {/* Unscheduled gutter — tasks with no planned/CPM dates (#213). Desktop
          only; the mobile surface carries its own Unscheduled tray (#1671). */}
      {projectId && (
        <UnscheduledGutter
          tasks={unscheduledTasks}
          projectId={projectId}
          scaleData={scheduleScales}
          canvasScrollRef={canvasScrollRef}
          taskListWidth={panelWidth}
          sprints={sprints}
          onScheduleMany={onScheduleMany}
        />
      )}
    </>
  );
}
