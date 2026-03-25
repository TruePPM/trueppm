/**
 * One resource row in the grid: sticky name column + day cells for the date window.
 */
import { CalendarMismatchTooltip } from './CalendarMismatchTooltip';
import { ResourceCell } from './ResourceCell';
import type { UtilizationResource } from './resourceUtils';

interface Props {
  resource: UtilizationResource;
  days: string[]; // ordered ISO date strings for the visible window
  rowIndex: number;
}

export function ResourceRow({ resource, days, rowIndex }: Props) {
  const isEvenRow = rowIndex % 2 === 0;

  return (
    <div
      className={`flex items-stretch border-b border-neutral-border/50 ${
        isEvenRow ? '' : 'bg-neutral-surface-sunken/30'
      }`}
    >
      {/* Sticky resource name column — 160px */}
      <div
        className="
          sticky left-0 z-10 flex-none w-40 h-8
          flex items-center px-3
          border-r border-neutral-border
          bg-neutral-surface text-xs font-medium text-neutral-text-primary
          truncate
        "
        style={{ background: isEvenRow ? undefined : 'var(--color-neutral-surface-sunken, #f5f5f0)' }}
        title={resource.resource_name}
      >
        <span className="truncate">{resource.resource_name}</span>
        {resource.calendar_differs_from_project && <CalendarMismatchTooltip />}
      </div>

      {/* Day cells */}
      {days.map((iso) => (
        <ResourceCell
          key={iso}
          iso={iso}
          entry={resource.days[iso]}
          hoursPerDay={resource.hours_per_day}
          maxUnits={parseFloat(resource.max_units)}
          tooltipId={`tooltip-${resource.resource_id}-${iso}`}
        />
      ))}
    </div>
  );
}
