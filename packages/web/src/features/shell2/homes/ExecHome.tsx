import { useMemo, useState } from 'react';
import { usePrograms } from '@/hooks/usePrograms';
import { useProgramProjects } from '@/hooks/useProgramProjects';
import { useProjectsHealthSummary } from '@/hooks/useProjectsHealthSummary';
import { PageFrame } from '@/components/page2/PageFrame';
import { PageTitle } from '@/components/page2/PageTitle';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { projectRows } from './programHomeModel';
import { useProgramForecast } from './useProgramForecast';
import { ProgramForecastHero } from './ProgramForecastHero';
import { ProgramDecisionsCard } from './ProgramDecisionsCard';
import { ProgramProjectsTable } from './ProgramProjectsTable';
import { ProgramShareStatus } from './ProgramShareStatus';
import { ProgramSwitcher } from './ProgramSwitcher';

/**
 * Shell-v2 Executive home (#4771): ONE program at a time. It opens on the program
 * the server chose (`landing.home_program`); the switcher lists the viewer's
 * programs and changes only what is shown, never the stored value. There is no
 * cross-program rollup here: that is portfolio governance, which is Enterprise.
 * With no program the home opens on the switcher's empty state.
 */
export function ExecHome({ initialProgramId }: { initialProgramId: string | null }) {
  const programsQuery = usePrograms();
  const [chosen, setChosen] = useState<string | null>(initialProgramId);
  const programs = programsQuery.data ?? [];
  const program = programs.find((p) => p.id === chosen) ?? null;
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

  if (programsQuery.error) {
    return (
      <QueryErrorState
        message="Couldn't load your programs."
        onRetry={() => void programsQuery.refetch()}
      />
    );
  }
  if (programsQuery.isLoading) return <LoadingSkeleton label="Loading…" variant="shell" rows={4} />;

  return (
    <PageFrame
      width="contained"
      header={<PageTitle description="One program at a time.">Home</PageTitle>}
      toolbar={
        programs.length > 0 ? (
          <ProgramSwitcher programs={programs} value={program?.id ?? null} onChange={setChosen} />
        ) : undefined
      }
    >
      {!program ? (
        <section aria-labelledby="home-empty" className="flex flex-col gap-2 py-8">
          <h2 id="home-empty" className="text-base font-semibold text-p1-text-1">
            {programs.length === 0 ? 'No programs to show' : 'Choose a program'}
          </h2>
          <p className="text-sm text-p1-text-2">
            {programs.length === 0
              ? 'Programs you can see will appear here.'
              : 'Pick a program above to see its forecast and what needs your decision.'}
          </p>
        </section>
      ) : (
        <div className="flex flex-col gap-4">
          <ProgramForecastHero
            program={program}
            hero={forecast.hero}
            mc={forecast.mc}
            driver={driver}
            onRetry={() => void forecast.rollup.refetch()}
          />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <ProgramDecisionsCard program={program} />
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
          {!projectsQuery.error && !projectsQuery.isLoading && <ProgramShareStatus rows={rows} />}
        </div>
      )}
    </PageFrame>
  );
}
