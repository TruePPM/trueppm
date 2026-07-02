import { useTaskBaseline } from '@/hooks/useTaskBaseline';
import type { BaselineComparison } from '@/hooks/useTaskBaseline';

interface BaselineTabProps {
  projectId: string;
  taskId: string;
}

export function BaselineTab({ projectId, taskId }: BaselineTabProps) {
  const { data, isLoading } = useTaskBaseline(projectId, taskId);

  if (isLoading) {
    return <BaselineSkeleton />;
  }

  if (!data) return null;

  if (!data.has_baseline) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
        <span className="text-2xl" aria-hidden="true">📊</span>
        <p className="text-sm font-medium text-neutral-text-primary">No baseline set</p>
        <p className="text-xs text-neutral-text-secondary">
          Take a baseline snapshot on this project to enable plan vs. actual tracking.
        </p>
      </div>
    );
  }

  if (!data.in_baseline) {
    return (
      <div className="rounded-card border border-neutral-border/60 bg-brand-primary/5 px-4 py-3 flex flex-col gap-1">
        <p className="text-sm font-medium text-neutral-text-primary">
          Task added after baseline
        </p>
        <p className="text-xs text-neutral-text-secondary">
          Baseline <strong>{data.baseline_name}</strong> was taken on{' '}
          {new Date(data.baseline_taken_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
          . This task did not exist at that time.
        </p>
      </div>
    );
  }

  return <ComparisonTable data={data} />;
}

// ---------------------------------------------------------------------------
// ComparisonTable
// ---------------------------------------------------------------------------

interface ComparisonTableProps {
  data: BaselineComparison;
}

interface RowSpec {
  label: string;
  current: string | null;
  planned: string | null;
  delta: number | null;
  isDays: boolean;
}

function buildRows(data: BaselineComparison): RowSpec[] {
  return [
    {
      label: 'Planned start',
      current: data.current_start,
      planned: data.planned_start,
      delta: data.start_delta_days,
      isDays: true,
    },
    {
      label: 'Planned finish',
      current: data.current_finish,
      planned: data.planned_finish,
      delta: data.finish_delta_days,
      isDays: true,
    },
    {
      label: 'Duration',
      current: data.current_duration != null ? `${data.current_duration}d` : null,
      planned: data.planned_duration != null ? `${data.planned_duration}d` : null,
      delta: data.duration_delta,
      isDays: true,
    },
    {
      label: 'Actual start',
      current: data.current_actual_start,
      planned: data.planned_actual_start,
      delta: null,
      isDays: false,
    },
    {
      label: 'Actual finish',
      current: data.current_actual_finish,
      planned: data.planned_actual_finish,
      delta: null,
      isDays: false,
    },
  ];
}

function ComparisonTable({ data }: ComparisonTableProps) {
  const rows = buildRows(data);

  return (
    <div className="flex flex-col gap-3">
      {/* Baseline info banner */}
      <div className="rounded-card border border-neutral-border bg-neutral-surface-raised px-3 py-2.5 flex flex-col gap-0.5">
        <p className="text-xs font-medium text-neutral-text-primary">{data.baseline_name}</p>
        <p className="text-xs text-neutral-text-secondary">
          Taken{' '}
          {new Date(data.baseline_taken_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
          {!data.has_cpm_dates && (
            <span className="ml-1 text-semantic-warning">
              · CPM not yet run at snapshot time
            </span>
          )}
        </p>
      </div>

      {/* Comparison table */}
      <div
        role="table"
        aria-label="Baseline comparison"
        className="flex flex-col border border-neutral-border rounded-card overflow-hidden"
      >
        {/* Header */}
        <div role="row" className="grid grid-cols-4 bg-neutral-surface-raised border-b border-neutral-border">
          {['Field', 'Current', 'Baseline', 'Delta'].map((h) => (
            <div
              key={h}
              role="columnheader"
              className="px-3 py-2 text-xs font-semibold text-neutral-text-secondary"
            >
              {h}
            </div>
          ))}
        </div>

        {rows.map((row) => (
          <div
            key={row.label}
            role="row"
            className="grid grid-cols-4 border-b border-neutral-border last:border-b-0 hover:bg-neutral-surface-raised"
          >
            <div role="cell" className="px-3 py-2 text-xs text-neutral-text-secondary">
              {row.label}
            </div>
            <div role="cell" className="px-3 py-2 text-xs text-neutral-text-primary tabular-nums">
              {formatDateCell(row.current)}
            </div>
            <div role="cell" className="px-3 py-2 text-xs text-neutral-text-secondary tabular-nums">
              {formatDateCell(row.planned)}
            </div>
            <div role="cell" className="px-3 py-2 text-xs tabular-nums">
              {row.delta != null ? <DeltaChip delta={row.delta} /> : <span className="text-neutral-text-disabled">—</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeltaChip — positive = slip (red), negative = ahead (green), zero = neutral
// ---------------------------------------------------------------------------

function DeltaChip({ delta }: { delta: number }) {
  if (delta === 0) {
    return <span className="text-neutral-text-disabled">0d</span>;
  }
  if (delta > 0) {
    return (
      <span className="text-semantic-critical font-medium" aria-label={`${delta} days late`}>
        +{delta}d
      </span>
    );
  }
  return (
    <span className="text-semantic-on-track font-medium" aria-label={`${Math.abs(delta)} days ahead`}>
      {delta}d
    </span>
  );
}

function formatDateCell(value: string | null) {
  if (!value) return <span className="text-neutral-text-disabled">—</span>;
  // If it looks like an ISO date, format it; otherwise return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(value + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  return value;
}

function BaselineSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading baseline">
      <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-3 motion-safe:animate-pulse">
        <div className="h-3 w-32 rounded-chip bg-neutral-border mb-1" />
        <div className="h-3 w-48 rounded-chip bg-neutral-border" />
      </div>
      <div className="rounded-card border border-neutral-border overflow-hidden motion-safe:animate-pulse">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="grid grid-cols-4 border-b border-neutral-border last:border-b-0 p-2 gap-2">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="h-3 rounded-chip bg-neutral-border" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
