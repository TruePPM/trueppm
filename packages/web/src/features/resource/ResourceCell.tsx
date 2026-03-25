/**
 * Single day cell in the resource grid. Renders a load % bar (rule 91).
 * 32px wide (rule 97). Weekends at 50% opacity (rule 97).
 */
import { useState } from 'react';
import { loadPercent, loadColor, LOAD_BAR_CLASS, capacityHours, isWeekend } from './resourceUtils';
import { LoadTooltip } from './LoadTooltip';
import type { UtilizationDayEntry } from './resourceUtils';

interface Props {
  iso: string;
  entry: UtilizationDayEntry | undefined;
  hoursPerDay: number;
  maxUnits: number;
  tooltipId: string;
}

export function ResourceCell({ iso, entry, hoursPerDay, maxUnits, tooltipId }: Props) {
  const [showTooltip, setShowTooltip] = useState(false);
  const weekend = isWeekend(iso);
  const hours = entry?.hours ?? 0;
  const capacity = capacityHours(hoursPerDay, maxUnits);
  const pct = loadPercent(hours, capacity);
  const color = loadColor(pct);
  const barHeight = Math.min(pct, 120); // cap visual bar at 120% to stay in bounds

  return (
    <div
      className={`
        relative flex-none w-8 h-8 border-r border-neutral-border/50
        flex items-end justify-center pb-0.5
        ${weekend ? 'opacity-50' : ''}
        ${hours > 0 ? 'cursor-pointer' : ''}
      `}
      onMouseEnter={() => hours > 0 && setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      aria-describedby={hours > 0 ? tooltipId : undefined}
    >
      {hours > 0 && (
        <div
          className={`w-4 rounded-sm ${LOAD_BAR_CLASS[color]} opacity-90`}
          style={{ height: `${(barHeight / 120) * 24}px` }}
          aria-label={`${Math.round(pct)}% load on ${iso}`}
        />
      )}

      {showTooltip && entry && (
        <LoadTooltip
          iso={iso}
          hours={hours}
          taskIds={entry.tasks}
          hoursPerDay={hoursPerDay}
          maxUnits={maxUnits}
          onClose={() => setShowTooltip(false)}
        />
      )}
    </div>
  );
}
