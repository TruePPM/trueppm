import { LearnMoreLink } from '../SettingsShell';

export interface LifecycleCardProps {
  title: string;
  tone: 'neutral' | 'warning';
  description: string;
  actionLabel: string;
  notes: string[];
  disabled?: boolean;
  /** When the card is a not-yet-wired placeholder, the reason shown on hover
   *  (and as the accessible title) — should link the tracking issue, e.g. "… — tracked in #967". */
  disabledReason?: string;
  /** Docs-site slug (+#anchor) for this card's "Learn more →" link (web-rule 263). */
  docHref?: string;
  onClick?: () => void;
  busy?: boolean;
  error?: string | null;
}

/**
 * A single lifecycle-action card (archive, restore, export, transfer, …) on
 * the project and program Archive settings pages — shared here since both
 * pages built the identical card shell (#3903).
 */
export function LifecycleCard({
  title,
  tone,
  description,
  actionLabel,
  notes,
  disabled,
  disabledReason,
  docHref,
  onClick,
  busy,
  error,
}: LifecycleCardProps) {
  const isWarning = tone === 'warning';
  return (
    <div
      className={[
        'rounded-card border p-4',
        // Warning tone uses the adaptive semantic-warning tokens (amber wash +
        // AA border) rather than the static bg-brand-accent-light (#FFF3CD),
        // which stays cream in dark mode while the neutral text tokens invert to
        // light ink — washing the card out to unreadable (issue 1619, rule 86).
        // Mirrors the sibling Delete card's border-semantic-critical bg-…-bg.
        isWarning
          ? 'border-semantic-warning/70 bg-semantic-warning-bg'
          : 'border-neutral-border bg-neutral-surface-raised',
      ].join(' ')}
    >
      <h2 className="text-[13px] font-semibold text-neutral-text-primary mb-1">{title}</h2>
      <p className="text-[12px] text-neutral-text-secondary mb-2 leading-relaxed">{description}</p>
      <ul className="list-disc pl-4 mb-3 space-y-0.5">
        {notes.map((n) => (
          <li key={n} className="text-[11px] text-neutral-text-secondary">
            {n}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy || !onClick}
        title={disabled && !busy ? disabledReason : undefined}
        className={[
          'px-3 py-1.5 rounded-control border border-neutral-border text-[12px] font-medium',
          'text-neutral-text-primary hover:bg-neutral-surface-sunken',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
          'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed',
        ].join(' ')}
      >
        {busy ? 'Working…' : actionLabel}
      </button>
      {error ? (
        <p className="mt-2 text-[11px] text-semantic-critical" role="alert">
          {error}
        </p>
      ) : null}
      {docHref ? (
        <div>
          <LearnMoreLink href={docHref} className="mt-3" />
        </div>
      ) : null}
    </div>
  );
}
