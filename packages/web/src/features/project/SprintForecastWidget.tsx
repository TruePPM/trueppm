/**
 * SprintForecastWidget — backlog delivery forecast on the project overview (#487).
 *
 * "When is the backlog done?" answered from a velocity Monte Carlo (the
 * /sprint-forecast/ read): P50/P80 sprint counts + calendar dates. Because the
 * basis is a real simulation (`monte_carlo`), P50/P80 percentile vocabulary is
 * honest here — unlike the milestone velocity *band*, which web-rule 166 keeps
 * to Early/Likely/Late. Renders an explicit team-private wall when the velocity
 * signal is gated (ADR-0104) and a warm-up state until two sprints have closed.
 */
import { formatShortDate } from '@/features/sprints/sprintMath';
import { useSprintForecast } from '@/hooks/useSprints';

interface Props {
  projectId: string;
}

export function SprintForecastWidget({ projectId }: Props) {
  const { data, isLoading } = useSprintForecast(projectId);

  if (isLoading || !data) return null;

  return (
    <section aria-label="Backlog forecast" data-testid="sprint-forecast-widget">
      <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
        Backlog forecast
      </h2>
      <div className="rounded-md border border-neutral-border bg-neutral-surface p-4">
        <Body data={data} />
      </div>
    </section>
  );
}

function Body({ data }: { data: NonNullable<ReturnType<typeof useSprintForecast>['data']> }) {
  if (data.velocity_suppressed) {
    return (
      <p className="text-sm text-neutral-text-secondary" data-testid="forecast-suppressed">
        <span aria-hidden="true">🔒 </span>The backlog forecast is team-private (visible to the
        team).
      </p>
    );
  }

  // ADR-0130 D3: a continuous-flow (kanban) team forecasts from weekly throughput,
  // not sprint velocity. Branch on forecast_basis (NOT the legacy `basis`, web-rule
  // 176): the throughput path counts items + dates and has no sprint counts.
  if (data.forecast_basis === 'throughput') {
    return <ThroughputBody data={data} />;
  }

  if (data.status === 'warming_up' || data.p50_date === null || data.p80_date === null) {
    return (
      <p className="text-sm text-neutral-text-secondary" data-testid="forecast-warming-up">
        A backlog forecast appears once at least two sprints have closed
        {data.sample_count > 0 ? (
          <>
            {' '}
            (<span className="tppm-mono">{data.sample_count}</span> so far)
          </>
        ) : null}
        .
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-testid="forecast-ready">
      <p className="text-sm text-neutral-text-primary">
        At current velocity, the remaining backlog
        {data.remaining_points !== null ? (
          <>
            {' '}
            (<span className="tppm-mono">{data.remaining_points}</span> pts)
          </>
        ) : null}{' '}
        is forecast to clear by{' '}
        <span className="tppm-mono font-semibold">{formatShortDate(data.p50_date)}</span>.
      </p>
      <p className="text-xs text-neutral-text-secondary">
        P50 ≈ <span className="tppm-mono">{data.p50_sprints}</span> sprint
        {data.p50_sprints === 1 ? '' : 's'} · P80{' '}
        <span className="tppm-mono">{formatShortDate(data.p80_date)}</span> (
        <span className="tppm-mono">{data.p80_sprints}</span> sprint
        {data.p80_sprints === 1 ? '' : 's'}) · Monte&nbsp;Carlo over velocity
      </p>
    </div>
  );
}

/**
 * Throughput-basis forecast (ADR-0130 D3) — a flow team with no sprint cadence.
 * Counts items, not points; reports dates, not sprint counts. Both bases are real
 * Monte Carlo, so P50/P80/P95 stay honest (web-rule 166); only the vocabulary is
 * flow-native ("throughput", "items") rather than velocity ("velocity", "sprints").
 */
function ThroughputBody({
  data,
}: {
  data: NonNullable<ReturnType<typeof useSprintForecast>['data']>;
}) {
  if (data.status === 'insufficient_flow_history' || data.p50_date === null) {
    return (
      <p className="text-sm text-neutral-text-secondary" data-testid="forecast-insufficient-flow">
        A throughput forecast needs at least 4 weeks of completed-work history
        {data.sample_count > 0 ? (
          <>
            {' '}
            (<span className="tppm-mono">{data.sample_count}</span> so far)
          </>
        ) : null}
        .
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-testid="forecast-ready-throughput">
      <p className="text-sm text-neutral-text-primary">
        At current throughput, the remaining backlog
        {data.remaining_count !== null ? (
          <>
            {' '}
            (<span className="tppm-mono">{data.remaining_count}</span> item
            {data.remaining_count === 1 ? '' : 's'})
          </>
        ) : null}{' '}
        is forecast to clear by{' '}
        <span className="tppm-mono font-semibold">{formatShortDate(data.p50_date)}</span>.
      </p>
      <p className="text-xs text-neutral-text-secondary">
        P50 <span className="tppm-mono">{formatShortDate(data.p50_date)}</span>
        {data.p80_date ? (
          <>
            {' · P80 '}
            <span className="tppm-mono">{formatShortDate(data.p80_date)}</span>
          </>
        ) : null}
        {data.p95_date ? (
          <>
            {' · P95 '}
            <span className="tppm-mono">{formatShortDate(data.p95_date)}</span>
          </>
        ) : null}{' '}
        · Monte&nbsp;Carlo over weekly throughput
      </p>
    </div>
  );
}
