import { useId } from 'react';

export interface InheritableSelectOption<T extends string> {
  value: T;
  label: string;
}

export interface InheritableSelectFieldProps<T extends string> {
  /** The scope's own override. `null` = inherit from the parent scope. */
  value: T | null;
  /** Emits the new override: a value to override, or `null` to inherit. */
  onChange: (next: T | null) => void;
  /** Value the scope WOULD inherit if its own override were cleared (the parent's
   *  resolved value — server `inherited_*`). Drives the "Inherit (label)" chip
   *  suffix and the inheriting body line. */
  inherited: T;
  /** The selectable options. */
  options: ReadonlyArray<InheritableSelectOption<T>>;
  /** Human description of the inheritance source, e.g. "the workspace default". */
  inheritFromLabel: string;
  /** Accessible name for BOTH the radiogroup and the select. Required. */
  ariaLabel: string;
  /** Owner/Admin (role >= ADMIN). When false the control is a read-only
   *  inherited/override indicator — no radios, no select (ADR-0133). */
  canEdit: boolean;
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

/**
 * Inheritable enum control for a scope that can INHERIT or OVERRIDE (ADR-0144).
 *
 * The select analog of {@link InheritableToggleField}: an inherit/override radio
 * pair wrapping a native `<select>`. "Inherit (label)" emits `null`; "Override"
 * reveals the picker seeded from the currently-effective value and emits the
 * chosen enum value. Below role >= ADMIN it collapses to a read-only indicator.
 */
export function InheritableSelectField<T extends string>({
  value,
  onChange,
  inherited,
  options,
  inheritFromLabel,
  ariaLabel,
  canEdit,
  scopeNoun = 'scope',
}: InheritableSelectFieldProps<T>) {
  const radioName = useId();
  const inheriting = value === null;
  const effective = value ?? inherited;
  const labelOf = (v: T) => options.find((o) => o.value === v)?.label ?? v;

  if (!canEdit) {
    const provenance = inheriting
      ? `inherited from ${inheritFromLabel}`
      : `set on this ${scopeNoun}`;
    return (
      <div
        className="flex items-center gap-2 text-[13px]"
        // Atomic, non-interactive readout (children aria-hidden, one composite
        // label) — `aria-label` is prohibited on a roleless div, so name it as a
        // single labeled graphic (WCAG 4.1.2, #2265).
        role="img"
        aria-label={`${ariaLabel}: ${labelOf(effective)}, ${provenance}. View only.`}
      >
        <span className="font-medium text-neutral-text-primary" aria-hidden="true">
          {labelOf(effective)}
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
          <span className="font-normal opacity-80"> ({labelOf(inherited)})</span>
        </label>
        <label className={chipClass(!inheriting)}>
          <input
            type="radio"
            name={radioName}
            className="sr-only"
            checked={!inheriting}
            // Seed the override from the currently-effective value so the picker
            // opens on the effective option rather than the first option.
            onChange={() => onChange(value ?? inherited)}
          />
          Override
        </label>
      </div>

      {inheriting ? (
        <p className="text-[12px] text-neutral-text-secondary">
          Using {inheritFromLabel}:{' '}
          <span className="font-medium text-neutral-text-primary">{labelOf(inherited)}</span>.
        </p>
      ) : (
        <div className="relative inline-block w-[220px]">
          <select
            value={value ?? inherited}
            aria-label={ariaLabel}
            onChange={(e) => onChange(e.target.value as T)}
            className="w-full h-8 pl-2.5 pr-8 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <svg
            className="pointer-events-none absolute right-2.5 top-2.5 text-neutral-text-secondary"
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  );
}
