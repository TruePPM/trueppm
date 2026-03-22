import { TASK_LIST_WIDTH } from './ganttConstants';

/**
 * Left-hand label cell of the Monte Carlo row. Fixed width matches the task
 * list panel so the vertical border aligns with the column separator above.
 */
export function MonteCarloLabel() {
  return (
    <div
      className="flex items-center gap-1.5 px-3 border-r border-t border-neutral-border bg-neutral-surface-raised flex-shrink-0"
      style={{ width: TASK_LIST_WIDTH }}
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
