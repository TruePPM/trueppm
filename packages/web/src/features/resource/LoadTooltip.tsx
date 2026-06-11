/**
 * Tooltip shown on cell hover when load > 0. Rule 99.
 * Shows total hours, capacity, percentage, and the list of contributing task UUIDs.
 *
 * Note: task UUIDs are shown until the tasks API is wired in for name resolution.
 */
import { useEffect, useRef } from 'react';
import { LOAD_TEXT_CLASS, capacityHours } from './resourceUtils';
import type { LoadColor } from './resourceUtils';

interface Props {
  iso: string;
  hours: number;
  taskIds: string[];
  hoursPerDay: number;
  maxUnits: number;
  /** Server-owned per-day load% and band (#989) — rendered, not re-derived. */
  loadPct: number;
  loadBand: LoadColor;
  /** Called when the tooltip should close (Escape key or pointer-leave). */
  onClose: () => void;
}

export function LoadTooltip({
  iso,
  hours,
  taskIds,
  hoursPerDay,
  maxUnits,
  loadPct,
  loadBand,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Capacity is still derived locally for the "X h / Y h" breakdown display; the
  // percentage and band come from the server so the verdict can't drift (#989).
  const capacity = capacityHours(hoursPerDay, maxUnits);
  const pct = loadPct;
  const color = loadBand;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="tooltip"
      className="
        absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2
        bg-neutral-text-primary text-neutral-surface rounded border border-neutral-text-primary
        text-xs px-3 py-2 min-w-[160px] whitespace-nowrap
        pointer-events-none
      "
    >
      <div className="font-medium mb-1">{iso}</div>
      <div className={`font-semibold ${LOAD_TEXT_CLASS[color]} mb-1`}>
        {hours.toFixed(1)} h / {capacity.toFixed(1)} h ({Math.round(pct)}%)
      </div>
      {taskIds.length > 0 && (
        <ul className="list-disc list-inside space-y-0.5 text-neutral-surface/80">
          {taskIds.map((id) => (
            <li key={id} className="truncate max-w-[200px]">
              {id}
            </li>
          ))}
        </ul>
      )}
      {/* Caret */}
      <div
        className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0
          border-l-4 border-r-4 border-t-4
          border-l-transparent border-r-transparent border-t-neutral-text-primary"
        aria-hidden="true"
      />
    </div>
  );
}
