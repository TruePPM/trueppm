import { lazy, Suspense, useRef, type KeyboardEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useFeatureFlag } from '@/lib/featureFlags';
import { SHELL_V2_FLAG } from '@/features/shell2/shellFlag';
import { usePeopleLoad } from '@/hooks/usePeopleLoad';
import { OverallocBanner } from '@/components/Overalloc';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { LoadHeatMap } from './LoadHeatMap';

const ResourcesPage = lazy(() =>
  import('@/features/resources/ResourcesPage').then((m) => ({ default: m.ResourcesPage })),
);

type PeopleView = 'capacity' | 'directory';
const VIEWS: ReadonlyArray<{ key: PeopleView; label: string }> = [
  { key: 'capacity', label: 'Capacity' },
  { key: 'directory', label: 'Directory' },
];

/**
 * `/people` — the shell v2 People destination (#4761). Capacity first: the load
 * heat map over the projects where the viewer can read per-person load, with the
 * roster (the v1 resource catalog) as the second tab. Behind `shell_v2`: with the
 * flag off the route sends the person to the v1 catalog at `/resources`.
 */
export function PeoplePage() {
  const v2 = useFeatureFlag(SHELL_V2_FLAG);
  if (!v2) return <Navigate to="/resources" replace />;
  return <PeoplePageBody />;
}

function PeoplePageBody() {
  const [params, setParams] = useSearchParams();
  const view: PeopleView = params.get('view') === 'directory' ? 'directory' : 'capacity';
  const tabRefs = useRef(new Map<PeopleView, HTMLButtonElement>());

  const select = (next: PeopleView, focus = false) => {
    setParams(next === 'capacity' ? {} : { view: next }, { replace: true });
    if (focus) tabRefs.current.get(next)?.focus();
  };
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    select(view === 'capacity' ? 'directory' : 'capacity', true);
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4 md:py-6">
      <h1 className="text-lg font-semibold text-p1-text-1">People</h1>
      <div
        role="tablist"
        aria-label="People views"
        className="mt-3 flex gap-1 border-b border-p1-hairline"
      >
        {VIEWS.map((v) => (
          <button
            key={v.key}
            ref={(el) => {
              if (el) tabRefs.current.set(v.key, el);
              else tabRefs.current.delete(v.key);
            }}
            type="button"
            role="tab"
            id={`people-tab-${v.key}`}
            aria-selected={view === v.key}
            aria-controls={`people-panel-${v.key}`}
            tabIndex={view === v.key ? 0 : -1}
            onClick={() => select(v.key)}
            onKeyDown={onTabKey}
            className="-mb-px h-11 border-b-2 border-transparent px-3 text-sm text-p1-text-2 hover:text-p1-text-1 focus:outline-none focus:ring-2 focus:ring-p1-focus focus:ring-inset aria-selected:border-p1-brand aria-selected:font-medium aria-selected:text-p1-text-1"
          >
            {v.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`people-panel-${view}`}
        aria-labelledby={`people-tab-${view}`}
        className="pt-4"
      >
        {view === 'capacity' ? (
          <CapacityPanel />
        ) : (
          <Suspense fallback={<LoadingSkeleton label="Loading people…" variant="rows" rows={5} />}>
            <ResourcesPage />
          </Suspense>
        )}
      </div>
    </div>
  );
}

function CapacityPanel() {
  const { data, isLoading, isError, refetch } = usePeopleLoad();
  return (
    <div className="flex flex-col gap-3">
      {data && <OverallocBanner count={data.over_allocated_count} />}
      <LoadHeatMap
        data={data}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        label="Load by person and week"
      />
    </div>
  );
}
