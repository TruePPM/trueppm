import { useMemo } from 'react';
import { useTaskHistory, type TaskActivityEntry } from '@/hooks/useTaskHistory';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { formatRelative } from '@/lib/formatRelative';
import { isEmptyChange, normalize, summaryVerb } from './ActivityTimeline';

/** How many entries the inline trail shows before deferring to the Activity tab. */
const INLINE_LIMIT = 3;

/**
 * The most recent entries, newest first. Reads only the first page of the
 * merged feed — three rows never need pagination, and the query key is shared
 * with the Activity tab so opening that tab is a cache hit, not a refetch.
 */
function recentEntries(pages: { results: TaskActivityEntry[] }[] | undefined): TaskActivityEntry[] {
  const first = pages?.[0]?.results ?? [];
  return first
    .map(normalize)
    .filter((entry) => !isEmptyChange(entry))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, INLINE_LIMIT);
}

interface TaskRecentActivityProps {
  projectId: string;
  taskId: string;
  /** Switches the drawer to the Activity tab — the full, filterable feed. */
  onViewAll: () => void;
}

/**
 * Inline audit trail (#2315) — the last few activity entries surfaced on the
 * Details tab so "what just happened to this task?" is answerable without a tab
 * switch. It is a *summary*, not a replacement: each row is one line (actor +
 * verb + relative time) with no field diffs, and "View all" hands off to the
 * Activity tab for the filterable feed.
 *
 * Renders nothing at all while loading, on error, or when the task has no
 * activity (rule 122) — an empty "Recent activity" heading would be noise on a
 * freshly created task, and the Activity tab already owns the empty state.
 */
export function TaskRecentActivity({ projectId, taskId, onViewAll }: TaskRecentActivityProps) {
  const { data, isLoading, isError } = useTaskHistory(projectId, taskId);
  const { prefs } = useUserDateFormat();
  const entries = useMemo(() => recentEntries(data?.pages), [data]);

  if (isLoading || isError || entries.length === 0) return null;

  return (
    <section aria-labelledby="drawer-recent-activity" data-testid="drawer-recent-activity">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <h3
          id="drawer-recent-activity"
          className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary"
        >
          Recent activity
        </h3>
        <button
          type="button"
          onClick={onViewAll}
          data-testid="drawer-recent-activity-view-all"
          className="text-xs text-brand-primary hover:underline rounded-control
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
        >
          View all
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {entries.map((entry, i) => (
          <li
            key={`${entry.event_type}-${entry.timestamp}-${i}`}
            className="flex items-baseline gap-1.5 text-xs text-neutral-text-secondary"
          >
            <span className="font-medium text-neutral-text-primary truncate">
              {entry.actor?.display_name ?? 'System'}
            </span>
            <span className="truncate">{summaryVerb(entry)}</span>
            <span aria-hidden="true" className="text-neutral-text-disabled">
              ·
            </span>
            <time
              dateTime={entry.timestamp}
              className="tppm-mono shrink-0 text-neutral-text-disabled"
            >
              {formatRelative(new Date(entry.timestamp), undefined, prefs)}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}
