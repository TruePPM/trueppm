/**
 * ProgressBar — inline progress indicator for long-running operations.
 *
 * Usage:
 *   <ProgressBar pct={65} label="Creating tasks…" />
 *
 * The bar fills from 0 to 100 using the brand-primary color.
 * When `pct` is null the bar renders in indeterminate (pulse) mode.
 */

interface Props {
  /** 0–100. Pass null for indeterminate mode. */
  pct: number | null;
  /** Optional message shown below the bar. */
  label?: string;
  className?: string;
}

export function ProgressBar({ pct, label, className = '' }: Props) {
  const isIndeterminate = pct === null;

  return (
    <div className={`w-full ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label={label ?? 'Progress'}>
      <div className="h-1.5 rounded-full bg-neutral-border overflow-hidden">
        {isIndeterminate ? (
          <div className="h-full w-1/3 rounded-full bg-brand-primary animate-pulse" />
        ) : (
          <div
            className="h-full rounded-full bg-brand-primary transition-[width] duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        )}
      </div>
      {label && (
        <p className="mt-1 text-xs text-neutral-text-secondary">{label}</p>
      )}
    </div>
  );
}
