import { useMemo } from 'react';
import { Link } from 'react-router';

import {
  useProjectsHealthSummary,
  type HealthBand,
  type ProjectHealthRow,
} from '@/hooks/useProjectsHealthSummary';
import { QueryErrorState } from '@/components/QueryErrorState';

/**
 * Compact "my projects" health triage for the My Work page (ADR-0401/#1941).
 *
 * Answers "which of my projects is on fire?" at a glance: three band tallies
 * (how many of the user's projects sit in each band) plus a drill-to-worst chip
 * that deep-links to the single worst project's overview. Scoped to the user's own
 * projects (adoption lens) — it is NOT a portfolio dashboard, and it reuses the
 * existing semantic health tokens rather than inventing any.
 *
 * Visibility: renders only when the user has ≥2 projects. A summary of one project
 * is redundant with that project's in-shell HealthCluster, and an empty summary is
 * dead space — so the component returns null (there is deliberately no zero-results
 * empty state here; My Work's own empty state covers the no-work case).
 */

const BAND_ORDINAL: Record<HealthBand, number> = {
  on_track: 0,
  at_risk: 1,
  critical: 2,
};

const BAND_DOT: Record<HealthBand, string> = {
  critical: 'bg-semantic-critical',
  at_risk: 'bg-semantic-at-risk',
  on_track: 'bg-semantic-on-track',
};

const BAND_LABEL: Record<HealthBand, string> = {
  critical: 'critical',
  at_risk: 'at risk',
  on_track: 'on track',
};

/** Rank order for the tally row and the "worst project" pick — worst leads. */
const TALLY_ORDER: HealthBand[] = ['critical', 'at_risk', 'on_track'];

function pickWorst(rows: ProjectHealthRow[]): ProjectHealthRow | null {
  let worst: ProjectHealthRow | null = null;
  for (const row of rows) {
    if (
      worst === null ||
      BAND_ORDINAL[row.healthBand] > BAND_ORDINAL[worst.healthBand] ||
      (BAND_ORDINAL[row.healthBand] === BAND_ORDINAL[worst.healthBand] &&
        (row.criticalCount > worst.criticalCount ||
          (row.criticalCount === worst.criticalCount && row.atRiskCount > worst.atRiskCount)))
    ) {
      worst = row;
    }
  }
  return worst;
}

function worstReason(worst: ProjectHealthRow): string | null {
  if (worst.healthBand === 'critical') {
    const n = worst.criticalCount;
    return `${n} critical ${n === 1 ? 'task' : 'tasks'}`;
  }
  if (worst.healthBand === 'at_risk') {
    const n = worst.atRiskCount;
    return `${n} at-risk ${n === 1 ? 'task' : 'tasks'}`;
  }
  return null;
}

export function MyProjectsHealthSummary() {
  const { data, isLoading, error, refetch } = useProjectsHealthSummary();

  const counts = useMemo(() => {
    const acc: Record<HealthBand, number> = { critical: 0, at_risk: 0, on_track: 0 };
    for (const row of data ?? []) acc[row.healthBand] += 1;
    return acc;
  }, [data]);

  const worst = useMemo(() => (data ? pickWorst(data) : null), [data]);

  if (error) {
    return (
      <section aria-label="Project health summary" className="mx-auto w-full max-w-[1100px] px-4 md:px-6">
        <QueryErrorState
          variant="inline"
          message="Couldn't load project health."
          onRetry={refetch}
        />
      </section>
    );
  }

  if (isLoading) {
    return (
      <section aria-label="Project health summary" className="mx-auto w-full max-w-[1100px] px-4 md:px-6">
        <div
          className="h-[60px] animate-pulse rounded-card border border-neutral-border bg-neutral-surface-sunken"
          aria-hidden="true"
        />
      </section>
    );
  }

  // Below the "many projects" threshold there is nothing to triage — hide entirely.
  if (!data || data.length < 2) return null;

  const showWorst = worst !== null && worst.healthBand !== 'on_track';

  return (
    <section aria-label="Project health summary" className="mx-auto w-full max-w-[1100px] px-4 md:px-6">
      <div
        className="flex flex-col gap-3 rounded-card border border-neutral-border bg-neutral-surface px-4 py-3
          md:flex-row md:items-center md:gap-4"
      >
        <span className="text-sm font-semibold text-neutral-text-primary">My projects</span>

        {/* Band tallies — project counts by band; a zero tally is muted. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {TALLY_ORDER.map((band) => {
            const n = counts[band];
            return (
              <span key={band} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${BAND_DOT[band]}`} aria-hidden="true" />
                <span
                  className={`text-sm font-medium ${n > 0 ? 'text-neutral-text-primary' : 'text-neutral-text-secondary'}`}
                >
                  {n}
                </span>
                <span className="text-sm text-neutral-text-secondary">{BAND_LABEL[band]}</span>
              </span>
            );
          })}
        </div>

        {/* Drill to worst — a nav affordance to the single worst project's
            overview. When every project is on track there is nothing to chase, so
            show a calm confirmation instead of a chip. */}
        {showWorst && worst ? (
          <Link
            to={`/projects/${worst.id}/overview`}
            className="flex min-h-[44px] items-center gap-2 rounded-control border border-neutral-border px-3
              hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary
              md:ml-auto md:min-h-0 md:h-9"
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${BAND_DOT[worst.healthBand]}`} aria-hidden="true" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="min-w-0 truncate text-sm font-medium text-neutral-text-primary">
                {worst.name}
              </span>
              {worstReason(worst) && (
                <span className="text-xs text-neutral-text-secondary">{worstReason(worst)}</span>
              )}
            </span>
            <span aria-hidden="true" className="shrink-0 text-neutral-text-secondary">
              ›
            </span>
          </Link>
        ) : (
          <span className="text-sm text-neutral-text-secondary md:ml-auto">All on track</span>
        )}
      </div>
    </section>
  );
}
