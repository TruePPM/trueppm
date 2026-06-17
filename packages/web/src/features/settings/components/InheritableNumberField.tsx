import { useId } from 'react';

export interface InheritableNumberFieldProps {
  /** The scope's own override. `null` = inherit from the parent scope. */
  value: number | null;
  /** Emits the new override: a number to override, or `null` to inherit. */
  onChange: (next: number | null) => void;
  /** Value the scope WOULD inherit if its own override were cleared (the parent's
   *  resolved value — server `inherited_*`). Drives the "Inherit (N)" chip suffix
   *  and the inheriting body line. */
  inherited: number;
  /** Human description of the inheritance source, e.g. "the workspace default". */
  inheritFromLabel: string;
  /** Inclusive clamp bounds for the override input. */
  min: number;
  max: number;
  /** Accessible name for BOTH the radiogroup and the number input, e.g.
   *  "Run history retention". Required. */
  ariaLabel: string;
  /** Owner/Admin (role >= ADMIN). When false the control is a read-only
   *  inherited/override indicator — no radios, no input (ADR-0133). */
  canEdit: boolean;
  /** Optional hint shown under the override input, e.g. "Maximum 500.". */
  overrideHint?: string;
  /** Noun for the read-only "set on this {scopeNoun}" line. */
  scopeNoun?: string;
}

const chipClass = (selected: boolean) =>
  [
    'px-3 py-1 rounded border text-[12px] font-medium transition-colors cursor-pointer',
    'has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-primary has-[:focus-visible]:ring-offset-1',
    selected
      ? 'border-2 border-brand-primary bg-brand-primary-light text-brand-primary'
      : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
    'has-[:disabled]:cursor-not-allowed has-[:disabled]:border-neutral-border/55',
    'has-[:disabled]:bg-neutral-surface-sunken has-[:disabled]:text-neutral-text-secondary',
  ].join(' ');

/** Clamp a raw input value into the inclusive [min, max] range. */
function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Inheritable integer control for a scope that can INHERIT or OVERRIDE (ADR-0144).
 *
 * The numeric analog of {@link InheritableToggleField}: an inherit/override radio
 * pair wrapping a clamped number input. "Inherit (N)" emits `null`; "Override"
 * reveals the input seeded from the currently-effective value and emits a clamped
 * number. The input clamps to [min, max] on change so the UI can never submit an
 * out-of-range cap (the server clamps independently). Below role >= ADMIN it
 * collapses to a read-only indicator.
 */
export function InheritableNumberField({
  value,
  onChange,
  inherited,
  inheritFromLabel,
  min,
  max,
  ariaLabel,
  canEdit,
  overrideHint,
  scopeNoun = 'scope',
}: InheritableNumberFieldProps) {
  const radioName = useId();
  const inheriting = value === null;
  const effective = value ?? inherited;

  if (!canEdit) {
    const provenance = inheriting
      ? `inherited from ${inheritFromLabel}`
      : `set on this ${scopeNoun}`;
    return (
      <div
        className="flex items-center gap-2 text-[13px]"
        aria-label={`${ariaLabel}: ${effective}, ${provenance}. View only.`}
      >
        <span className="font-medium text-neutral-text-primary" aria-hidden="true">
          {effective}
        </span>
        <span className="text-neutral-text-secondary" aria-hidden="true">
          · {provenance}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-2">
        <label className={chipClass(inheriting)}>
          <input
            type="radio"
            name={radioName}
            className="sr-only"
            checked={inheriting}
            onChange={() => onChange(null)}
          />
          Inherit
          <span className="font-normal opacity-80"> ({inherited})</span>
        </label>
        <label className={chipClass(!inheriting)}>
          <input
            type="radio"
            name={radioName}
            className="sr-only"
            checked={!inheriting}
            // Seed the override from the currently-effective value so the input
            // opens reflecting reality rather than jumping to a default.
            onChange={() => onChange(clamp(value ?? inherited, min, max))}
          />
          Override
        </label>
      </div>

      {inheriting ? (
        <p className="text-[12px] text-neutral-text-secondary">
          Using {inheritFromLabel}:{' '}
          <span className="font-medium text-neutral-text-primary">{inherited}</span>.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <input
            type="number"
            min={min}
            max={max}
            value={value ?? min}
            aria-label={ariaLabel}
            onChange={(e) => onChange(clamp(e.target.valueAsNumber, min, max))}
            className="w-[120px] h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary"
          />
          {overrideHint && (
            <span className="text-[12px] text-neutral-text-secondary">{overrideHint}</span>
          )}
        </div>
      )}
    </div>
  );
}
