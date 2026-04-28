import { useTaskHistory } from '@/hooks/useTaskHistory';

interface HistoryTabProps {
  projectId: string;
  taskId: string;
}

/** Human-readable field names for the diff display. */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  duration: 'Duration',
  status: 'Status',
  percent_complete: 'Progress',
  planned_start: 'Planned start',
  actual_start: 'Actual start',
  actual_finish: 'Actual finish',
  optimistic_duration: 'Optimistic (O)',
  most_likely_duration: 'Most Likely (M)',
  pessimistic_duration: 'Pessimistic (P)',
  estimate_status: 'Estimate status',
};

const HISTORY_TYPE_BADGE: Record<
  '+' | '~' | '-',
  { label: string; classes: string }
> = {
  '+': {
    label: 'Created',
    classes:
      'bg-semantic-on-track/10 text-semantic-on-track border border-semantic-on-track/30',
  },
  '~': {
    label: 'Updated',
    classes:
      'bg-brand-primary/10 text-brand-primary border border-brand-primary/30',
  },
  '-': {
    label: 'Deleted',
    classes:
      'bg-semantic-critical/10 text-semantic-critical border border-semantic-critical/30',
  },
};

export function HistoryTab({ projectId, taskId }: HistoryTabProps) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useTaskHistory(projectId, taskId);

  const records = data?.pages.flatMap((p) => p.results) ?? [];

  if (isLoading) {
    return <HistorySkeleton />;
  }

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
        <span className="text-2xl" aria-hidden="true">📋</span>
        <p className="text-sm font-medium text-neutral-text-primary">No history yet</p>
        <p className="text-xs text-neutral-text-secondary">
          Changes to this task will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {records.map((record) => {
        const badge = HISTORY_TYPE_BADGE[record.history_type];
        const date = new Date(record.history_date);
        const relativeTime = formatRelative(date);

        return (
          <div
            key={record.id}
            className="rounded-lg border border-neutral-border bg-neutral-surface-raised p-3 flex flex-col gap-2"
          >
            {/* Header row */}
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${badge.classes}`}
              >
                {badge.label}
              </span>
              <time
                dateTime={date.toISOString()}
                title={date.toLocaleString()}
                className="text-xs text-neutral-text-secondary"
              >
                {relativeTime}
              </time>
              {record.history_user && (
                <span className="text-xs text-neutral-text-disabled">
                  by {record.history_user}
                </span>
              )}
            </div>

            {/* Diff rows */}
            {record.diff.length > 0 && (
              <dl className="flex flex-col gap-1 mt-1">
                {record.diff.map((d) => (
                  <div key={d.field} className="flex items-baseline gap-1 text-xs">
                    <dt className="w-32 shrink-0 text-neutral-text-secondary truncate">
                      {FIELD_LABELS[d.field] ?? d.field}
                    </dt>
                    <dd className="flex items-baseline gap-1 min-w-0 text-neutral-text-primary">
                      {d.old != null && (
                        <>
                          <span className="line-through text-neutral-text-disabled truncate max-w-[80px]">
                            {d.old}
                          </span>
                          <span className="text-neutral-text-disabled" aria-hidden="true">→</span>
                        </>
                      )}
                      <span className="font-medium truncate max-w-[80px]">
                        {d.new ?? <span className="text-neutral-text-disabled italic">cleared</span>}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        );
      })}

      {/* Load more */}
      {hasNextPage && (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="w-full h-9 text-xs font-medium border border-neutral-border rounded
            text-neutral-text-secondary hover:text-neutral-text-primary hover:border-brand-primary
            disabled:opacity-50 disabled:cursor-not-allowed
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function HistorySkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading history">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border border-neutral-border bg-neutral-surface-raised p-3 animate-pulse">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-4 w-14 rounded bg-neutral-border" />
            <div className="h-3 w-20 rounded bg-neutral-border" />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="h-3 w-full rounded bg-neutral-border" />
            <div className="h-3 w-3/4 rounded bg-neutral-border" />
          </div>
        </div>
      ))}
    </div>
  );
}
