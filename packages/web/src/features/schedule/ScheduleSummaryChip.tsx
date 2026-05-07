import type { Task } from '@/types';
import { useSchedulerStore } from '@/stores/schedulerStore';

export interface ScheduleSummaryChipProps {
  /** Tasks visible after filtering — counts derive from this set. */
  visibleTasks: Task[];
}

/**
 * Read-only project-health chip in the Schedule toolbar (#248).
 * Format: "{N} tasks · {C} critical · CPM ✓".
 *
 * Loading state preserves chip width via two-dot placeholders + italic
 * "CPM …" so the surrounding toolbar does not reflow during recompute.
 */
export function ScheduleSummaryChip({ visibleTasks }: ScheduleSummaryChipProps) {
  const isRecalculating = useSchedulerStore((s) => s.isRecalculating);
  const cpmError = useSchedulerStore((s) => s.cpmError);

  const taskCount = visibleTasks.length;
  const criticalCount = visibleTasks.filter((t) => t.isCritical && !t.isSummary).length;

  const status: 'loading' | 'ok' | 'error' = isRecalculating
    ? 'loading'
    : cpmError
      ? 'error'
      : 'ok';

  const ariaLabel = (() => {
    if (status === 'loading') return 'Project status: recalculating';
    if (status === 'error')
      return `Project status: ${taskCount} tasks, ${criticalCount} critical, CPM error`;
    return `Project status: ${taskCount} tasks, ${criticalCount} critical, CPM healthy`;
  })();

  return (
    <div
      role="status"
      aria-label={ariaLabel}
      className="hidden md:inline-flex h-7 items-center gap-1.5 rounded
        border border-neutral-border bg-transparent px-3 text-xs text-neutral-text-secondary
        whitespace-nowrap"
    >
      {status === 'loading' ? (
        <>
          <span className="tppm-mono animate-pulse opacity-50">··</span>
          <span>tasks</span>
          <span aria-hidden="true">·</span>
          <span className="tppm-mono animate-pulse opacity-50">··</span>
          <span>critical</span>
          <span aria-hidden="true">·</span>
          <span className="italic">CPM …</span>
        </>
      ) : (
        <>
          <span className="tppm-mono">{taskCount}</span>
          <span>{taskCount === 1 ? 'task' : 'tasks'}</span>
          <span aria-hidden="true">·</span>
          <span className="tppm-mono">{criticalCount}</span>
          <span>critical</span>
          <span aria-hidden="true">·</span>
          {status === 'error' ? (
            <span className="text-semantic-at-risk">
              CPM <span aria-hidden="true">⚠</span>
            </span>
          ) : (
            <span className="text-semantic-on-track">
              CPM <span aria-hidden="true">✓</span>
            </span>
          )}
        </>
      )}
    </div>
  );
}
