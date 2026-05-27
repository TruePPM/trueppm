import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@/types';
import type { GanttScaleData } from './engine';
import { leftToDate } from './engine';
import { usePromoteTask } from '@/hooks/useTaskMutations';
import { useScheduleStore } from '@/stores/scheduleStore';
import { UnscheduledTaskRow } from './UnscheduledTaskRow';
import { UnscheduledDragPreview } from './UnscheduledDragPreview';
import { UnscheduledDropIndicator } from './UnscheduledDropIndicator';
import { ScheduleTaskDialog } from './ScheduleTaskDialog';
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
}: UnscheduledGutterProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === 'true';
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

  const persistCollapsed = useCallback((val: boolean) => {
    setCollapsed(val);
    try { localStorage.setItem(COLLAPSED_KEY, String(val)); } catch { /* ignore */ }
  }, []);

  // Partition into the two sections (rule 132). The header count is the sum.
  const { todoTasks, backlogTasks } = useMemo(() => {
    const todo: Task[] = [];
    const backlog: Task[] = [];
    for (const t of tasks) {
      if (t.status === 'BACKLOG') backlog.push(t);
      else todo.push(t);
    }
    return { todoTasks: todo, backlogTasks: backlog };
  }, [tasks]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const promoteMutation = usePromoteTask();
  const setActionToast = useScheduleStore((s) => s.setScheduleActionToast);

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
            // Promote a backlog idea (decision A2): explicit NOT_STARTED skips
            // the server's date-gated → IN_PROGRESS bump → deterministic To Do.
            promoteMutation.mutate(
              { id: task.id, projectId, planned_start: dropDate, status: 'NOT_STARTED' },
              {
                onSuccess: () => {
                  const label = formatShortDate(dropDate);
                  setActionToast({
                    message: `Promoted '${task.name}' to To Do and scheduled for ${label}`,
                  });
                  if (ariaLiveRef.current) {
                    ariaLiveRef.current.textContent = `Promoted ${task.name}, scheduled for ${label}.`;
                  }
                },
                onError: () => {
                  if (ariaLiveRef.current) {
                    ariaLiveRef.current.textContent = `Could not schedule ${task.name}.`;
                  }
                },
              },
            );
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
  }, [drag, canvasScrollRef, scaleData, projectId, promoteMutation, setActionToast]);

  const handleSetDate = useCallback((task: Task, date: string) => {
    if (!navigator.onLine) return;
    promoteMutation.mutate({ id: task.id, projectId, planned_start: date });
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

  return (
    <>
      {/* Gutter panel */}
      <div
        role="region"
        aria-label="Unscheduled tasks"
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
          <span className="tppm-mono text-xs text-neutral-text-disabled ml-1">
            ({totalCount})
          </span>
          {totalCount === 0 && (
            <span className="text-xs italic text-neutral-text-disabled ml-3">
              All To Do and Backlog tasks have planned dates
            </span>
          )}
          <div className="flex-1" />
          {totalCount > 0 && (
            <button
              type="button"
              aria-label={collapsed ? 'Expand unscheduled tasks' : 'Collapse unscheduled tasks'}
              onClick={() => persistCollapsed(!collapsed)}
              className="w-8 h-8 flex items-center justify-center mr-2 rounded text-neutral-text-secondary
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
          )}
        </div>

        {/* Two-section tray — one scroll container, sticky sub-headers (rule 132) */}
        {!collapsed && totalCount > 0 && (
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
                  className="px-4 py-2 text-xs italic text-neutral-text-disabled"
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
                  />
                ))
              )}
            </section>

            {/* Backlog section */}
            <section
              role="group"
              aria-label={`Backlog, ${backlogTasks.length} ${backlogTasks.length === 1 ? 'item' : 'items'}`}
              className="border-t border-neutral-border"
            >
              <div className="sticky top-0 z-10 bg-neutral-surface-sunken flex items-baseline gap-2 px-4 py-1.5">
                <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
                  Backlog ({backlogTasks.length})
                </h3>
                {backlogTasks.length > 0 && (
                  <span className="hidden lg:inline ml-auto text-xs italic text-neutral-text-disabled">
                    drag onto the timeline to promote &amp; schedule
                  </span>
                )}
              </div>
              {backlogTasks.length === 0 ? (
                <div
                  role="status"
                  className="px-4 py-2 text-xs italic text-neutral-text-disabled"
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
                  />
                ))
              )}
            </section>
          </div>
        )}

        {/* Loading skeleton — shown while promote mutation is in-flight */}
        {promoteMutation.isPending && (
          <div
            aria-busy="true"
            aria-label="Promoting task…"
            style={{ paddingLeft: taskListWidth }}
            className="px-4 py-2"
          >
            <div className="h-9 rounded animate-pulse bg-neutral-border/50" />
          </div>
        )}
      </div>

      {/* aria-live (polite) — promote announcements via DOM ref (rule 30) */}
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
