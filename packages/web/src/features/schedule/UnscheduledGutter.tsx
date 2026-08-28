import { countRows, ROW_NOUN, ROW_NOUN_PLURAL } from './rowVocabulary';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApiSprint, Task } from '@/types';
import type { GanttScaleData } from './engine';
import { leftToDate } from './engine';
import { usePromoteTask } from '@/hooks/useTaskMutations';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useProject } from '@/hooks/useProject';
import { useScheduleStore } from '@/stores/scheduleStore';
import { UnscheduledTaskRow } from './UnscheduledTaskRow';
import { UnscheduledDragPreview } from './UnscheduledDragPreview';
import { UnscheduledDropIndicator } from './UnscheduledDropIndicator';
import { ScheduleTaskDialog } from './ScheduleTaskDialog';
import { Button } from '@/components/Button';
import { Tooltip } from '@/components/Tooltip';
import { useIsCoarsePointer } from '@/hooks/useIsCoarsePointer';
import { ROW_HEIGHT_COARSE } from './scheduleConstants';
import { formatShortDate } from './scheduleUtils';

interface UnscheduledGutterProps {
  tasks: Task[];
  projectId: string;
  /** GanttScaleData for converting pointer X → date (passed from ScheduleView). */
  scaleData: GanttScaleData | null;
  /** Ref to the canvas scroll container — used to compute drop coordinates. */
  canvasScrollRef: React.RefObject<HTMLDivElement | null>;
  /** Left offset of the task list panel — gutter header aligns with timeline area. */
  taskListWidth: number;
  /** Project sprints (#1790) — used to group sprint-assigned backlog under its
   *  target sprint with an honest window/state header. */
  sprints?: ApiSprint[];
  /**
   * Select these rows in the outline and open the bulk-edit sheet (#2987).
   *
   * The tray does not own a selection model: the sheet resolves its selection
   * against the outline's `visibleTasks`, so a second selection here would have
   * to be marshalled across anyway — and a row inside a collapsed phase would
   * silently resolve to nothing. Absent when the viewer cannot edit, which is
   * why the button is omitted rather than disabled (rule 302).
   */
  onScheduleMany?: (taskIds: string[]) => void;
  /**
   * Walk the outline to the next row this tray is counting (#3131).
   *
   * The count is the tray's headline, and until this existed it was a caption:
   * it named a number of rows and offered no way to reach one. This is that
   * route, and it is a *different act* from `onScheduleMany` — that one selects
   * every datable row and opens the bulk-edit sheet to write dates in a batch;
   * this one only moves focus, writes nothing, and is therefore offered to a
   * viewer with no edit rights too.
   *
   * Absent → the count renders as the plain span it has always been, rather
   * than as a button that refuses (rule 302).
   */
  onWalkToUnscheduled?: () => void;
}

interface DragState {
  task: Task;
  /** True when the dragged chip is a BACKLOG item (#318 promote branch). */
  isBacklog: boolean;
  x: number;
  y: number;
  overCanvas: boolean;
  dropDate: string | null;
}

const COLLAPSED_KEY = 'trueppm.gantt.unscheduledGutter.collapsed';

/**
 * Unscheduled gutter — a two-section tray below the Gantt (#213, extended #318).
 *
 * Sections (rule 132), top to bottom in one scroll container:
 *   - "To Do" — NOT_STARTED tasks with no committed planned_start.
 *   - "Backlog" — status === 'BACKLOG' ideas. Their chips carry a dashed left
 *     edge + readiness label (rule 133) and dragging one onto the timeline
 *     PROMOTES it: PATCH `{ planned_start, status: 'NOT_STARTED' }` (decision
 *     A2) so it lands deterministically in To Do regardless of the drop date.
 *
 * Drag-to-schedule: pointer events on a row → floating preview → drop on canvas
 * → promote. For a To Do chip the PATCH sends only `planned_start` and the
 * server applies its date-gated → IN_PROGRESS rule (#336); for a Backlog chip
 * the explicit status skips that auto-bump. Offline guard skips the PATCH and
 * leaves the chip (rule 29); aria-live is written via DOM ref (rule 30); Esc
 * cancels mid-drag (rule 28).
 */
export function UnscheduledGutter({
  tasks,
  projectId,
  scaleData,
  canvasScrollRef,
  taskListWidth,
  sprints,
  onScheduleMany,
  onWalkToUnscheduled,
}: UnscheduledGutterProps) {
  const itl = useIterationLabel();
  // Server-resolved today for the rows' date-gated disclosure (#3075).
  const { data: project } = useProject(projectId);
  // The walk control's hit target, resolved from the row-height owner rather
  // than a literal (rules 315/328): `ROW_HEIGHT_COARSE` on a coarse pointer,
  // 32px on a mouse to match the collapse toggle beside it. A `text-xs` count
  // would otherwise be a ~20px target on a touch tablet, which is ≥768px and
  // therefore renders this desktop gutter.
  const walkTargetSize = useIsCoarsePointer() ? ROW_HEIGHT_COARSE : 32;
  // Absent a persisted choice, default to collapsed when there is nothing
  // unscheduled. Since #3131 the empty tray does not render at all, so this no
  // longer governs anything visible at zero — it governs the frame between the
  // first unscheduled row arriving and the auto-expand effect below firing,
  // which is why it stays.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(COLLAPSED_KEY);
      return stored !== null ? stored === 'true' : tasks.length === 0;
    } catch {
      return tasks.length === 0;
    }
  });

  // Auto-expand when tasks appear for the first time
  const prevCountRef = useRef(tasks.length);
  useEffect(() => {
    if (tasks.length > 0 && prevCountRef.current === 0) {
      setCollapsed(false);
    }
    prevCountRef.current = tasks.length;
  }, [tasks.length]);

  /**
   * Hand focus back to the outline when the tray removes itself from under it
   * (#3131, WCAG 2.4.3).
   *
   * The tray now disappears at zero, and `usePromoteTask` is optimistic — so
   * the count can hit zero from a *collaborator's* WebSocket update while this
   * user's focus is resting on the walk control or the collapse toggle. React
   * unmounts the node, the browser drops focus to `<body>`, and the next Tab
   * restarts from the top of the document. That is the same class of loss the
   * live region above is hoisted out of the gate to avoid, applied to focus
   * instead of announcements.
   *
   * `focusWasInsideRef` is driven by the region's own focus/blur events, NOT
   * sampled in an effect. Focusing a control does not re-render, so an effect
   * that reads `document.activeElement` on each commit never observes the user
   * arriving — it would still hold `false` at the moment the region vanishes,
   * which is the whole case this exists for. React's `onFocus`/`onBlur` bubble,
   * so one pair on the region covers every control inside it; when the node is
   * removed while focused no blur fires, which leaves the flag `true` exactly
   * when it should be. The `<body>` check is what then keeps this from stealing
   * focus the user moved somewhere legitimate in the meantime.
   */
  const focusWasInsideRef = useRef(false);
  useEffect(() => {
    if (tasks.length > 0) return;
    if (!focusWasInsideRef.current) return;
    focusWasInsideRef.current = false;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    // The outline's roving-tabindex row is the one focusable anchor on this
    // surface that is guaranteed to exist while the Schedule is rendered.
    document.querySelector<HTMLElement>('[data-row-id][tabindex="0"]')?.focus();
  }, [tasks.length]);

  const persistCollapsed = useCallback((val: boolean) => {
    setCollapsed(val);
    try { localStorage.setItem(COLLAPSED_KEY, String(val)); } catch { /* ignore */ }
  }, []);

  // Partition into sections (rule 132, extended #1790). The header count is the
  // sum. No-sprint work keeps the draggable To Do / Backlog sections; sprint-
  // assigned backlog (predicate guarantees status BACKLOG) is grouped read-only
  // under its target sprint, ordered by the sprint's start date.
  const { todoTasks, backlogTasks, sprintGroups } = useMemo(() => {
    const sprintById = new Map<string, ApiSprint>();
    for (const s of sprints ?? []) sprintById.set(s.id, s);

    const todo: Task[] = [];
    const backlog: Task[] = [];
    const bySprint = new Map<string, Task[]>();
    for (const t of tasks) {
      if (t.sprintId) {
        const arr = bySprint.get(t.sprintId) ?? [];
        arr.push(t);
        bySprint.set(t.sprintId, arr);
      } else if (t.status === 'BACKLOG') {
        backlog.push(t);
      } else {
        todo.push(t);
      }
    }

    const groups = [...bySprint.entries()]
      .map(([sprintId, groupTasks]) => ({
        sprintId,
        sprint: sprintById.get(sprintId) ?? null,
        tasks: groupTasks,
      }))
      .sort((a, b) =>
        (a.sprint?.start_date ?? '￿').localeCompare(b.sprint?.start_date ?? '￿'),
      );

    return { todoTasks: todo, backlogTasks: backlog, sprintGroups: groups };
  }, [tasks, sprints]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const promoteMutation = usePromoteTask();
  const setActionToast = useScheduleStore((s) => s.setScheduleActionToast);

  // Reveal bridge (#1798): the "N planned" badge on a phase row asks the tray to
  // expand and scroll a target sprint's group into view. We own the collapsed
  // state, so the request comes through the store; the `nonce` re-fires the
  // reveal on a repeat click even when the sprintId is unchanged.
  const revealRequest = useScheduleStore((s) => s.revealGutterSprint);
  useEffect(() => {
    if (!revealRequest) return;
    persistCollapsed(false);
    const sprintId = revealRequest.sprintId;
    if (!sprintId) return;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Two rAFs so the tray has committed its expanded DOM before we look up the
    // group element and scroll it in (a single frame can race the state flush).
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-sprint-group="${sprintId}"]`);
        el?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [revealRequest, persistCollapsed]);

  // aria-live (polite) — promote announcements via DOM ref (rule 30), not state.
  const ariaLiveRef = useRef<HTMLDivElement>(null);

  // Keyboard "Schedule…" dialog (rule 135) — opened from a backlog chip's ···
  // menu. Tracks the trigger element so focus returns to it on close.
  const [scheduleDialogTask, setScheduleDialogTask] = useState<Task | null>(null);
  const scheduleTriggerRef = useRef<HTMLElement | null>(null);

  const handleScheduleRequest = useCallback((task: Task, trigger: HTMLElement) => {
    scheduleTriggerRef.current = trigger;
    setScheduleDialogTask(task);
  }, []);

  const handleScheduleDialogClose = useCallback(() => {
    setScheduleDialogTask(null);
    // Return focus to the ··· trigger (rule 135 / BacklogDemoteConfirmDialog pattern).
    scheduleTriggerRef.current?.focus();
    scheduleTriggerRef.current = null;
  }, []);

  // --- Drag start from a row ---
  const handleDragStart = useCallback(
    (task: Task, _pointerId: number, x: number, y: number) => {
      setDrag({ task, isBacklog: task.status === 'BACKLOG', x, y, overCanvas: false, dropDate: null });
    },
    [],
  );

  /**
   * Promote a backlog idea onto the schedule (decision A2): the explicit
   * NOT_STARTED skips the server's date-gated → IN_PROGRESS bump, so the chip
   * lands deterministically in To Do.
   *
   * Lives at component scope rather than inline in the drop handler so its
   * success/error callbacks aren't nested five function levels deep inside the
   * `setDrag` updater inside `onUp` inside the effect (Sonar S2004).
   */
  const promoteBacklogTask = useCallback(
    (task: Task, dropDate: string) => {
      promoteMutation.mutate(
        { id: task.id, projectId, planned_start: dropDate, status: 'NOT_STARTED' },
        {
          onSuccess: () => {
            const label = formatShortDate(dropDate);
            setActionToast({
              message: `Added '${task.name}' to the ${itl.lower}, starting ${label}`,
            });
            if (ariaLiveRef.current) {
              ariaLiveRef.current.textContent = `Added ${task.name} to the ${itl.lower}, starting ${label}.`;
            }
          },
          onError: () => {
            if (ariaLiveRef.current) {
              ariaLiveRef.current.textContent = `Could not add ${task.name} to the ${itl.lower}.`;
            }
          },
        },
      );
    },
    [projectId, promoteMutation, setActionToast, itl.lower],
  );

  // --- Global pointer move/up during drag ---
  useEffect(() => {
    if (!drag) return;

    function onMove(e: PointerEvent) {
      const canvasEl = canvasScrollRef.current;
      if (!canvasEl || !scaleData) {
        setDrag((d) => d ? { ...d, x: e.clientX, y: e.clientY, overCanvas: false, dropDate: null } : null);
        return;
      }
      const rect = canvasEl.getBoundingClientRect();
      const overCanvas =
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom;

      let dropDate: string | null = null;
      if (overCanvas) {
        // Convert viewport X → canvas-origin X → date (subtract scrollLeft, rule 57)
        const canvasX = e.clientX - rect.left + canvasEl.scrollLeft;
        dropDate = leftToDate(canvasX, scaleData).toISOString().slice(0, 10);
      }
      setDrag((d) => d ? { ...d, x: e.clientX, y: e.clientY, overCanvas, dropDate } : null);
    }

    function onUp(e: PointerEvent) {
      setDrag((d) => {
        if (!d) return null;
        if (d.overCanvas && d.dropDate) {
          if (!navigator.onLine) {
            // Offline (rule 29) — skip PATCH, clear preview, leave the chip;
            // the existing offline toast in ScheduleView surfaces the reason.
            return null;
          }
          const dropDate = d.dropDate;
          const task = d.task;
          if (d.isBacklog) {
            promoteBacklogTask(task, dropDate);
          } else {
            // To Do path unchanged — only planned_start; server owns the bump.
            promoteMutation.mutate({ id: task.id, projectId, planned_start: dropDate });
          }
        }
        return null;
      });
      void e; // suppress unused warning
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setDrag(null);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [drag, canvasScrollRef, scaleData, projectId, promoteMutation, promoteBacklogTask]);

  /**
   * Commit a To Do row's planned start — the ··· menu's quick actions and its
   * date picker both land here (#3064).
   *
   * Announces the outcome (#3064). The only visible proof of success is the chip
   * LEAVING the tray, which tells a screen-reader user nothing; the backlog
   * promote path beside this one has always announced, and two paths writing the
   * same field with different feedback is the drift #3063 was about.
   *
   * Sends `planned_start` alone. The NOT_STARTED → IN_PROGRESS transition for a
   * date that has already arrived is the server's call (#336) and is deliberately
   * not pre-empted here — see #3075, which owns disclosing it.
   */
  const handleSetDate = useCallback((task: Task, date: string) => {
    if (!navigator.onLine) {
      if (ariaLiveRef.current) {
        ariaLiveRef.current.textContent = 'You are offline — reconnect to schedule this task.';
      }
      return;
    }
    promoteMutation.mutate(
      { id: task.id, projectId, planned_start: date },
      {
        onSuccess: () => {
          if (ariaLiveRef.current) {
            ariaLiveRef.current.textContent =
              `Scheduled ${task.name} to start ${formatShortDate(date)}.`;
          }
        },
        onError: () => {
          if (ariaLiveRef.current) {
            ariaLiveRef.current.textContent = `Could not schedule ${task.name}.`;
          }
        },
      },
    );
  }, [projectId, promoteMutation]);

  const canvasRect = canvasScrollRef.current?.getBoundingClientRect() ?? null;
  const dropX = drag?.dropDate && canvasRect && scaleData
    ? (() => {
        const canvasEl = canvasScrollRef.current!;
        const leftFromOrigin =
          (new Date(drag.dropDate + 'T00:00:00Z').getTime() - scaleData.start.getTime()) *
          scaleData.pxPerMs;
        return leftFromOrigin - canvasEl.scrollLeft;
      })()
    : null;

  const totalCount = tasks.length;

  /**
   * The rows the "Schedule N…" button acts on — everything the tray renders as
   * draggable. Sprint-targeted groups are excluded: their dates come from sprint
   * planning, so the apparatus is absent rather than disabled.
   *
   * The header count stays the TOTAL while the button counts only what it can
   * act on. When they differ that is honest, not a bug — but the difference has
   * to reach a screen reader, hence the explicit label below.
   */
  const datableIds = useMemo(
    () => [...todoTasks, ...backlogTasks].map((t) => t.id),
    [todoTasks, backlogTasks],
  );
  const excludedCount = totalCount - datableIds.length;

  /**
   * Offline guard (rule 29), read at click time rather than render time so a
   * connection that drops while the tray sits open is still caught.
   *
   * Opening the sheet offline would walk the planner through picking a date and
   * then fail at Apply — a batch write cannot be queued, for the same reason
   * `handleSetDate` refuses one: it recomputes CPM server-side.
   */
  const handleScheduleClick = useCallback(() => {
    if (!navigator.onLine) {
      if (ariaLiveRef.current) {
        ariaLiveRef.current.textContent =
          'You are offline — reconnect to schedule these tasks.';
      }
      setActionToast({ message: 'You are offline — reconnect to schedule these tasks.' });
      return;
    }
    onScheduleMany?.(datableIds);
  }, [onScheduleMany, datableIds, setActionToast]);

  return (
    <>
      {/*
        Gutter panel — rendered only while the tray is holding something (#3131).

        An empty queue is not a status. Before this the panel was a permanent
        44px lane across the bottom of the Schedule whose entire content was the
        word "Unscheduled", a `(0)`, and a caption confirming nothing was wrong —
        a standing reassurance about a problem nobody has, costing canvas height
        on every fully-scheduled project forever. Absence is the empty state,
        which is what the mobile tray has always done (`mobile/MobileSchedule.tsx`,
        "No tasks → no tray at all").

        The gate is HERE and not at the `<UnscheduledGutter>` call site in
        `ScheduleView.tsx`, and moving it there would be a silent regression.
        `usePromoteTask` is optimistic in `onMutate`, so scheduling the LAST
        unscheduled row drops the count to zero *before* the mutation resolves.
        Unmounting the component on that transition destroys the `aria-live`
        node below, and the `onSuccess` handler firing a moment later then
        writes its announcement to a `ref.current` that is already `null` — so
        the one act a screen-reader user most needs confirmed ("that was the
        last one") would be the one act that says nothing. #3064 added that
        announcement precisely because "the chip left the tray" is not feedback
        a screen reader can perceive. The live region, the drag portals and the
        schedule dialog are therefore siblings of this gate, not children of it,
        and stay mounted at zero.
      */}
      {totalCount > 0 && (
      <div
        role="region"
        aria-label="Unscheduled tasks"
        // Focus bookkeeping for the hand-back above — these bubble, so one pair
        // here covers every control in the tray.
        onFocus={() => { focusWasInsideRef.current = true; }}
        onBlur={() => { focusWasInsideRef.current = false; }}
        className="flex-shrink-0 border-t-2 border-neutral-border bg-neutral-surface-sunken"
      >
        {/* Header strip */}
        <div
          className="flex items-center h-11"
          style={{ paddingLeft: taskListWidth }}
        >
          <span className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary px-4">
            Unscheduled
          </span>
          {/*
            The count is a control, not a caption (#3131). It walks the outline
            to the next row this tray is counting, so the number names something
            you can reach instead of merely describing a situation.

            Deliberately NOT the F7 walk (`findUndatedRow`), even though that
            helper is right there. F7's predicate is `!plannedStart` over every
            visible row, which is a strictly WIDER set than this tray's — it
            includes summaries, IN_PROGRESS rows and sprint-committed work that
            the gutter's own filter excludes. Walking from "(3)" onto a row that
            is not one of those 3 would make the number mean two things at once.
            What the number MEANS is #2986's question, and this issue does not
            answer it; this only makes the members of the existing count
            reachable.
          */}
          {onWalkToUnscheduled ? (
            // The `Tooltip` is not decoration (rule 287, restated by rule
            // 328(b)): without it the control's whole visible form is `(2) →`
            // and its meaning lives only in the `aria-label` — which is the
            // inversion those rules name, handing screen-reader users a
            // sentence sighted users never get. `describe={false}` because the
            // accessible name already says the same thing, so AT hears it once.
            <Tooltip
              content={`Go to the next unscheduled ${ROW_NOUN} in the outline`}
              describe={false}
            >
              <button
                type="button"
                onClick={onWalkToUnscheduled}
                // The name LEADS with the visible token (WCAG 2.5.3 Label in
                // Name): the visible label is `(2)`, so a speech-input user
                // saying "click 2" must match.
                aria-label={`(${totalCount}) — go to the next unscheduled ${ROW_NOUN} in the outline, ${countRows(totalCount)} unscheduled`}
                // Sized from the row-height owner rather than a literal (rule
                // 315/328): on a coarse pointer the target is `ROW_HEIGHT_COARSE`,
                // the same route `NUDGE_SIZE_COARSE` takes. On a mouse it matches
                // the 32px collapse toggle beside it rather than the `text-xs`
                // glyph it wraps, so it is not a NEW sub-32px target on this strip.
                style={{ minHeight: walkTargetSize, minWidth: walkTargetSize }}
                className="group ml-1 inline-flex items-center justify-center gap-1 rounded-control px-1.5
                  text-neutral-text-secondary hover:text-neutral-text-primary hover:underline
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                <span className="tppm-mono text-xs">({totalCount})</span>
                <span
                  aria-hidden="true"
                  className="text-xs motion-safe:transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </button>
            </Tooltip>
          ) : (
            <span className="tppm-mono text-xs text-neutral-text-secondary ml-1">
              ({totalCount})
            </span>
          )}
          <span className="hidden md:inline text-xs italic text-neutral-text-secondary ml-3">
            no committed start yet
          </span>
          <div className="flex-1" />
          {onScheduleMany && datableIds.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              className="mr-2"
              onClick={handleScheduleClick}
              aria-label={
                excludedCount > 0
                  ? `Schedule ${datableIds.length} unscheduled ${datableIds.length === 1 ? 'task' : 'tasks'} — ${excludedCount} ${itl.lower}-targeted ${excludedCount === 1 ? `${ROW_NOUN} is` : `${ROW_NOUN_PLURAL} are`} excluded`
                  : undefined
              }
            >
              Schedule {datableIds.length}…
            </Button>
          )}
          <button
            type="button"
            aria-label={collapsed ? 'Expand unscheduled tasks' : 'Collapse unscheduled tasks'}
            onClick={() => persistCollapsed(!collapsed)}
            className="w-8 h-8 flex items-center justify-center mr-2 rounded-control text-neutral-text-secondary
              hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <span
              className={`inline-block transition-transform duration-150 ${collapsed ? '' : 'rotate-180'}`}
              aria-hidden="true"
            >
              ▾
            </span>
          </button>
        </div>

        {/* Two-section tray — one scroll container, sticky sub-headers (rule 132) */}
        {!collapsed && (
          <div
            className="overflow-y-auto"
            style={{
              maxHeight: Math.min(totalCount * 36 + 80, 360),
              paddingLeft: taskListWidth,
            }}
          >
            {/* To Do section */}
            <section
              role="group"
              aria-label={`To do, unscheduled, ${todoTasks.length} ${todoTasks.length === 1 ? 'task' : 'tasks'}`}
            >
              <h3
                className="sticky top-0 z-10 bg-neutral-surface-sunken px-4 py-1.5
                  text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
              >
                To Do · Unscheduled ({todoTasks.length})
              </h3>
              {todoTasks.length === 0 ? (
                <div
                  role="status"
                  className="px-4 py-2 text-xs italic text-neutral-text-secondary"
                >
                  No unscheduled To Do tasks
                </div>
              ) : (
                todoTasks.map((task) => (
                  <UnscheduledTaskRow
                    key={task.id}
                    task={task}
                    variant="todo"
                    onDragStart={handleDragStart}
                    onSetDate={handleSetDate}
                    serverDate={project?.server_date}
                  />
                ))
              )}
            </section>

            {/* Backlog section */}
            <section
              role="group"
              aria-label={`Backlog, ${countRows(backlogTasks.length)}`}
              className="border-t border-neutral-border"
            >
              <div className="sticky top-0 z-10 bg-neutral-surface-sunken flex items-baseline gap-2 px-4 py-1.5">
                <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
                  Backlog ({backlogTasks.length})
                </h3>
                {backlogTasks.length > 0 && (
                  <span className="hidden lg:inline ml-auto text-xs italic text-neutral-text-secondary">
                    drag onto the timeline to promote &amp; schedule
                  </span>
                )}
              </div>
              {backlogTasks.length === 0 ? (
                <div
                  role="status"
                  className="px-4 py-2 text-xs italic text-neutral-text-secondary"
                >
                  No backlog items
                </div>
              ) : (
                backlogTasks.map((task) => (
                  <UnscheduledTaskRow
                    key={task.id}
                    task={task}
                    variant="backlog"
                    onDragStart={handleDragStart}
                    onSetDate={handleSetDate}
                    onScheduleRequest={handleScheduleRequest}
                    serverDate={project?.server_date}
                  />
                ))
              )}
            </section>

            {/* Sprint-assigned backlog (#1790) — one read-only group per target
                sprint. These are uncommitted (CPM-excluded) so they carry no
                timeline bar and cannot be dated from here; the honest header
                states the sprint window without implying a committed date. */}
            {sprintGroups.map((group) => {
              const s = group.sprint;
              const planned = s?.state === 'PLANNED';
              const stateWord = s
                ? s.state.charAt(0) + s.state.slice(1).toLowerCase()
                : '';
              const name = s?.name ?? 'Sprint';
              const window = s
                ? `${formatShortDate(s.start_date)} – ${formatShortDate(s.finish_date)}`
                : '';
              const subnote = planned
                ? 'pending team plan — not scheduled'
                : 'not yet started — not scheduled';
              const n = group.tasks.length;
              return (
                <section
                  key={group.sprintId}
                  data-sprint-group={group.sprintId}
                  role="group"
                  aria-label={`Targeted for ${name}, ${stateWord.toLowerCase()}, read-only, ${n} ${n === 1 ? 'task' : 'tasks'}`}
                  className="border-t border-neutral-border"
                >
                  <div className="sticky top-0 z-10 bg-neutral-surface-sunken px-4 py-1.5">
                    <div className="flex items-baseline gap-2">
                      <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
                        Targeted: {name}
                        {stateWord && ` · ${stateWord}`}
                      </h3>
                      {window && (
                        <span className="tppm-mono text-xs text-neutral-text-secondary">
                          {window}
                        </span>
                      )}
                    </div>
                    <span className="text-xs italic text-neutral-text-secondary">
                      {subnote}
                    </span>
                  </div>
                  {group.tasks.map((task) => (
                    <UnscheduledTaskRow key={task.id} task={task} variant="planned" />
                  ))}
                </section>
              );
            })}
          </div>
        )}

      </div>
      )}

      {/* In-flight indicator — OUTSIDE the `totalCount > 0` gate, for exactly
          the reason the live region is. `usePromoteTask` is optimistic, so
          promoting the LAST row zeroes the count while the PATCH is still in
          flight; leaving this inside the gate would unmount the only "something
          is happening" signal at the moment it is doing its job, and flash the
          whole panel back in if the mutation then fails and rolls back. Loading
          is its own state and must not be erased by an optimistic empty (rule
          248). */}
      {promoteMutation.isPending && (
        <div
          aria-busy="true"
          aria-label="Promoting task…"
          style={{ paddingLeft: taskListWidth }}
          className="px-4 py-2"
        >
          <div className="h-9 rounded-card motion-safe:animate-pulse bg-neutral-border/50" />
        </div>
      )}

      {/* aria-live (polite) — promote announcements via DOM ref (rule 30).
          Outside the `totalCount > 0` gate on purpose — see the note above it:
          the last row leaving the tray is the announcement most worth keeping,
          and it is the one an unmount would eat. */}
      <div ref={ariaLiveRef} aria-live="polite" aria-atomic="true" className="sr-only" />

      {/* Drag preview portal */}
      {drag && createPortal(
        <UnscheduledDragPreview task={drag.task} x={drag.x} y={drag.y} />,
        document.body,
      )}

      {/* Drop indicator portal — only when over canvas with a valid date */}
      {drag?.overCanvas && drag.dropDate && canvasRect && dropX !== null && createPortal(
        <UnscheduledDropIndicator
          x={dropX}
          canvasRect={canvasRect}
          dateLabel={formatShortDate(drag.dropDate)}
        />,
        document.body,
      )}

      {/* Keyboard "Schedule…" dialog (rule 135) — backlog chip ··· entry point */}
      {scheduleDialogTask && (
        <ScheduleTaskDialog
          task={scheduleDialogTask}
          projectId={projectId}
          ariaLiveRef={ariaLiveRef}
          onClose={handleScheduleDialogClose}
        />
      )}
    </>
  );
}
