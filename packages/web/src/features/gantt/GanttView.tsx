import { useRef, useMemo, useCallback, useState } from 'react';
import type { IApi } from '@svar-ui/gantt-store';
import './gantt.css';
import '@svar-ui/react-gantt/style.css';
import { useGanttTasks } from '@/hooks/useGanttTasks';
import { useGanttStore } from '@/stores/ganttStore';
import { useScrollSync } from '@/hooks/useScrollSync';
import { useDragCpm } from '@/hooks/useDragCpm';
import { useKeyboardReschedule } from '@/hooks/useKeyboardReschedule';
import { useDragStore } from '@/stores/dragStore';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { toSvarTasks } from './adapters/toSvarTasks';
import { toSvarLinks } from './adapters/toSvarLinks';
import { TaskListPanel } from './TaskListPanel';
import { GanttTimeline } from './GanttTimeline';
import { ZoomControl } from './ZoomControl';
import { MonteCarloRow } from './MonteCarloRow';
import { MilestoneDeltaTooltip } from './MilestoneDeltaTooltip';
import { DateInputPopover } from './DateInputPopover';
import type { Task } from '@/types';

export function GanttView() {
  const { tasks, links, isLoading, error } = useGanttTasks();
  const zoomLevel = useGanttStore((s) => s.zoomLevel);

  const taskListScrollRef = useRef<HTMLDivElement>(null);
  const ganttApiRef = useRef<IApi | null>(null);
  const [ganttApi, setGanttApi] = useState<IApi | null>(null);
  const { widths, setWidth, totalWidth } = useColumnWidths();

  // aria-live (polite) — drag announcements via DOM ref (rule 30)
  const ariaLiveRef = useRef<HTMLDivElement>(null);
  // aria-live (assertive) — keyboard nudge announcements; must interrupt immediately (rule 53)
  const ariaAssertiveRef = useRef<HTMLDivElement>(null);

  // Ref to the timeline container for MilestoneDeltaTooltip positioning (rule 31)
  const timelineContainerRef = useRef<HTMLDivElement>(null);

  // Ref set true while keyboard reschedule mode is active — read by useDragCpm
  // to prevent its Escape handler from double-cancelling (issue #34)
  const keyboardModeRef = useRef<boolean>(false);

  // Task shown in the date input popover (null = popover closed)
  const [datePopoverTask, setDatePopoverTask] = useState<Task | null>(null);

  useScrollSync(taskListScrollRef, ganttApiRef);

  const handleApiReady = useCallback(
    (api: IApi) => {
      ganttApiRef.current = api;
      setGanttApi(api);
    },
    [],
  );

  const svarTasks = useMemo(() => (tasks ? toSvarTasks(tasks) : []), [tasks]);
  const svarLinks = useMemo(() => (links ? toSvarLinks(links) : []), [links]);
  const taskIds = useMemo(() => (tasks ? tasks.map((t) => t.id) : []), [tasks]);

  // Drag CPM preview — wires SVAR intercepts + Web Worker (issue #19)
  useDragCpm({
    ganttApi,
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
    ganttApi,
    tasks: tasks ?? [],
    links: links ?? [],
    ariaLiveRef,
    ariaAssertiveRef,
    keyboardModeRef,
    onOpenDatePopover: handleOpenDatePopover,
  });

  const dragPhase = useDragStore((s) => s.phase);
  const draggedTaskId = useDragStore((s) => s.draggedTaskId);
  const isKeyboardMode = useDragStore((s) => s.isKeyboardMode);

  // Origin task for the keyboard reschedule ghost bar (rule 52)
  const originTask = useMemo(() => {
    if (!isKeyboardMode || !draggedTaskId || !tasks) return null;
    const t = tasks.find((task) => task.id === draggedTaskId);
    return t ? { id: t.id, start: t.start, finish: t.finish } : null;
  }, [isKeyboardMode, draggedTaskId, tasks]);

  const timelineTop = timelineContainerRef.current
    ? timelineContainerRef.current.getBoundingClientRect().top
    : 0;

  const handleDatePopoverConfirm = useCallback(
    (newStart: string) => {
      setDatePopoverTask(null);
      // Commit via drag store — the confirmed start overrides the keyboard delta
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
    // Return focus to the Gantt without cancelling the keyboard reschedule —
    // user may have opened the popover accidentally and wants to keep nudging
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-semantic-critical">
          Couldn&apos;t load tasks.{' '}
          <button
            type="button"
            className="underline focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
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
      <div className="flex h-full" aria-busy="true" aria-label="Loading Gantt">
        <div className="w-[280px] flex-shrink-0 border-r border-neutral-border p-2 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-7 rounded animate-pulse bg-neutral-surface-raised" />
          ))}
        </div>
        <div className="flex-1 bg-neutral-surface" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-end px-4 h-10 border-b border-neutral-border bg-neutral-surface-raised flex-shrink-0">
        <ZoomControl />
      </div>

      <div className="flex flex-1 overflow-hidden" ref={timelineContainerRef}>
        <TaskListPanel
          tasks={tasks}
          scrollRef={taskListScrollRef}
          widths={widths}
          setWidth={setWidth}
          totalWidth={totalWidth}
        />
        <GanttTimeline
          tasks={svarTasks}
          links={svarLinks as never}
          zoom={zoomLevel}
          onApiReady={handleApiReady}
          taskIds={taskIds}
          originTask={originTask}
        />
      </div>

      <MonteCarloRow ganttApi={ganttApi} taskListWidth={totalWidth} />

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
