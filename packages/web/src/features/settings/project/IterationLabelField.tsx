import { useEffect, useId, useRef, useState } from 'react';
import { iterationLabelForms } from '@/lib/iterationLabel';

/** Suggested container nouns offered as one-tap chips (ADR-0111, #862). */
const PRESETS = ['Sprint', 'Iteration', 'PI'] as const;
const MAX_LEN = 32;

export interface IterationLabelFieldProps {
  /** Current stored singular label (e.g. "Sprint"). */
  value: string;
  /** Emits the new singular label. Trimmed; never the empty string while a preset is active. */
  onChange: (next: string) => void;
}

/**
 * Settings control for the iteration-container label (ADR-0111, #862).
 *
 * A native radio group (Sprint / Iteration / PI / Custom…) — native `<input
 * type="radio">` rather than ARIA-role buttons, so the browser provides
 * arrow-key roving, a single tab stop, and correct `checked` semantics for free
 * (WCAG 4.1.2). The radios are visually hidden; the `<label>` is styled as a chip.
 * Choosing "Custom…" reveals a free-text input; a live preview shows the derived
 * singular + plural forms so the admin sees how their label pluralizes before saving.
 * Display-only — it never changes behavior, only the noun shown across iteration surfaces.
 *
 * State model: the chip selection is derived from `value` on each render (no
 * duplicated source of truth). The only local state is whether Custom mode is
 * *forced* open (so selecting "Custom…" while the stored value is still "Sprint"
 * reveals an empty input rather than snapping back to the Sprint chip).
 */
export function IterationLabelField({ value, onChange }: IterationLabelFieldProps) {
  const groupId = useId();
  const groupName = `${groupId}-iteration-label`;
  const previewId = `${groupId}-preview`;
  const errorId = `${groupId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);

  const matchesPreset = (PRESETS as readonly string[]).includes(value.trim());
  const [customForced, setCustomForced] = useState(!matchesPreset);
  const isCustom = customForced || !matchesPreset;

  // When the stored value changes to a preset out from under us (e.g. discard),
  // drop the forced-custom flag so the right chip lights up.
  useEffect(() => {
    if (matchesPreset) setCustomForced(false);
  }, [matchesPreset]);

  const selectPreset = (preset: string) => {
    setCustomForced(false);
    onChange(preset);
  };

  const selectCustom = () => {
    setCustomForced(true);
    // Reveal an empty input when coming from a preset; keep the value if already custom.
    if (matchesPreset) onChange('');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const forms = iterationLabelForms(value);
  const customEmpty = isCustom && value.trim().length === 0;

  const chipClass = (selected: boolean) =>
    [
      'px-3 py-1 rounded border text-[12px] font-medium transition-colors cursor-pointer',
      // Focus ring follows the (visually hidden) radio's focus state.
      'has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-primary has-[:focus-visible]:ring-offset-1',
      selected
        ? 'border-2 border-brand-primary bg-brand-primary-light text-brand-primary'
        : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
    ].join(' ');

  return (
    <fieldset className="flex flex-col gap-2.5 border-0 p-0 m-0">
      <legend className="sr-only">Iteration terminology</legend>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => {
          const selected = !isCustom && value.trim() === preset;
          return (
            <label key={preset} className={chipClass(selected)}>
              <input
                type="radio"
                name={groupName}
                className="sr-only"
                checked={selected}
                onChange={() => selectPreset(preset)}
              />
              {preset}
            </label>
          );
        })}
        <label className={chipClass(isCustom)}>
          <input
            type="radio"
            name={groupName}
            className="sr-only"
            checked={isCustom}
            onChange={selectCustom}
          />
          Custom…
        </label>
      </div>

      {isCustom && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={value}
              maxLength={MAX_LEN}
              onChange={(e) => onChange(e.target.value)}
              onBlur={(e) => onChange(e.target.value.trim())}
              aria-label="Custom iteration label"
              aria-invalid={customEmpty ? 'true' : undefined}
              aria-describedby={`${previewId}${customEmpty ? ` ${errorId}` : ''}`}
              placeholder="e.g. Cycle"
              className="w-[200px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
            <span className="text-[11px] text-neutral-text-secondary tabular-nums">
              {value.trim().length}/{MAX_LEN}
            </span>
          </div>
          {customEmpty && (
            <p id={errorId} className="text-[12px] text-semantic-critical">
              Enter a label or pick a preset.
            </p>
          )}
        </div>
      )}

      <p id={previewId} aria-live="polite" className="text-[12px] text-neutral-text-secondary">
        Preview:{' '}
        <span className="text-neutral-text-primary font-medium">{forms.singular} Goal</span>
        {' · '}
        <span className="text-neutral-text-primary font-medium">No {forms.lowerPlural} yet</span>
        {' · '}
        <span className="text-neutral-text-primary font-medium">Last 8 {forms.lowerPlural}</span>
      </p>
    </fieldset>
  );
}
