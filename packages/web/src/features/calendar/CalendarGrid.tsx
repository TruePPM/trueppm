/**
 * CalendarGrid — month grid with chip-fragment overlays and milestone diamonds.
 *
 * Layout strategy:
 *   - 7-column CSS grid for day cells (date numbers, today tint, weekend mute)
 *   - Per-week chip overlay: position:absolute chips over the row, sized by %
 *     so no ResizeObserver is needed
 *   - Lane assignment: greedy interval scheduling so non-overlapping chips
 *     share the same vertical lane; overlapping chips stack in separate lanes
 *   - MAX 4 chip lanes per row; overflow shows "+N more" in the cell corner
 *   - Milestone diamonds render in each day cell below the date number
 *
 * Design rules applied (CLAUDE.md):
 *   - No drop shadows (rule 1) — border-neutral-border separation
 *   - Today cell: brand-primary/5 bg tint, brand-primary day number
 *   - text-xs floor (rule 50) — no text-xs
 *   - Focus rings (rule 4) on all chip buttons
 *   - tppm-mono for date numbers (rule 8c)
 */

import type { Task } from '@/types';
import {
  parseUTCDate,
  viewWeekStarts,
  weekDays,
  formatISODate,
  isSameDay,
  buildChips,
  buildMilestoneMarks,
  formatWindowNoun,
  type CalendarChipData,
  type CalViewMode,
  type MilestoneMark,
} from './calendarUtils';
import { CalendarChip } from './CalendarChip';
import { CalendarMobileList } from './CalendarMobileList';
import { useBreakpoint } from '@/hooks/useBreakpoint';

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_LANES = 4;
const LANE_HEIGHT_PX = 22; // chip height (18px) + 4px gap
const DATE_NUMBER_HEIGHT_PX = 24;
const CELL_MIN_HEIGHT_PX = DATE_NUMBER_HEIGHT_PX + MAX_LANES * LANE_HEIGHT_PX + 8;

/**
 * Assign each chip a vertical lane using greedy interval scheduling.
 * Returns a Map<chip index → lane number (0-based)>.
 */
function assignLanes(chips: CalendarChipData[]): Map<number, number> {
  const sorted = chips
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.chipStartOffset - b.c.chipStartOffset);
  const laneEnd: number[] = [];
  const result = new Map<number, number>();

  for (const { c, i } of sorted) {
    const chipEnd = c.chipStartOffset + c.chipDays - 1;
    let assigned = -1;
    for (let lane = 0; lane < laneEnd.length; lane++) {
      if ((laneEnd[lane] ?? 0) < c.chipStartOffset) {
        laneEnd[lane] = chipEnd;
        assigned = lane;
        break;
      }
    }
    if (assigned === -1) {
      assigned = laneEnd.length;
      laneEnd.push(chipEnd);
    }
    result.set(i, assigned);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function LegendSwatch({ className }: { className: string }) {
  return (
    <span
      className={`inline-block w-4 h-2 rounded-chip flex-shrink-0 ${className}`}
      aria-hidden="true"
    />
  );
}

function CalendarLegend() {
  return (
    <div
      className="flex items-center gap-4 px-4 py-2 border-t border-neutral-border
        bg-neutral-surface-raised flex-shrink-0"
      aria-label="Calendar legend"
    >
      <span className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary tppm-mono mr-1">
        Legend
      </span>
      <span className="flex items-center gap-1.5 text-xs text-neutral-text-secondary">
        <LegendSwatch className="bg-semantic-critical" />
        Critical path
      </span>
      <span className="flex items-center gap-1.5 text-xs text-neutral-text-secondary">
        <LegendSwatch className="bg-semantic-at-risk" />
        At risk
      </span>
      <span className="flex items-center gap-1.5 text-xs text-neutral-text-secondary">
        <LegendSwatch className="bg-brand-primary" />
        On track
      </span>
      <span className="flex items-center gap-2 text-xs text-neutral-text-secondary">
        <svg
          aria-hidden="true"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className="flex-shrink-0 text-brand-accent fill-current"
        >
          <polygon points="5,0 10,5 5,10 0,5" />
        </svg>
        Milestone
      </span>
      {/* Due legend (issue 1230) — the dot marking a task bar's finish (due) day. */}
      <span className="flex items-center gap-1.5 text-xs text-neutral-text-secondary">
        <span
          aria-hidden="true"
          className="inline-block w-1.5 h-1.5 rounded-full bg-neutral-text-secondary flex-shrink-0"
        />
        Due
      </span>
      {/* Sprint-boundary legend (issue 1230) — dots on sprint start/finish days. */}
      <span className="flex items-center gap-1.5 text-xs text-neutral-text-secondary">
        <span
          aria-hidden="true"
          className="inline-block w-1.5 h-1.5 rounded-full bg-brand-accent-dark flex-shrink-0"
        />
        Sprint boundary
      </span>
    </div>
  );
}

/**
 * One milestone diamond inside a day cell.
 *
 * Its own component rather than inline JSX because the day cell already sits
 * three maps deep (weeks → days → marks); an inline `onClick` handler there is
 * the fifth function level (Sonar S2004).
 */
function MilestoneMarkButton({
  mark,
  onTaskClick,
}: {
  mark: MilestoneMark;
  onTaskClick: (taskId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onTaskClick(mark.taskId)}
      aria-label={`Milestone: ${mark.taskName}`}
      title={mark.taskName}
      className="flex items-center gap-1 mt-0.5 w-full text-left
        focus-visible:outline-none focus-visible:ring-2
        focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
    >
      <svg
        aria-hidden="true"
        width="10"
        height="10"
        viewBox="0 0 10 10"
        className="flex-shrink-0 text-brand-accent fill-current"
      >
        <polygon points="5,0 10,5 5,10 0,5" />
      </svg>
      <span className="text-xs text-brand-accent-dark truncate leading-tight">{mark.taskName}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main grid
// ---------------------------------------------------------------------------

interface CalendarGridProps {
  anchorIso: string;
  /**
   * Which window to render. Week mode draws the single Mon-Sun row containing
   * the anchor; month mode draws the 4-6 rows of the anchored month.
   *
   * Defaults to month so the prop is additive — this component rendered a month
   * unconditionally until #3167, and every existing caller and test means month.
   */
  calView?: CalViewMode;
  tasks: Task[];
  onTaskClick: (taskId: string) => void;
  /**
   * ISO dates (YYYY-MM-DD) on which a sprint starts or finishes (issue 1230).
   * A day cell in this set gets a small boundary dot. Optional/empty → no dots.
   */
  sprintBoundaries?: Set<string>;
}

export function CalendarGrid({
  anchorIso,
  calView = 'month',
  tasks,
  onTaskClick,
  sprintBoundaries,
}: CalendarGridProps) {
  // Below the `md` breakpoint the 7-column grid collapses to unusable ~60px
  // columns; render the documented date-grouped agenda list instead (#2161).
  const breakpoint = useBreakpoint();
  // A landmark's accessible name is an IDENTITY, not a state readout — renaming
  // it on every Prev/Next would churn the rotor entry a user navigates by. The
  // volatile window lives in the toolbar heading and in CalendarView's live
  // region instead (#3167).
  const regionLabel = 'Calendar';

  if (breakpoint === 'sm') {
    return (
      <div role="region" aria-label={regionLabel} className="flex flex-col h-full overflow-hidden">
        <CalendarMobileList
          anchorIso={anchorIso}
          calView={calView}
          tasks={tasks}
          onTaskClick={onTaskClick}
        />
        <CalendarLegend />
      </div>
    );
  }

  const anchor = parseUTCDate(anchorIso);
  const today = new Date();
  const isWeek = calView === 'week';
  const weeks = viewWeekStarts(anchor, calView);
  const allChips = buildChips(tasks, anchor, calView);
  const allMarks = buildMilestoneMarks(tasks, anchor, calView);
  const currentMonth = anchor.getUTCMonth();

  // The 4-lane cap exists because a month packs 4-6 rows into one viewport, so
  // each row can only afford ~4 chips. A week row has that whole budget to
  // itself, so week mode lifts the cap entirely and shows every task touching
  // the week. The cap is not a display preference — "+N more" is inert text, so
  // a capped row silently hides most of a busy week, and every project with 10+
  // tasks has such a week (#3167).
  const maxLanes = isWeek ? Number.POSITIVE_INFINITY : MAX_LANES;

  // Group chips by weekStart ISO
  const chipsByWeek = new Map<string, CalendarChipData[]>();
  for (const chip of allChips) {
    const list = chipsByWeek.get(chip.weekStart) ?? [];
    list.push(chip);
    chipsByWeek.set(chip.weekStart, list);
  }

  // Group milestone marks by weekStart, then by dayOffset
  const marksByWeekDay = new Map<string, MilestoneMark[]>();
  for (const mark of allMarks) {
    const key = `${mark.weekStart}:${mark.dayOffset}`;
    const list = marksByWeekDay.get(key) ?? [];
    list.push(mark);
    marksByWeekDay.set(key, list);
  }

  return (
    <div role="region" aria-label={regionLabel} className="flex flex-col h-full overflow-hidden">
      {/* Day-of-week header */}
      <div className="grid grid-cols-7 border-b border-neutral-border flex-shrink-0">
        {DAY_HEADERS.map((d) => (
          <div
            key={d}
            className="py-1.5 text-center tppm-mono text-xs font-semibold uppercase tracking-widest
              text-neutral-text-secondary border-r last:border-r-0 border-neutral-border
              bg-neutral-surface-sunken"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Week rows */}
      <div
        className={
          isWeek
            ? 'flex flex-1 min-h-0 flex-col overflow-y-auto divide-y divide-neutral-border'
            : 'flex-1 overflow-y-auto divide-y divide-neutral-border'
        }
      >
        {weeks.map((ws) => {
          const wsIso = formatISODate(ws);
          const days = weekDays(ws);
          const weekChips = chipsByWeek.get(wsIso) ?? [];
          const laneMap = assignLanes(weekChips);

          const overflowByDay = new Map<number, number>();
          weekChips.forEach((chip, idx) => {
            const lane = laneMap.get(idx) ?? 0;
            if (lane >= maxLanes) {
              const dayOffset = chip.chipStartOffset;
              overflowByDay.set(dayOffset, (overflowByDay.get(dayOffset) ?? 0) + 1);
            }
          });

          // Carry each chip's lane alongside it rather than re-deriving it from
          // an array position later. `laneMap` is keyed by index into
          // `weekChips`, so any *filtered* array's indices stop corresponding to
          // it — reading `laneMap.get(i)` with a filtered `i` paints chips at
          // other chips' lanes, and can place one past the row's own height
          // (see the regression test in CalendarGrid.test.tsx).
          const visibleChips = weekChips
            .map((chip, idx) => ({ chip, lane: laneMap.get(idx) ?? 0 }))
            .filter(({ lane }) => lane < maxLanes);

          // Week mode grows the row to fit however many lanes it actually uses,
          // never below the month row's height so a quiet week doesn't collapse
          // into a strip. Month mode keeps the fixed 4-lane height.
          const laneCount = visibleChips.reduce((max, { lane }) => Math.max(max, lane + 1), 0);

          // Count THIS row's milestones, not the whole window's. Identical today
          // because week mode renders exactly one row — but only by coincidence
          // of the loop having one iteration, which a future multi-week mode
          // would silently break.
          const weekMarkCount = days.reduce(
            (n, _d, i) => n + (marksByWeekDay.get(`${wsIso}:${i}`)?.length ?? 0),
            0,
          );
          const rowMinHeight = isWeek
            ? Math.max(CELL_MIN_HEIGHT_PX, DATE_NUMBER_HEIGHT_PX + laneCount * LANE_HEIGHT_PX + 8)
            : CELL_MIN_HEIGHT_PX;

          return (
            <div
              key={wsIso}
              className={`relative ${isWeek ? 'flex-1' : ''}`}
              style={{ minHeight: rowMinHeight }}
            >
              {/* Day cells grid */}
              <div className="grid grid-cols-7 h-full">
                {days.map((day, dayIdx) => {
                  const iso = formatISODate(day);
                  const isToday = isSameDay(day, today);
                  // Every day a week row renders is inside the window, so the
                  // out-of-month graying is a month-mode concept only.
                  const isCurrentMonth = isWeek || day.getUTCMonth() === currentMonth;
                  const dayOffset = Math.round((day.getTime() - ws.getTime()) / 86_400_000);
                  const overflow = overflowByDay.get(dayOffset) ?? 0;
                  const dayMarks = marksByWeekDay.get(`${wsIso}:${dayOffset}`) ?? [];
                  const isSprintBoundary = sprintBoundaries?.has(iso) ?? false;

                  return (
                    <div
                      key={iso}
                      className={`
                        relative border-r last:border-r-0 border-neutral-border p-1
                        ${isToday ? 'bg-brand-primary/5' : ''}
                        ${!isCurrentMonth ? 'bg-neutral-surface-sunken' : ''}
                        ${dayIdx >= 5 ? 'opacity-60' : ''}
                      `}
                      style={{ minHeight: rowMinHeight }}
                    >
                      {/* Day number */}
                      <span
                        className={`
                          block tppm-mono text-xs font-medium leading-5 w-5 text-center rounded-full
                          ${
                            isToday
                              ? 'bg-sage-500 text-navy-900 font-semibold'
                              : isCurrentMonth
                                ? 'text-neutral-text-primary'
                                : 'text-neutral-text-disabled'
                          }
                        `}
                      >
                        {day.getUTCDate()}
                      </span>

                      {/* Sprint-boundary dot (issue 1230) — marks a sprint start/finish day. */}
                      {isSprintBoundary && (
                        <span
                          className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-brand-accent-dark"
                          title="Sprint boundary"
                          aria-label="Sprint boundary"
                          role="img"
                        />
                      )}

                      {/* Milestone diamonds in this day cell */}
                      {dayMarks.map((mark) => (
                        <MilestoneMarkButton
                          key={mark.taskId}
                          mark={mark}
                          onTaskClick={onTaskClick}
                        />
                      ))}

                      {overflow > 0 && (
                        <span className="absolute bottom-1 left-1 text-xs text-neutral-text-secondary">
                          +{overflow} more
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* A quiet week stretches to fill the viewport, and an empty
                  stretched row reads as a failed render rather than as "nothing
                  scheduled" — so name it. Month mode needs no equivalent: 30
                  dated empty cells already say it. */}
              {isWeek && visibleChips.length === 0 && weekMarkCount === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="text-sm text-neutral-text-secondary">
                    No tasks in {formatWindowNoun(anchor, calView)}.
                  </p>
                </div>
              )}

              {/* Chip overlay — absolutely positioned over the day cells */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ top: DATE_NUMBER_HEIGHT_PX }}
              >
                {visibleChips.map(({ chip, lane }, idx) => {
                  const top = lane * LANE_HEIGHT_PX + 2;
                  const leftPct = (chip.chipStartOffset / 7) * 100;
                  const widthPct = (chip.chipDays / 7) * 100;

                  return (
                    <div
                      key={`${chip.taskId}-${wsIso}-${idx}`}
                      className="absolute pointer-events-auto"
                      style={{
                        top,
                        left: `calc(${leftPct}% + 2px)`,
                        width: `calc(${widthPct}% - 4px)`,
                      }}
                    >
                      <CalendarChip chip={chip} onClick={onTaskClick} />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <CalendarLegend />
    </div>
  );
}
