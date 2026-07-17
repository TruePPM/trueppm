import { useProjectForecast, useProjectVelocity } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { daysBetween, formatShortDate } from './sprintMath';
import { varianceToneChipClass, type MilestoneVarianceTone } from '@/lib/milestoneVariance';

interface Props {
  projectId: string;
  /** The active/planned sprint's bound milestone (Sprint.target_milestone), if any. */
  targetMilestoneId: string | null;
  /** CPM critical-path flag of the milestone task (#551), from the host card. */
  onCriticalPath: boolean | null;
  /** CPM total float (working days) of the milestone task (#551), from the host card. */
  totalFloatDays: number | null;
}

/**
 * The hybrid-bridge proof card region (#730, ADR-0241) — the on-screen proof of
 * the causal chain "velocity feeds the schedule", mounted inside
 * {@link AdvancingToMilestoneCard} beneath the rollup.
 *
 * Co-locates four reads for the active sprint's bound milestone:
 *   1. Scheduled (CPM) finish — the deterministic date — next to the velocity
 *      estimate, so the two forecasts are seen side by side.
 *   2. Delta since last close — how the CPM finish moved and after which sprint.
 *   3. "If velocity holds" — the remaining backlog re-paced by the velocity band.
 *   4. The velocity read itself, which keeps percentile vocabulary honest.
 *
 * web-rule 166/223: the CPM date is exact (deterministic, no qualifier); the
 * velocity read renders a band with an on-screen "(velocity estimate)" qualifier
 * unless the snapshot is a real Monte Carlo run (`basis === 'monte_carlo'`), and
 * the delta is derived from `cpm_finish` movement only — never the noisy velocity
 * band. Velocity fields are gated by the ADR-0104 privacy suppression (the
 * component self-resolves it from the project velocity read), so an out-of-audience
 * reader never pulls the band here.
 */
export function MilestoneBridgeForecast({
  projectId,
  targetMilestoneId,
  onCriticalPath,
  totalFloatDays,
}: Props) {
  const itl = useIterationLabel(projectId);
  // Self-resolve the ADR-0104 velocity gate (rather than threading a prop through
  // both AdvancingToMilestoneCard call sites): wait for the velocity read, then
  // enable the forecast pull only when the band is NOT suppressed for this reader.
  const velocity = useProjectVelocity(projectId);
  const enabled = velocity.data != null && !velocity.data.velocity_suppressed;
  const { data: forecast } = useProjectForecast(projectId, { enabled });

  // Guard the milestones array explicitly: a page that renders this card without
  // a real /forecast/ mock (e.g. an e2e leaning on a catch-all list route) would
  // otherwise hand us a `{count,results}` shape and crash `.find` into the root
  // error boundary (the #1190 catch-all-object hazard). Null-render instead.
  if (!enabled || targetMilestoneId == null || !forecast || !Array.isArray(forecast.milestones)) {
    return null;
  }

  const milestone = forecast.milestones.find((m) => m.milestone_id === targetMilestoneId);
  // No matching snapshot, or no CPM anchor to prove the velocity estimate against.
  if (!milestone || !milestone.cpm_finish) return null;

  const { sprints_to_complete_low: stcLow, sprints_to_complete_high: stcHigh } = forecast;
  const remaining = forecast.remaining_committed_points;
  const showProjection = stcLow != null && stcHigh != null && remaining > 0;

  const prev = milestone.previous;
  const showDelta = prev != null && prev.cpm_finish != null && prev.cpm_finish !== milestone.cpm_finish;

  return (
    <div
      data-testid="milestone-bridge-forecast"
      className="border-t border-neutral-border pt-3 flex flex-col gap-2.5"
    >
      <span
        id="mbf-region-label"
        className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary"
      >
        Velocity vs schedule
      </span>

      <div
        role="group"
        aria-label="Scheduled finish versus velocity estimate"
        className="flex flex-col gap-3 sm:flex-row sm:gap-6"
      >
        <ScheduleColumn
          cpmFinish={milestone.cpm_finish}
          onCriticalPath={onCriticalPath}
          totalFloatDays={totalFloatDays}
        />
        <VelocityColumn p50={milestone.p50} p80={milestone.p80} basis={milestone.basis} />
      </div>

      {showDelta && (
        <DeltaLine
          prevCpmFinish={prev.cpm_finish!}
          cpmFinish={milestone.cpm_finish}
          previousSprintName={milestone.previous_sprint_name}
        />
      )}

      {showProjection && (
        <p className="text-xs text-neutral-text-secondary">
          If velocity holds, ~
          <span className="tppm-mono">{stcLow}</span>
          {stcLow !== stcHigh && (
            <>
              –<span className="tppm-mono">{stcHigh}</span>
            </>
          )}{' '}
          more {stcHigh === 1 ? itl.lower : itl.lowerPlural} to clear{' '}
          <span className="tppm-mono">{remaining}</span> pts.
        </p>
      )}
    </div>
  );
}

/** Left column — the deterministic CPM finish, with the existing critical/float annotation. */
function ScheduleColumn({
  cpmFinish,
  onCriticalPath,
  totalFloatDays,
}: {
  cpmFinish: string;
  onCriticalPath: boolean | null;
  totalFloatDays: number | null;
}) {
  const annotation =
    onCriticalPath === true
      ? { text: 'critical path', cls: 'text-semantic-critical', aria: 'on the critical path' }
      : totalFloatDays != null
        ? { text: null, cls: 'text-neutral-text-secondary', aria: `${totalFloatDays} days of float remaining` }
        : null;
  return (
    <div className="flex-1 flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
        Schedule (CPM)
      </span>
      <span
        className="text-sm font-semibold text-neutral-text-primary"
        aria-label={`Scheduled finish ${formatShortDate(cpmFinish)}${annotation ? `, ${annotation.aria}` : ''}`}
      >
        <span className="tppm-mono">{formatShortDate(cpmFinish)}</span>
        {annotation && (
          <span aria-hidden="true" className={`text-xs ${annotation.cls}`}>
            {' · '}
            {annotation.text ?? (
              <>
                <span className="tppm-mono">{totalFloatDays}</span>d float
              </>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Right column — the velocity read (web-rule 166/223). A velocity-band snapshot
 * renders an "est. {p50}–{p80}" range with an on-screen "(velocity estimate)"
 * qualifier; only a real Monte Carlo snapshot may wear percentile labels.
 */
function VelocityColumn({
  p50,
  p80,
  basis,
}: {
  p50: string | null;
  p80: string | null;
  basis: string;
}) {
  const simulated = basis === 'monte_carlo';
  const chipCls =
    'tppm-mono inline-flex self-start items-center px-2 py-0.5 rounded border bg-transparent text-xs border-neutral-border text-neutral-text-primary';
  return (
    <div className="flex-1 flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
        Velocity estimate
      </span>
      {p50 == null ? (
        // rule 119: a configured-but-not-yet-computable read shows a reason, never a blank.
        <span className="text-xs text-neutral-text-secondary">Estimate pending — building velocity</span>
      ) : simulated ? (
        <>
          <span className={chipCls} aria-label={`Monte Carlo P80 finish ${formatShortDate(p80 ?? p50)}`}>
            P80 <span className="tppm-mono">{formatShortDate(p80 ?? p50)}</span>
          </span>
          {p80 && (
            <span className="text-xs text-neutral-text-secondary">
              P50 <span className="tppm-mono">{formatShortDate(p50)}</span>
            </span>
          )}
        </>
      ) : (
        <>
          <span
            className={chipCls}
            aria-label={`Velocity estimate, likely finish ${formatShortDate(p50)}${p80 ? ` to ${formatShortDate(p80)}` : ''}`}
          >
            est. <span className="tppm-mono">{formatShortDate(p50)}</span>
            {p80 && (
              <>
                –<span className="tppm-mono">{formatShortDate(p80)}</span>
              </>
            )}
          </span>
          {/* Visible on-screen (not a title tooltip — web-rules 22a/121/166): the
              honesty qualifier keeps a velocity band from reading as false precision. */}
          <span className="text-xs italic text-neutral-text-secondary">(velocity estimate)</span>
        </>
      )}
    </div>
  );
}

/** Delta-since-last-close chip, computed on CPM finish movement only (web-rule 223). */
function DeltaLine({
  prevCpmFinish,
  cpmFinish,
  previousSprintName,
}: {
  prevCpmFinish: string;
  cpmFinish: string;
  previousSprintName: string | null;
}) {
  const signedDays = daysBetween(prevCpmFinish, cpmFinish); // >0 = finish moved later (slip)
  const tone: MilestoneVarianceTone = signedDays > 0 ? 'at-risk' : 'on-track';
  const word = signedDays > 0 ? 'later' : 'earlier';
  const signed = signedDays > 0 ? `+${signedDays}` : `${signedDays}`;
  const since = previousSprintName ?? 'the last forecast';
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className={`tppm-mono inline-flex items-center px-2 py-0.5 rounded border bg-transparent text-xs ${varianceToneChipClass(tone)}`}
        aria-label={`Scheduled finish moved ${Math.abs(signedDays)} days ${word}, from ${formatShortDate(prevCpmFinish)} to ${formatShortDate(cpmFinish)}, since ${since}`}
      >
        {formatShortDate(prevCpmFinish)}
        <span aria-hidden="true">{' → '}</span>
        {formatShortDate(cpmFinish)}
        {' · '}
        {signed}d {word}
      </span>
      <span className="text-xs text-neutral-text-secondary">· since {since}</span>
    </div>
  );
}
