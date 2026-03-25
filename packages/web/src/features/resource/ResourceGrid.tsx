/**
 * The resource grid: sticky header row of week/day labels + scrollable body of resource rows.
 * CSS Grid layout, not canvas (rule 100). Row virtualization not required for initial
 * implementation (≤ 50 resources, rule 100).
 *
 * Layout:
 *   - First column (160px): resource names, sticky left
 *   - Remaining columns: 32px per day (rule 97)
 *   - Week header spans 7 days (224px per week)
 *   - Weekends rendered at 50% opacity (rule 97)
 */
import { ResourceRow } from './ResourceRow';
import {
  formatWeekHeader,
  formatDayCell,
  dateRange,
  groupByWeek,
  isWeekend,
  todayISO,
} from './resourceUtils';
import type { UtilizationResource } from './resourceUtils';

const NAME_COL_WIDTH = 160; // px
const DAY_COL_WIDTH = 32;   // px (rule 97)

interface Props {
  resources: UtilizationResource[];
  windowStart: string;
  windowEnd: string;
}

export function ResourceGrid({ resources, windowStart, windowEnd }: Props) {
  const days = dateRange(windowStart, windowEnd);
  const weeks = groupByWeek(days);
  const today = todayISO();

  return (
    <div className="overflow-auto h-full">
      {/* Header — sticky top */}
      <div className="sticky top-0 z-20 bg-neutral-surface border-b border-neutral-border">
        {/* Week header row */}
        <div className="flex">
          {/* Empty cell above resource name column */}
          <div
            className="sticky left-0 z-30 flex-none border-r border-neutral-border bg-neutral-surface"
            style={{ width: NAME_COL_WIDTH }}
          />
          {weeks.map(({ weekStart, days: weekDays }) => (
            <div
              key={weekStart}
              className="flex-none border-r border-neutral-border/50 px-1 flex items-center"
              style={{ width: weekDays.length * DAY_COL_WIDTH }}
            >
              <span className="text-[11px] font-medium text-neutral-text-secondary truncate">
                {formatWeekHeader(weekStart)}
              </span>
            </div>
          ))}
        </div>

        {/* Day header row */}
        <div className="flex border-t border-neutral-border/30">
          {/* Empty cell above resource name column */}
          <div
            className="sticky left-0 z-30 flex-none border-r border-neutral-border bg-neutral-surface"
            style={{ width: NAME_COL_WIDTH }}
          />
          {days.map((iso) => {
            const isToday = iso === today;
            const weekend = isWeekend(iso);
            return (
              <div
                key={iso}
                className={`
                  flex-none flex items-center justify-center h-5
                  border-r border-neutral-border/30 text-[10px]
                  ${weekend ? 'opacity-50' : ''}
                  ${isToday ? 'font-bold text-brand-primary' : 'text-neutral-text-secondary'}
                `}
                style={{ width: DAY_COL_WIDTH }}
              >
                {formatDayCell(iso)}
              </div>
            );
          })}
        </div>
      </div>

      {/* Body — resource rows */}
      <div>
        {resources.map((resource, idx) => (
          <ResourceRow
            key={resource.resource_id}
            resource={resource}
            days={days}
            rowIndex={idx}
          />
        ))}
      </div>
    </div>
  );
}
