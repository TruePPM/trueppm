import { useState } from 'react';
import { Link } from 'react-router';
import type { ApiSprint, MilestoneRollup } from '@/types';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { Button } from '@/components/Button';
import { daysUntil, formatShortDate } from './sprintMath';
import { PromoteMilestoneDialog } from './PromoteMilestoneDialog';
import type { IterationLabelForms } from '@/lib/iterationLabel';

interface Props {
  sprint: ApiSprint;
  projectId: string;
  /**
   * Predecessor-intersection summary (#866, ADR-0094 §3) — how many of the
   * milestone's predecessor tasks are committed to this sprint. Passed only by
   * the PLANNED-state bridge banner; omitted on the ACTIVE card. Renders a
   * "{inSprint} of {total} predecessor tasks land in this sprint" caption when
   * the milestone has predecessors.
   */
  predecessorsInSprint?: { inSprint: number; total: number };
}

/**
 * Right column of the SprintsView header grid — surfaces the milestone the
 * active sprint is advancing toward, with a deep-link to the schedule view
 * (#hash carries the milestone task id so ScheduleView can scroll to it).
 *
 * Days-out chip color band:
 *   > 7 days  → semantic-on-track
 *   0–7 days  → semantic-at-risk
 *   < 0 days  → semantic-critical (overdue)
 *
 * Rollup (ADR-0074): when `sprint.target_milestone_detail.rollup` is present,
 * surface the rolled-up percent_complete, rollup_basis label, and the sprint
 * vs. milestone variance. Days-out (today vs milestone) and variance (sprint
 * finish vs milestone) answer different questions and are stacked, not
 * collapsed.
 */
export function AdvancingToMilestoneCard({ sprint, projectId, predecessorsInSprint }: Props) {
  const itl = useIterationLabel(projectId);
  const detail = sprint.target_milestone_detail;
  const rollup = detail?.rollup ?? null;

  // Promote affordance (DA-02 / ADR-0106): binding a milestone is a
  // schedule-authoring write, so only SCHEDULER+ sees the entry point. The
  // server enforces the same gate; this is render-gate only.
  const { role } = useCurrentUserRole(projectId);
  const canPromote = role !== null && role >= ROLE_SCHEDULER;
  const [promoting, setPromoting] = useState(false);

  return (
    <section
      aria-labelledby="sprint-milestone-heading"
      className="rounded-md border border-neutral-border bg-neutral-surface p-4 flex flex-col gap-3"
    >
      <h2
        id="sprint-milestone-heading"
        className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
      >
        Advancing to Milestone
      </h2>

      {detail ? (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-neutral-text-primary leading-tight">
              {detail.name}
            </p>
            <div className="flex items-center gap-3 text-xs text-neutral-text-secondary">
              {detail.wbs_path && <span className="tppm-mono">WBS {detail.wbs_path}</span>}
              {detail.finish && <span className="tppm-mono">{formatShortDate(detail.finish)}</span>}
              {detail.finish && <DaysOutChip targetIso={detail.finish} />}
            </div>
          </div>

          {rollup && rollup.rollup_basis !== 'none' && rollup.percent_complete != null && (
            <RollupBlock rollup={rollup} label={itl} />
          )}

          {predecessorsInSprint && predecessorsInSprint.total > 0 && (
            <p className="text-xs text-neutral-text-secondary">
              <span className="tppm-mono">{predecessorsInSprint.inSprint}</span> of{' '}
              <span className="tppm-mono">{predecessorsInSprint.total}</span> predecessor
              {predecessorsInSprint.total === 1 ? ' task' : ' tasks'} land in this sprint
            </p>
          )}

          <div className="flex items-center gap-4">
            <Link
              to={`/projects/${projectId}/schedule#task-${detail.id}`}
              className="text-xs font-medium text-brand-primary hover:text-brand-primary-dark
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
            >
              Open in Schedule view →
            </Link>
            {canPromote && (
              <button
                type="button"
                onClick={() => setPromoting(true)}
                className="text-xs font-medium text-neutral-text-secondary hover:text-neutral-text-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
              >
                Change milestone
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm italic text-neutral-text-disabled">
            No milestone linked to this {itl.lower}.
          </p>
          {canPromote && (
            <Button variant="secondary" size="sm" onClick={() => setPromoting(true)}>
              Promote to milestone
            </Button>
          )}
        </div>
      )}

      {promoting && (
        <PromoteMilestoneDialog
          projectId={projectId}
          sprint={sprint}
          onClose={() => setPromoting(false)}
        />
      )}
    </section>
  );
}

interface RollupBlockProps {
  rollup: MilestoneRollup;
  label: IterationLabelForms;
}

/**
 * Stacked rollup display: the rolled-up percent (large mono number),
 * the basis label ("by points · 18 of 24"), and a variance chip when the
 * sprint plan is anchored against the milestone. Scope-change indicator (ⓘ)
 * sits inline with the percent and surfaces a native `title=` tooltip — never
 * a banner (deliberate: rule "no banners for soft signals").
 */
function RollupBlock({ rollup, label }: RollupBlockProps) {
  const percent = rollup.percent_complete!;
  return (
    <div
      className="flex flex-col gap-1"
      aria-label={`Milestone progress ${Math.round(percent)} percent`}
    >
      <div className="flex items-baseline gap-1">
        <span className="text-2xl tppm-mono text-neutral-text-primary leading-none">
          {Math.round(percent)}%
        </span>
        {rollup.sprint_scope_changed && (
          <span
            aria-label={`${label.singular} scope changed since activation`}
            title={`${label.singular} scope changed since activation — committed baseline preserved.`}
            className="ml-1 text-neutral-text-secondary cursor-help"
          >
            ⓘ
          </span>
        )}
      </div>
      <p className="text-xs text-neutral-text-secondary">
        {rollup.rollup_basis === 'tasks' ? 'by tasks' : 'by points'}
        {' · '}
        {rollup.sprint_count > 1
          ? `across ${rollup.sprint_count} ${label.lowerPlural}`
          : `this ${label.lower}`}
      </p>
      {rollup.variance_days != null && (
        <VarianceChip days={rollup.variance_days} iterationSingular={label.singular} />
      )}
    </div>
  );
}

interface VarianceChipProps {
  days: number;
  iterationSingular: string;
}

/**
 * Sprint-plan variance vs the milestone date. Different signal from
 * DaysOutChip: that one is anchored to TODAY, this one is anchored to the
 * SPRINT'S planned finish. Both can be informative simultaneously — sprint
 * ends in 5d but milestone is 8d out → variance is -3 (ahead).
 */
function VarianceChip({ days, iterationSingular }: VarianceChipProps) {
  let className: string;
  let label: string;
  if (days < 0) {
    className = 'border-semantic-on-track/40 text-semantic-on-track';
    label = `${iterationSingular} plan: ${days}d ahead`;
  } else if (days === 0) {
    className = 'border-neutral-border text-neutral-text-primary';
    label = `${iterationSingular} plan: on time`;
  } else if (days <= 5) {
    className = 'border-semantic-at-risk/40 text-semantic-at-risk';
    label = `${iterationSingular} plan: +${days}d slip`;
  } else {
    className = 'border-semantic-critical/40 text-semantic-critical';
    label = `${iterationSingular} plan: +${days}d slip`;
  }
  return (
    <span
      className={`tppm-mono inline-flex self-start items-center px-2 py-0.5 rounded border bg-transparent text-xs ${className}`}
      aria-label={label}
    >
      {label}
    </span>
  );
}

function DaysOutChip({ targetIso }: { targetIso: string }) {
  const days = daysUntil(targetIso);
  let className: string;
  let label: string;
  if (days < 0) {
    className = 'border-semantic-critical/40 text-semantic-critical';
    label = `${Math.abs(days)}d overdue`;
  } else if (days <= 7) {
    className = 'border-semantic-at-risk/40 text-semantic-at-risk';
    label = `${days}d out`;
  } else {
    className = 'border-semantic-on-track/40 text-semantic-on-track';
    label = `${days}d out`;
  }
  return (
    <span
      className={`tppm-mono inline-flex items-center px-2 py-0.5 rounded border bg-transparent text-xs ${className}`}
      aria-label={`${days} days until milestone`}
    >
      {label}
    </span>
  );
}
