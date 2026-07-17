/**
 * Read-only value indicator for below-role users (ADR-0133, web-rule 175/164).
 *
 * When a control would 403 for the current role, we never ship a *disabled*
 * input — a greyed-out field implies editability and announces "[label], dimmed"
 * to screen readers with no reason. Instead we render the effective value plus
 * its provenance, so a Viewer/Member can still see *what* the setting is and
 * *who* owns it. This is the generalization of the per-field read-only branch
 * baked into {@link InheritableToggleField}; extracting it here lets the ~19
 * grayed-fieldset sites converge on one WCAG-reviewed shape.
 *
 * Presentation rules encoded here:
 * - state is conveyed by a status dot **and** the literal value word, never by
 *   color alone (rule 7);
 * - body text uses `neutral-text-secondary`, never the sub-AA `-disabled` token
 *   (rule 169);
 * - the whole row carries one composite `aria-label` ending in "View only." with
 *   `aria-hidden` children, so a screen reader hears the subject, value, and
 *   provenance as a single phrase rather than a dimmed orphan control (rule 171).
 */
export interface ReadOnlyIndicatorProps {
  /** Accessible subject of the setting, e.g. "Slip policy" or "Methodology".
   *  Announced first in the composite label. */
  label: string;
  /** The effective value to display, e.g. "Warn only", "Agile", "On". */
  value: string;
  /** Provenance clause rendered after "· ", e.g. "managed by the program admin".
   *  Explains why there is no editable control. */
  provenance: string;
  /** Filled brand dot (a set/on value) vs a hollow outline (an off/empty value).
   *  Defaults to filled; pass the on-state for boolean settings. */
  filled?: boolean;
  /** Hide the *visible* "· provenance" clause (keeping it in the composite
   *  `aria-label`) for tight cells — e.g. a fixed narrow grid column where the
   *  full sentence would overflow, and where the identical provenance repeats on
   *  every row and so carries no per-row visual signal. Screen readers still hear
   *  the full phrase. */
  compact?: boolean;
  className?: string;
}

export function ReadOnlyIndicator({
  label,
  value,
  provenance,
  filled = true,
  compact = false,
  className,
}: ReadOnlyIndicatorProps) {
  return (
    <div
      className={['flex items-center gap-2 text-[13px]', className].filter(Boolean).join(' ')}
      aria-label={`${label}: ${value}, ${provenance}. View only.`}
    >
      <span className="inline-flex items-center gap-1.5" aria-hidden="true">
        <span
          className={
            filled
              ? 'w-2 h-2 rounded-full bg-brand-primary'
              : 'w-2 h-2 rounded-full border border-neutral-border'
          }
        />
        <span className="font-medium text-neutral-text-primary">{value}</span>
      </span>
      {!compact && (
        <span className="text-neutral-text-secondary" aria-hidden="true">
          · {provenance}
        </span>
      )}
    </div>
  );
}
