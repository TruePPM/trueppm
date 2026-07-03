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
 * Uses stub hook (useCalendarTasks) returning fixture data until
 * the real TanStack Query hook is wired — tracked in issue 1613.
 */

import { useState } from 'react';
import { useCalendarFilter } from './useCalendarFilter';
import { CalendarGrid } from './CalendarGrid';
import { parseUTCDate, formatMonthLabel } from './calendarUtils';
import { useCalendarTasks } from '@/hooks/useCalendarTasks';

// ---------------------------------------------------------------------------
// Task detail popover — inline, avoids full modal (keeps list in view on mobile)
// ---------------------------------------------------------------------------

interface TaskDetailBannerProps {
  taskId: string;
  onClose: () => void;
}

function TaskDetailBanner({ taskId, onClose }: TaskDetailBannerProps) {
  return (
    <div
      role="region"
      aria-label="Task detail"
      className="border-b border-neutral-border bg-neutral-surface-raised px-4 py-2 flex items-center gap-3"
    >
      <span className="text-sm text-neutral-text-primary font-medium">{taskId}</span>
      <span className="text-xs text-neutral-text-secondary">
        Full task details are coming — tracked in issue 1613.
      </span>
      <div className="flex-1" />
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

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const anchor = parseUTCDate(anchorIso);
  const label = formatMonthLabel(anchor);

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
      {selectedTaskId && (
        <TaskDetailBanner taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
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
          />
        )}
      </div>
    </div>
  );
}
