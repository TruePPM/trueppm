import { useId } from 'react';

export interface ReasonOption {
  value: string;
  label: string;
  /** One line under the label. */
  hint?: string;
}

export interface ReasonRadioGroupProps {
  /** The group's visible label, e.g. "Why did it move?". */
  legend: string;
  name: string;
  options: ReasonOption[];
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Pass 3 reason radio group (#4802): native radios in a fieldset (radiogroup
 * semantics and arrow keys for free), one 44px row per reason. Nothing is
 * preselected unless the caller passes a value.
 */
export function ReasonRadioGroup({
  legend,
  name,
  options,
  value,
  onChange,
  disabled,
}: ReasonRadioGroupProps) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-1" disabled={disabled}>
      <legend className="mb-2 text-xs text-p1-text-2">{legend}</legend>
      {options.map((o, i) => (
        <label
          key={o.value}
          className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-p1-hairline px-3 py-1 text-sm text-p1-text-1 has-[:checked]:border-p1-brand has-[:checked]:bg-p1-surface-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-p1-focus has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-p1-surface-1"
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            aria-labelledby={`${id}-${i}-label`}
            aria-describedby={o.hint ? `${id}-${i}-hint` : undefined}
            className="h-4 w-4 shrink-0 accent-[oklch(var(--p1-brand))] focus:outline-none"
          />
          <span className="flex min-w-0 flex-col">
            <span id={`${id}-${i}-label`}>{o.label}</span>
            {o.hint && (
              <span id={`${id}-${i}-hint`} className="text-xs text-p1-text-2">
                {o.hint}
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
