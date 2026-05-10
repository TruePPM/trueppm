import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';

interface Props {
  projectId: string;
}

/**
 * Read-only block shown in EstimatesSection for summary (phase) tasks when
 * at least one descendant has PERT estimates.
 *
 * Summary tasks do not have editable O/M/P fields — the MC engine only samples
 * leaf task durations. This component surfaces the project-level P50/P80/P95
 * schedule confidence dates (derived by propagating child PERT spreads through
 * the schedule) along with a hint to edit estimates on leaf tasks.
 */
export function PhaseUncertaintyBlock({ projectId }: Props) {
  const { data: mcResult, isLoading } = useMonteCarloResult(projectId);

  if (isLoading) return null;

  const fmtShort = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
      new Date(iso),
    );

  const chips = mcResult
    ? ([
        { label: 'Phase P50', iso: mcResult.p50, border: 'border-semantic-on-track/40', text: 'text-semantic-on-track' },
        { label: 'Phase P80', iso: mcResult.p80, border: 'border-semantic-at-risk/40',  text: 'text-semantic-at-risk' },
        { label: 'Phase P95', iso: mcResult.p95, border: 'border-semantic-critical/40', text: 'text-semantic-critical' },
      ] as const)
    : null;

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
        Schedule Confidence
      </span>

      {chips ? (
        <div
          className="rounded-lg border border-neutral-border bg-neutral-surface-raised px-4 py-3 flex flex-col gap-3"
          role="region"
          aria-label="Phase schedule confidence"
        >
          <div className="flex flex-col gap-2">
            {chips.map(({ label, iso, border, text }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-xs text-neutral-text-secondary">{label}</span>
                <span
                  className={`text-xs font-medium px-1.5 py-0.5 rounded border ${border} ${text} bg-transparent tppm-mono`}
                >
                  {fmtShort(iso)}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-neutral-text-disabled">
            Derived from child task estimates · Edit estimates on leaf tasks
          </p>
        </div>
      ) : (
        <div
          className="rounded-lg border border-neutral-border bg-neutral-surface-raised px-4 py-3"
          role="region"
          aria-label="Phase schedule confidence"
        >
          <p className="text-xs text-neutral-text-secondary">
            Run Monte Carlo to see phase confidence dates.
          </p>
          <p className="text-xs text-neutral-text-disabled mt-1">
            Edit estimates on leaf tasks, then run the simulation.
          </p>
        </div>
      )}
    </div>
  );
}
