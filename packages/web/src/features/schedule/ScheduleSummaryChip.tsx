import { CheckIcon, CriticalDotIcon, WarningIcon } from '@/components/Icons';
import { Tooltip } from '@/components/Tooltip';
import type { Task } from '@/types';
import { useSchedulerStore } from '@/stores/schedulerStore';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { ROW_NOUN, ROW_NOUN_PLURAL, countRows } from './rowVocabulary';
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
 * Format: "{N} items · {S} in sprints · {C} critical · CPM ✓".
 *
 * **The noun is governed** (#3259). The count derives from `visibleTasks`, which
 * is every row regardless of `structure_role` — tasks, phases and milestones
 * alike — so a header naming them must use `ROW_VOCABULARY`'s neutral noun
 * rather than a literal. It said "tasks" until #3259, which typed every phase
 * and milestone it counted; two hand sweeps (#3027, #2952) and the mechanism
 * that replaced them (#3031) all passed over this file because the lock test
 * did not render it. It does now.
 *
 * **`{S} in sprints` is what paid for the Mode column's removal.** The column
 * went and `RowModeIndicators` kept only the 3px gutter and the exception chip
 * (#3139 item 2 pins that gutter as a WCAG 1.4.1 requirement, so it is not
 * coming back) — but the readout that was supposed to replace it never shipped,
 * leaving a hybrid plan with nowhere on the Schedule to say how much of itself
 * runs in sprints. The predicate mirrors `criticalCount`: summaries are excluded,
 * because a phase is not itself in a sprint even when its children are.
 *
 * It renders at zero, exactly as `critical` does. A readout whose tokens appear
 * and vanish with their values cannot be read at a glance — the reader has to
 * work out whether a missing token means zero or means shortened.
 *
 * **Two vocabularies meet in this one string, and they are unrelated.** The row
 * noun is `ROW_VOCABULARY`'s (#3031); the iteration-container noun is the
 * project's own configured label via `useIterationLabel` (ADR-0111), because a
 * team running Iterations or PIs is not running sprints. Hardcoding the second
 * would have shipped "in sprints" onto every such project — `web:lint`'s
 * `no-restricted-syntax` iteration-label gate (#1287) is what caught it here.
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
  const itl = useIterationLabel();
  const inIterations = `in ${itl.lowerPlural}`;

  const rowCount = visibleTasks.length;
  const criticalCount = visibleTasks.filter((t) => t.isCritical && !t.isSummary).length;
  const inSprintCount = visibleTasks.filter((t) => t.sprintId != null && !t.isSummary).length;

  const status: 'loading' | 'ok' | 'error' = isRecalculating
    ? 'loading'
    : cpmError
      ? 'error'
      : 'ok';

  // Spelled out in full at EVERY density (rule 161): the fit ladder shortens what
  // is painted, never what is announced, so a screen-reader user at `min` gets
  // the same four facts a sighted user gets at `full`.
  const ariaLabel = (() => {
    if (status === 'loading') return 'Project status: recalculating';
    const facts = `${countRows(rowCount)}, ${inSprintCount} ${inIterations}, ${criticalCount} critical`;
    return `Project status: ${facts}, CPM ${status === 'error' ? 'error' : 'healthy'}`;
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
          {density === 'full' && <span>{ROW_NOUN_PLURAL}</span>}
          <span>·</span>
          {density === 'full' && (
            <>
              <span className="tppm-mono motion-safe:animate-pulse opacity-50">··</span>
              <span>{inIterations}</span>
              <span>·</span>
            </>
          )}
          <span className="tppm-mono motion-safe:animate-pulse opacity-50">··</span>
          {density === 'full' && <span>critical</span>}
          <span>·</span>
          <span className="italic">CPM …</span>
        </span>
      ) : (
        <span aria-hidden="true" className="inline-flex items-center gap-1.5">
          {density !== 'min' && (
            <>
              <span className="tppm-mono">{rowCount}</span>
              {density === 'full' && <span>{rowCount === 1 ? ROW_NOUN : ROW_NOUN_PLURAL}</span>}
              <span>·</span>
              {/* First token to drop when the ladder tightens, ahead of
                  `critical`: the critical count drives the plan's dates, the
                  sprint count describes how it is being run. */}
              {density === 'full' && (
                <>
                  <span className="tppm-mono">{inSprintCount}</span>
                  <span>{inIterations}</span>
                  <span>·</span>
                </>
              )}
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
