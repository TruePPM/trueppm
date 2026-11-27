import { Link } from 'react-router';
import type { Program } from '@/api/types';
import { DefinitionTip } from '@/components/page2/DefinitionTip';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { SCurveChart, forecastToSCurveProps } from '@/features/charts';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { formatRelative } from '@/lib/formatRelative';
import { projectPath } from '@/lib/refPath';
import type { Project } from '@/types';
import type { UseMonteCarloResultReturn } from '@/hooks/useMonteCarloResult';
import { slipCard, type ForecastHeroState } from './programHomeModel';

/**
 * The forecast hero both the PM and Executive homes lead with: the program's P80
 * finish, its "as of", the commitment delta, and the S-curve of the run that drives
 * it. The date and the sentence are the rollup's; the curve and the delta are the
 * driver project's saved Monte Carlo run. Nothing is computed here.
 */
export function ProgramForecastHero({
  program,
  hero,
  mc,
  driver,
  onRetry,
}: {
  program: Program;
  hero: ForecastHeroState;
  mc: UseMonteCarloResultReturn;
  driver: Project | null;
  onRetry: () => void;
}) {
  return (
    <section
      aria-labelledby="home-forecast"
      className="flex flex-col gap-3 rounded-lg border border-p1-hairline bg-p1-surface-1 p-4 md:p-5"
    >
      <h2 id="home-forecast" className="text-sm font-semibold text-p1-text-1">
        Forecast · {program.name}
      </h2>
      {hero.kind === 'loading' && <LoadingSkeleton label="Loading forecast…" rows={3} />}
      {hero.kind === 'error' && (
        <QueryErrorState message="Couldn't load the forecast." onRetry={onRetry} />
      )}
      {hero.kind === 'none' && <p className="text-sm text-p1-text-2">{hero.reason}</p>}
      {hero.kind === 'ready' && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          <div className="flex flex-col gap-2">
            <span className="text-xs text-p1-text-2">
              <DefinitionTip term="P80 finish" definition={hero.definition} />
            </span>
            <span className="font-mono text-3xl font-semibold tabular-nums text-p1-text-1">
              {fmtUtcShort(hero.p80)}
            </span>
            {hero.asOf && (
              <span className="text-xs text-p1-text-3">
                As of {formatRelative(new Date(hero.asOf))}
              </span>
            )}
            <CommitmentLine mc={mc} />
            {hero.projectsWithoutForecast > 0 && (
              <span className="text-xs text-p1-text-2">
                {hero.projectsWithoutForecast}{' '}
                {hero.projectsWithoutForecast === 1 ? 'project has' : 'projects have'} no forecast
                yet
              </span>
            )}
            {hero.projectsWithStaleForecast > 0 && (
              <span className="text-xs text-p1-risk-text">
                <span aria-hidden="true">◆ </span>
                {hero.staleLine}
              </span>
            )}
            {driver && (
              <Link
                to={projectPath(driver, 'forecast')}
                className="inline-flex min-h-[44px] items-center text-sm text-p1-brand underline focus:outline-none focus:ring-2 focus:ring-p1-focus"
              >
                Why this date? Open {driver.name} forecast
              </Link>
            )}
          </div>
          <div className="min-w-0">
            {mc.isLoading && <LoadingSkeleton label="Loading curve…" rows={3} />}
            {mc.error && (
              <QueryErrorState
                variant="inline"
                message="Couldn't load the curve."
                onRetry={() => void mc.refetch?.()}
              />
            )}
            {!mc.isLoading && !mc.error && mc.data?.p80 && (
              <SCurveChart {...forecastToSCurveProps(mc.data)} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function CommitmentLine({ mc }: { mc: UseMonteCarloResultReturn }) {
  const slip = slipCard(mc.data);
  const definition = mc.data?.definitions?.p80_delta_vs_commitment_days;
  if (slip.kind === 'none') return null;
  return (
    <span className="text-sm text-p1-text-1">
      <DefinitionTip
        term={
          slip.kind === 'past'
            ? `${slip.days}d past commitment`
            : slip.days === 0
              ? 'On commitment'
              : `${slip.days}d ahead of commitment`
        }
        definition={definition}
      />
    </span>
  );
}
