import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { apiClient } from '@/api/client';

// ---------------------------------------------------------------------------
// API response types (GET /programs/{id}/rollup/ — ADR-0088, #713)
// ---------------------------------------------------------------------------

type HealthBand = 'on_track' | 'at_risk' | 'critical' | 'unknown';
type AggregationPolicy = 'worst' | 'average' | 'weighted_by_budget' | 'task_weighted';

/** A built KPI: value present (may be null when there is no data yet). */
interface AvailableKpi {
  available: true;
  value: string | number | null;
  unit?: 'calendar_days';
}

/** A deferred KPI: no per-project source yet (#753/#754). */
interface UnavailableKpi {
  available: false;
  reason: 'no_cost_data' | 'no_montecarlo_store';
}

type RollupKpiEntry = AvailableKpi | UnavailableKpi;

interface ProgramRollup {
  aggregation_policy: AggregationPolicy;
  policy_available: boolean;
  project_count: number;
  program_health: HealthBand;
  kpis: Record<string, RollupKpiEntry>;
}

// ---------------------------------------------------------------------------
// Display metadata
// ---------------------------------------------------------------------------

const KPI_LABELS: Record<string, string> = {
  schedule_health: 'Schedule health',
  milestone_health: 'Milestone health',
  baseline_variance: 'Baseline variance',
  schedule_variance: 'Schedule variance',
  critical_tasks: 'Critical tasks',
  at_risk_tasks: 'At-risk tasks',
  risk_score: 'Risk score',
  cost_variance: 'Cost variance',
  budget_utilization: 'Budget utilization',
  p80_completion: 'P80 completion',
};

const HEALTH_KPIS = new Set(['schedule_health', 'milestone_health']);
const VARIANCE_KPIS = new Set(['baseline_variance', 'schedule_variance']);

const HEALTH_LABEL: Record<HealthBand, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  critical: 'Critical',
  unknown: 'Unknown',
};

// Health band → KpiCard variant. unknown is neutral so a data-less program is
// not painted as a problem (mirrors ProjectOverviewPage).
const HEALTH_VARIANT: Record<HealthBand, KpiVariant> = {
  on_track: 'on-track',
  at_risk: 'at-risk',
  critical: 'critical',
  unknown: 'neutral',
};

const POLICY_LABEL: Record<AggregationPolicy, string> = {
  worst: 'Worst-case',
  average: 'Average',
  weighted_by_budget: 'Budget-weighted',
  task_weighted: 'Task-weighted',
};

// Plain-language explanation for a deferred KPI, keyed by its machine reason so
// the PM understands why a KPI they enabled is blank rather than seeing nothing.
const DEFERRED_REASON_LABEL: Record<UnavailableKpi['reason'], string> = {
  no_cost_data: 'Needs cost data',
  no_montecarlo_store: 'Needs a saved Monte Carlo run',
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useProgramRollup(programId: string | undefined) {
  return useQuery<ProgramRollup>({
    queryKey: ['program-rollup', programId],
    queryFn: async () => {
      const res = await apiClient.get<ProgramRollup>(`/programs/${programId}/rollup/`);
      return res.data;
    },
    enabled: !!programId,
  });
}

// ---------------------------------------------------------------------------
// KPI card (mirrors ProjectOverviewPage's KpiCard visual language)
// ---------------------------------------------------------------------------

type KpiVariant = 'on-track' | 'at-risk' | 'critical' | 'neutral';

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  variant?: KpiVariant;
  /** Deferred KPI — render muted/dashed so it reads as "not yet available". */
  muted?: boolean;
}

function KpiCard({ label, value, sub, variant = 'neutral', muted = false }: KpiCardProps) {
  const valueColor = muted
    ? 'text-neutral-text-disabled'
    : {
        'on-track': 'text-semantic-on-track',
        'at-risk': 'text-semantic-at-risk',
        critical: 'text-semantic-critical',
        neutral: 'text-neutral-text-primary',
      }[variant];

  const border = muted ? 'border-dashed border-neutral-border' : 'border-neutral-border';

  return (
    <div
      className={`flex flex-col gap-1 p-4 rounded border ${border} bg-neutral-surface-raised min-w-0 overflow-hidden [container-type:inline-size]`}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary truncate">
        {label}
      </span>
      <span
        className={`font-semibold tppm-mono break-words leading-tight text-[clamp(0.875rem,7cqi,1.5rem)] ${valueColor}`}
      >
        {value}
      </span>
      {sub && <span className="text-xs text-neutral-text-disabled tppm-mono truncate">{sub}</span>}
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-24 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised"
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI value formatting
// ---------------------------------------------------------------------------

/** Format a signed day-variance as "+9d" / "−3d" / "—". Late (positive) is bad. */
function formatVariance(value: number | null): { display: string; variant: KpiVariant } {
  if (value === null) return { display: '—', variant: 'neutral' };
  const rounded = Math.round(value);
  if (rounded > 0) return { display: `+${rounded}d`, variant: 'at-risk' };
  if (rounded < 0) return { display: `${rounded}d`, variant: 'on-track' };
  return { display: '0d', variant: 'neutral' };
}

interface RenderedKpi {
  key: string;
  label: string;
  value: string;
  sub?: string;
  variant: KpiVariant;
  muted: boolean;
}

function renderKpi(key: string, entry: RollupKpiEntry): RenderedKpi {
  const label = KPI_LABELS[key] ?? key;

  if (!entry.available) {
    return { key, label, value: '—', sub: DEFERRED_REASON_LABEL[entry.reason], variant: 'neutral', muted: true };
  }

  if (HEALTH_KPIS.has(key)) {
    const band = (entry.value as HealthBand) ?? 'unknown';
    return { key, label, value: HEALTH_LABEL[band], variant: HEALTH_VARIANT[band], muted: false };
  }

  if (VARIANCE_KPIS.has(key)) {
    const { display, variant } = formatVariance(entry.value as number | null);
    return { key, label, value: display, sub: 'vs baseline', variant, muted: false };
  }

  // Counts / score: a number; > 0 leans at-risk for the task buckets.
  const num = entry.value as number | null;
  const isAttentionKpi = key === 'critical_tasks' || key === 'at_risk_tasks';
  return {
    key,
    label,
    value: num === null ? '—' : String(num),
    variant: isAttentionKpi && (num ?? 0) > 0 ? 'at-risk' : 'neutral',
    muted: false,
  };
}

// ---------------------------------------------------------------------------
// Health hero
// ---------------------------------------------------------------------------

function HealthHero({ rollup }: { rollup: ProgramRollup }) {
  const band = rollup.program_health;
  const badgeClass = {
    on_track: 'border-semantic-on-track/40 text-semantic-on-track',
    at_risk: 'border-semantic-at-risk/40 text-semantic-at-risk',
    critical: 'border-semantic-critical/40 text-semantic-critical',
    unknown: 'border-neutral-border text-neutral-text-disabled',
  }[band];

  const projects = `${rollup.project_count} project${rollup.project_count === 1 ? '' : 's'}`;
  const subtitle = `${POLICY_LABEL[rollup.aggregation_policy]} across ${projects}`;

  return (
    <div className="flex flex-col gap-1 pb-2 border-b border-neutral-border">
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={`bg-transparent border rounded px-2 py-0.5 text-xs font-medium ${badgeClass}`}
          aria-label={`Program health: ${HEALTH_LABEL[band]}`}
        >
          {HEALTH_LABEL[band]}
        </span>
        <span className="text-xs text-neutral-text-secondary">{subtitle}</span>
      </div>
      {!rollup.policy_available && (
        <p className="text-xs text-neutral-text-disabled">
          Budget weighting is unavailable — showing the average instead.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProgramOverviewPage
// ---------------------------------------------------------------------------

/**
 * Landing page for a program (/programs/:programId). Renders the computed
 * rollup of the enabled KPIs (ADR-0088, #713): a program health hero plus a
 * KPI strip. Deferred KPIs (cost/EVM #754, Monte Carlo store #753) appear muted
 * with the reason rather than hidden, so a PM sees why a toggled KPI is blank.
 */
export function ProgramOverviewPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: rollup, isLoading, error } = useProgramRollup(programId);

  const kpiEntries = rollup ? Object.entries(rollup.kpis) : [];

  return (
    <div className="flex flex-col gap-6 p-6 overflow-y-auto h-full bg-neutral-surface">
      {error && (
        <p role="alert" className="text-sm text-semantic-critical">
          Failed to load the program rollup.
        </p>
      )}

      {!error && (isLoading || !rollup) ? (
        <>
          <div
            aria-hidden="true"
            className="h-6 w-56 animate-pulse rounded bg-neutral-surface-raised"
          />
          <KpiSkeleton />
        </>
      ) : null}

      {!error && rollup && (
        <>
          <HealthHero rollup={rollup} />

          {rollup.project_count === 0 ? (
            <div
              className="flex flex-col items-start gap-2 px-4 py-6 rounded border border-neutral-border bg-neutral-surface-raised"
              role="status"
            >
              <p className="text-sm text-neutral-text-primary">
                No projects in this program yet.
              </p>
              <p className="text-xs text-neutral-text-secondary">
                Add projects to the program to see a rolled-up health summary.
              </p>
              <Link
                to={`/programs/${programId}/projects`}
                className="text-xs text-brand-primary underline-offset-2 hover:underline
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                  focus-visible:outline-none rounded"
              >
                Manage projects
              </Link>
            </div>
          ) : kpiEntries.length === 0 ? (
            <div
              className="flex flex-col items-start gap-2 px-4 py-6 rounded border border-neutral-border bg-neutral-surface-raised"
              role="status"
            >
              <p className="text-sm text-neutral-text-primary">No KPIs enabled.</p>
              <Link
                to={`/programs/${programId}/settings/rollup`}
                className="text-xs text-brand-primary underline-offset-2 hover:underline
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                  focus-visible:outline-none rounded"
              >
                Configure rollup
              </Link>
            </div>
          ) : (
            <section aria-label="Program KPIs">
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                {kpiEntries.map(([key, entry]) => {
                  const k = renderKpi(key, entry);
                  return (
                    <KpiCard
                      key={k.key}
                      label={k.label}
                      value={k.value}
                      sub={k.sub}
                      variant={k.variant}
                      muted={k.muted}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {rollup.project_count > 0 && (
            <div className="flex flex-col gap-1 border-t border-neutral-border pt-3">
              <Link
                to={`/programs/${programId}/settings/rollup`}
                className="self-start text-xs text-brand-primary underline-offset-2 hover:underline
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                  focus-visible:outline-none rounded"
              >
                Configure rollup
              </Link>
              {/* OSS↔Enterprise boundary affordance (ADR-0070/0088): this rollup is
                  per-program; comparing across programs is an Enterprise capability. */}
              <p className="text-xs text-neutral-text-disabled">
                Rolling up across multiple programs? Cross-program portfolio rollups are part of
                TruePPM Enterprise.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
