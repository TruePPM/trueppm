import { useId, useState } from 'react';

/**
 * Workspace fiscal-year-start picker (#756): four quarter-aligned preset chips
 * plus a Custom… chip that reveals a year-agnostic month + day picker for the
 * oddball starts (e.g. the UK tax year, April 6).
 *
 * Fully controlled by the `(month, day)` pair. Invalid combinations are made
 * unreachable rather than validated-then-blocked: the day dropdown only offers
 * days that exist in the chosen month, and switching month clamps an
 * out-of-range day down to the new month's maximum. The server enforces the
 * same matrix (the day is year-agnostic, so February caps at 28).
 */

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface Preset {
  readonly label: string;
  readonly month: number;
  readonly day: number;
}

const PRESETS: readonly Preset[] = [
  { label: 'Jan 1', month: 1, day: 1 },
  { label: 'Apr 1', month: 4, day: 1 },
  { label: 'Jul 1', month: 7, day: 1 },
  { label: 'Oct 1', month: 10, day: 1 },
];

/** Year-agnostic day ceiling: Feb caps at 28; 30-day months reject 31. */
export function maxFiscalDay(month: number): number {
  if (month === 2) return 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

const CHIP_BASE =
  'h-7 px-2.5 rounded text-[12px] font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';
const CHIP_ON = 'bg-brand-primary text-white border-brand-primary-dark';
const CHIP_OFF =
  'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border hover:border-neutral-text-disabled';

const SELECT_CLASS =
  'h-7 pl-2 pr-6 rounded border border-neutral-border bg-neutral-surface-raised text-[12px] text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.35rem_center] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary';
const SELECT_STYLE = {
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")",
};

interface FiscalYearStartFieldProps {
  month: number;
  day: number;
  onChange: (month: number, day: number) => void;
}

export function FiscalYearStartField({ month, day, onChange }: FiscalYearStartFieldProps) {
  const monthId = useId();
  const dayId = useId();

  const matchedPreset = PRESETS.find((p) => p.month === month && p.day === day);
  // Force the picker open when the user explicitly chooses Custom, even if the
  // current value happens to match a preset. It is always open when no preset
  // matches (the only way to see/edit an oddball value).
  const [forceCustom, setForceCustom] = useState(false);
  const showPicker = forceCustom || !matchedPreset;

  function selectPreset(p: Preset) {
    setForceCustom(false);
    onChange(p.month, p.day);
  }

  function changeMonth(nextMonth: number) {
    const clampedDay = Math.min(day, maxFiscalDay(nextMonth));
    onChange(nextMonth, clampedDay);
  }

  const dayCount = maxFiscalDay(month);

  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label="Fiscal year start" className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const on = !showPicker && matchedPreset === p;
          return (
            <button
              key={p.label}
              type="button"
              aria-pressed={on}
              onClick={() => selectPreset(p)}
              className={`${CHIP_BASE} ${on ? CHIP_ON : CHIP_OFF}`}
            >
              {p.label}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={showPicker}
          onClick={() => setForceCustom(true)}
          className={`${CHIP_BASE} ${showPicker ? CHIP_ON : CHIP_OFF}`}
        >
          Custom…
        </button>
      </div>

      {showPicker && (
        <div className="flex items-center gap-2">
          <label htmlFor={monthId} className="sr-only">
            Fiscal year start month
          </label>
          <select
            id={monthId}
            value={month}
            onChange={(e) => changeMonth(Number(e.target.value))}
            className={`${SELECT_CLASS} w-[120px]`}
            style={SELECT_STYLE}
          >
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </select>
          <label htmlFor={dayId} className="sr-only">
            Fiscal year start day
          </label>
          <select
            id={dayId}
            value={day}
            onChange={(e) => onChange(month, Number(e.target.value))}
            className={`${SELECT_CLASS} w-[64px]`}
            style={SELECT_STYLE}
          >
            {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
