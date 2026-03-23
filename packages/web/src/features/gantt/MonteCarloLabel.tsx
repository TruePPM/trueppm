interface Props {
  /** Dynamic total width of the task list panel — keeps the label column aligned after column resize. */
  width: number;
  /**
   * P80 ISO date string — rendered as a persistent "P80: Mon D" chip on
   * tablet (md–lg) so the key confidence number is visible without hovering.
   */
  p80Date: string;
}

/**
 * Left-hand label cell of the Monte Carlo row. Width matches the task list
 * panel so the vertical border aligns with the column separator above.
 * Shows a persistent P80 chip at tablet breakpoints (md–lg).
 */
export function MonteCarloLabel({ width, p80Date }: Props) {
  const p80Formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(p80Date));

  return (
    <div
      className="flex items-center gap-1.5 px-3 border-r border-t border-neutral-border bg-neutral-surface-raised flex-shrink-0"
      style={{ width }}
    >
      {/* Sigma icon — decorative, aria-hidden */}
      <span className="text-xs text-neutral-text-secondary leading-none" aria-hidden="true">
        σ
      </span>
      <span className="text-xs font-medium text-neutral-text-secondary truncate">
        Monte Carlo
      </span>
      {/* P80 chip — visible at md+ so the key number shows without hover (issue #33) */}
      <span
        className="ml-auto hidden md:inline-flex items-center px-1.5 py-0.5 rounded border border-semantic-at-risk/40 text-xs font-medium text-semantic-at-risk bg-transparent"
        aria-label={`P80 completion: ${p80Formatted}`}
      >
        P80: {p80Formatted}
      </span>
    </div>
  );
}
