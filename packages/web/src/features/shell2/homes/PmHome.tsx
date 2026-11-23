import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { usePrograms } from '@/hooks/usePrograms';
import { useProgramProjects } from '@/hooks/useProgramProjects';
import { useProjectsHealthSummary } from '@/hooks/useProjectsHealthSummary';
import { useProjectBlocked } from '@/hooks/useBlockedRollup';
import { PageFrame } from '@/components/page2/PageFrame';
import { PageTitle } from '@/components/page2/PageTitle';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { projectPath } from '@/lib/refPath';
import { chooseProgram, projectRows, slipCard } from './programHomeModel';
import { useProgramForecast } from './useProgramForecast';
import { ProgramForecastHero } from './ProgramForecastHero';
import { ProgramDecisionsCard } from './ProgramDecisionsCard';
import { ProgramProjectsTable } from './ProgramProjectsTable';
import { ProgramSwitcher } from './ProgramSwitcher';

const CARD = 'flex flex-col gap-1 rounded-lg border border-p1-hairline bg-p1-surface-1 p-4';
const LINK =
  'inline-flex min-h-[44px] items-center text-sm text-p1-brand underline focus:outline-none focus:ring-2 focus:ring-p1-focus';

/**
 * Shell-v2 PM home (#4769): the program's forecast, the two things to look at
 * first (biggest slip, what is blocked), decisions waiting, and the projects.
 * Opens on the first program the server lists; the switcher changes the view only.
 */
export function PmHome() {
  const programsQuery = usePrograms();
  const [chosen, setChosen] = useState<string | null>(null);
  const program = chooseProgram(programsQuery.data, chosen);
  const forecast = useProgramForecast(program?.id);
  const projectsQuery = useProgramProjects(program?.id);
  const health = useProjectsHealthSummary();
  const rows = useMemo(
    () => projectRows(projectsQuery.data, health.data),
    [projectsQuery.data, health.data],
  );
  const driver = useMemo(
    () => projectsQuery.data?.find((p) => p.id === forecast.driverId) ?? null,
    [projectsQuery.data, forecast.driverId],
  );
  const blocked = useProjectBlocked(forecast.driverId);

  if (programsQuery.error) {
    return (
      <QueryErrorState
        message="Couldn't load your programs."
        onRetry={() => void programsQuery.refetch()}
      />
    );
  }
  if (programsQuery.isLoading) return <LoadingSkeleton label="Loading…" variant="shell" rows={4} />;
  if (!program) {
    return (
      <PageFrame width="contained" header={<PageTitle>Home</PageTitle>}>
        <section aria-labelledby="home-empty" className="flex flex-col gap-2 py-8">
          <h2 id="home-empty" className="text-base font-semibold text-p1-text-1">
            No programs yet
          </h2>
          <p className="text-sm text-p1-text-2">
            Create a program to see its forecast, what is slipping and what is blocked here.
          </p>
          <Link to="/programs" className={LINK}>
            Go to programs
          </Link>
        </section>
      </PageFrame>
    );
  }

  const slip = slipCard(forecast.mc.data);
  const programs = programsQuery.data ?? [];
  return (
    <PageFrame
      width="contained"
      header={
        <PageTitle description="Forecast, what to look at first, and your projects.">
          Home
        </PageTitle>
      }
      toolbar={
        programs.length > 1 ? (
          <ProgramSwitcher programs={programs} value={program.id} onChange={setChosen} />
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <ProgramForecastHero
          program={program}
          hero={forecast.hero}
          mc={forecast.mc}
          driver={driver}
          onRetry={() => void forecast.rollup.refetch()}
        />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <article aria-labelledby="focus-slip" className={CARD}>
            <h2 id="focus-slip" className="text-xs font-medium text-p1-text-2">
              Biggest slip
            </h2>
            {driver && slip.kind !== 'none' ? (
              <>
                <span className="text-base font-semibold text-p1-text-1">{driver.name}</span>
                <span className="text-sm text-p1-text-2">
                  {slip.kind === 'past'
                    ? `P80 is ${slip.days} working ${slip.days === 1 ? 'day' : 'days'} past commitment.`
                    : 'P80 is within commitment.'}
                </span>
                <Link to={projectPath(driver, 'schedule')} className={LINK}>
                  Open in Plan
                </Link>
              </>
            ) : (
              <span className="text-sm text-p1-text-2">
                Nothing to compare with a commitment yet.
              </span>
            )}
          </article>
          <article aria-labelledby="focus-blocked" className={CARD}>
            <h2 id="focus-blocked" className="text-xs font-medium text-p1-text-2">
              Blocked
            </h2>
            {blocked.error ? (
              <QueryErrorState
                variant="inline"
                message="Couldn't load blocked work."
                onRetry={() => void blocked.refetch()}
              />
            ) : driver && blocked.data ? (
              blocked.data.count === 0 ? (
                <span className="text-sm text-p1-text-2">Nothing is blocked in {driver.name}.</span>
              ) : (
                <>
                  <span className="text-base font-semibold text-p1-text-1">
                    {blocked.data.count} blocked in {driver.name}
                  </span>
                  <span className="text-sm text-p1-text-2">
                    Longest waiting: {blocked.data.blocked[0]?.title}
                  </span>
                  <Link to={projectPath(driver, 'board')} className={LINK}>
                    Open in Deliver
                  </Link>
                </>
              )
            ) : (
              <span className="text-sm text-p1-text-2">Nothing to show until a forecast runs.</span>
            )}
          </article>
          <ProgramDecisionsCard program={program} />
        </div>
        <section aria-labelledby="home-projects" className="flex flex-col gap-2">
          <h2 id="home-projects" className="text-sm font-semibold text-p1-text-1">
            Projects
          </h2>
          {projectsQuery.error ? (
            <QueryErrorState
              variant="inline"
              message="Couldn't load projects."
              onRetry={() => void projectsQuery.refetch()}
            />
          ) : projectsQuery.isLoading ? (
            <LoadingSkeleton label="Loading projects…" rows={3} />
          ) : (
            <ProgramProjectsTable rows={rows} />
          )}
        </section>
      </div>
    </PageFrame>
  );
}
