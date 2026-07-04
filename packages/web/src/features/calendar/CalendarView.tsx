/**
 * CalendarView — month/week calendar with chip-fragment task overlays.
 *
 * URL params managed by useCalendarFilter:
 *   ?calView=month|week   (defaults to month)
 *   ?calAnchor=YYYY-MM-DD (defaults to today)
 *
 * Design decisions (from architect + VoC reviews):
 *   - Explicit is_milestone field used — never infer from duration==0
 *   - Fragment chips for multi-week tasks (never truncated mid-row)
 *   - Month view is the default; week toggle in toolbar
 *   - Mobile (< 768px): vertical date-grouped list instead of grid
 *   - Today button + prev/next chevrons for navigation
 *
 * Clicking a chip or milestone selects the task and opens an inline detail
 * banner (name, dates, status, assignees) with a link to the full task detail
 * route. The task object is already loaded for chip rendering, so the banner
 * reuses it — no extra fetch.
 */

import { useState } from 'react';
import { Link } from 'react-router';
import type { Task, TaskStatus } from '@/types';
import { useCalendarFilter } from './useCalendarFilter';
import { CalendarGrid } from './CalendarGrid';
import { parseUTCDate, formatMonthLabel, formatDayLabel } from './calendarUtils';
import { useCalendarTasks } from '@/hooks/useCalendarTasks';
import { useProjectId } from '@/hooks/useProjectId';
import { useSprints } from '@/hooks/useSprints';

// ---------------------------------------------------------------------------
// Task detail banner — inline, avoids a full modal (keeps the calendar in view)
// ---------------------------------------------------------------------------

/** Human-readable board-status labels (mirrors the board card popover). */
const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  NOT_STARTED: 'To Do',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Review',
  ON_HOLD: 'On hold',
  COMPLETE: 'Complete',
};

function statusDotClass(status: TaskStatus): string {
  switch (status) {
    case 'COMPLETE':
      return 'bg-semantic-on-track';
    case 'IN_PROGRESS':
      return 'bg-brand-primary';
    case 'REVIEW':
      return 'bg-semantic-at-risk';
    default:
      return 'bg-neutral-text-disabled';
  }
}

/**
 * Format a task's date window for the banner. Milestones (or zero-span tasks)
 * collapse to a single date; everything else shows "start – finish".
 */
function formatTaskDates(task: Task): string {
  if (!task.start) return 'No dates';
  const start = formatDayLabel(parseUTCDate(task.start));
  if (task.isMilestone || !task.finish || task.finish === task.start) return start;
  return `${start} – ${formatDayLabel(parseUTCDate(task.finish))}`;
}

interface TaskDetailBannerProps {
  task: Task;
  projectId: string | undefined;
  onClose: () => void;
}

export function TaskDetailBanner({ task, projectId, onClose }: TaskDetailBannerProps) {
  const assigneeNames = task.assignees.map((a) => a.name).join(', ');

  return (
    <div
      role="region"
      aria-label={`Task detail: ${task.name}`}
      className="border-b border-neutral-border bg-neutral-surface-raised px-4 py-2 flex items-center gap-3 flex-wrap"
    >
      <span className="text-sm text-neutral-text-primary font-medium">{task.name}</span>

      <span className="inline-flex items-center gap-1.5 text-xs text-neutral-text-secondary">
        <span
          aria-hidden="true"
          className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${statusDotClass(task.status)}`}
        />
        {STATUS_LABEL[task.status]}
      </span>

      <span className="text-xs text-neutral-text-secondary tppm-mono">{formatTaskDates(task)}</span>

      <span className="text-xs text-neutral-text-secondary">
        {assigneeNames ? assigneeNames : 'Unassigned'}
      </span>

      <div className="flex-1" />

      {projectId && (
        <Link
          to={`/projects/${projectId}/tasks/${task.id}`}
          className="text-xs font-medium text-brand-primary hover:underline
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded"
        >
          Open full detail
        </Link>
      )}

      <button
        type="button"
        onClick={onClose}
        aria-label="Close task detail"
        className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded"
      >
        Close
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CalendarView
// ---------------------------------------------------------------------------

export function CalendarView() {
  const { calView, anchorIso, setCalView, goToToday, goNext, goPrev } = useCalendarFilter();
  const { tasks } = useCalendarTasks();
  const projectId = useProjectId();
  // Sprint-boundary markers (issue 1230): reuse the existing sprints list to dot
  // the day cells where a sprint starts or finishes, so cadence lands on the
  // calendar without a new endpoint. Degrades to no dots when the project has no
  // sprints (or the list is still loading).
  const { sprints } = useSprints(projectId ?? null);
  const sprintBoundaries = new Set<string>(
    sprints.flatMap((s) => [s.start_date, s.finish_date]),
  );

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const anchor = parseUTCDate(anchorIso);
  const label = formatMonthLabel(anchor);

  // The clicked task is already loaded for chip rendering — resolve it by id
  // rather than re-fetching. Falls back to null if it scrolled out of the window.
  const selectedTask = selectedTaskId ? (tasks.find((t) => t.id === selectedTaskId) ?? null) : null;

  function handleTaskClick(taskId: string) {
    setSelectedTaskId((prev) => (prev === taskId ? null : taskId));
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-neutral-surface">
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-4 h-10 border-b border-neutral-border
          bg-neutral-surface-raised flex-shrink-0"
      >
        {/* Navigation cluster */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={goPrev}
            aria-label={`Previous ${calView}`}
            className="border border-neutral-border rounded h-7 w-7 flex items-center justify-center
              text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
          </button>

          <button
            type="button"
            onClick={goToToday}
            className="border border-neutral-border rounded h-7 px-3 text-xs font-medium
              text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Today
          </button>

          <button
            type="button"
            onClick={goNext}
            aria-label={`Next ${calView}`}
            className="border border-neutral-border rounded h-7 w-7 flex items-center justify-center
              text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" /></svg>
          </button>
        </div>

        {/* Month label */}
        <h2 className="text-sm font-semibold text-neutral-text-primary ml-1">{label}</h2>

        <div className="flex-1" />

        {/* View mode toggle: Month | Week */}
        <div role="group" aria-label="Calendar view mode" className="flex items-center gap-1">
          {(['month', 'week'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={calView === mode}
              onClick={() => setCalView(mode)}
              className={`
                border rounded h-7 px-3 text-xs font-medium capitalize
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                ${
                  calView === mode
                    ? 'border-brand-primary/40 bg-brand-primary/10 text-brand-primary'
                    : 'border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary'
                }
              `}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Selected task detail banner */}
      {selectedTask && (
        <TaskDetailBanner
          task={selectedTask}
          projectId={projectId}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      {/* Calendar grid — fills remaining height */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tasks.length === 0 ? (
          <div
            role="status"
            className="flex h-full items-center justify-center"
          >
            <p className="text-sm text-neutral-text-secondary">
              No tasks yet. Add a task to get started.
            </p>
          </div>
        ) : (
          <CalendarGrid
            anchorIso={anchorIso}
            tasks={tasks}
            onTaskClick={handleTaskClick}
            sprintBoundaries={sprintBoundaries}
          />
        )}
      </div>
    </div>
  );
}
