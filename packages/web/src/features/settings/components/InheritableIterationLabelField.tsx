import { useId } from 'react';
import { IterationLabelField } from '../project/IterationLabelField';

export interface InheritableIterationLabelFieldProps {
  /** The scope's own override. `null` = inherit from the parent scope. */
  value: string | null;
  /** Emits the new override: a string to override, or `null` to inherit. */
  onChange: (next: string | null) => void;
  /** The resolved label shown while inheriting (the parent's effective value). */
  inheritedLabel: string;
  /** Human description of where the inherited value comes from, e.g.
   *  "the workspace default" or "the program or workspace default". */
  inheritFromLabel: string;
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
 * Iteration-label control for a scope that can INHERIT or OVERRIDE (ADR-0116, #1106).
 *
 * Wraps the #862 `IterationLabelField` with an inherit/override radio pair so a
 * program or project can defer to its parent's term (the common case) or set its
 * own. "Inherit" emits `null`; choosing "Set a custom label" reveals the preset/
 * custom picker and emits a string. The parent page persists `null` as a cleared
 * override (the server resolves the effective label). A blank custom value is
 * coerced back to inherit by the page's save handler — "inherit" is the explicit
 * null, never an empty string the serializer would reject.
 */
export function InheritableIterationLabelField({
  value,
  onChange,
  inheritedLabel,
  inheritFromLabel,
}: InheritableIterationLabelFieldProps) {
  const radioName = useId();
  const inheriting = value === null;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-2">
        <label className={chipClass(inheriting)}>
          <input
            type="radio"
            name={radioName}
            className="sr-only"
            checked={inheriting}
            onChange={() => onChange(null)}
          />
          Inherit
          <span className="font-normal opacity-80"> ({inheritedLabel})</span>
        </label>
        <label className={chipClass(!inheriting)}>
          <input
            type="radio"
            name={radioName}
            className="sr-only"
            checked={!inheriting}
            // Seed the override from the currently-inherited value so the picker
            // opens on the effective label rather than an empty field.
            onChange={() => onChange(value ?? inheritedLabel)}
          />
          Set a custom label
        </label>
      </div>

      {inheriting ? (
        <p className="text-[12px] text-neutral-text-secondary">
          Using {inheritFromLabel}:{' '}
          <span className="font-medium text-neutral-text-primary">{inheritedLabel}</span>.
        </p>
      ) : (
        <IterationLabelField value={value ?? ''} onChange={(v) => onChange(v)} />
      )}
    </div>
  );
}
