/**
 * Phone layout of the weekly timesheet (#1949): one day at a time, one hours field per task.
 *
 * The seven-column grid needs ~50rem, so on a phone it collapses to the selected day's task
 * list. It deliberately reuses `TimesheetCell` so the read-only reasons (multi-entry,
 * submitted, future date), inline server rejections and the hours shorthand parser behave
 * exactly as they do in the grid; only the layout differs.
 */
import { TimesheetCell } from './TimesheetCell';
import { AddTaskRow } from './AddTaskRow';
import { formatMinutesAsHm } from '@/lib/parseHours';
import { cellAt, isOverDaily, type DayColumn, type TimesheetRow } from './weekModel';
import type { CellTaskMeta } from '@/hooks/useWeekTimesheet';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface TimesheetDayListProps {
  rows: TimesheetRow[];
  day: DayColumn;
  dayTotal: number;
  existingTaskIds: Set<string>;
  submitted: boolean;
  cellErrors: Record<string, string>;
  onCellSave: (row: TimesheetRow, date: string, minutes: number) => void;
  onAddTask: (meta: CellTaskMeta) => void;
}

export function TimesheetDayList({
  rows,
  day,
  dayTotal,
  existingTaskIds,
  submitted,
  cellErrors,
  onCellSave,
  onAddTask,
}: TimesheetDayListProps) {
  const over = isOverDaily(dayTotal);
  const dayLabel = `${WEEKDAY_LABELS[day.weekday]} ${Number(day.date.slice(8, 10))}`;
  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface">
      <div role="grid" aria-label={`Timesheet for ${dayLabel}`} className="text-sm">
        {rows.map((row) => {
          const cell = cellAt(row, day.date);
          return (
            <div
              key={row.taskId}
              role="row"
              className="grid min-h-[44px] grid-cols-[1fr_5.5rem] items-center gap-2 border-b border-neutral-border/60 px-3 py-1.5"
            >
              <div role="rowheader" className="min-w-0">
                <div className="truncate font-medium text-neutral-text-primary" title={row.taskName}>
                  <span className="tppm-mono text-xs text-neutral-text-secondary">{row.taskShortId}</span>{' '}
                  {row.taskName}
                </div>
                <div className="truncate text-xs text-neutral-text-secondary">{row.projectName}</div>
              </div>
              <div className="min-h-[44px]">
                <TimesheetCell
                  minutes={cell.minutes}
                  editable={cell.editable && !submitted}
                  entryCount={cell.entries.length}
                  isWeekend={day.isWeekend}
                  isToday={day.isToday}
                  isFuture={day.isFuture}
                  readOnlyReason={!cell.editable ? 'multi-entry' : submitted ? 'submitted' : undefined}
                  ariaLabel={`${row.taskShortId} ${row.taskName}, ${dayLabel}`}
                  errorText={cellErrors[`${row.taskId}|${day.date}`]}
                  onSave={(minutes) => onCellSave(row, day.date, minutes)}
                />
              </div>
            </div>
          );
        })}
        <div
          role="row"
          className="flex items-center justify-between bg-neutral-surface-raised px-3 py-2 text-xs font-medium"
        >
          <span role="rowheader" className="uppercase tracking-wide text-neutral-text-secondary">
            Day total
          </span>
          <span
            role="gridcell"
            aria-label={
              over
                ? `${dayLabel} total ${formatMinutesAsHm(dayTotal)}, over 8 hours`
                : `${dayLabel} total ${formatMinutesAsHm(dayTotal)}`
            }
            className={`tabular-nums ${over ? 'font-semibold text-semantic-at-risk' : 'text-neutral-text-primary'}`}
          >
            {dayTotal > 0 ? formatMinutesAsHm(dayTotal) : '—'}
          </span>
        </div>
      </div>
      {!submitted && <AddTaskRow existingTaskIds={existingTaskIds} onAdd={onAddTask} />}
    </div>
  );
}
