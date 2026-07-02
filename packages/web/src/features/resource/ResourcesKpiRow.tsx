import type { ResourceSummary } from '@/hooks/useResourceSummary';

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string | string[];
  variant?: 'on-track' | 'at-risk' | 'critical' | 'neutral';
}

function KpiCard({ label, value, sub, variant = 'neutral' }: KpiCardProps) {
  const valueColor = {
    'on-track': 'text-semantic-on-track',
    'at-risk':  'text-semantic-at-risk',
    critical:   'text-semantic-critical',
    neutral:    'text-neutral-text-primary',
  }[variant];

  const subLines = Array.isArray(sub) ? sub : sub ? [sub] : [];

  return (
    <div className="flex flex-col gap-1 p-[14px] rounded-card border border-neutral-border bg-neutral-surface-raised">
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
        {label}
      </span>
      <span className={`text-[22px] font-semibold tppm-mono ${valueColor}`}>{value}</span>
      {/* Sub-lines mix words with numbers (e.g. "vs. 80% target", "+2 contractors").
          Apply mono only to the value above, not whole prose strings (rule 8c). */}
      {subLines.map((line, i) => (
        <span key={i} className="text-xs text-neutral-text-disabled">{line}</span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function ResourcesKpiRowSkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-[88px] rounded-card border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised"
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  data: ResourceSummary;
}

/**
 * Four KPI summary cards for the Resources / Team heatmap page (issue #219).
 * Color thresholds follow the design spec in ADR-0042.
 */
export function ResourcesKpiRow({ data }: Props) {
  const avgUtil = data.avg_utilization_pct;
  const avgVariant =
    avgUtil > 90 ? 'at-risk' : avgUtil >= 70 ? 'on-track' : 'neutral';

  const overVariant = data.over_allocated_count > 0 ? 'critical' : 'neutral';

  const underNames =
    data.under_utilized_names.length > 0 ? data.under_utilized_names : undefined;

  const contractorSub =
    data.contractor_count > 0
      ? `+${data.contractor_count} contractor${data.contractor_count !== 1 ? 's' : ''}`
      : undefined;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard
        label="Avg utilization"
        value={`${avgUtil}%`}
        sub="vs. 80% target"
        variant={avgVariant}
      />
      <KpiCard
        label="Over-allocated"
        value={
          data.over_allocated_count > 0
            ? `${data.over_allocated_count} ${data.over_allocated_count === 1 ? 'person' : 'people'}`
            : 'None'
        }
        sub={data.over_allocated_weeks || undefined}
        variant={overVariant}
      />
      <KpiCard
        label="Under-utilized"
        value={
          data.under_utilized_count > 0
            ? `${data.under_utilized_count} ${data.under_utilized_count === 1 ? 'person' : 'people'}`
            : 'None'
        }
        sub={underNames}
        variant="neutral"
      />
      <KpiCard
        label="Headcount"
        value={`${data.headcount} active`}
        sub={contractorSub}
        variant="neutral"
      />
    </div>
  );
}
