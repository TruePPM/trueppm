export interface ToggleProps {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Words shown beside the switch for the on / off states. The visible word is
   *  derived from `on`, so it can never contradict the switch — a green (on) switch
   *  always reads "Enabled", never a stale hardcoded "Disabled" (#978). */
  onLabel?: string;
  offLabel?: string;
  hint?: string;
  /** Accessible name for the control. Without it the switch announces only its
   *  visible label ("Enabled"/"Disabled"), which does not say what it controls. */
  ariaLabel?: string;
}

/**
 * On/off switch whose visible word is always derived from state (#978).
 *
 * Extracted from WorkspaceGeneralPage so the same switch backs both the
 * workspace-scope toggles and the program/project `InheritableToggleField`
 * (ADR-0135) — the on/off rendering never forks.
 */
export function Toggle({
  on,
  onChange,
  onLabel = 'Enabled',
  offLabel = 'Disabled',
  hint,
  ariaLabel,
}: ToggleProps) {
  const label = on ? onLabel : offLabel;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      className="inline-flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
    >
      <span
        className={[
          'relative w-8 h-[18px] rounded-full border transition-colors shrink-0',
          on
            ? 'bg-brand-primary border-brand-primary-dark'
            : 'bg-neutral-surface-sunken border-neutral-border',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-[2px] w-3 h-3 rounded-full bg-white transition-[left] duration-150',
            on ? 'left-[14px]' : 'left-[2px]',
          ].join(' ')}
        />
      </span>
      {label && (
        <span className="flex flex-col text-left">
          <span className="text-[13px] text-neutral-text-primary">{label}</span>
          {hint && <span className="text-[12px] text-neutral-text-secondary">{hint}</span>}
        </span>
      )}
    </button>
  );
}
