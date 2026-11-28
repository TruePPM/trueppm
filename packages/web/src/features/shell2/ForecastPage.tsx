import { Navigate } from 'react-router';
import { useFeatureFlag } from '@/lib/featureFlags';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjectRef } from '@/hooks/useProjectRef';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useRunMonteCarlo } from '@/hooks/useRunMonteCarlo';
import { useCanRunMonteCarlo, MC_RUN_ROLE_NOTE } from '@/hooks/useCanRunMonteCarlo';
import { PageFrame } from '@/components/page2/PageFrame';
import { PageTitle } from '@/components/page2/PageTitle';
import { DefinitionTip } from '@/components/page2/DefinitionTip';
import { PAGE_BUTTON } from '@/components/page2/classes';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { HistogramChart, SCurveChart, forecastToSCurveProps } from '@/features/charts';
import { formatRelative } from '@/lib/formatRelative';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { SHELL_V2_FLAG } from './shellFlag';
import { forecastViewState, staleMessage, runRefusalText } from './forecastViewModel';

const BUTTON =
  `inline-flex h-9 items-center rounded-md bg-p1-brand px-3 text-sm font-medium text-white ` +
  `hover:opacity-90 disabled:opacity-60 focus:outline-none focus:ring-2 ${PAGE_BUTTON}`;

/**
 * Shell-v2 Monte Carlo view: the finish-date distribution with the server's
 * P50/P80/P95, its "as of", and a run action. Behind `shell_v2`; with the flag
 * off it sends the visitor to the project's Overview.
 */
export function ForecastPage() {
  const v2 = useFeatureFlag(SHELL_V2_FLAG);
  const ref = useProjectRef();
  if (!v2) return <Navigate to={ref ? `/projects/${ref}/overview` : '/'} replace />;
  return <ForecastBody />;
}

function RunButton({ projectId, label }: { projectId: string | undefined; label: string }) {
  const run = useRunMonteCarlo(projectId);
  const canRun = useCanRunMonteCarlo(projectId);
  const refusal = run.isError ? runRefusalText(run.error) : null;
  if (!canRun) return null;
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className={BUTTON}
        disabled={run.isPending || !projectId}
        onClick={() => run.mutate({})}
      >
        {run.isPending ? 'Running…' : label}
      </button>
      {refusal && (
        <span role="alert" className="text-sm text-p1-text-2">
          {refusal}
        </span>
      )}
    </div>
  );
}

function ForecastBody() {
  const projectId = useProjectId();
  const query = useMonteCarloResult(projectId);
  const canRun = useCanRunMonteCarlo(projectId);
  const state = forecastViewState(query);

  return (
    <PageFrame
      width="contained"
      header={<PageTitle description="Monte Carlo finish-date distribution.">Forecast</PageTitle>}
      toolbar={<RunButton projectId={projectId} label="Run forecast" />}
    >
      {state.kind === 'loading' && <LoadingSkeleton label="Loading forecast…" rows={4} />}
      {state.kind === 'error' && (
        <QueryErrorState message="Couldn't load the forecast." onRetry={() => query.refetch?.()} />
      )}
      {state.kind === 'not-run' && (
        <section aria-labelledby="forecast-empty" className="flex flex-col gap-2 py-8">
          <h2 id="forecast-empty" className="text-base font-semibold text-p1-text-1">
            Not run yet
          </h2>
          <p className="text-sm text-p1-text-2">
            {canRun
              ? 'Run a forecast to see the range of finish dates this schedule could reach.'
              : `No forecast has been run for this schedule. ${MC_RUN_ROLE_NOTE}`}
          </p>
        </section>
      )}
      {state.kind === 'ready' && (
        <div className="flex flex-col gap-4">
          <dl className="flex flex-wrap gap-6">
            {(['p50', 'p80', 'p95'] as const).map((k) => (
              <div key={k} className="flex flex-col">
                <dt className="text-xs text-p1-text-2">
                  <DefinitionTip
                    term={k.toUpperCase()}
                    definition={state.result.definitions?.[k]}
                  />
                </dt>
                <dd className="font-mono text-lg font-semibold tabular-nums text-p1-text-1">
                  {fmtUtcShort(state.result[k])}
                </dd>
              </div>
            ))}
          </dl>
          {/* Rule 415: when the server says the run no longer describes the plan,
              the "as of" claim is replaced, not left beside a warning. */}
          {state.stale ? (
            <p role="status" className="text-sm font-medium text-p1-text-1">
              {staleMessage(state.result.forecastStaleness)}
            </p>
          ) : (
            state.asOf && (
              <p className="text-xs text-p1-text-3">As of {formatRelative(new Date(state.asOf))}</p>
            )
          )}
          <SCurveChart {...forecastToSCurveProps(state.result)} />
          {state.result.buckets && state.result.buckets.length > 0 && (
            <HistogramChart
              title="Finish by week"
              buckets={state.result.buckets}
              markers={(['p50', 'p80', 'p95'] as const).map((k) => ({
                key: k,
                label: k.toUpperCase(),
                date: state.result[k],
              }))}
            />
          )}
        </div>
      )}
    </PageFrame>
  );
}
