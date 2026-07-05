/**
 * Timesheet — weekly cross-project entry + submit surface (#1435, ADR-0224).
 *
 * Route: `/me/timesheet`. The "review + submit my week" companion to the per-task inline
 * quick-log and running timer: a keyboard-fast grid of every project/task the contributor
 * logged against this week, with row/day/week totals, an over-8h amber flag, weekend
 * shading, a week stepper, an add-task row, and a single `Submit week` action (a
 * per-user-per-week marker — entries stay editable; approval is #100/0.5).
 *
 * The read reuses `GET /me/time-entries/?from=&to=`; per-cell writes reuse the entry
 * endpoints (create / PATCH / DELETE); the multi-entry cell is read-only (ADR-0224). No
 * portfolio/governance surface — a contributor reviews and submits *their own* time (OSS).
 */
import { useMemo, useState } from 'react';
import { Button } from '@/components/Button';
import {
  useSubmitWeek,
  useTimesheetCell,
  useWeekTimesheet,
  type CellTaskMeta,
} from '@/hooks/useWeekTimesheet';
import { formatMinutesAsHm } from '@/lib/parseHours';
import { TimesheetGrid } from './TimesheetGrid';
import {
  addDaysIso,
  buildRows,
  cellAt,
  dailyTotals,
  formatWeekRange,
  mondayOf,
  weekDays,
  weekTotalMinutes,
  type TimesheetRow,
} from './weekModel';

function localTodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function rowMeta(row: TimesheetRow): CellTaskMeta {
  return {
    taskId: row.taskId,
    taskShortId: row.taskShortId,
    taskName: row.taskName,
    projectId: row.projectId,
    projectCode: row.projectCode,
    projectName: row.projectName,
  };
}

function emptyRow(meta: CellTaskMeta): TimesheetRow {
  return { ...meta, cells: {} };
}

export function TimesheetPage() {
  const today = localTodayIso();
  const [monday, setMonday] = useState(() => mondayOf(today));
  // Tasks the user added via the add-row that have no entries yet this week.
  const [extraTasks, setExtraTasks] = useState<CellTaskMeta[]>([]);

  const { data, isLoading, isError, refetch } = useWeekTimesheet(monday);
  const cellMutation = useTimesheetCell(monday);
  const submitMutation = useSubmitWeek(monday);

  const days = useMemo(() => weekDays(monday, today), [monday, today]);

  const rows = useMemo(() => {
    const entryRows = buildRows(data?.results ?? []);
    const present = new Set(entryRows.map((r) => r.taskId));
    const extras = extraTasks.filter((t) => !present.has(t.taskId)).map(emptyRow);
    return [...entryRows, ...extras];
  }, [data, extraTasks]);

  const existingTaskIds = useMemo(() => new Set(rows.map((r) => r.taskId)), [rows]);
  const dayTotals = useMemo(() => dailyTotals(rows, days), [rows, days]);
  const weekTotal = useMemo(() => weekTotalMinutes(rows), [rows]);

  const submitted = data?.submission.submitted ?? false;

  function stepWeek(deltaWeeks: number) {
    setMonday((m) => addDaysIso(m, deltaWeeks * 7));
    setExtraTasks([]); // add-row context is per-week
  }

  function handleCellSave(row: TimesheetRow, date: string, minutes: number) {
    const cell = cellAt(row, date);
    cellMutation.mutate({ meta: rowMeta(row), date, minutes, entryId: cell.entryId });
  }

  function handleAddTask(meta: CellTaskMeta) {
    setExtraTasks((prev) => (prev.some((t) => t.taskId === meta.taskId) ? prev : [...prev, meta]));
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-neutral-text-primary">Timesheet</h1>
          <p className="text-sm text-neutral-text-secondary">
            Review and submit your logged time across every project.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-neutral-text-secondary">Week total</div>
            <div className="tabular-nums font-semibold text-neutral-text-primary">
              {formatMinutesAsHm(weekTotal)}
            </div>
          </div>
          {submitted ? (
            <Button
              variant="secondary"
              onClick={() => submitMutation.mutate(false)}
              disabled={submitMutation.isPending}
            >
              Reopen week
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => submitMutation.mutate(true)}
              disabled={submitMutation.isPending || weekTotal === 0}
            >
              Submit week
            </Button>
          )}
        </div>
      </div>

      {/* Week stepper */}
      <div className="mb-3 flex items-center justify-between">
        {/* The stepper is the sole week-navigation affordance, so the glyph buttons meet
            the ≥44px touch target even though the surface is desktop-dense (web-rule). */}
        <div className="inline-flex items-center rounded-control border border-neutral-border bg-neutral-surface">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => stepWeek(-1)}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-primary"
          >
            ‹
          </button>
          <span className="min-w-[10rem] px-2 text-center text-sm font-medium tabular-nums text-neutral-text-primary">
            {formatWeekRange(monday)}
          </span>
          <button
            type="button"
            aria-label="Next week"
            onClick={() => stepWeek(1)}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-primary"
          >
            ›
          </button>
        </div>
        {submitted && (
          <span className="rounded-chip bg-semantic-on-track-bg px-2 py-0.5 text-xs font-medium text-semantic-on-track">
            Submitted
          </span>
        )}
      </div>

      {/* Body */}
      {isLoading ? (
        <div
          className="h-64 animate-pulse rounded-card border border-neutral-border bg-neutral-surface-raised"
          aria-label="Loading timesheet"
        />
      ) : isError ? (
        <div className="rounded-card border border-semantic-critical/30 bg-semantic-critical-bg p-4 text-sm">
          <p className="mb-2 text-neutral-text-primary">Couldn&rsquo;t load your timesheet.</p>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <TimesheetGrid
          rows={rows}
          days={days}
          dayTotals={dayTotals}
          weekTotal={weekTotal}
          existingTaskIds={existingTaskIds}
          submitted={submitted}
          onCellSave={handleCellSave}
          onAddTask={handleAddTask}
        />
      )}
    </div>
  );
}
