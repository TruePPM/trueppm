import { COL_DURATION, COL_PROGRESS, COL_START } from './ganttConstants';

export function TaskListHeader() {
  return (
    <div
      className="flex items-center h-7 px-2 bg-neutral-surface-raised border-b border-neutral-border
        text-xs font-medium text-neutral-text-secondary select-none sticky top-0 z-10"
      role="row"
      aria-label="Task list columns"
    >
      <span className="flex-1 truncate" role="columnheader">Task</span>
      <span
        className="text-right shrink-0"
        style={{ width: COL_DURATION }}
        role="columnheader"
        aria-label="Duration"
      >
        Dur
      </span>
      <span
        className="text-right shrink-0"
        style={{ width: COL_START }}
        role="columnheader"
        aria-label="Start date"
      >
        Start
      </span>
      <span
        className="text-right shrink-0"
        style={{ width: COL_PROGRESS }}
        role="columnheader"
        aria-label="Progress"
      >
        %
      </span>
    </div>
  );
}
