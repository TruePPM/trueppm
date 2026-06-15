import { useId } from 'react';
import { Toggle } from './Toggle';

export interface InheritableToggleFieldProps {
  /** The scope's own override. `null` = inherit from the parent scope. */
  value: boolean | null;
  /** Emits the new override: `true`/`false` to override, or `null` to inherit. */
  onChange: (next: boolean | null) => void;
  /** Value the scope WOULD inherit if its own override were cleared (the parent's
   *  resolved value — server `inherited_*`). Drives the "Inherit (On/Off)" chip
   *  suffix and the inheriting body line. */
  inherited: boolean;
  /** Human description of the inheritance source, e.g. "the workspace default"
   *  (program) or "the program or workspace default" (project). */
  inheritFromLabel: string;
  /** Noun for the read-only "set on this {scopeNoun}" line. */
  scopeNoun?: string;
  /** Words shown beside the override switch for on / off. Passed straight to
   *  Toggle so the visible word is always derived from state (#978). */
  onLabel?: string;
  offLabel?: string;
  /** Accessible name for BOTH the radiogroup and the override switch, e.g.
   *  "Public sharing". Required — without it the switch announces only
   *  "Enabled/Disabled" with no subject. */
  ariaLabel: string;
  /** Owner/Admin (role >= ADMIN). When false the control is a read-only
   *  inherited/override indicator — no radios, no switch (ADR-0133). */
  canEdit: boolean;
  /** Optional secondary line under the override switch. */
  overrideHint?: string;
}

const chipClass = (selected: boolean) =>
  [
    'px-3 py-1 rounded border text-[12px] font-medium transition-colors cursor-pointer',
    'has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-primary has-[:focus-visible]:ring-offset-1',
    selected
      ? 'border-2 border-brand-primary bg-brand-primary-light text-brand-primary'
      : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
  ].join(' ');

/**
 * Inheritable boolean control for a scope that can INHERIT or OVERRIDE (ADR-0135, #978).
 *
 * The boolean analog of {@link InheritableIterationLabelField}: an inherit/override
 * radio pair wrapping the shared {@link Toggle}. "Inherit (On/Off)" emits `null`;
 * "Override" reveals the switch and emits `true`/`false`. The displayed state is
 * always derived from `value` and the parent's resolved `inherited`
 * (`effective = value ?? inherited`), so the chip suffix and the switch word can
 * never contradict — the #978 unintuitive-toggle fix carried through.
 *
 * Below role >= ADMIN (`canEdit === false`) it collapses to a read-only indicator:
 * a status dot + the literal word + provenance, one composite `aria-label`.
 */
export function InheritableToggleField({
  value,
  onChange,
  inherited,
  inheritFromLabel,
  scopeNoun = 'scope',
  onLabel = 'Enabled',
  offLabel = 'Disabled',
  ariaLabel,
  canEdit,
  overrideHint,
}: InheritableToggleFieldProps) {
  const radioName = useId();
  const inheriting = value === null;
  const effective = value ?? inherited;
  const word = (on: boolean) => (on ? onLabel : offLabel);

  if (!canEdit) {
    // Read-only indicator (ADR-0133): state conveyed by text + dot, never color
    // alone (rule 7); body text uses neutral-text-secondary, not -disabled (rule
    // 169); one composite aria-label with aria-hidden children (rule 171).
    const provenance = inheriting
      ? `inherited from ${inheritFromLabel}`
      : `set on this ${scopeNoun}`;
    return (
      <div
        className="flex items-center gap-2 text-[13px]"
        aria-label={`${ariaLabel}: ${effective ? 'On' : 'Off'}, ${provenance}. View only.`}
      >
        <span className="inline-flex items-center gap-1.5" aria-hidden="true">
          <span
            className={
              effective
                ? 'w-2 h-2 rounded-full bg-brand-primary'
                : 'w-2 h-2 rounded-full border border-neutral-border'
            }
          />
          <span className="font-medium text-neutral-text-primary">
            {effective ? onLabel : offLabel}
          </span>
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
          <span className="font-normal opacity-80"> ({inherited ? 'On' : 'Off'})</span>
        </label>
        <label className={chipClass(!inheriting)}>
          <input
            type="radio"
            name={radioName}
            className="sr-only"
            checked={!inheriting}
            // Seed the override from the currently-effective value so the switch
            // opens reflecting reality rather than silently flipping it.
            onChange={() => onChange(value ?? inherited)}
          />
          Override
        </label>
      </div>

      {inheriting ? (
        <p className="text-[12px] text-neutral-text-secondary">
          Using {inheritFromLabel}:{' '}
          <span className="font-medium text-neutral-text-primary">{word(inherited)}</span>.
        </p>
      ) : (
        <Toggle
          on={value}
          onChange={(b) => onChange(b)}
          onLabel={onLabel}
          offLabel={offLabel}
          ariaLabel={ariaLabel}
          hint={overrideHint}
        />
      )}
    </div>
  );
}
