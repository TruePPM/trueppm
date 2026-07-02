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
  monthWeekStarts,
  weekDays,
  formatISODate,
  isSameDay,
  buildChips,
  buildMilestoneMarks,
  type CalendarChipData,
  type MilestoneMark,
} from './calendarUtils';
import { CalendarChip } from './CalendarChip';

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
  const sorted = chips.map((c, i) => ({ c, i })).sort((a, b) => a.c.chipStartOffset - b.c.chipStartOffset);
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
  return <span className={`inline-block w-4 h-2 rounded-chip flex-shrink-0 ${className}`} aria-hidden="true" />;
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
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="flex-shrink-0 text-brand-accent fill-current">
          <polygon points="5,0 10,5 5,10 0,5" />
        </svg>
        Milestone
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main grid
// ---------------------------------------------------------------------------

interface CalendarGridProps {
  anchorIso: string;
  tasks: Task[];
  onTaskClick: (taskId: string) => void;
}

export function CalendarGrid({ anchorIso, tasks, onTaskClick }: CalendarGridProps) {
  const anchor = parseUTCDate(anchorIso);
  const today = new Date();
  const weeks = monthWeekStarts(anchor);
  const allChips = buildChips(tasks, anchor);
  const allMarks = buildMilestoneMarks(tasks, anchor);
  const currentMonth = anchor.getUTCMonth();

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
    <div className="flex flex-col h-full overflow-hidden">
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
      <div className="flex-1 overflow-y-auto divide-y divide-neutral-border">
        {weeks.map((ws) => {
          const wsIso = formatISODate(ws);
          const days = weekDays(ws);
          const weekChips = chipsByWeek.get(wsIso) ?? [];
          const laneMap = assignLanes(weekChips);

          const overflowByDay = new Map<number, number>();
          weekChips.forEach((chip, idx) => {
            const lane = laneMap.get(idx) ?? 0;
            if (lane >= MAX_LANES) {
              const dayOffset = chip.chipStartOffset;
              overflowByDay.set(dayOffset, (overflowByDay.get(dayOffset) ?? 0) + 1);
            }
          });

          const visibleChips = weekChips.filter((_, idx) => (laneMap.get(idx) ?? 0) < MAX_LANES);

          return (
            <div key={wsIso} className="relative" style={{ minHeight: CELL_MIN_HEIGHT_PX }}>
              {/* Day cells grid */}
              <div className="grid grid-cols-7 h-full">
                {days.map((day, dayIdx) => {
                  const iso = formatISODate(day);
                  const isToday = isSameDay(day, today);
                  const isCurrentMonth = day.getUTCMonth() === currentMonth;
                  const dayOffset = Math.round((day.getTime() - ws.getTime()) / 86_400_000);
                  const overflow = overflowByDay.get(dayOffset) ?? 0;
                  const dayMarks = marksByWeekDay.get(`${wsIso}:${dayOffset}`) ?? [];

                  return (
                    <div
                      key={iso}
                      className={`
                        relative border-r last:border-r-0 border-neutral-border p-1
                        ${isToday ? 'bg-brand-primary/5' : ''}
                        ${!isCurrentMonth ? 'bg-neutral-surface-sunken' : ''}
                        ${dayIdx >= 5 ? 'opacity-60' : ''}
                      `}
                      style={{ minHeight: CELL_MIN_HEIGHT_PX }}
                    >
                      {/* Day number */}
                      <span
                        className={`
                          block tppm-mono text-xs font-medium leading-5 w-5 text-center rounded-full
                          ${isToday
                            ? 'bg-sage-500 text-navy-900 font-semibold'
                            : isCurrentMonth
                              ? 'text-neutral-text-primary'
                              : 'text-neutral-text-disabled'
                          }
                        `}
                      >
                        {day.getUTCDate()}
                      </span>

                      {/* Milestone diamonds in this day cell */}
                      {dayMarks.map((mark) => (
                        <button
                          key={mark.taskId}
                          type="button"
                          onClick={() => onTaskClick(mark.taskId)}
                          aria-label={`Milestone: ${mark.taskName}`}
                          title={mark.taskName}
                          className="flex items-center gap-1 mt-0.5 w-full text-left
                            focus-visible:outline-none focus-visible:ring-2
                            focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
                        >
                          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"
                            className="flex-shrink-0 text-brand-accent fill-current"
                          >
                            <polygon points="5,0 10,5 5,10 0,5" />
                          </svg>
                          <span className="text-xs text-brand-accent-dark truncate leading-tight">
                            {mark.taskName}
                          </span>
                        </button>
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

              {/* Chip overlay — absolutely positioned over the day cells */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ top: DATE_NUMBER_HEIGHT_PX }}
              >
                {visibleChips.map((chip, idx) => {
                  const lane = laneMap.get(idx) ?? 0;
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
