/**
 * CalendarGrid — month grid with chip-fragment overlays.
 *
 * Layout strategy:
 *   - 7-column CSS grid for day cells (date numbers, today tint, weekend mute)
 *   - Per-week chip overlay: position:absolute chips over the row, sized by %
 *     so no ResizeObserver is needed
 *   - Lane assignment: greedy interval scheduling so non-overlapping chips
 *     share the same vertical lane; overlapping chips stack in separate lanes
 *   - MAX 4 chip lanes per row; overflow shows "+N more" in the cell corner
 *
 * Design rules applied (CLAUDE.md):
 *   - No drop shadows (rule 1) — border-neutral-border separation
 *   - Today cell: brand-primary/5 bg tint, brand-primary day number
 *   - text-xs floor (rule 50) — no text-[10px]
 *   - Focus rings (rule 4) on all chip buttons
 */

import type { Task } from '@/types';
import {
  parseUTCDate,
  monthWeekStarts,
  weekDays,
  formatISODate,
  isSameDay,
  buildChips,
  type CalendarChipData,
} from './calendarUtils';
import { CalendarChip } from './CalendarChip';

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_LANES = 4;
const LANE_HEIGHT_PX = 22; // chip height (18px) + 4px gap
const DATE_NUMBER_HEIGHT_PX = 20;
const CELL_MIN_HEIGHT_PX = DATE_NUMBER_HEIGHT_PX + MAX_LANES * LANE_HEIGHT_PX + 8;

/**
 * Assign each chip a vertical lane using greedy interval scheduling.
 * Returns a Map<chip index → lane number (0-based)>.
 */
function assignLanes(chips: CalendarChipData[]): Map<number, number> {
  // Sort by start offset
  const sorted = chips.map((c, i) => ({ c, i })).sort((a, b) => a.c.chipStartOffset - b.c.chipStartOffset);
  const laneEnd: number[] = []; // laneEnd[lane] = chipEnd offset of last chip in that lane
  const result = new Map<number, number>();

  for (const { c, i } of sorted) {
    const chipEnd = c.chipStartOffset + c.chipDays - 1;
    // Find the first lane where this chip fits (no overlap)
    let assigned = -1;
    for (let lane = 0; lane < laneEnd.length; lane++) {
      if (laneEnd[lane] < c.chipStartOffset) {
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
  const currentMonth = anchor.getUTCMonth();

  // Group chips by weekStart ISO
  const chipsByWeek = new Map<string, CalendarChipData[]>();
  for (const chip of allChips) {
    const list = chipsByWeek.get(chip.weekStart) ?? [];
    list.push(chip);
    chipsByWeek.set(chip.weekStart, list);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Day-of-week header */}
      <div className="grid grid-cols-7 border-b border-neutral-border flex-shrink-0">
        {DAY_HEADERS.map((d) => (
          <div
            key={d}
            className="py-1.5 text-center text-xs font-medium text-neutral-text-secondary
              border-r last:border-r-0 border-neutral-border"
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

          // Count overflow chips (lane >= MAX_LANES)
          // Group overflow by day so "+N more" appears in the correct cell
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
            <div
              key={wsIso}
              className="relative"
              style={{ minHeight: CELL_MIN_HEIGHT_PX }}
            >
              {/* Day cells grid — date numbers, today tint */}
              <div className="grid grid-cols-7 h-full">
                {days.map((day) => {
                  const iso = formatISODate(day);
                  const isToday = isSameDay(day, today);
                  const isCurrentMonth = day.getUTCMonth() === currentMonth;
                  const dayOffset = Math.round(
                    (day.getTime() - ws.getTime()) / 86_400_000,
                  );
                  const overflow = overflowByDay.get(dayOffset) ?? 0;

                  return (
                    <div
                      key={iso}
                      className={`
                        relative border-r last:border-r-0 border-neutral-border p-1
                        ${isToday ? 'bg-brand-primary/5' : ''}
                      `}
                      style={{ minHeight: CELL_MIN_HEIGHT_PX }}
                    >
                      <span
                        className={`
                          block text-xs font-medium leading-5 w-5 text-center rounded-full
                          ${isToday
                            ? 'bg-brand-primary text-white'
                            : isCurrentMonth
                              ? 'text-neutral-text-primary'
                              : 'text-neutral-text-disabled'
                          }
                        `}
                      >
                        {day.getUTCDate()}
                      </span>

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
                  // Percentage-based left/width so no ResizeObserver needed
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
    </div>
  );
}
