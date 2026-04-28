import { useScheduleStore } from '@/stores/scheduleStore';
import type { ZoomLevel } from '@/types';

const LEVELS: { value: ZoomLevel; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
];

export function ZoomControl() {
  const zoomLevel = useScheduleStore((s) => s.zoomLevel);
  const setZoomLevel = useScheduleStore((s) => s.setZoomLevel);

  return (
    <div
      role="group"
      aria-label="Timeline zoom"
      className="flex items-center rounded border border-neutral-border overflow-hidden"
    >
      {LEVELS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => setZoomLevel(value)}
          aria-pressed={zoomLevel === value}
          className={[
            'px-3 h-7 text-xs font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
            zoomLevel === value
              ? 'bg-brand-primary text-neutral-text-inverse'
              : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised',
          ].join(' ')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
