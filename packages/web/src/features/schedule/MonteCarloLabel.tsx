interface Props {
  /** Dynamic total width of the task list panel — keeps the label column aligned after column resize. */
  width: number;
}

/**
 * Left-hand label cell of the Monte Carlo row. Width matches the task list
 * panel so the vertical border aligns with the column separator above.
 *
 * Shows only the σ icon and "Monte Carlo" text — the P50/P80/P95 chips on
 * the right side already carry every persona-aligned signal, and a duplicate
 * P80 here was VoC-flagged as noise.
 */
export function MonteCarloLabel({ width }: Props) {
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
    </div>
  );
}
