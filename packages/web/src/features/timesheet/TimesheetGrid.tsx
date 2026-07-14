/**
 * The weekly timesheet data grid (#1435, ADR-0224).
 *
 * ARIA `role="grid"`: a header row of day columns, one `role="row"` per task (a
 * `rowheader` label + seven editable day-cells + a row total), and a footer of daily
 * totals + the week total. `Tab` moves between cell inputs (native order); `Enter` saves,
 * `Esc` reverts (in `TimesheetCell`). Weekend columns are shaded, today is tinted, and a
 * daily total over 8h is flagged amber (`--semantic-at-risk`). Horizontally scrollable on
 * narrow / tablet widths without collapsing the column model.
 */
import { TimesheetCell } from './TimesheetCell';
import { AddTaskRow } from './AddTaskRow';
import { formatMinutesAsHm } from '@/lib/parseHours';
import {
  cellAt,
  isOverDaily,
  rowTotalMinutes,
  type DayColumn,
  type TimesheetRow,
} from './weekModel';
import type { CellTaskMeta } from '@/hooks/useWeekTimesheet';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// task label (flexible) · 7 day columns · row total. Inline so the many repeats don't
// depend on Tailwind arbitrary-value purge.
const GRID_COLS = 'minmax(11rem, 1fr) repeat(7, minmax(3.25rem, 1fr)) 4rem';

interface TimesheetGridProps {
  rows: TimesheetRow[];
  days: DayColumn[];
  dayTotals: Record<string, number>;
  weekTotal: number;
  existingTaskIds: Set<string>;
  submitted: boolean;
  onCellSave: (row: TimesheetRow, date: string, minutes: number) => void;
  onAddTask: (meta: CellTaskMeta) => void;
}

function dayOfMonth(iso: string): number {
  return Number(iso.slice(8, 10));
}

export function TimesheetGrid({
  rows,
  days,
  dayTotals,
  weekTotal,
  existingTaskIds,
  submitted,
  onCellSave,
  onAddTask,
}: TimesheetGridProps) {
  return (
    <div className="overflow-x-auto rounded-card border border-neutral-border bg-neutral-surface">
      <div role="grid" aria-label="Weekly timesheet" className="min-w-[46rem] text-sm">
        {/* Header */}
        <div
          role="row"
          className="grid items-center border-b border-neutral-border bg-neutral-surface-raised text-xs font-medium uppercase tracking-wide text-neutral-text-secondary"
          style={{ gridTemplateColumns: GRID_COLS }}
        >
          <div role="columnheader" className="px-3 py-2">
            Task
          </div>
          {days.map((d, i) => (
            <div
              key={d.date}
              role="columnheader"
              aria-label={`${WEEKDAY_LABELS[i]} ${dayOfMonth(d.date)}`}
              className={`px-2 py-2 text-right ${d.isWeekend ? 'bg-neutral-surface-sunken' : ''} ${
                d.isToday ? 'text-brand-primary' : ''
              }`}
            >
              <span className="block">{WEEKDAY_LABELS[i]}</span>
              <span className="block tabular-nums text-neutral-text-primary">{dayOfMonth(d.date)}</span>
            </div>
          ))}
          <div role="columnheader" className="px-2 py-2 text-right">
            Total
          </div>
        </div>

        {/* Task rows */}
        {rows.map((row) => {
          const rowTotal = rowTotalMinutes(row);
          return (
            <div
              key={row.taskId}
              role="row"
              className="grid items-stretch border-b border-neutral-border/60 last:border-b-0 hover:bg-neutral-surface-raised/40"
              style={{ gridTemplateColumns: GRID_COLS }}
            >
              <div role="rowheader" className="min-w-0 px-3 py-1.5">
                <div className="truncate font-medium text-neutral-text-primary" title={row.taskName}>
                  <span className="tppm-mono text-xs text-neutral-text-secondary">{row.taskShortId}</span>{' '}
                  {row.taskName}
                </div>
                <div className="truncate text-xs text-neutral-text-secondary" title={row.projectName}>
                  {row.projectName}
                </div>
              </div>
              {days.map((d, i) => {
                const cell = cellAt(row, d.date);
                return (
                  <TimesheetCell
                    key={d.date}
                    minutes={cell.minutes}
                    editable={cell.editable && !submitted}
                    entryCount={cell.entries.length}
                    isWeekend={d.isWeekend}
                    isToday={d.isToday}
                    isFuture={d.isFuture}
                    ariaLabel={`${row.taskShortId} ${row.taskName}, ${WEEKDAY_LABELS[i]} ${dayOfMonth(d.date)}`}
                    onSave={(minutes) => onCellSave(row, d.date, minutes)}
                  />
                );
              })}
              <div
                role="gridcell"
                className="flex items-center justify-end px-2 py-1.5 tabular-nums font-medium text-neutral-text-primary"
              >
                {rowTotal > 0 ? formatMinutesAsHm(rowTotal) : '—'}
              </div>
            </div>
          );
        })}

        {/* Daily totals footer */}
        <div
          role="row"
          className="grid items-center border-t border-neutral-border bg-neutral-surface-raised text-xs font-medium"
          style={{ gridTemplateColumns: GRID_COLS }}
        >
          <div role="rowheader" className="px-3 py-2 uppercase tracking-wide text-neutral-text-secondary">
            Daily total
          </div>
          {days.map((d) => {
            const total = dayTotals[d.date] ?? 0;
            const over = isOverDaily(total);
            return (
              <div
                key={d.date}
                role="gridcell"
                aria-label={
                  over
                    ? `${WEEKDAY_LABELS[d.weekday]} total ${formatMinutesAsHm(total)}, over 8 hours`
                    : `${WEEKDAY_LABELS[d.weekday]} total ${formatMinutesAsHm(total)}`
                }
                className={`px-2 py-2 text-right tabular-nums ${d.isWeekend ? 'bg-neutral-surface-sunken' : ''} ${
                  over ? 'text-semantic-at-risk font-semibold' : 'text-neutral-text-primary'
                }`}
              >
                {total > 0 ? formatMinutesAsHm(total) : '—'}
              </div>
            );
          })}
          <div
            role="gridcell"
            aria-label={`Week total ${formatMinutesAsHm(weekTotal)}`}
            className="px-2 py-2 text-right tabular-nums font-semibold text-neutral-text-primary"
          >
            {formatMinutesAsHm(weekTotal)}
          </div>
        </div>
      </div>

      {/* Add-task row — hidden once the week is submitted (read-only). */}
      {!submitted && (
        <div className="border-t border-neutral-border">
          <AddTaskRow existingTaskIds={existingTaskIds} onAdd={onAddTask} />
        </div>
      )}
    </div>
  );
}
