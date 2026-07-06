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
import { ScopeChangedChip } from './ScopeChangedChip';
import { MilestoneBridgeForecast } from './MilestoneBridgeForecast';
import { useSprintScopeChanges } from '@/hooks/useSprints';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import {
  milestoneVarianceAnnotation,
  varianceToneChipClass,
} from '@/lib/milestoneVariance';

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

  // CPM annotation (issue 551): join the milestone task from the already-loaded
  // schedule task list (warm TanStack Query cache — the parent SprintsView
  // reads the same key, so this is a cache hit, not a second fetch) to read
  // `isCritical` / `totalFloat`. No new API — both are on TaskSerializer.
  const { tasks } = useScheduleTasks(projectId || undefined);
  const milestoneTask = detail ? (tasks?.find((t) => t.id === detail.id) ?? null) : null;

  // Promote affordance (DA-02 / ADR-0106): binding a milestone is a
  // schedule-authoring write, so only SCHEDULER+ sees the entry point. The
  // server enforces the same gate; this is render-gate only.
  const { role } = useCurrentUserRole(projectId);
  const canPromote = role !== null && role >= ROLE_SCHEDULER;
  const [promoting, setPromoting] = useState(false);

  return (
    <section
      aria-labelledby="sprint-milestone-heading"
      className="rounded-card border border-neutral-border bg-neutral-surface p-4 flex flex-col gap-3"
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
            {/* The milestone is identified here by name + finish date only.
                CPM structural vocabulary (WBS path) is deliberately kept off the
                agile/Sprints surface (issue 734, web-rule 141) — it belongs on
                the schedule, one click away via the deep-link below. */}
            <div className="flex items-center gap-3 text-xs text-neutral-text-secondary">
              {detail.finish && <span className="tppm-mono">{formatShortDate(detail.finish)}</span>}
              {detail.finish && <DaysOutChip targetIso={detail.finish} />}
            </div>
          </div>

          {rollup && rollup.rollup_basis !== 'none' && rollup.percent_complete != null && (
            <RollupBlock
              rollup={rollup}
              label={itl}
              onCriticalPath={milestoneTask?.isCritical ?? null}
              totalFloatDays={milestoneTask?.totalFloat ?? null}
            />
          )}

          {/* Hybrid-bridge proof (#730, ADR-0241): velocity vs CPM finish,
              delta-since-last-close, and the "if velocity holds" projection —
              the on-screen proof that sprint velocity feeds the schedule. */}
          <MilestoneBridgeForecast
            projectId={projectId}
            targetMilestoneId={detail.id}
            onCriticalPath={milestoneTask?.isCritical ?? null}
            totalFloatDays={milestoneTask?.totalFloat ?? null}
          />

          {predecessorsInSprint && predecessorsInSprint.total > 0 && (
            <p className="text-xs text-neutral-text-secondary">
              <span className="tppm-mono">{predecessorsInSprint.inSprint}</span> of{' '}
              <span className="tppm-mono">{predecessorsInSprint.total}</span> predecessor
              {predecessorsInSprint.total === 1 ? ' task' : ' tasks'} land in this {itl.lower}
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
  /** CPM critical-path flag of the milestone task (issue 551). Null until CPM runs. */
  onCriticalPath: boolean | null;
  /** CPM total float (working days) of the milestone task (issue 551). Null until CPM runs. */
  totalFloatDays: number | null;
}

/**
 * Stacked rollup display: the rolled-up percent (large mono number),
 * the basis label ("by points · 18 of 24"), and a variance chip when the
 * sprint plan is anchored against the milestone. The scope-change signal is a
 * persistent, clickable chip (#550) — replacing the former hover-only ⓘ — that
 * opens the scope-change audit drawer with the per-event delta.
 */
function RollupBlock({ rollup, label, onCriticalPath, totalFloatDays }: RollupBlockProps) {
  const percent = rollup.percent_complete!;
  const scopeSprintId = rollup.scope_change_sprint_id ?? null;
  // Fetch the delta only for this one card (single instance) so the chip can
  // show "+N / −M pts"; enabled-gated, so it no-ops until a sprint is known.
  const { data: scopeData } = useSprintScopeChanges(
    rollup.sprint_scope_changed ? scopeSprintId : null,
  );
  return (
    <div
      className="flex flex-col gap-1"
      aria-label={`Milestone progress ${Math.round(percent)} percent`}
    >
      <span className="text-2xl tppm-mono text-neutral-text-primary leading-none">
        {Math.round(percent)}%
      </span>
      <p className="text-xs text-neutral-text-secondary">
        {rollup.rollup_basis === 'tasks' ? 'by tasks' : 'by points'}
        {' · '}
        {rollup.sprint_count > 1
          ? `across ${rollup.sprint_count} ${label.lowerPlural}`
          : `this ${label.lower}`}
      </p>
      {rollup.variance_days != null && (
        <VarianceChip
          days={rollup.variance_days}
          iterationSingular={label.singular}
          onCriticalPath={onCriticalPath}
          totalFloatDays={totalFloatDays}
        />
      )}
      {rollup.sprint_scope_changed && scopeSprintId && (
        <span className="mt-0.5 self-start">
          <ScopeChangedChip sprintId={scopeSprintId} summary={scopeData?.summary} />
        </span>
      )}
    </div>
  );
}

interface VarianceChipProps {
  days: number;
  iterationSingular: string;
  /** CPM critical-path flag of the milestone task (issue 551). */
  onCriticalPath: boolean | null;
  /** CPM total float (working days) of the milestone task (issue 551). */
  totalFloatDays: number | null;
}

/**
 * Sprint-plan variance vs the milestone date, annotated with CPM float /
 * critical-path status (issue 551). Different signal from DaysOutChip: that one is
 * anchored to TODAY, this one is anchored to the SPRINT'S planned finish. Both
 * can be informative simultaneously — sprint ends in 5d but milestone is 8d
 * out → variance is -3 (ahead).
 *
 * The color band comes from slip-vs-float, not slip magnitude: `+3d slip` on a
 * milestone with 8d of float is amber; the same slip on a 1d-float or critical
 * milestone is red. See {@link milestoneVarianceAnnotation}.
 */
function VarianceChip({ days, iterationSingular, onCriticalPath, totalFloatDays }: VarianceChipProps) {
  const { tone, annotation, ariaAnnotation } = milestoneVarianceAnnotation({
    varianceDays: days,
    totalFloatDays,
    onCriticalPath,
  });

  const base =
    days < 0
      ? `${iterationSingular} plan: ${days}d ahead`
      : days === 0
        ? `${iterationSingular} plan: on time`
        : `${iterationSingular} plan: +${days}d slip`;
  const label = annotation ? `${base} · ${annotation}` : base;
  const ariaLabel = ariaAnnotation ? `${base}, ${ariaAnnotation}` : base;

  return (
    <span
      className={`tppm-mono inline-flex self-start items-center px-2 py-0.5 rounded border bg-transparent text-xs ${varianceToneChipClass(tone)}`}
      aria-label={ariaLabel}
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
