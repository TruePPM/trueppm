import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { AgentAction } from '@/api/types';
import { AgentIcon } from '@/components/Icons';
import { EmptyState } from '@/components/EmptyState';
import { useProgramId } from '@/hooks/useProgramId';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useProgramProjects } from '@/hooks/useProgramProjects';
import { useProgramAgentActions } from './useProgramAgentActions';
import { AgentActivityTable } from './AgentActivityTable';
import { AgentActionDrawer } from './AgentActionDrawer';
import { RefusalLog } from './RefusalLog';
import { AgentForecastImpact } from './AgentForecastImpact';
import { ChainVerifyBadge } from './ChainVerifyBadge';

type SubView = 'activity' | 'refusals' | 'forecast';
const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: 'activity', label: 'Activity' },
  { key: 'refusals', label: 'Refusals' },
  { key: 'forecast', label: 'Forecast impact' },
];

type Range = '24h' | '7d' | '30d' | 'all';
const RANGES: { key: Range; label: string; ms: number | null }[] = [
  { key: '24h', label: 'Last 24h', ms: 24 * 3_600_000 },
  { key: '7d', label: '7d', ms: 7 * 86_400_000 },
  { key: '30d', label: '30d', ms: 30 * 86_400_000 },
  { key: 'all', label: 'All', ms: null },
];

/**
 * The OSS per-program agent-oversight panel (#2020, ADR-0362, design note
 * docs/design/agent-oversight-panel-oss.md). A read-only projection of the
 * hash-chained AgentAction log (ADR-0112) + the program forecast rollup — never a
 * new data store. Three sub-views behind a segmented control: Activity (what the
 * agents did), Refusals (what the engine stopped, and why), and Forecast impact
 * (when the program lands given the agents' real work).
 */
export function ProgramAgentsPage() {
  const programId = useProgramId();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = (searchParams.get('view') as SubView) || 'activity';
  const [range, setRange] = useState<Range>('7d');
  const [selected, setSelected] = useState<AgentAction | null>(null);

  const setView = useCallback(
    (next: SubView) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === 'activity') p.delete('view');
          else p.set('view', next);
          return p;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Approximate lower bound, stable within a session per range so the query key
  // doesn't churn each render (mirrors ProgramResourcesPage's window memo).
  const since = useMemo(() => {
    const ms = RANGES.find((r) => r.key === range)?.ms ?? null;
    return ms === null ? undefined : new Date(Date.now() - ms).toISOString();
  }, [range]);

  const { user } = useCurrentUser();
  const { data: projects } = useProgramProjects(programId);

  const resolveProject = useCallback(
    (id: string | null) => projects?.find((p) => p.id === id)?.name ?? null,
    [projects],
  );
  const resolvePrincipal = useCallback(
    (id: string | null) => (id && user?.id === id ? 'You' : null),
    [user?.id],
  );

  return (
    <div className="px-6 py-5 max-w-5xl">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="m-0 text-lg font-semibold text-neutral-text-primary">Agents</h1>
          <p className="mt-1 text-sm text-neutral-text-secondary">
            A read-only projection of the tamper-evident agent-action log for this program.
          </p>
        </div>
        <ChainVerifyBadge />
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl view={view} onChange={setView} />
        {view !== 'forecast' && <RangeFilter range={range} onChange={setRange} />}
      </div>

      {view === 'activity' && (
        <ActivityView
          programId={programId}
          since={since}
          resolvePrincipal={resolvePrincipal}
          onSelect={setSelected}
        />
      )}
      {view === 'refusals' && (
        <RefusalsView
          programId={programId}
          since={since}
          resolvePrincipal={resolvePrincipal}
          onSelect={setSelected}
        />
      )}
      {view === 'forecast' && (
        <AgentForecastImpact programId={programId} onViewActivity={() => setView('activity')} />
      )}

      <AgentActionDrawer
        action={selected}
        projectName={selected ? resolveProject(selected.project) : null}
        principalName={selected ? resolvePrincipal(selected.principal) : null}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function ActivityView({
  programId,
  since,
  resolvePrincipal,
  onSelect,
}: {
  programId: string | undefined;
  since: string | undefined;
  resolvePrincipal: (id: string | null) => string | null;
  onSelect: (a: AgentAction) => void;
}) {
  const q = useProgramAgentActions(programId, { since });
  if (q.isLoading) return <TableSkeleton />;
  if (q.isError) return <ErrorState onRetry={q.refetch} />;
  if (q.actions.length === 0) {
    return (
      <EmptyState
        icon={AgentIcon}
        title="No agent activity yet"
        description="When an MCP client or agent acts in this program, every action it takes is recorded here — tamper-evident and verifiable."
        action={
          <Link
            to="/me/settings/api-tokens"
            className="rounded-control bg-brand-primary px-3 py-2 text-sm font-medium text-neutral-text-inverse hover:opacity-90"
          >
            Connect an agent →
          </Link>
        }
      />
    );
  }
  return (
    <AgentActivityTable
      actions={q.actions}
      resolvePrincipal={resolvePrincipal}
      onSelect={onSelect}
      hasNextPage={q.hasNextPage}
      fetchNextPage={q.fetchNextPage}
      isFetchingNextPage={q.isFetchingNextPage}
      showReadOnlyStrip={q.actions.every((a) => a.method === 'GET')}
    />
  );
}

function RefusalsView({
  programId,
  since,
  resolvePrincipal,
  onSelect,
}: {
  programId: string | undefined;
  since: string | undefined;
  resolvePrincipal: (id: string | null) => string | null;
  onSelect: (a: AgentAction) => void;
}) {
  const q = useProgramAgentActions(programId, { since, verdict: 'refused' });
  if (q.isLoading) return <TableSkeleton />;
  if (q.isError) return <ErrorState onRetry={q.refetch} />;
  return (
    <RefusalLog
      refusals={q.actions}
      resolvePrincipal={resolvePrincipal}
      onSelect={onSelect}
      hasNextPage={q.hasNextPage}
      fetchNextPage={q.fetchNextPage}
      isFetchingNextPage={q.isFetchingNextPage}
    />
  );
}

function SegmentedControl({ view, onChange }: { view: SubView; onChange: (v: SubView) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Agent oversight views"
      className="inline-flex items-center gap-1 self-start rounded-control border border-neutral-border bg-neutral-surface-sunken p-0.5"
    >
      {SUB_VIEWS.map(({ key, label }) => {
        const active = view === key;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={[
              'inline-flex min-h-[44px] items-center rounded-chip px-3 text-xs font-medium transition-colors md:min-h-[32px]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              active
                ? 'bg-brand-primary text-neutral-text-inverse'
                : 'text-neutral-text-secondary hover:bg-neutral-surface-raised hover:text-neutral-text-primary',
            ].join(' ')}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function RangeFilter({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-text-secondary">
      Range{' '}
      <select
        value={range}
        onChange={(e) => onChange(e.target.value as Range)}
        className="rounded-control border border-neutral-border bg-neutral-surface px-2 py-1 text-xs text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        {RANGES.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label="Loading agent activity">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-12 rounded-card border border-neutral-border bg-neutral-surface-raised motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-card border border-semantic-critical/30 bg-semantic-critical-bg px-4 py-3 text-sm text-semantic-critical"
    >
      Couldn&rsquo;t load agent activity.{' '}
      <button type="button" onClick={onRetry} className="font-medium underline">
        Try again
      </button>
    </div>
  );
}
