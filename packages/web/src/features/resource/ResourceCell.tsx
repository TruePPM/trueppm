/**
 * Single day cell in the resource grid. Renders a load % bar (rule 91).
 * 32px wide (rule 97). Weekends at 50% opacity (rule 97).
 *
 * Overallocated cells (pct > 100) render as an accessible <button> so the
 * user can activate the ResourceOverallocationDrawer (rule 89) via click or
 * keyboard (Enter/Space).
 */
import { useState } from 'react';
import { loadPercent, loadColor, LOAD_BAR_CLASS, capacityHours, isWeekend } from './resourceUtils';
import { LoadTooltip } from './LoadTooltip';
import type { UtilizationDayEntry } from './resourceUtils';
import type { OverallocationTarget } from './ResourceOverallocationDrawer';

interface Props {
  iso: string;
  entry: UtilizationDayEntry | undefined;
  hoursPerDay: number;
  maxUnits: number;
  tooltipId: string;
  resourceId: string;
  resourceName: string;
  onOpenDrawer?: (target: OverallocationTarget) => void;
}

export function ResourceCell({
  iso,
  entry,
  hoursPerDay,
  maxUnits,
  tooltipId,
  resourceId,
  resourceName,
  onOpenDrawer,
}: Props) {
  const [showTooltip, setShowTooltip] = useState(false);
  const weekend = isWeekend(iso);
  const hours = entry?.hours ?? 0;
  const capacity = capacityHours(hoursPerDay, maxUnits);
  const pct = loadPercent(hours, capacity);
  const color = loadColor(pct);
  const barHeight = Math.min(pct, 120); // cap visual bar at 120% to stay in bounds

  const isOverallocated = pct > 100 && !!onOpenDrawer && !!entry;

  const barContent = (
    <>
      {hours > 0 && (
        <div
          className={`w-4 rounded-sm ${LOAD_BAR_CLASS[color]} opacity-90`}
          style={{ height: `${(barHeight / 120) * 24}px` }}
          aria-label={isOverallocated ? undefined : `${Math.round(pct)}% load on ${iso}`}
        />
      )}

      {showTooltip && entry && !isOverallocated && (
        <LoadTooltip
          iso={iso}
          hours={hours}
          taskIds={entry.tasks}
          hoursPerDay={hoursPerDay}
          maxUnits={maxUnits}
          onClose={() => setShowTooltip(false)}
        />
      )}
    </>
  );

  const cellClass = `
    relative flex-none w-8 h-8 border-r border-neutral-border/50
    flex items-end justify-center pb-0.5
    ${weekend ? 'opacity-50' : ''}
  `;

  if (isOverallocated) {
    return (
      <button
        type="button"
        className={`
          ${cellClass}
          cursor-pointer
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-inset
        `}
        aria-label={`${Math.round(pct)}% load on ${iso} — overallocated. Press Enter to view details.`}
        aria-describedby={tooltipId}
        onClick={() =>
          onOpenDrawer({
            resourceId,
            resourceName,
            iso,
            entry,
            hoursPerDay,
            maxUnits,
          })
        }
      >
        {barContent}
      </button>
    );
  }

  // Loaded non-overallocated cells expose hover tooltip via keyboard too (WCAG 2.1.1).
  // tabIndex and onKeyDown make the cell focusable and activatable with Enter/Space.
  const hasLoad = hours > 0;
  return (
    <div
      className={`
        ${cellClass}
        ${hasLoad ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset' : ''}
      `}
      tabIndex={hasLoad ? 0 : undefined}
      role={hasLoad ? 'button' : undefined}
      aria-label={hasLoad ? `${Math.round(pct)}% load on ${iso}` : undefined}
      aria-describedby={hasLoad ? tooltipId : undefined}
      onMouseEnter={() => hasLoad && setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onFocus={() => hasLoad && setShowTooltip(true)}
      onBlur={() => setShowTooltip(false)}
      onKeyDown={(e) => {
        if (hasLoad && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          setShowTooltip((v) => !v);
        }
      }}
    >
      {barContent}
    </div>
  );
}
