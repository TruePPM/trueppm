import { useId } from 'react';
import { FOCUS_RING } from '@/components/page2/classes';

export interface StepperProps {
  /** What is being stepped, e.g. "Allocation". Names the group and both buttons. */
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Printed after the number. */
  unit?: string;
  disabled?: boolean;
}

const BUTTON = `inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-p1-hairline bg-p1-surface-1 text-lg text-p1-text-1 hover:bg-p1-surface-2 aria-disabled:cursor-default aria-disabled:text-p1-text-3 aria-disabled:hover:bg-p1-surface-1 ${FOCUS_RING}`;

/**
 * Pass 3 stepper (#4802): minus, value, plus, with 44px buttons and a percent
 * value by default. A button at its bound takes `aria-disabled`, not `disabled`:
 * the press that reaches the bound would otherwise remove the focused control and
 * drop keyboard focus on the page.
 */
export function Stepper({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 5,
  unit = '%',
  disabled,
}: StepperProps) {
  const labelId = useId();
  const atMin = disabled || value <= min;
  const atMax = disabled || value >= max;
  const set = (next: number) => onChange(Math.min(max, Math.max(min, next)));
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1">
      <span id={labelId} className="text-xs text-p1-text-2">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={BUTTON}
          aria-label={`Decrease ${label}`}
          aria-disabled={atMin || undefined}
          onClick={() => !atMin && set(value - step)}
        >
          <span aria-hidden="true">−</span>
        </button>
        <output
          aria-live="polite"
          className="min-w-[4rem] text-center font-mono text-sm tabular-nums text-p1-text-1"
        >
          {value}
          {unit}
        </output>
        <button
          type="button"
          className={BUTTON}
          aria-label={`Increase ${label}`}
          aria-disabled={atMax || undefined}
          onClick={() => !atMax && set(value + step)}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
    </div>
  );
}
