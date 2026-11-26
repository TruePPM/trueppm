/**
 * CalendarGrid — month grid with chip-fragment overlays and milestone diamonds.
 *
 * Layout strategy:
 *   - 7-column CSS grid for day cells (date numbers, today tint, non-working mute)
 *   - Chips are absolutely positioned inside the day cell they START in, sized
 *     as a multiple of that cell's own width (every column is exactly 1/7 of
 *     the row), so a multi-day chip overhangs its neighbours without needing a
 *     ResizeObserver or a separate overlay layer
 *   - Lane assignment: greedy interval scheduling so non-overlapping chips
 *     share the same vertical lane; overlapping chips stack in separate lanes
 *   - MAX 4 chip lanes per row; overflow shows a "+N more" button in the cell corner that opens a popover of the hidden tasks (rule 296)
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

import { useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react';
import type { Task } from '@/types';
import {
  parseUTCDate,
  viewWeekStarts,
  weekDays,
  formatISODate,
  formatDayCellLabel,
  buildChips,
  buildMilestoneMarks,
  formatWindowNoun,
  resolveDayAvailability,
  buildAssigneeLanes,
  inAssigneeLane,
  DEFAULT_WEEK_START_DAY,
  DEFAULT_WORKING_TIME,
  type CalendarChipData,
  type CalViewMode,
  type DayAvailability,
  type MilestoneMark,
  type WeekStartDay,
  type WorkingTimeInputs,
} from './calendarUtils';
import { CalendarChip } from './CalendarChip';
import { CalendarMobileList } from './CalendarMobileList';
import { DayOverflowButton } from './DayOverflowButton';
import { dayTypeFillStyle } from '@/features/settings/project/calendarDisplay';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { todayLocalIso } from '@/features/schedule/scheduleUtils';

/**
 * Column headers, indexed by `getUTCDay()` so a week start rotates them directly.
 * The abbreviation is what the header cell prints; the full name is its accessible
 * name, because "Mon" read aloud is an abbreviation a screen reader may or may not
 * expand.
 */
const DAY_HEADERS: ReadonlyArray<{ abbr: string; full: string }> = [
  { abbr: 'Sun', full: 'Sunday' },
  { abbr: 'Mon', full: 'Monday' },
  { abbr: 'Tue', full: 'Tuesday' },
  { abbr: 'Wed', full: 'Wednesday' },
  { abbr: 'Thu', full: 'Thursday' },
  { abbr: 'Fri', full: 'Friday' },
  { abbr: 'Sat', full: 'Saturday' },
];
const DAYS_PER_WEEK = 7;
const MAX_LANES = 4;
const LANE_HEIGHT_PX = 22; // chip height (18px) + 4px gap
const DATE_NUMBER_HEIGHT_PX = 24;
const CELL_MIN_HEIGHT_PX = DATE_NUMBER_HEIGHT_PX + MAX_LANES * LANE_HEIGHT_PX + 8;
// Month rows reserve a strip below the fourth lane for the "+N more" button: the
// chips are absolutely positioned at z-10, so a button drawn over lane 4 is both
// hidden and unclickable (#3179). Week mode has no cap and no button.
const OVERFLOW_ROW_PX = 24; // WCAG 2.5.8 minimum target size
const MONTH_ROW_MIN_HEIGHT_PX = CELL_MIN_HEIGHT_PX + OVERFLOW_ROW_PX;

/**
 * The day cell's accessible name. The visible cue for a non-working day is the
 * muted number, which a screen reader cannot perceive, and an exception's label
 * is aria-hidden beside it — so the name states both.
 */
function dayCellName(dayLabel: string, isToday: boolean, availability: DayAvailability): string {
  const parts = [dayLabel];
  if (availability.kind === 'exception') {
    parts.push(...new Set([availability.name, ...availability.calendars]));
  }
  if (availability.kind === 'non-working') parts.push(...availability.calendars);
  if (availability.kind !== 'working') parts.push('non-working day');
  if (isToday) parts.push('today');
  return parts.join(', ');
}

const flatLayer = (color: string) => `linear-gradient(${color}, ${color})`;
const TODAY_TINT = flatLayer('rgb(var(--brand-primary) / 0.05)');

/**
 * The cell's pattern fill, shared with the settings preview so a day type reads alike.
 *
 * An inline background beats the cell's today and out-of-month utility classes, so a
 * filled cell states those itself as layers: the today tint over the pattern, and the
 * fill's color over the sunken surface. The hatch alone marks an out-of-month ordinary
 * non-working day, because its own opaque color would hide the dimming beneath it.
 */
function dayFillStyle(
  availability: DayAvailability,
  isToday: boolean,
  isCurrentMonth: boolean,
): CSSProperties | undefined {
  if (availability.kind === 'working') return undefined;
  const type = availability.kind === 'exception' ? availability.type : 'weekend';
  const fill = dayTypeFillStyle(type);
  const tint = isToday ? [TODAY_TINT] : [];
  if (isCurrentMonth && !isToday) return fill;

  const colorLayers =
    !isCurrentMonth && type !== 'weekend' ? [flatLayer(String(fill.backgroundColor))] : [];
  return {
    ...fill,
    backgroundColor: isCurrentMonth ? fill.backgroundColor : 'rgb(var(--neutral-surface-sunken))',
    backgroundImage: [...tint, fill.backgroundImage, ...colorLayers].join(', '),
    // Only the holiday dots carry a size, and a size list pairs with images by position.
    backgroundSize:
      fill.backgroundSize &&
      [...tint.map(() => 'auto'), fill.backgroundSize, ...colorLayers.map(() => 'auto')].join(', '),
  };
}

/** A solid backing for text on a pattern fill, which is too busy to carry it directly. */
const ON_FILL_BACKING = 'rounded-sm bg-neutral-surface';

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

function LegendSwatch({ className, style }: { className: string; style?: CSSProperties }) {
  return (
    <span
      className={`inline-block w-4 h-2 rounded-chip flex-shrink-0 ${className}`}
      style={style}
      aria-hidden="true"
    />
  );
}

function CalendarLegend({
  showWorkingTime = false,
  workingTimeIncomplete = false,
}: {
  /** The day-type fills exist only on the grid, not the phone agenda. */
  showWorkingTime?: boolean;
  workingTimeIncomplete?: boolean;
}) {
  return (
    // role="group" is load-bearing, not decoration: an aria-label on a role-less
    // <div> names nothing, so the label was invisible to AT entirely (#3241).
    <div
      role="group"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-t border-neutral-border
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
      {showWorkingTime &&
        (
          [
            ['weekend', 'Non-working day'],
            ['holiday', 'Holiday'],
            ['shutdown', 'Shutdown'],
          ] as const
        ).map(([type, label]) => (
          <span
            key={type}
            className="flex items-center gap-1.5 text-xs text-neutral-text-secondary"
          >
            <LegendSwatch className="border border-neutral-border" style={dayTypeFillStyle(type)} />
            {label}
          </span>
        ))}
      {/* A failed read and a calendar with no holidays draw identical grids, so
          the failure has to be stated or it reads as "nothing is off". */}
      {showWorkingTime && workingTimeIncomplete && (
        <span className="text-xs text-neutral-text-secondary">
          Couldn&apos;t load this project&apos;s full working calendar, so the days shown as
          non-working may be wrong.
        </span>
      )}
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
  onFill,
  onTaskClick,
}: {
  mark: MilestoneMark;
  onFill: boolean;
  onTaskClick: (taskId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onTaskClick(mark.taskId)}
      aria-label={`Milestone: ${mark.taskName}`}
      title={mark.taskName}
      className={`flex items-center gap-1 mt-0.5 w-full text-left
        focus-visible:outline-none focus-visible:ring-2
        focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded
        ${onFill ? ON_FILL_BACKING : ''}`}
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
 * and so create no stacking context of their own. The solid wrapper is there
 * because a chip's fill is a translucent tint, and a non-working cell's pattern
 * would otherwise show through behind the task name.
 */
function DayChips({
  chips,
  weekStartIso,
  onTaskClick,
  labelContinuation,
}: {
  chips: PlacedChip[];
  weekStartIso: string;
  onTaskClick: (taskId: string) => void;
  labelContinuation: boolean;
}) {
  return (
    <>
      {chips.map(({ chip, lane }, idx) => (
        <div
          key={`${chip.taskId}-${weekStartIso}-${idx}`}
          data-cal-chip=""
          className="absolute z-10 rounded-chip bg-neutral-surface"
          style={{
            top: DATE_NUMBER_HEIGHT_PX + lane * LANE_HEIGHT_PX + 2,
            left: 2,
            width: `calc(${chip.chipDays * 100}% - 4px)`,
          }}
        >
          <CalendarChip chip={chip} onClick={onTaskClick} labelContinuation={labelContinuation} />
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
   * Which window to render. Week mode draws the single row containing the anchor; month mode draws the 4-6 rows of the anchored month.
   *
   * Defaults to month so the prop is additive — this component rendered a month
   * unconditionally until #3167, and every existing caller and test means month.
   */
  calView?: CalViewMode;
  /** The weekday the first column shows. Optional so the prop is additive. */
  weekStartDay?: WeekStartDay;
  /** The project's working time. Optional; absent reads as Mon–Fri with no exceptions. */
  workingTime?: WorkingTimeInputs;
  /** True when a calendar could not be read, so the day types drawn may be wrong. */
  workingTimeIncomplete?: boolean;
  tasks: Task[];
  onTaskClick: (taskId: string) => void;
  /**
   * ISO dates (YYYY-MM-DD) on which a sprint starts or finishes (issue 1230).
   * A day cell in this set gets a small boundary dot. Optional/empty → no dots.
   */
  sprintBoundaries?: Set<string>;
  /**
   * Week mode only: draw one swimlane (a full 7-day row) per assignee instead of
   * one row packed by date-overlap (#3169). Ignored in month mode, where six
   * rows already fill the viewport.
   */
  groupByAssignee?: boolean;
}

/** One rendered row: a calendar week, or one assignee's slice of the single week. */
interface GridRow {
  key: string;
  ws: Date;
  /** Swimlane identity; null for an ordinary week row. */
  laneKey: string | null;
  laneLabel: string | null;
  chips: CalendarChipData[];
}

export function CalendarGrid({
  anchorIso,
  calView = 'month',
  weekStartDay = DEFAULT_WEEK_START_DAY,
  workingTime = DEFAULT_WORKING_TIME,
  workingTimeIncomplete = false,
  tasks,
  onTaskClick,
  sprintBoundaries,
  groupByAssignee = false,
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
  // In swimlane mode the same date appears once per lane, so the stop is keyed on
  // `cellKey` (lane + date), which equals the bare ISO date outside swimlanes.
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
          weekStartDay={weekStartDay}
          tasks={tasks}
          onTaskClick={onTaskClick}
        />
        <CalendarLegend />
      </div>
    );
  }

  const anchor = parseUTCDate(anchorIso);
  // Cells are date-only values at UTC midnight; "today" is the viewer's local
  // calendar day, so compare ISO strings rather than UTC accessors on a local Date.
  const todayIso = todayLocalIso();
  const isWeek = calView === 'week';
  const weeks = viewWeekStarts(anchor, calView, weekStartDay);
  const allChips = buildChips(tasks, anchor, calView, weekStartDay);
  const allMarks = buildMilestoneMarks(tasks, anchor, calView, weekStartDay);
  const currentMonth = anchor.getUTCMonth();
  const grouped = isWeek && groupByAssignee;

  // Group chips by weekStart ISO
  const chipsByWeek = new Map<string, CalendarChipData[]>();
  for (const chip of allChips) {
    const list = chipsByWeek.get(chip.weekStart) ?? [];
    list.push(chip);
    chipsByWeek.set(chip.weekStart, list);
  }

  // The rows to draw. Swimlanes re-slice the one week by assignee; lanes are
  // assigned within each slice, so a person's bars pack against their own
  // schedule rather than against everyone's.
  const rows: GridRow[] = grouped
    ? buildAssigneeLanes([...allChips, ...allMarks]).map((lane) => ({
        key: lane.key,
        ws: weeks[0],
        laneKey: lane.key,
        laneLabel: lane.label,
        chips: (chipsByWeek.get(formatISODate(weeks[0])) ?? []).filter((c) =>
          inAssigneeLane(c, lane.key),
        ),
      }))
    : weeks.map((ws) => ({
        key: formatISODate(ws),
        ws,
        laneKey: null,
        laneLabel: null,
        chips: chipsByWeek.get(formatISODate(ws)) ?? [],
      }));
  const cellKeyOf = (row: GridRow, iso: string) => (row.laneKey ? `${row.laneKey}|${iso}` : iso);

  // Every rendered day, in visual order — the grid's own coordinate space for
  // keyboard traversal. Always a whole number of 7-day rows.
  const windowDays = rows.flatMap((row) =>
    weekDays(row.ws, weekStartDay).map((d) => ({ d, key: cellKeyOf(row, formatISODate(d)) })),
  );
  const windowIsos = windowDays.map((x) => x.key);

  // Where the single tab stop sits when the user has not moved it: today if the
  // window contains it, else the anchor day, else the first day drawn. Tabbing
  // into the grid should land on the day the view is *about*.
  const todayIdx = windowDays.findIndex((x) => formatISODate(x.d) === todayIso);
  const anchorIdx = windowDays.findIndex((x) => formatISODate(x.d) === anchorIso);
  let defaultIso = windowIsos[0];
  if (todayIdx >= 0) defaultIso = windowIsos[todayIdx];
  else if (anchorIdx >= 0) defaultIso = windowIsos[anchorIdx];
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
  // the week. The cap is not a display preference — a capped row hides tasks
  // behind a "+N more" button, and a week with 10+ tasks would bury most of
  // them one click away, so week mode shows them all (#3167).
  const maxLanes = isWeek ? Number.POSITIVE_INFINITY : MAX_LANES;

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

  // Swimlanes add a leading name column ahead of the seven day columns.
  const gridColsClass = grouped ? 'grid-cols-[8rem_repeat(7,minmax(0,1fr))]' : 'grid-cols-7';
  const firstDayCol = grouped ? 2 : 1;

  return (
    <div role="region" aria-label={regionLabel} className="flex flex-col h-full overflow-hidden">
      <div className="relative flex flex-1 min-h-0 flex-col">
        <div
          role="grid"
          aria-label="Calendar dates"
          aria-rowcount={rows.length + 1}
          aria-colcount={DAYS_PER_WEEK + (grouped ? 1 : 0)}
          className="flex flex-1 min-h-0 flex-col"
        >
          {/* Day-of-week header */}
          <div
            role="row"
            aria-rowindex={1}
            className={`grid ${gridColsClass} border-b border-neutral-border flex-shrink-0`}
          >
            {grouped && (
              <div
                role="columnheader"
                aria-colindex={1}
                className="py-1.5 pl-2 text-left tppm-mono text-xs font-semibold uppercase tracking-widest
                  text-neutral-text-secondary border-r border-neutral-border bg-neutral-surface-sunken"
              >
                Assignee
              </div>
            )}
            {Array.from(
              { length: DAYS_PER_WEEK },
              (_, i) => DAY_HEADERS[(weekStartDay + i) % DAYS_PER_WEEK],
            ).map((d, i) => (
              <div
                key={d.abbr}
                role="columnheader"
                aria-colindex={i + firstDayCol}
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
            {rows.map((row, weekIdx) => {
              const ws = row.ws;
              const wsIso = formatISODate(ws);
              const days = weekDays(ws, weekStartDay);
              const weekChips = row.chips;
              const laneMap = assignLanes(weekChips);
              // A lane can hold only a milestone diamond (lanes are built from chips
              // and marks), so the header counts distinct tasks across both.
              const laneTaskCount = new Set([
                ...weekChips.map((c) => c.taskId),
                ...allMarks
                  .filter((m) => row.laneKey !== null && inAssigneeLane(m, row.laneKey))
                  .map((m) => m.taskId),
              ]).size;

              const overflowByDay = new Map<number, CalendarChipData[]>();
              weekChips.forEach((chip, idx) => {
                const lane = laneMap.get(idx) ?? 0;
                if (lane >= maxLanes) {
                  const dayOffset = chip.chipStartOffset;
                  const list = overflowByDay.get(dayOffset) ?? [];
                  list.push(chip);
                  overflowByDay.set(dayOffset, list);
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
                : MONTH_ROW_MIN_HEIGHT_PX;

              return (
                <div
                  key={row.key}
                  role="row"
                  aria-rowindex={weekIdx + 2}
                  className={`relative grid ${gridColsClass} ${isWeek && !grouped ? 'flex-1' : ''}`}
                  style={{ minHeight: rowMinHeight }}
                >
                  {row.laneLabel !== null && (
                    <div
                      role="rowheader"
                      aria-colindex={1}
                      className="border-r border-neutral-border bg-neutral-surface-sunken p-2 min-w-0"
                    >
                      <div
                        className="text-xs font-semibold text-neutral-text-primary truncate"
                        title={row.laneLabel}
                      >
                        {row.laneLabel}
                      </div>
                      <div className="text-xs text-neutral-text-secondary">
                        {laneTaskCount} {laneTaskCount === 1 ? 'task' : 'tasks'}
                      </div>
                    </div>
                  )}
                  {days.map((day, dayIdx) => {
                    const iso = formatISODate(day);
                    const cellKey = cellKeyOf(row, iso);
                    const isToday = formatISODate(day) === todayIso;
                    // Every day a week row renders is inside the window, so the
                    // out-of-month graying is a month-mode concept only.
                    const isCurrentMonth = isWeek || day.getUTCMonth() === currentMonth;
                    const dayOffset = Math.round((day.getTime() - ws.getTime()) / 86_400_000);
                    const hiddenChips = overflowByDay.get(dayOffset) ?? [];
                    const dayMarks = (marksByWeekDay.get(`${wsIso}:${dayOffset}`) ?? []).filter(
                      (m) => row.laneKey === null || inAssigneeLane(m, row.laneKey),
                    );
                    const isSprintBoundary = sprintBoundaries?.has(iso) ?? false;
                    const availability = resolveDayAvailability(iso, workingTime);
                    const onFill = availability.kind !== 'working';

                    return (
                      <div
                        key={cellKey}
                        ref={(el) => {
                          if (el) cellRefs.current.set(cellKey, el);
                          return () => {
                            cellRefs.current.delete(cellKey);
                          };
                        }}
                        role="gridcell"
                        aria-colindex={dayIdx + firstDayCol}
                        aria-label={
                          dayCellName(formatDayCellLabel(day), isToday, availability) +
                          (row.laneLabel ? `, ${row.laneLabel}` : '')
                        }
                        tabIndex={cellKey === activeIso ? 0 : -1}
                        onKeyDown={(e) => handleCellKeyDown(e, cellKey)}
                        onFocus={(e) => handleCellFocus(e, cellKey)}
                        className={`
                          relative border-r last:border-r-0 border-neutral-border p-1
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
                          focus-visible:ring-brand-primary
                          ${isToday ? 'bg-brand-primary/5' : ''}
                          ${!isCurrentMonth ? 'bg-neutral-surface-sunken' : ''}
                        `}
                        style={{
                          minHeight: rowMinHeight,
                          ...dayFillStyle(availability, isToday, isCurrentMonth),
                        }}
                      >
                        {/* The non-working mute is a solid text token on the date number
                            only — never `opacity` on the cell or its marks.
                            Opacity composites whatever sits underneath, so
                            `opacity-60` over the primary ink landed at 4.02:1
                            (WCAG 1.4.3) and would dim a Saturday-starting bar
                            but not an identical Monday-starting one. Milestone
                            marks and "+N more" stay full strength on these days. */}
                        <div>
                          {/* Day number — aria-hidden because the cell's own
                              label already states the full date; without this
                              the number is read a second time, bare. */}
                          <div className="flex pr-2">
                            <div
                              className={`flex items-center gap-1 min-w-0 ${
                                onFill ? ON_FILL_BACKING : ''
                              } ${availability.kind === 'exception' ? 'pr-1' : ''}`}
                            >
                              <span
                                aria-hidden="true"
                                className={`
                                block flex-shrink-0 tppm-mono text-xs font-medium leading-5 w-5 text-center rounded-full
                                ${
                                  isToday
                                    ? 'bg-sage-500 text-navy-900 font-semibold'
                                    : !isCurrentMonth
                                      ? 'text-neutral-text-disabled'
                                      : availability.kind !== 'working'
                                        ? 'text-neutral-text-secondary font-normal'
                                        : 'text-neutral-text-primary'
                                }
                              `}
                              >
                                {day.getUTCDate()}
                              </span>

                              {/* Inherits the fill's own contrast-checked ink. Shares
                                the date line so it never moves the chip lanes. */}
                              {availability.kind === 'exception' && (
                                <span
                                  aria-hidden="true"
                                  title={availability.name}
                                  className="min-w-0 truncate text-xs font-medium leading-5"
                                >
                                  {availability.name}
                                </span>
                              )}
                            </div>
                          </div>

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
                              onFill={onFill}
                              onTaskClick={onTaskClick}
                            />
                          ))}

                          {hiddenChips.length > 0 && (
                            <DayOverflowButton
                              hidden={hiddenChips}
                              dayLabel={formatDayCellLabel(day)}
                              onTaskClick={onTaskClick}
                              className={onFill ? `${ON_FILL_BACKING} px-0.5` : ''}
                            />
                          )}
                        </div>

                        {availability.kind !== 'working' && availability.calendars.length > 1 && (
                          <span
                            aria-hidden="true"
                            data-cal-multi-source=""
                            className="pointer-events-none absolute bottom-0 right-0 h-0 w-0 border-b-[7px] border-l-[7px] border-b-current border-l-transparent"
                          />
                        )}

                        {/* Task chips starting on this day */}
                        <DayChips
                          chips={chipsByDay.get(dayOffset) ?? []}
                          weekStartIso={wsIso}
                          onTaskClick={onTaskClick}
                          // Row 0 in month mode: a task that began before the grid would otherwise be nameless.
                          labelContinuation={isWeek || weekIdx === 0}
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
            <p className={`text-sm text-neutral-text-secondary ${ON_FILL_BACKING} px-2`}>
              No tasks in {formatWindowNoun(anchor, calView, weekStartDay)}.
            </p>
          </div>
        )}
      </div>

      {/* Legend */}
      <CalendarLegend showWorkingTime workingTimeIncomplete={workingTimeIncomplete} />
    </div>
  );
}
