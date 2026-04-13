import { useRef, useCallback, useState, useEffect, type PointerEvent } from 'react';
import { useSearchParams } from 'react-router';
import type { GanttEngine } from './engine';
import { dateToLeft, leftToDate } from './engine';
import { HEADER_HEIGHT, ROW_HEIGHT } from './ganttConstants';
import { useGanttTasks } from '@/hooks/useGanttTasks';
import { useCreateTask, useRescheduleTask } from '@/hooks/useTaskMutations';
import { useGanttStore } from '@/stores/ganttStore';
import { useDragCpm } from '@/hooks/useDragCpm';
import { useKeyboardReschedule } from '@/hooks/useKeyboardReschedule';
import { useDragStore } from '@/stores/dragStore';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { TaskListPanel } from './TaskListPanel';
import { CanvasGanttTimeline } from './CanvasGanttTimeline';
import { ZoomControl } from './ZoomControl';
import { MonteCarloRow } from './MonteCarloRow';
import { MilestoneDeltaTooltip } from './MilestoneDeltaTooltip';
import { DateInputPopover } from './DateInputPopover';
import { AddTaskForm, type AddTaskFormHandle } from '@/features/project/AddTaskForm';
import { RecalculatingBadge } from '@/features/project/RecalculatingBadge';
import type { Task } from '@/types';

// ---------------------------------------------------------------------------
// GanttEmptyState — shown when tasks.length === 0 (rule 78)
// ---------------------------------------------------------------------------

function GanttEmptyState() {
  return (
    <div
      role="status"
      className="flex flex-1 h-full items-center justify-center bg-gantt-surface"
    >
      <p className="text-sm text-gantt-text-secondary">No tasks yet. Add a task to get started.</p>
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
      className="w-1 flex-shrink-0 cursor-col-resize bg-white/10 hover:bg-brand-primary/60 transition-colors z-10"
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
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('project');
  const { tasks, links, isLoading, error } = useGanttTasks();
  const zoomLevel = useGanttStore((s) => s.zoomLevel);
  const [showAddForm, setShowAddForm] = useState(false);
  const addFormRef = useRef<AddTaskFormHandle>(null);
  const createTask = useCreateTask(projectId);

  // Tracks tasks created but not yet scheduled (null dates filtered from Gantt).
  // Entries are removed when the task appears in the scheduled tasks list.
  const [pendingTaskIds, setPendingTaskIds] = useState<Map<string, string>>(new Map());

  // Remove pending entries once the scheduler assigns them dates
  useEffect(() => {
    if (!tasks || pendingTaskIds.size === 0) return;
    const taskIds = new Set(tasks.map((t) => t.id));
    setPendingTaskIds((prev) => {
      const next = new Map(prev);
      for (const id of prev.keys()) {
        if (taskIds.has(id)) next.delete(id);
      }
      return next;
    });
  }, [tasks, pendingTaskIds.size]);

  const taskListScrollRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<GanttEngine | null>(null);
  const { widths, setWidth, totalWidth } = useColumnWidths();

  // aria-live (polite) — drag announcements via DOM ref (rule 30)
  const ariaLiveRef = useRef<HTMLDivElement>(null);
  // aria-live (assertive) — keyboard nudge announcements; must interrupt immediately (rule 53)
  const ariaAssertiveRef = useRef<HTMLDivElement>(null);

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
    tasks: tasks ?? [],
    links: links ?? [],
    ariaLiveRef,
    keyboardModeRef,
  });

  // Keyboard rescheduling — Enter/Arrow/d/Escape (issue #34)
  const handleOpenDatePopover = useCallback(
    (taskId: string) => {
      const task = tasks?.find((t) => t.id === taskId) ?? null;
      setDatePopoverTask(task);
    },
    [tasks],
  );

  useKeyboardReschedule({
    engine,
    tasks: tasks ?? [],
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
      const task = tasks?.find((t) => t.id === id);
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
  }, [engine, projectId, tasks, rescheduleTask]);

  // Bar resize — convert canvas-origin right-x to new finish date and PATCH
  useEffect(() => {
    if (!engine || !projectId) return;
    return engine.on('resize-task-end', ({ id, right, cancelled }) => {
      if (cancelled) return;
      const scales = engine.scales;
      if (!scales) return;
      const task = tasks?.find((t) => t.id === id);
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
  }, [engine, projectId, tasks, rescheduleTask]);

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

  // "Today" button handler (rule 82)
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
      <div className="flex h-full items-center justify-center bg-gantt-surface">
        <p className="text-sm text-gantt-semantic-critical">
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

  if (isLoading || !tasks) {
    return (
      <div className="flex h-full bg-gantt-surface" aria-busy="true" aria-label="Loading Gantt">
        <div className="w-[280px] flex-shrink-0 border-r border-white/10 p-2 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-7 rounded animate-pulse bg-white/10" />
          ))}
        </div>
        <div className="flex-1 bg-gantt-surface" />
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
            tasks={tasks}
            scrollRef={taskListScrollRef}
            widths={widths}
            setWidth={setWidth}
            totalWidth={totalWidth}
          />
          <GanttFallbackTable tasks={tasks} />
        </div>
      </div>
    );
  }

  // Compute scrollable content width from scales
  const scales = engine?.scales;
  const totalCanvasWidth = scales ? scales.totalWidth : 0;

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
        <div className="flex-1" />
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
          tasks={tasks}
          pendingTaskIds={pendingTaskIds}
          scrollRef={taskListScrollRef}
          widths={widths}
          setWidth={setWidth}
          totalWidth={totalWidth}
        />
        {/* Panel splitter — drag to resize task list width */}
        <PanelSplitter currentTaskWidth={widths.task} setWidth={setWidth} />

        {tasks.length === 0 ? (
          <GanttEmptyState />
        ) : (
          <div
            ref={canvasScrollRef}
            className="flex-1 min-w-0 overflow-auto relative"
            onScroll={handleCanvasScroll}
          >
            {/* Scrollable content area sized to the full canvas width */}
            <div
              style={{
                width: totalCanvasWidth > 0 ? totalCanvasWidth : '100%',
                height: HEADER_HEIGHT + tasks.length * ROW_HEIGHT,
                position: 'relative',
              }}
            >
              {/* Canvas layers fill the viewport (sticky via absolute+inset in container) */}
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none',
                }}
              >
                <CanvasGanttTimeline
                  tasks={tasks}
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
    </div>
  );
}

