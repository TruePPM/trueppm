import { useActiveSprint } from '@/hooks/useSprints';
import { useProject } from '@/hooks/useProject';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { registry } from '@/lib/widget-registry';
import {
  useProjectScheduleSummary,
  type ProjectScheduleSummary,
} from './useProjectScheduleSummary';

type Health = ProjectScheduleSummary['schedule_health'];

// Reuse the project-overview health treatment so Today and Overview never drift.
// Color is never the only signal — every pill carries its text label (WCAG 1.4.1).
const HEALTH_PILL: Record<Health, string> = {
  on_track: 'border-semantic-on-track/40 text-semantic-on-track',
  at_risk: 'border-semantic-at-risk/40 text-semantic-at-risk',
  critical: 'border-semantic-critical/40 text-semantic-critical',
  unknown: 'border-neutral-border text-neutral-text-secondary',
};
const HEALTH_LABEL: Record<Health, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  critical: 'Critical',
  unknown: 'Unknown',
};

/** A read-only KPI chip: small label over a value. `critical`/`warn` tint the value. */
function KpiChip({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'warn' | 'critical';
}) {
  const valueTone =
    tone === 'critical'
      ? 'text-semantic-critical'
      : tone === 'warn'
        ? 'text-semantic-at-risk'
        : 'text-neutral-text-primary';
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-[.06em] text-neutral-text-secondary">
        {label}
      </span>
      <span className={`text-[15px] font-semibold tabular-nums ${valueTone}`}>{value}</span>
    </div>
  );
}

/**
 * The Unified Today schedule strip (ADR-0180). Read-only: it surfaces the project's
 * schedule-health signal (from `GET /projects/{id}/overview/`) and the active sprint's
 * live progress derived from the board tasks — the one-way board → schedule rollup link
 * that is the headline of the unified view. Nothing here edits sprint content; the flow
 * is strictly board → strip. The `today_view.gate_status` slot is an OSS extension point
 * (ADR-0029) — Enterprise registers gate-status / change-request cards; OSS renders nothing.
 *
 * The two halves are methodology-aware (ADR-0107, issue 1338): WATERFALL drops the
 * (always-empty) sprint rollup; AGILE drops the CPM/SPI/critical-path cluster — which is
 * off-vocabulary once the Schedule and Calendar views are themselves hidden — and
 * foregrounds the sprint; HYBRID lights up both. The tab itself is never gated.
 */
export function SchedulePulse({ projectId }: { projectId: string }) {
  const { data: overview, isLoading, error } = useProjectScheduleSummary(projectId);
  const { sprint } = useActiveSprint(projectId);
  const { tasks } = useScheduleTasks(projectId);

  // Read the server-resolved methodology (ADR-0107), never the raw override. Default to
  // HYBRID (the superset) while the project loads so neither half flashes in then out.
  const { data: project } = useProject(projectId);
  const methodology = project?.effective_methodology ?? 'HYBRID';
  const showScheduleSignals = methodology !== 'AGILE';
  const showSprintRollup = methodology !== 'WATERFALL';

  // Live sprint percent-complete: the sprint serializer's completion_ratio_* is null
  // until close, so derive it from the already-loaded board tasks scoped to the active
  // sprint (board → strip). Task-count basis (committed points are snapshotted at
  // activation and miss mid-sprint scope); good enough for the v1 pulse.
  const sprintTasks = sprint && tasks ? tasks.filter((t) => t.sprintId === sprint.id) : [];
  const sprintDone = sprintTasks.filter((t) => t.status === 'COMPLETE').length;
  const sprintTotal = sprintTasks.length;
  const sprintPct = sprintTotal > 0 ? Math.round((sprintDone / sprintTotal) * 100) : null;

  const gateSlots = registry.get('today_view.gate_status');

  // The skeleton stands in for the schedule cluster only; AGILE doesn't render it, so
  // skip straight to the sprint-foregrounded strip rather than flash an empty skeleton.
  if (showScheduleSignals && isLoading) {
    return (
      <section
        aria-label="Schedule status"
        aria-busy="true"
        className="border-b border-neutral-border bg-neutral-surface-raised px-4 py-3"
      >
        <div aria-label="Loading schedule status" className="flex gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              aria-hidden="true"
              className="h-9 w-24 motion-safe:animate-pulse rounded bg-neutral-surface-sunken"
            />
          ))}
        </div>
      </section>
    );
  }

  const health: Health = overview?.schedule_health ?? 'unknown';
  const pctComplete =
    overview && overview.total_tasks > 0
      ? Math.round((overview.complete_tasks / overview.total_tasks) * 100)
      : null;

  return (
    <section
      aria-label="Schedule status"
      className="border-b border-neutral-border bg-neutral-surface-raised px-4 py-3"
      data-testid="schedule-pulse"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {showScheduleSignals && (
          <>
            {/* Schedule health band */}
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold ${HEALTH_PILL[health]}`}
              data-testid="pulse-health"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
              {HEALTH_LABEL[health]}
              {overview?.spi != null && (
                <span className="font-normal text-neutral-text-secondary">
                  · SPI {overview.spi.toFixed(2)}
                </span>
              )}
            </span>

            {error ? (
              <span role="alert" className="text-[13px] text-semantic-critical">
                Couldn&apos;t load schedule status.
              </span>
            ) : (
              <>
                <KpiChip label="Complete" value={pctComplete != null ? `${pctComplete}%` : '—'} />
                <KpiChip
                  label="Critical"
                  value={String(overview?.critical_task_count ?? 0)}
                  tone={overview && overview.critical_task_count > 0 ? 'warn' : 'neutral'}
                />
                <KpiChip
                  label="Late"
                  value={String(overview?.tasks_late_count ?? 0)}
                  tone={overview && overview.tasks_late_count > 0 ? 'critical' : 'neutral'}
                />
                {overview?.next_milestone && (
                  <KpiChip
                    label="Next milestone"
                    value={`${overview.next_milestone.name} · ${overview.next_milestone.percent_complete}%`}
                  />
                )}
              </>
            )}
          </>
        )}

        {/* Enterprise gate / change-request slot (ADR-0029) — empty in OSS. */}
        {gateSlots.map((reg) => {
          const Slot = reg.component;
          return <Slot key={reg.id} />;
        })}

        {/* Sprint rollup chip — the board → schedule link. Right-aligned beside the
            schedule cluster; left-aligned and foregrounded on AGILE where it stands alone. */}
        {showSprintRollup && (
          <div className={showScheduleSignals ? 'ml-auto' : ''} data-testid="pulse-sprint">
            {sprint ? (
              <div className="min-w-[200px] max-w-[280px] rounded-card border border-neutral-border bg-neutral-surface px-3 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-neutral-text-primary">
                    {sprint.name}
                  </span>
                  {sprintPct != null && (
                    <span className="shrink-0 text-[12px] font-semibold tabular-nums text-brand-primary">
                      {sprintPct}%
                    </span>
                  )}
                </div>
                {sprintPct != null ? (
                  <div
                    className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-surface-sunken"
                    role="progressbar"
                    aria-valuenow={sprintPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Active sprint ${sprint.name}: ${sprintPct}% complete (${sprintDone} of ${sprintTotal} tasks)`}
                  >
                    <div
                      className="h-full rounded-full bg-brand-primary"
                      style={{ width: `${sprintPct}%` }}
                    />
                  </div>
                ) : (
                  <span className="text-xs text-neutral-text-secondary">
                    No committed tasks yet
                  </span>
                )}
                <span className="mt-0.5 block text-xs text-neutral-text-secondary">
                  ↳ {sprintDone}/{sprintTotal} done · live from the board
                </span>
              </div>
            ) : (
              <span
                className="text-[12px] text-neutral-text-secondary"
                data-testid="pulse-no-sprint"
              >
                No active sprint
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
