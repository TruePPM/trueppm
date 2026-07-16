/**
 * Dialog-local segmented radiogroup for the schedule-export options (issue 1438).
 *
 * Hand-rolled per web-rule 179 (no shared SegmentedControl exists): `role="radio"`
 * buttons in a `role="radiogroup"`, roving tabindex, arrow/Home/End navigation
 * bound to the focusable radios, selection commits on move, and an active FILL
 * (`bg-brand-primary text-neutral-text-inverse`) that contrasts the sunken track —
 * never shade-only. One option may be `disabled` (Layout B until #1439) using the
 * rule-122 placeholder recipe (dimmed inert, not opacity-50).
 */
import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  /** Inert placeholder (e.g. Layout B until #1439). */
  disabled?: boolean;
  /** Hover/AT hint, e.g. "Available soon — 3-page report (#1439)". */
  title?: string;
  /** id of an element describing the option (the disabled hint text). */
  describedById?: string;
}

interface ExportSegmentedFieldProps<V extends string> {
  /** Visible group label (mono uppercase) + accessible name for the radiogroup. */
  legend: string;
  name: string;
  options: SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
}

export function ExportSegmentedField<V extends string>({
  legend,
  name,
  options,
  value,
  onChange,
}: ExportSegmentedFieldProps<V>) {
  const legendId = `seg-${name}-legend`;
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Indices of the selectable (enabled) options, for wrap-around arrow nav.
  const enabledIdx = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  function moveTo(targetIdx: number) {
    const opt = options[targetIdx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    btnRefs.current[targetIdx]?.focus();
  }

  function onKeyDown(e: ReactKeyboardEvent, currentIdx: number) {
    const pos = enabledIdx.indexOf(currentIdx);
    if (pos < 0 || enabledIdx.length === 0) return;
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = enabledIdx[(pos + 1) % enabledIdx.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = enabledIdx[(pos - 1 + enabledIdx.length) % enabledIdx.length];
        break;
      case 'Home':
        next = enabledIdx[0];
        break;
      case 'End':
        next = enabledIdx[enabledIdx.length - 1];
        break;
      default:
        return;
    }
    e.preventDefault();
    moveTo(next);
  }

  // The roving tab stop is the selected option; if it is somehow disabled, fall
  // back to the first enabled option so the group is always reachable by Tab.
  const selectedIdx = options.findIndex((o) => o.value === value && !o.disabled);
  const tabStop = selectedIdx >= 0 ? selectedIdx : (enabledIdx[0] ?? -1);

  return (
    <div>
      <span
        id={legendId}
        className="mb-1 block text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary"
      >
        {legend}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={legendId}
        className="inline-flex rounded-control border border-neutral-border bg-neutral-surface-sunken p-0.5"
      >
        {options.map((opt, i) => {
          const selected = opt.value === value;
          return (
            <button
              key={opt.value}
              ref={(el) => {
                btnRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={opt.disabled || undefined}
              disabled={opt.disabled}
              title={opt.title}
              aria-describedby={opt.describedById}
              tabIndex={i === tabStop ? 0 : -1}
              onClick={() => !opt.disabled && onChange(opt.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={[
                'rounded-[5px] px-3 py-2 text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface',
                selected
                  ? 'bg-brand-primary text-neutral-text-inverse'
                  : opt.disabled
                    ? 'cursor-not-allowed text-neutral-text-disabled'
                    : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised',
              ].join(' ')}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
