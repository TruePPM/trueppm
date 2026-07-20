/**
 * CalendarMobileList — the documented under-768px calendar reflow.
 *
 * The 7-column month grid is unusable on a phone (each day column is ~60px, so
 * chips truncate to slivers far below the 44px touch floor). Below the `md`
 * breakpoint CalendarGrid renders this vertical date-grouped agenda instead —
 * the layout the CalendarView docstring has always promised but never shipped.
 *
 * Grouping: every task overlapping the anchored month is listed once, under the
 * later of its start day or the first of the month (a task that began earlier
 * surfaces on day one of the visible window, matching the grid's chip). Rows are
 * full-width ≥44px touch targets that open the same task-detail banner as a chip.
 */

import type { Task } from '@/types';
import { parseUTCDate, formatDayLabel, formatMonthLabel } from './calendarUtils';

/**
 * Status color bar — mirrors the legend and the TaskDetailBanner status dot
 * (critical wins over status). Complete and on-track are deliberately distinct
 * so a finished task doesn't read the same as an in-flight one.
 */
function statusBarClass(task: Task): string {
  if (task.isCritical) return 'bg-semantic-critical';
  switch (task.status) {
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

function formatRange(task: Task): string {
  if (!task.start) return 'No dates';
  const start = formatDayLabel(parseUTCDate(task.start));
  if (task.isMilestone || !task.finish || task.finish === task.start) return start;
  return `${start} – ${formatDayLabel(parseUTCDate(task.finish))}`;
}

interface DayGroup {
  iso: string;
  label: string;
  tasks: Task[];
}

interface CalendarMobileListProps {
  anchorIso: string;
  tasks: Task[];
  onTaskClick: (taskId: string) => void;
}

export function CalendarMobileList({ anchorIso, tasks, onTaskClick }: CalendarMobileListProps) {
  const anchor = parseUTCDate(anchorIso);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  // ISO strings are zero-padded YYYY-MM-DD, so lexical comparison == date order.
  const monthStartIso = `${year}-${pad(month + 1)}-01`;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthEndIso = `${year}-${pad(month + 1)}-${pad(lastDay)}`;

  const groupsByIso = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.start) continue;
    const finish = task.finish || task.start;
    // Keep tasks whose span intersects the visible month.
    if (finish < monthStartIso || task.start > monthEndIso) continue;
    const key = task.start < monthStartIso ? monthStartIso : task.start;
    const list = groupsByIso.get(key) ?? [];
    list.push(task);
    groupsByIso.set(key, list);
  }

  const groups: DayGroup[] = [...groupsByIso.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([iso, dayTasks]) => ({
      iso,
      label: formatDayLabel(parseUTCDate(iso)),
      tasks: dayTasks.sort((a, b) => a.name.localeCompare(b.name)),
    }));

  // Tasks may exist elsewhere in the project but not intersect the anchored
  // month — an empty scroll container would read as a broken surface, so name
  // the empty window explicitly (the desktop grid conveys this via empty cells).
  if (groups.length === 0) {
    return (
      <div
        role="status"
        className="flex flex-1 items-center justify-center px-6 py-16 text-center"
      >
        <p className="text-sm text-neutral-text-secondary">
          No tasks in {formatMonthLabel(anchor)}.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto divide-y divide-neutral-border">
      {groups.map((group) => (
        <section key={group.iso} aria-label={group.label}>
          <h3
            className="sticky top-0 z-10 bg-neutral-surface-sunken px-4 py-1.5 tppm-mono text-xs
              font-semibold uppercase tracking-widest text-neutral-text-secondary
              border-b border-neutral-border"
          >
            {group.label}
          </h3>
          <ul>
            {group.tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => onTaskClick(task.id)}
                  className="flex min-h-[44px] w-full items-center gap-3 px-4 py-2 text-left
                    hover:bg-neutral-surface-raised
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                    focus-visible:ring-inset"
                >
                  {task.isMilestone ? (
                    <svg
                      aria-hidden="true"
                      width="12"
                      height="12"
                      viewBox="0 0 10 10"
                      className="flex-shrink-0 text-brand-accent fill-current"
                    >
                      <polygon points="5,0 10,5 5,10 0,5" />
                    </svg>
                  ) : (
                    <span
                      aria-hidden="true"
                      className={`h-8 w-1 flex-shrink-0 rounded-full ${statusBarClass(task)}`}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-neutral-text-primary">
                      {task.name}
                    </span>
                    <span className="block text-xs text-neutral-text-secondary tppm-mono">
                      {formatRange(task)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
