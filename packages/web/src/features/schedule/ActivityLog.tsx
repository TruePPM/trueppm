import { useState } from 'react';
import { useTaskHistory } from '@/hooks/useTaskHistory';
import type { TaskHistoryRecord } from '@/hooks/useTaskHistory';
import { formatRelative } from '@/lib/formatRelative';

interface ActivityLogProps {
  projectId: string;
  taskId: string;
}

// ---------------------------------------------------------------------------
// Filter chip categories derived from the current history API.
// Comments and Time events require API-side support (follow-up vs #307).
// ---------------------------------------------------------------------------
type FilterChip = 'all' | 'status' | 'edits' | 'system';

function getCategory(record: TaskHistoryRecord): FilterChip {
  if (record.history_user === null) return 'system';
  const fields = record.diff.map((d) => d.field);
  if (fields.includes('status')) return 'status';
  return 'edits';
}

// ---------------------------------------------------------------------------
// Action description
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<string, string> = {
  BACKLOG: 'Backlog',
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Review',
  ON_HOLD: 'On hold',
  COMPLETE: 'Complete',
};

function fmtStatus(val: string | null): string {
  if (val == null) return '—';
  return STATUS_LABELS[val] ?? val;
}

function buildAction(record: TaskHistoryRecord): { verb: string; detail: string | null } {
  if (record.history_type === '+') {
    return record.history_user
      ? { verb: 'created this task', detail: null }
      : { verb: 'Task created', detail: null };
  }
  if (record.history_type === '-') {
    return { verb: 'deleted this task', detail: null };
  }

  const diffs = record.diff;
  const fields = diffs.map((d) => d.field);

  if (fields.includes('status')) {
    const d = diffs.find((d) => d.field === 'status')!;
    return { verb: 'changed status', detail: `${fmtStatus(d.old)} → ${fmtStatus(d.new)}` };
  }
  if (fields.includes('name')) {
    const d = diffs.find((d) => d.field === 'name')!;
    return { verb: 'renamed task', detail: d.new };
  }
  if (fields.includes('assignee')) {
    const d = diffs.find((d) => d.field === 'assignee')!;
    return d.new
      ? { verb: 'assigned to', detail: d.new }
      : { verb: 'removed assignee', detail: null };
  }
  if (fields.includes('planned_start')) {
    const d = diffs.find((d) => d.field === 'planned_start')!;
    return { verb: 'moved start date', detail: d.new ? `to ${d.new}` : null };
  }
  if (fields.includes('percent_complete')) {
    const d = diffs.find((d) => d.field === 'percent_complete')!;
    return { verb: 'updated progress', detail: `${d.old ?? '0'}% → ${d.new ?? '0'}%` };
  }
  if (fields.includes('notes')) {
    return { verb: 'updated notes', detail: null };
  }
  if (
    fields.some((f) =>
      ['optimistic_duration', 'most_likely_duration', 'pessimistic_duration'].includes(f),
    )
  ) {
    return { verb: 'updated estimates', detail: null };
  }
  if (fields.includes('priority_rank')) {
    return { verb: 'updated priority', detail: null };
  }
  if (fields.includes('actual_start')) {
    const d = diffs.find((d) => d.field === 'actual_start')!;
    return { verb: 'logged actual start', detail: d.new };
  }
  if (fields.includes('actual_finish')) {
    const d = diffs.find((d) => d.field === 'actual_finish')!;
    return { verb: 'logged actual finish', detail: d.new };
  }
  return { verb: 'updated task', detail: null };
}

// ---------------------------------------------------------------------------
// Avatar / system dot
// ---------------------------------------------------------------------------

function EventAvatar({ user }: { user: string | null }) {
  if (user === null) {
    return (
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
        aria-hidden="true"
      >
        <div className="w-2.5 h-2.5 rounded-full bg-neutral-text-disabled/50" />
      </div>
    );
  }
  return (
    <div
      className="w-7 h-7 rounded-full bg-brand-primary/10 border border-brand-primary/30 flex items-center justify-center shrink-0"
      aria-hidden="true"
    >
      <span className="text-xs font-semibold text-brand-primary leading-none">
        {user.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single activity row
// ---------------------------------------------------------------------------

function ActivityRow({ record, isLast }: { record: TaskHistoryRecord; isLast: boolean }) {
  const { verb, detail } = buildAction(record);
  const date = new Date(record.history_date);
  const isSystem = record.history_user === null;

  return (
    <div className="flex gap-3">
      {/* Timeline column */}
      <div className="flex flex-col items-center w-7 shrink-0">
        <EventAvatar user={record.history_user} />
        {!isLast && (
          <div className="w-px flex-1 bg-neutral-border/60 mt-1 min-h-4" aria-hidden="true" />
        )}
      </div>

      {/* Content column */}
      <div className="flex-1 min-w-0 pb-4">
        <div className="flex items-start justify-between gap-2">
          <p className="flex-1 min-w-0 text-xs text-neutral-text-primary">
            {isSystem ? (
              <span className="text-neutral-text-disabled italic">System</span>
            ) : (
              <span className="font-semibold">{record.history_user}</span>
            )}{' '}
            {verb}
          </p>
          <time
            dateTime={date.toISOString()}
            title={date.toLocaleString()}
            className="text-xs text-neutral-text-disabled tppm-mono shrink-0"
          >
            {formatRelative(date)}
          </time>
        </div>
        {detail && (
          <p className="text-xs text-neutral-text-secondary mt-0.5 tppm-mono">{detail}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function ActivitySkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="Loading activity">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <div className="flex flex-col items-center w-7 shrink-0">
            <div className="w-7 h-7 rounded-full bg-neutral-border animate-pulse" />
            {i < 2 && <div className="w-px flex-1 bg-neutral-border/40 mt-1 min-h-4" />}
          </div>
          <div className="flex-1 pb-4">
            <div className="flex justify-between gap-2">
              <div className="h-3 w-40 rounded bg-neutral-border animate-pulse" />
              <div className="h-3 w-12 rounded bg-neutral-border animate-pulse shrink-0" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ filter }: { filter: FilterChip }) {
  const msg =
    filter === 'all'
      ? 'No activity yet'
      : `No ${filter === 'system' ? 'system' : filter} events`;
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
      <p className="text-sm font-medium text-neutral-text-primary">{msg}</p>
      {filter === 'all' && (
        <p className="text-xs text-neutral-text-secondary">
          Task changes will appear here as they happen.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * Activity log for the task detail drawer.
 *
 * Renders a timeline of task events from `useTaskHistory` with filter chips
 * (All · Status · Edits · System). Each event shows an avatar (user initials)
 * or system dot, a human-readable action description, and a relative timestamp.
 *
 * Gaps in API coverage (comments, time logs) are tracked in the follow-up filed
 * against issue #307.
 */
export function ActivityLog({ projectId, taskId }: ActivityLogProps) {
  const [filter, setFilter] = useState<FilterChip>('all');
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useTaskHistory(
    projectId,
    taskId,
  );

  const allRecords = data?.pages.flatMap((p) => p.results) ?? [];

  const filtered =
    filter === 'all' ? allRecords : allRecords.filter((r) => getCategory(r) === filter);

  const chips: { key: FilterChip; label: string }[] = [
    { key: 'all', label: `All · ${allRecords.length}` },
    {
      key: 'status',
      label: `Status · ${allRecords.filter((r) => getCategory(r) === 'status').length}`,
    },
    {
      key: 'edits',
      label: `Edits · ${allRecords.filter((r) => getCategory(r) === 'edits').length}`,
    },
    {
      key: 'system',
      label: `System · ${allRecords.filter((r) => getCategory(r) === 'system').length}`,
    },
  ];

  if (isLoading) return <ActivitySkeleton />;

  return (
    <div className="flex flex-col gap-4">
      {/* Filter chips */}
      <div role="group" aria-label="Filter activity by type" className="flex flex-wrap gap-1.5">
        {chips.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
            className={`h-7 px-3 rounded-full text-xs font-medium border transition-colors
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              ${
                filter === key
                  ? 'bg-brand-primary text-white border-brand-primary'
                  : 'bg-transparent text-neutral-text-secondary border-neutral-border hover:border-brand-primary hover:text-neutral-text-primary'
              }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Timeline */}
      {filtered.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <div className="flex flex-col">
          {filtered.map((record, i) => (
            <ActivityRow key={record.id} record={record} isLast={i === filtered.length - 1} />
          ))}
        </div>
      )}

      {/* Load more — only shown on 'all' to avoid pagination confusion on filtered views */}
      {filter === 'all' && hasNextPage && (
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
