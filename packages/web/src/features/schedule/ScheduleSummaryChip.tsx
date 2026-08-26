import { CheckIcon, CriticalDotIcon, WarningIcon } from '@/components/Icons';
import { Tooltip } from '@/components/Tooltip';
import type { Task } from '@/types';
import { useSchedulerStore } from '@/stores/schedulerStore';
import type { CountsDensity } from './toolbar/toolbarLadder';

export interface ScheduleSummaryChipProps {
  /** Tasks visible after filtering — counts derive from this set. */
  visibleTasks: Task[];
  /**
   * How much room the fit ladder left for it (#3076).
   *
   * A readout **shortens; it never hides**. There is no `overflow` state here
   * and there deliberately is no route into the `···` menu: a count sitting
   * behind a click is not a count, it is a fact nobody will look at. `hidden`
   * is the *pin* being off — a deliberate choice by this person — not a
   * concession the ladder made on their behalf.
   */
  density?: CountsDensity;
}

/**
 * Read-only project-health chip in the Schedule toolbar (#248).
 * Format: "{N} tasks · {C} critical · CPM ✓".
 *
 * Loading state preserves chip width via two-dot placeholders + italic
 * "CPM …" so the surrounding toolbar does not reflow during recompute.
 *
 * At `mid` and `min` the accessible name is **unchanged** — the counts are
 * spelled out in words at every density, so a screen-reader user never gets the
 * shortened reading (rule 161). At `min` the visible form is the bare `CPM ✓`
 * token, which is exactly rule 287's case: a sighted user seeing shorthand is
 * owed the sentence a screen-reader user already had, so it carries a
 * `Tooltip` with `describe={false}` (the label already says it — describing it
 * as well would announce the same sentence twice).
 */
export function ScheduleSummaryChip({
  visibleTasks,
  density = 'full',
}: ScheduleSummaryChipProps) {
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

  if (density === 'hidden') return null;

  const cpmToken =
    status === 'error' ? (
      <span className="text-semantic-at-risk">
        CPM <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
      </span>
    ) : (
      <span className="text-semantic-on-track">
        CPM{' '}
        <CheckIcon
          className="inline-block h-3 w-3 align-[-0.125em]"
          aria-hidden="true"
          data-testid="cpm-healthy-check"
        />
      </span>
    );

  const chip = (
    <div
      role="status"
      aria-label={ariaLabel}
      data-testid="schedule-summary-chip"
      data-density={density}
      className="hidden md:inline-flex shrink-0 h-7 items-center gap-1.5 rounded-chip
        border border-neutral-border bg-transparent px-3 text-xs text-neutral-text-secondary
        whitespace-nowrap"
    >
      {/* Every visible child is `aria-hidden`: `role="status"` is not a widget
          role, so an `aria-label` on this container does NOT suppress its
          descendant text in NVDA/JAWS — without this the chip is read twice,
          once as the label and once as the spans (rule 171). */}
      {status === 'loading' ? (
        <span aria-hidden="true" className="inline-flex items-center gap-1.5">
          <span className="tppm-mono motion-safe:animate-pulse opacity-50">··</span>
          {density === 'full' && <span>tasks</span>}
          <span>·</span>
          <span className="tppm-mono motion-safe:animate-pulse opacity-50">··</span>
          {density === 'full' && <span>critical</span>}
          <span>·</span>
          <span className="italic">CPM …</span>
        </span>
      ) : (
        <span aria-hidden="true" className="inline-flex items-center gap-1.5">
          {density !== 'min' && (
            <>
              <span className="tppm-mono">{taskCount}</span>
              {density === 'full' && <span>{taskCount === 1 ? 'task' : 'tasks'}</span>}
              <span>·</span>
              <span className="tppm-mono">{criticalCount}</span>
              {density === 'full' ? (
                <span>critical</span>
              ) : (
                // `mid` drops the word but not the meaning: the critical dot is
                // the same mark the outline puts on a critical row, so the
                // number keeps a referent rather than becoming a bare digit.
                <CriticalDotIcon className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
              )}
              <span>·</span>
            </>
          )}
          {cpmToken}
        </span>
      )}
    </div>
  );

  if (density !== 'min') return chip;
  return (
    <Tooltip content={ariaLabel} describe={false}>
      {chip}
    </Tooltip>
  );
}
