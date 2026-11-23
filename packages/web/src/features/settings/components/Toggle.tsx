import { useFeatureFlag } from '../../../lib/featureFlags';
import { FOCUS_RING } from '../../../components/page2/classes';

export interface ToggleProps {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Words shown beside the switch for the on / off states. The visible word is
   *  derived from `on`, so it can never contradict the switch — a green (on) switch
   *  always reads "Enabled", never a stale hardcoded "Disabled". */
  onLabel?: string;
  offLabel?: string;
  hint?: string;
  /** Accessible name for the control. Without it the switch announces only its
   *  visible label ("Enabled"/"Disabled"), which does not say what it controls. */
  ariaLabel?: string;
  /** Render the switch inert. Use it when the state the switch would write is not
   *  yet known — a switch that paints "on" from an unanswered query and silently
   *  ignores the click is a worse affordance than one that is visibly not ready. */
  disabled?: boolean;
  /** A write is in flight: announces `aria-busy`, dims the switch and blocks re-entry. */
  busy?: boolean;
  /** Id of a caption that describes the switch (resolved timezone, enforced-by note). */
  describedBy?: string;
  /** Dim and ignore clicks but keep the switch focusable and announced as
   *  `aria-disabled` — for a switch whose "why not" is explained in `describedBy`,
   *  where a native `disabled` would drop it from the tab order. */
  softDisabled?: boolean;
}

/**
 * On/off switch whose visible word is always derived from state.
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
  disabled = false,
  busy = false,
  describedBy,
  softDisabled = false,
}: ToggleProps) {
  const label = on ? onLabel : offLabel;
  // Shell v2: 36x20 track inside a 44px target; the state is always written out.
  const v2 = useFeatureFlag('shell_v2');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      aria-disabled={softDisabled || undefined}
      disabled={disabled}
      onClick={() => {
        if (softDisabled || busy) return;
        onChange(!on);
      }}
      className={[
        v2
          ? `inline-flex min-h-11 items-center gap-2.5 rounded disabled:opacity-60 disabled:cursor-not-allowed ${FOCUS_RING}`
          : 'inline-flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded disabled:opacity-60 disabled:cursor-not-allowed',
        softDisabled ? 'opacity-60 cursor-not-allowed' : '',
        busy ? 'opacity-70 cursor-progress' : '',
      ].join(' ')}
    >
      <span
        className={[
          v2 ? 'relative w-9 h-5 rounded-full border transition-colors shrink-0' : 'relative w-8 h-[18px] rounded-full border transition-colors shrink-0',
          on
            ? 'bg-brand-primary border-brand-primary-dark'
            : 'bg-neutral-surface-sunken border-neutral-border',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-[2px] rounded-full bg-white transition-[left] duration-150',
            v2 ? 'w-4 h-4' : 'w-3 h-3',
            on ? (v2 ? 'left-[18px]' : 'left-[14px]') : 'left-[2px]',
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
