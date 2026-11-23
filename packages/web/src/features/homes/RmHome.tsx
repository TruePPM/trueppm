import { Link } from 'react-router';
import { usePeopleLoad } from '@/hooks/usePeopleLoad';
import { OverallocBanner } from '@/components/Overalloc';
import { LoadHeatMap } from '@/features/people/LoadHeatMap';
import { PEOPLE_PATH } from '@/features/people/peoplePath';
import { rmHomeState, rmScopeLine } from './rmHomeModel';

const LINK =
  'inline-flex h-11 items-center rounded-md px-2 text-sm text-p1-text-1 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus';

/**
 * The Resource Manager home (#4770): team load across the projects where the
 * viewer can read per-person load. Renders in `/home` when the server resolves
 * `landing.home = "rm"`. Same `LoadHeatMap` and the same `usePeopleLoad` query as
 * the People destination, so the home and the destination cannot disagree.
 */
export function RmHome() {
  const query = usePeopleLoad();
  const state = rmHomeState(query);
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4 md:py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-p1-text-1">Team load</h1>
          {state.kind === 'ready' && <p className="text-sm text-p1-text-2">{rmScopeLine(state)}</p>}
        </div>
        <Link to={PEOPLE_PATH} className={LINK}>
          Open People
        </Link>
      </div>
      {state.kind === 'ready' && <OverallocBanner count={state.overAllocated} />}
      <LoadHeatMap
        data={query.data}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => void query.refetch()}
        label="Team load by person and week"
      />
    </div>
  );
}
