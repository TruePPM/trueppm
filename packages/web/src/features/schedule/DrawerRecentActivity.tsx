import { useMemo } from 'react';
import { useTaskHistory } from '@/hooks/useTaskHistory';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { formatRelative } from '@/lib/formatRelative';
import { summaryVerb, isEmptyChange } from './activityFormat';

/**
 * Inline "Recent changes" audit trail at the top of the task-drawer Details tab
 * (#2315, Drawer v2 slice 3). Surfaces the **last 3** activity entries — the
 * who/what/when the full Activity tab shows — so a user inspecting a task sees
 * recent history without a tab switch. Per-event wording comes from the shared
 * `summaryVerb` (activityFormat.ts), so this compact view and the full timeline
 * can never disagree.
 *
 * It reuses the same `useTaskHistory` cache the Activity tab reads, so this fetch
 * is shared (opening Details warms it; switching to Activity reuses it). Renders
 * nothing while loading and nothing when there is no readable history — the
 * drawer never flashes an empty "Recent changes" box.
 */
export function DrawerRecentActivity({
  projectId,
  taskId,
  onViewActivity,
}: {
  projectId: string;
  taskId: string;
  /** Switch the drawer to the full Activity tab. */
  onViewActivity: () => void;
}) {
  const { data, isLoading } = useTaskHistory(projectId, taskId);
  const { prefs, formatInstant } = useUserDateFormat();

  const recent = useMemo(() => {
    const entries = data?.pages.flatMap((p) => p.results) ?? [];
    return entries
      .filter((e) => e.event_type && e.timestamp && !isEmptyChange(e))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 3);
  }, [data]);

  if (isLoading || recent.length === 0) return null;

  return (
    <section
      aria-label="Recent changes"
      className="overflow-hidden rounded-card border border-neutral-border"
    >
      <div className="flex items-center gap-2 px-3 pb-1 pt-2">
        <h3 className="m-0 text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary">
          Recent changes
        </h3>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onViewActivity}
          aria-label="View all activity"
          className="rounded-control text-xs font-medium text-brand-primary hover:text-brand-primary-dark
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          Activity <span aria-hidden="true">→</span>
        </button>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 px-3 pb-2">
        {recent.map((e, i) => {
          const iso = new Date(e.timestamp).toISOString();
          const isSystem = e.actor === null;
          return (
            <li
              key={e.id ?? `${e.event_type}-${e.timestamp}-${i}`}
              className="flex items-baseline gap-2 text-xs"
            >
              <span
                aria-hidden="true"
                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                  i === 0 ? 'bg-brand-primary' : 'bg-neutral-border'
                }`}
              />
              <span className="min-w-0 flex-1 text-neutral-text-primary">
                {isSystem ? (
                  <span className="italic text-neutral-text-secondary">System</span>
                ) : (
                  <span className="font-semibold">{e.actor?.display_name}</span>
                )}{' '}
                {summaryVerb(e)}
              </span>
              <time
                dateTime={iso}
                title={formatInstant(iso)}
                className="shrink-0 tppm-mono text-neutral-text-secondary"
              >
                {formatRelative(new Date(e.timestamp), undefined, prefs)}
              </time>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
