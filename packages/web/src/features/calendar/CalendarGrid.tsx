/**
 * CalendarGrid — month grid with chip-fragment overlays and milestone diamonds.
 *
 * Layout strategy:
 *   - 7-column CSS grid for day cells (date numbers, today tint, weekend mute)
 *   - Chips are absolutely positioned inside the day cell they START in, sized
 *     as a multiple of that cell's own width (every column is exactly 1/7 of
 *     the row), so a multi-day chip overhangs its neighbours without needing a
 *     ResizeObserver or a separate overlay layer
 *   - Lane assignment: greedy interval scheduling so non-overlapping chips
 *     share the same vertical lane; overlapping chips stack in separate lanes
 *   - MAX 4 chip lanes per row; overflow shows "+N more" in the cell corner
 *   - Milestone diamonds render in each day cell below the date number
 *
 * Accessibility (#3241): the date grid implements the ARIA grid pattern —
 * `role="grid"` > `row` > `gridcell`, each cell named with its full date, one
 * roving tab stop, and arrow / Home / End traversal between cells.
 *
 * Design rules applied (CLAUDE.md):
 *   - No drop shadows (rule 1) — border-neutral-border separation
 *   - Today cell: brand-primary/5 bg tint, brand-primary day number
 *   - text-xs floor (rule 50) — no text-xs
 *   - Focus rings (rule 4) on all chip buttons and on the roving day cell
 *   - tppm-mono for date numbers (rule 8c)
 */

import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import type { Task } from '@/types';
import {
  parseUTCDate,
  viewWeekStarts,
  weekDays,
  formatISODate,
  formatDayCellLabel,
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

/**
 * Column headers. The abbreviation is what the header cell prints; the full
 * name is its accessible name, because "Mon" read aloud is an abbreviation a
 * screen reader may or may not expand.
 */
const DAY_HEADERS: ReadonlyArray<{ abbr: string; full: string }> = [
  { abbr: 'Mon', full: 'Monday' },
  { abbr: 'Tue', full: 'Tuesday' },
  { abbr: 'Wed', full: 'Wednesday' },
  { abbr: 'Thu', full: 'Thursday' },
  { abbr: 'Fri', full: 'Friday' },
  { abbr: 'Sat', full: 'Saturday' },
  { abbr: 'Sun', full: 'Sunday' },
];
const DAYS_PER_WEEK = 7;
const MAX_LANES = 4;
const LANE_HEIGHT_PX = 22; // chip height (18px) + 4px gap
const DATE_NUMBER_HEIGHT_PX = 24;
const CELL_MIN_HEIGHT_PX = DATE_NUMBER_HEIGHT_PX + MAX_LANES * LANE_HEIGHT_PX + 8;

/** A chip plus the lane it was assigned, carried together (see visibleChips). */
interface PlacedChip {
  chip: CalendarChipData;
  lane: number;
}

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
    // role="group" is load-bearing, not decoration: an aria-label on a role-less
    // <div> names nothing, so the label was invisible to AT entirely (#3241).
    <div
      role="group"
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

/**
 * The chips that START in one day cell, drawn at their assigned lanes.
 *
 * Chips live inside their start day's cell rather than in a row-wide overlay
 * (#3241): the overlay was a SIBLING rendered after all seven cells, so tab
 * order per week row was "every milestone button in day order, then every
 * chip in API list order" — an order unrelated to what is on screen. As a cell
 * child, a chip's DOM position is its visual position.
 *
 * Widths are a multiple of the cell's own width because `grid-cols-7` makes
 * every column exactly 1/7 of the row, so `chipDays * 100%` is the same span
 * the row-relative overlay used to compute. `z-10` is what lets a chip overhang
 * the cells to its right: sibling cells are `position: relative` with `z-auto`
 * and so create no stacking context of their own.
 */
function DayChips({
  chips,
  weekStartIso,
  onTaskClick,
}: {
  chips: PlacedChip[];
  weekStartIso: string;
  onTaskClick: (taskId: string) => void;
}) {
  return (
    <>
      {chips.map(({ chip, lane }, idx) => (
        <div
          key={`${chip.taskId}-${weekStartIso}-${idx}`}
          data-cal-chip=""
          className="absolute z-10"
          style={{
            top: DATE_NUMBER_HEIGHT_PX + lane * LANE_HEIGHT_PX + 2,
            left: 2,
            width: `calc(${chip.chipDays * 100}% - 4px)`,
          }}
        >
          <CalendarChip chip={chip} onClick={onTaskClick} />
        </div>
      ))}
    </>
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

  // The roving tab stop is keyed on the ISO DATE, never on an index into the
  // day array or on its length: the whole day set is replaced on every
  // month/week step and on every mode switch, and an index-keyed roving stop
  // both points at a different day afterwards and (if re-focused from an
  // effect) steals focus from whatever the user was actually on (web rule 280).
  // An ISO that is no longer in the window simply falls back to the default
  // below — a pure derivation, so no effect and no focus movement.
  const [focusedIso, setFocusedIso] = useState<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());

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

  // Every rendered day, in visual order — the grid's own coordinate space for
  // keyboard traversal. Always a whole number of 7-day rows.
  const windowDays = weeks.flatMap((ws) => weekDays(ws));
  const windowIsos = windowDays.map(formatISODate);

  // Where the single tab stop sits when the user has not moved it: today if the
  // window contains it, else the anchor day, else the first day drawn. Tabbing
  // into the grid should land on the day the view is *about*.
  const todayIdx = windowDays.findIndex((d) => isSameDay(d, today));
  let defaultIso = windowIsos[0];
  if (todayIdx >= 0) defaultIso = windowIsos[todayIdx];
  else if (windowIsos.includes(anchorIso)) defaultIso = anchorIso;
  const activeIso =
    focusedIso !== null && windowIsos.includes(focusedIso) ? focusedIso : defaultIso;

  /**
   * Resolve a key press to the ISO date it should move the tab stop to, or
   * null if the grid does not own that key.
   *
   * Movement CLAMPS at the window's edges rather than wrapping or stepping the
   * window. The grid does not own the anchor — stepping it is the toolbar's
   * ‹ / › (which also drives CalendarView's live region) — and a window step
   * unmounts every cell including the focused one, so silently doing it from an
   * arrow key would drop focus to the document body. PageUp/PageDown are left
   * unbound for the same reason.
   */
  function nextIso(fromIso: string, key: string, wholeGrid: boolean): string | null {
    const i = windowIsos.indexOf(fromIso);
    if (i === -1) return null;
    const last = windowIsos.length - 1;
    const rowStart = i - (i % DAYS_PER_WEEK);
    switch (key) {
      case 'ArrowLeft':
        return windowIsos[Math.max(0, i - 1)];
      case 'ArrowRight':
        return windowIsos[Math.min(last, i + 1)];
      case 'ArrowUp':
        return windowIsos[Math.max(0, i - DAYS_PER_WEEK)];
      case 'ArrowDown':
        return windowIsos[Math.min(last, i + DAYS_PER_WEEK)];
      case 'Home':
        return wholeGrid ? windowIsos[0] : windowIsos[rowStart];
      case 'End':
        return wholeGrid ? windowIsos[last] : windowIsos[rowStart + DAYS_PER_WEEK - 1];
      default:
        return null;
    }
  }

  function handleCellKeyDown(e: KeyboardEvent<HTMLDivElement>, iso: string) {
    // Only the cell itself navigates. A chip or milestone button inside a cell
    // is its own widget; arrowing off it would yank focus out from under a user
    // who is on the chip, not on the day.
    if (e.target !== e.currentTarget) return;
    const target = nextIso(iso, e.key, e.ctrlKey || e.metaKey);
    if (target === null) return;
    // Swallow the key even when clamped at an edge, so ArrowDown on the last
    // row scrolls nothing and Home does not jump the scroll container.
    e.preventDefault();
    if (target === iso) return;
    setFocusedIso(target);
    cellRefs.current.get(target)?.focus();
  }

  function handleCellFocus(e: FocusEvent<HTMLDivElement>, iso: string) {
    // React's onFocus is focusin, so a chip inside the cell bubbles here too —
    // and moving the day tab stop because a chip was focused would put the two
    // out of step.
    if (e.target === e.currentTarget) setFocusedIso(iso);
  }

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

  // Week mode renders exactly one row, so "this row is empty" and "the window
  // is empty" are the same statement — and stating it once, outside the grid,
  // keeps `role="row"` owning nothing but `gridcell`s.
  const windowIsEmpty = isWeek && allChips.length === 0 && allMarks.length === 0;

  return (
    <div role="region" aria-label={regionLabel} className="flex flex-col h-full overflow-hidden">
      <div className="relative flex flex-1 min-h-0 flex-col">
        <div
          role="grid"
          aria-label="Calendar dates"
          aria-rowcount={weeks.length + 1}
          aria-colcount={DAYS_PER_WEEK}
          className="flex flex-1 min-h-0 flex-col"
        >
          {/* Day-of-week header */}
          <div
            role="row"
            aria-rowindex={1}
            className="grid grid-cols-7 border-b border-neutral-border flex-shrink-0"
          >
            {DAY_HEADERS.map((d, i) => (
              <div
                key={d.abbr}
                role="columnheader"
                aria-colindex={i + 1}
                aria-label={d.full}
                className="py-1.5 text-center tppm-mono text-xs font-semibold uppercase tracking-widest
                  text-neutral-text-secondary border-r last:border-r-0 border-neutral-border
                  bg-neutral-surface-sunken"
              >
                {d.abbr}
              </div>
            ))}
          </div>

          {/* Week rows */}
          <div
            role="rowgroup"
            className={
              isWeek
                ? 'flex flex-1 min-h-0 flex-col overflow-y-auto divide-y divide-neutral-border'
                : 'flex-1 overflow-y-auto divide-y divide-neutral-border'
            }
          >
            {weeks.map((ws, weekIdx) => {
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
              const visibleChips: PlacedChip[] = weekChips
                .map((chip, idx) => ({ chip, lane: laneMap.get(idx) ?? 0 }))
                .filter(({ lane }) => lane < maxLanes);

              // Chips are dealt to the cell they start in, lane order within a
              // cell — which is top-to-bottom on screen, and therefore the tab
              // order a sighted keyboard user is looking at (#3241).
              const chipsByDay = new Map<number, PlacedChip[]>();
              for (const placed of visibleChips) {
                const list = chipsByDay.get(placed.chip.chipStartOffset) ?? [];
                list.push(placed);
                chipsByDay.set(placed.chip.chipStartOffset, list);
              }
              for (const list of chipsByDay.values()) list.sort((a, b) => a.lane - b.lane);

              // Week mode grows the row to fit however many lanes it actually uses,
              // never below the month row's height so a quiet week doesn't collapse
              // into a strip. Month mode keeps the fixed 4-lane height.
              const laneCount = visibleChips.reduce((max, { lane }) => Math.max(max, lane + 1), 0);
              const rowMinHeight = isWeek
                ? Math.max(
                    CELL_MIN_HEIGHT_PX,
                    DATE_NUMBER_HEIGHT_PX + laneCount * LANE_HEIGHT_PX + 8,
                  )
                : CELL_MIN_HEIGHT_PX;

              return (
                <div
                  key={wsIso}
                  role="row"
                  aria-rowindex={weekIdx + 2}
                  className={`relative grid grid-cols-7 ${isWeek ? 'flex-1' : ''}`}
                  style={{ minHeight: rowMinHeight }}
                >
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
                    const dayLabel = formatDayCellLabel(day);

                    return (
                      <div
                        key={iso}
                        ref={(el) => {
                          if (el) cellRefs.current.set(iso, el);
                          return () => {
                            cellRefs.current.delete(iso);
                          };
                        }}
                        role="gridcell"
                        aria-colindex={dayIdx + 1}
                        aria-label={isToday ? `${dayLabel}, today` : dayLabel}
                        tabIndex={iso === activeIso ? 0 : -1}
                        onKeyDown={(e) => handleCellKeyDown(e, iso)}
                        onFocus={(e) => handleCellFocus(e, iso)}
                        className={`
                          relative border-r last:border-r-0 border-neutral-border p-1
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
                          focus-visible:ring-brand-primary
                          ${isToday ? 'bg-brand-primary/5' : ''}
                          ${!isCurrentMonth ? 'bg-neutral-surface-sunken' : ''}
                        `}
                        style={{ minHeight: rowMinHeight }}
                      >
                        {/* The weekend mute is on the cell's OWN marks, not on
                            the cell: chips live in the cell they start in now,
                            so dimming the cell would dim a Saturday-starting
                            bar and leave an identical Monday-starting one at
                            full strength. It stays off the cell box for a
                            second reason — a 60% focus ring is a weaker focus
                            indicator on exactly two of seven columns. */}
                        <div className={dayIdx >= 5 ? 'opacity-60' : ''}>
                          {/* Day number — aria-hidden because the cell's own
                              label already states the full date; without this
                              the number is read a second time, bare. */}
                          <span
                            aria-hidden="true"
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

                        {/* Task chips starting on this day */}
                        <DayChips
                          chips={chipsByDay.get(dayOffset) ?? []}
                          weekStartIso={wsIso}
                          onTaskClick={onTaskClick}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* A quiet week stretches to fill the viewport, and an empty stretched
            row reads as a failed render rather than as "nothing scheduled" — so
            name it. Month mode needs no equivalent: 30 dated empty cells
            already say it. Drawn over the grid rather than inside a row so that
            `role="row"` owns nothing but `gridcell`s. */}
        {windowIsEmpty && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-sm text-neutral-text-secondary">
              No tasks in {formatWindowNoun(anchor, calView)}.
            </p>
          </div>
        )}
      </div>

      {/* Legend */}
      <CalendarLegend />
    </div>
  );
}
