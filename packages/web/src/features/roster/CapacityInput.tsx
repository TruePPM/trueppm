/**
 * Shared capacity input for ProjectResource (units_override) and Resource (max_units).
 *
 * Persists the user's preferred display unit (%FTE vs hours/day) in localStorage so
 * it survives navigation. Both modes write the same decimal max_units field.
 */
import { useState, useId } from 'react';

const STORAGE_KEY = 'trueppm.capacityUnit';

type Unit = 'percent' | 'hours';

function loadUnit(): Unit {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'percent' || stored === 'hours') return stored;
  } catch {
    // ignore
  }
  return 'percent';
}

function saveUnit(unit: Unit) {
  try {
    localStorage.setItem(STORAGE_KEY, unit);
  } catch {
    // ignore
  }
}

export interface CapacityInputProps {
  /** Decimal fraction (1.0 = 100% FTE = full capacity). */
  value: number;
  onChange: (value: number) => void;
  /** Hours per working day from the resource's effective calendar. Used for conversion. */
  calendarHoursPerDay?: number;
  /** When defined, the value is a project-level override and a chip is shown. */
  isOverride?: boolean;
  label?: string;
  disabled?: boolean;
}

export function CapacityInput({
  value,
  onChange,
  calendarHoursPerDay = 8,
  isOverride = false,
  label = 'Capacity',
  disabled = false,
}: CapacityInputProps) {
  const [unit, setUnit] = useState<Unit>(loadUnit);
  const groupId = useId();
  const pctId = useId();
  const hoursId = useId();
  const inputId = useId();

  // Derived display value — what we show in the input field.
  const displayValue = unit === 'percent' ? Math.round(value * 100) : value * calendarHoursPerDay;

  // Conversion hint shown below the input.
  const hint =
    unit === 'percent'
      ? `${(value * calendarHoursPerDay).toFixed(1)}h/day on this calendar`
      : `${Math.round(value * 100)}% FTE`;

  function handleUnitChange(next: Unit) {
    setUnit(next);
    saveUnit(next);
  }

  function handleInputChange(raw: string) {
    const n = parseFloat(raw);
    if (isNaN(n)) return;
    const clamped =
      unit === 'percent'
        ? Math.min(200, Math.max(0, n))
        : Math.min(calendarHoursPerDay * 2, Math.max(0, n));
    const asDecimal = unit === 'percent' ? clamped / 100 : clamped / calendarHoursPerDay;
    onChange(asDecimal);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={inputId} className="text-sm font-medium text-neutral-text-primary">
          {label}
        </label>
        {isOverride && (
          <span className="text-xs px-1.5 py-0.5 rounded border border-brand-primary/40 text-brand-primary">
            Project override
          </span>
        )}
      </div>

      {/* Unit toggle */}
      <div
        role="tablist"
        aria-label="Capacity unit"
        id={groupId}
        className="flex rounded border border-neutral-border overflow-hidden w-fit"
      >
        <button
          role="tab"
          id={pctId}
          aria-selected={unit === 'percent'}
          type="button"
          disabled={disabled}
          onClick={() => handleUnitChange('percent')}
          className={[
            'min-h-[44px] px-3 text-xs font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            unit === 'percent'
              ? 'bg-brand-primary text-neutral-text-inverse'
              : 'bg-neutral-surface text-neutral-text-secondary hover:text-neutral-text-primary',
          ].join(' ')}
        >
          % FTE
        </button>
        <button
          role="tab"
          id={hoursId}
          aria-selected={unit === 'hours'}
          type="button"
          disabled={disabled}
          onClick={() => handleUnitChange('hours')}
          className={[
            'min-h-[44px] px-3 text-xs font-medium transition-colors border-l border-neutral-border',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            unit === 'hours'
              ? 'bg-brand-primary text-neutral-text-inverse'
              : 'bg-neutral-surface text-neutral-text-secondary hover:text-neutral-text-primary',
          ].join(' ')}
        >
          h/day
        </button>
      </div>

      {/* Numeric input */}
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="number"
          min={0}
          max={unit === 'percent' ? 200 : calendarHoursPerDay * 2}
          step={unit === 'percent' ? 5 : 0.5}
          value={displayValue}
          disabled={disabled}
          onChange={(e) => handleInputChange(e.target.value)}
          aria-describedby={`${groupId}-hint`}
          className={[
            'w-24 rounded border border-neutral-border px-3 py-2 text-sm text-neutral-text-primary',
            'bg-neutral-surface',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            disabled ? 'opacity-50 cursor-not-allowed' : '',
          ].join(' ')}
        />
        <span className="text-xs text-neutral-text-secondary">{unit === 'percent' ? '%' : 'h'}</span>
      </div>

      {/* Conversion hint */}
      <p id={`${groupId}-hint`} className="text-xs text-neutral-text-secondary">
        {hint}
      </p>
    </div>
  );
}
