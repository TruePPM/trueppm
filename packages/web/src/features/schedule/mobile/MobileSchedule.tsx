import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Task, TaskStatus } from '@/types';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useUnscheduledTasks } from '@/hooks/useUnscheduledTasks';
import { useToggleComplete } from '@/hooks/useTaskMutations';
import { toast } from '@/components/Toast';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/Button';
import {
  CalendarIcon,
  ChevronRightIcon,
  GanttIcon,
  PlusIcon,
  WarningIcon,
} from '@/components/Icons';
import {
  barGeometry,
  compareWbs,
  computeScheduleWindow,
  markerLeftPct,
  todayLeftPct,
  wbsDepth,
  type ScheduleWindow,
} from './mobileScheduleGeometry';

const UNSCHEDULED_COLLAPSED_KEY = 'trueppm.mobile.schedule.unscheduled.collapsed';

const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  REVIEW: 'In review',
  ON_HOLD: 'On hold',
  COMPLETE: 'Complete',
};

export interface MobileScheduleProps {
  /** The full task set for the project (WBS is resolved client-side). */
  tasks: Task[];
  projectId: string | null;
  /** True when the current role cannot create/edit — hides the "+ Task" CTA. */
  readOnly: boolean;
  isLoading: boolean;
  error: Error | null;
  /** Opens the desktop-shared "add task" form (mounted by ScheduleView). */
  onAddTask: () => void;
}

/**
 * Mobile-first Schedule surface (#1671, ADR-0348, web-rule 249) — a
 * vertically-scrolling DOM list-timeline that replaces the desktop canvas Gantt
 * below `md`. Modeled on the `MobileBoard` reflow (web-rule 193): a dedicated
 * tree gated behind `isMobile`, never a restyle of the canvas.
 *
 * Read/navigate only — a row tap opens the shared `TaskDetailDrawer` (via
 * `scheduleStore.selectedTaskId`) for online, `canEdit`-gated edits; leaf rows
 * offer a one-tap complete (web-rule 184). Scheduling and drag are delegated to
 * the drawer; offline writes are deferred to the native app (ADR-0348).
 */
export function MobileSchedule({
  tasks,
  projectId,
  readOnly,
  isLoading,
  error,
  onAddTask,
}: MobileScheduleProps) {
  const queryClient = useQueryClient();
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const toggleComplete = useToggleComplete();

  const unscheduled = useUnscheduledTasks(tasks);

  // The list body is every task NOT routed to the unscheduled tray, in WBS order.
  const listTasks = useMemo(() => {
    const trayIds = new Set(unscheduled.map((t) => t.id));
    return tasks.filter((t) => !trayIds.has(t.id)).sort((a, b) => compareWbs(a.wbs, b.wbs));
  }, [tasks, unscheduled]);

  const window = useMemo(() => computeScheduleWindow(listTasks), [listTasks]);

  const handleComplete = (task: Task) => {
    if (!projectId || task.isComplete) return;
    toggleComplete.mutate(
      { id: task.id, projectId, previousStatus: task.status },
      { onSuccess: () => toast.warm(`Nice — ${task.name} done.`) },
    );
  };

  const header = (
    <div className="flex min-h-11 flex-shrink-0 items-center gap-2 border-b border-neutral-border bg-neutral-surface px-4 py-2">
      <div className="min-w-0">
        <h1 className="text-base font-semibold text-neutral-text-primary">Schedule</h1>
        <p className="text-xs text-neutral-text-secondary">
          {listTasks.length} task{listTasks.length === 1 ? '' : 's'}
        </p>
      </div>
      {projectId && !readOnly && (
        <button
          type="button"
          onClick={onAddTask}
          className="ml-auto inline-flex min-h-11 shrink-0 items-center gap-1 rounded-control bg-brand-primary px-3 text-sm font-medium text-neutral-text-inverse
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
          Task
        </button>
      )}
    </div>
  );

  // Body region swaps by state; header + tray + MC card frame stays put.
  let body: ReactNode;
  if (isLoading) {
    body = <LoadingSkeleton />;
  } else if (error) {
    body = (
      <EmptyState
        className="h-full bg-neutral-surface"
        icon={WarningIcon}
        title="Couldn't load the schedule"
        description="Something went wrong fetching this project's tasks. Check your connection and try again."
        action={
          <Button
            variant="secondary"
            onClick={() => {
              if (!projectId) return;
              void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
              void queryClient.invalidateQueries({ queryKey: ['dependencies', projectId] });
            }}
          >
            Try again
          </Button>
        }
      />
    );
  } else if (tasks.length === 0) {
    body = (
      <EmptyState
        className="h-full bg-neutral-surface"
        icon={CalendarIcon}
        title="No tasks yet"
        description="Add your first task to start building the schedule. Tasks you create appear here in outline order."
        action={
          projectId && !readOnly ? <Button onClick={onAddTask}>+ Add task</Button> : undefined
        }
      />
    );
  } else if (listTasks.length === 0 || !window) {
    // Tasks exist but none are scheduled yet — the tray above still offers the
    // tap-to-schedule path, so this is guidance, not a dead end.
    body = (
      <EmptyState
        className="h-full bg-neutral-surface"
        icon={GanttIcon}
        title="Not scheduled yet"
        description="These tasks don't have dates yet. Open a task to set a start date, or run the scheduler, and the timeline will fill in."
      />
    );
  } else {
    body = (
      <ul className="flex-1 divide-y divide-neutral-border overflow-y-auto overscroll-contain">
        {listTasks.map((task) => (
          <MobileScheduleRow
            key={task.id}
            task={task}
            window={window}
            onOpen={() => setSelectedTaskId(task.id)}
            onComplete={() => handleComplete(task)}
            completeDisabled={toggleComplete.isPending}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-neutral-surface-sunken">
      {header}
      <UnscheduledTray tasks={unscheduled} onOpen={(id) => setSelectedTaskId(id)} />
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface RowProps {
  task: Task;
  window: ScheduleWindow;
  onOpen: () => void;
  onComplete: () => void;
  completeDisabled: boolean;
}

function MobileScheduleRow({ task, window, onOpen, onComplete, completeDisabled }: RowProps) {
  const [justCompleted, setJustCompleted] = useState(false);
  const isGroup = task.isSummary || task.isPhase;
  const isMilestone = !!task.isMilestone;
  const canComplete = !isGroup && !isMilestone && !!task.canEdit;

  const indentPx = wbsDepth(task.wbs) * 12;
  const geom = barGeometry(task, window);
  const marker = markerLeftPct(task, window);
  const today = todayLeftPct(window, Date.now());

  const datesText = isMilestone
    ? fmtUtcShort(task.finish)
    : `${fmtUtcShort(task.start)} – ${fmtUtcShort(task.finish)}`;

  const ariaLabel =
    `${task.name}, ${STATUS_LABEL[task.status]}, ${datesText}` +
    (task.isCritical ? ', on the critical path' : '') +
    (task.isBlocked ? ', blocked' : '');

  return (
    <li className="relative" style={{ paddingLeft: indentPx }}>
      {/* Full-bleed open target. An overlay button (not a wrapping button)
          keeps the complete control from nesting inside another button —
          invalid HTML that mis-announces for screen readers. The visual content
          below is pointer-events-none so taps fall through to this layer; the
          complete button re-enables pointer events and lifts above it (z-10). */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={ariaLabel}
        className="absolute inset-0 rounded-none active:bg-neutral-surface-sunken
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
      />
      <div className="pointer-events-none flex min-h-[64px] flex-col gap-1.5 px-3 py-2">
        {/* Line 1 — identity + dates + complete control */}
        <div className="flex w-full items-center gap-2">
          {/* Critical rail — grayscale-safe luminance edge, always occupies the
              slot so text never reflows (rules 234/235). */}
          <span
            aria-hidden="true"
            className={`h-4 w-1 shrink-0 rounded-full ${
              task.isCritical ? 'bg-semantic-critical' : 'bg-transparent'
            }`}
          />
          {task.shortId && (
            <span className="tppm-mono shrink-0 rounded-chip bg-neutral-surface-sunken px-1.5 py-0.5 text-xs text-neutral-text-secondary">
              {task.shortId}
            </span>
          )}
          <span
            className={`min-w-0 flex-1 truncate text-sm ${isGroup ? 'font-semibold' : ''} ${
              task.isComplete
                ? 'text-neutral-text-disabled line-through'
                : 'text-neutral-text-primary'
            }`}
          >
            {task.name}
          </span>
          {/* Critical is already in the row's aria-label; the glyph is a
              redundant sighted-only cue (rule 235), so hide it from AT. */}
          {task.isCritical && (
            <WarningIcon className="h-3 w-3 shrink-0 text-semantic-critical" aria-hidden="true" />
          )}
          {task.isBlocked && (
            <span className="tppm-mono shrink-0 rounded-chip bg-semantic-at-risk-bg px-1.5 py-0.5 text-xs font-medium text-semantic-at-risk">
              Blocked
            </span>
          )}
          {/* Dates hide below 360px so a critical + blocked row never squeezes
              the name to nothing — the line-2 strip and aria-label still carry them. */}
          <span className="tppm-mono hidden shrink-0 text-xs text-neutral-text-secondary min-[360px]:inline">
            {datesText}
          </span>
          {canComplete ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setJustCompleted(true);
                onComplete();
              }}
              disabled={task.isComplete || completeDisabled}
              aria-pressed={task.isComplete}
              aria-label={
                task.isComplete ? `${task.name} is complete` : `Mark ${task.name} complete`
              }
              className="pointer-events-auto relative z-10 grid h-11 w-11 shrink-0 place-items-center rounded-control
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                disabled:cursor-default"
            >
              <span
                onAnimationEnd={() => setJustCompleted(false)}
                className={[
                  'grid h-[18px] w-[18px] place-items-center rounded-[5px] border-[1.5px] text-xs leading-none',
                  task.isComplete
                    ? 'border-brand-primary bg-brand-primary text-neutral-text-inverse'
                    : 'border-neutral-border text-transparent',
                  justCompleted ? 'motion-safe:animate-checkpop' : '',
                ].join(' ')}
              >
                <span aria-hidden="true">✓</span>
              </span>
            </button>
          ) : (
            <span aria-hidden="true" className="w-11 shrink-0" />
          )}
        </div>

        {/* Line 2 — the shared-scale mini-timeline */}
        <div className="flex w-full items-center gap-2 pr-11">
          {isMilestone ? (
            <div className="relative h-3 flex-1">
              <span
                aria-hidden="true"
                style={{ left: `${marker}%` }}
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] bg-brand-accent"
              />
            </div>
          ) : isGroup ? (
            <div className="relative h-1.5 flex-1">
              <span
                aria-hidden="true"
                style={{ left: `${geom.leftPct}%`, width: `${geom.widthPct}%` }}
                className="absolute inset-y-0 rounded-full bg-neutral-border"
              />
            </div>
          ) : (
            <div
              aria-hidden="true"
              className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-neutral-surface-sunken"
            >
              <div
                style={{ left: `${geom.leftPct}%`, width: `${geom.widthPct}%` }}
                className={`absolute inset-y-0 rounded-full bg-brand-primary/25 ring-1 ring-inset ${
                  task.isCritical ? 'ring-semantic-critical' : 'ring-brand-primary/30'
                }`}
              >
                {task.progress > 0 && (
                  <div
                    style={{ width: `${Math.min(task.progress, 100)}%` }}
                    className={`absolute inset-y-0 left-0 rounded-full ${
                      task.isComplete ? 'bg-semantic-on-track' : 'bg-brand-primary'
                    }`}
                  />
                )}
              </div>
              {today !== null && (
                <span
                  aria-hidden="true"
                  style={{ left: `${today}%` }}
                  className="absolute inset-y-0 w-[1.5px] bg-semantic-at-risk opacity-60"
                />
              )}
            </div>
          )}
          {!isMilestone && !isGroup && task.progress > 0 && (
            <span className="tppm-mono shrink-0 text-xs text-neutral-text-secondary">
              {Math.round(task.progress)}%
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Unscheduled tray
// ---------------------------------------------------------------------------

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(UNSCHEDULED_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

interface TrayProps {
  tasks: Task[];
  onOpen: (id: string) => void;
}

function UnscheduledTray({ tasks, onOpen }: TrayProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());
  const prevCount = useRef(tasks.length);

  // Auto-expand once when unscheduled work first appears, mirroring the desktop
  // gutter — a task that just fell out of a plan shouldn't hide behind a chevron.
  useEffect(() => {
    if (prevCount.current === 0 && tasks.length > 0) setCollapsed(false);
    prevCount.current = tasks.length;
  }, [tasks.length]);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(UNSCHEDULED_COLLAPSED_KEY, String(next));
      } catch {
        // Non-fatal — private mode / disabled storage just loses persistence.
      }
      return next;
    });
  };

  // No tasks → no tray at all (absence is the empty state).
  if (tasks.length === 0) return null;

  return (
    <div className="flex-shrink-0 border-b border-neutral-border bg-neutral-surface">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls="mobile-unscheduled-list"
        className="flex min-h-11 w-full items-center gap-2 px-4 text-sm font-medium text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={`h-4 w-4 text-neutral-text-secondary motion-safe:transition-transform ${
            collapsed ? '' : 'rotate-90'
          }`}
        />
        Unscheduled
        <span className="tppm-mono ml-auto rounded-chip bg-semantic-at-risk-bg px-1.5 py-0.5 text-xs text-semantic-at-risk">
          {tasks.length}
        </span>
      </button>
      {!collapsed && (
        <ul id="mobile-unscheduled-list" className="divide-y divide-neutral-border">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onOpen(task.id)}
                aria-label={`${task.name}, unscheduled — open to set a start date`}
                className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left active:bg-neutral-surface-sunken
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
              >
                {task.shortId && (
                  <span className="tppm-mono shrink-0 rounded-chip bg-neutral-surface-sunken px-1.5 py-0.5 text-xs text-neutral-text-secondary">
                    {task.shortId}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-text-primary">
                  {task.name}
                </span>
                <span className="shrink-0 text-xs text-neutral-text-secondary">Schedule ›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton (rule 248 idiom — labeled list, pulsing aria-hidden ghosts)
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <ul aria-label="Loading schedule" className="flex flex-col gap-1 px-4 py-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li
          key={i}
          aria-hidden="true"
          className="h-16 rounded-card bg-neutral-surface-sunken motion-safe:animate-pulse"
        />
      ))}
    </ul>
  );
}
