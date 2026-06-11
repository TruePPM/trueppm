/**
 * My Work page — cross-project contributor surface (issue #499, ADR-0065 Gap 2;
 * grouping reworked in #484 / ADR-0118).
 *
 * Route: /me/work. Grouped into Today / This Sprint / Upcoming — the buckets a
 * contributor thinks in, computed server-side (`task.group`) and returned
 * pre-sorted so the page groups by a contiguous walk and never re-derives date
 * math. No CPM vocabulary anywhere on the surface; the API returns a
 * deliberately flat shape with `is_critical` as a single boolean rendered as an
 * icon plus plain-English tooltip, and a `blocked_reason` that drives a
 * prominent blocked badge.
 *
 * Loading shows a row skeleton (no spinners — rule 3 / progressive
 * disclosure). Errors surface as a banner with retry; cached data, if any,
 * remains visible below the banner so a transient failure doesn't wipe the
 * page.
 *
 * Status updates from this surface go through the existing task PATCH path
 * with header ``X-Source: my_work`` (see ``useMyWorkStatusUpdate``).
 */
import { useMemo } from 'react';
import { useMyWork, type MyWorkGroup, type MyWorkTask } from '@/hooks/useMyWork';
import { useProjects } from '@/hooks/useProjects';
import { MyWorkTaskRow } from './MyWorkTaskRow';
import { MyWorkEmptyState } from './MyWorkEmptyState';
import { MyWorkRetroSection } from './MyWorkRetroSection';

interface WorkGroup {
  group: MyWorkGroup;
  tasks: MyWorkTask[];
}

// Render order + contributor-facing labels (#484). Deliberately plain language —
// "Today" / "This Sprint" / "Upcoming", never "Phase" / "Early Finish" / "WBS".
const GROUP_ORDER: MyWorkGroup[] = ['today', 'this_sprint', 'upcoming'];
const GROUP_LABEL: Record<MyWorkGroup, string> = {
  today: 'Today',
  this_sprint: 'This Sprint',
  upcoming: 'Upcoming',
};

/**
 * Partition the flat list into its contiguous server-assigned buckets. The
 * response is already sorted group_rank → blocked-first → due, so this is a
 * stable group-by that preserves the server ordering within each section.
 */
function groupByBucket(tasks: MyWorkTask[]): WorkGroup[] {
  const buckets = new Map<MyWorkGroup, MyWorkTask[]>();
  for (const t of tasks) {
    const bucket = buckets.get(t.group) ?? [];
    bucket.push(t);
    buckets.set(t.group, bucket);
  }
  return GROUP_ORDER.map((g) => ({ group: g, tasks: buckets.get(g) ?? [] })).filter(
    (g) => g.tasks.length > 0,
  );
}

export function MyWorkPage() {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useMyWork();
  // Used to differentiate empty-state flavor A (no projects) vs B (no assignments).
  // useProjects is already in cache from the Sidebar — cheap reuse.
  const { data: projects } = useProjects();

  const allTasks = useMemo<MyWorkTask[]>(
    () => (data?.pages ?? []).flatMap((p) => p.results),
    [data],
  );
  const firstPage = data?.pages[0];
  const retroItemCount = firstPage?.retro_action_items?.length ?? 0;
  // Surface count includes retro suggestions/owned items so an empty task list
  // doesn't suppress the "From retros" section when a user has pending
  // suggestions but no other assigned work (ADR-0071 §4c).
  const totalCount = allTasks.length + retroItemCount;
  const dueTodayCount = firstPage?.due_today_count ?? 0;

  const workGroups = useMemo(() => groupByBucket(allTasks), [allTasks]);

  return (
    <main className="flex flex-col h-full overflow-y-auto bg-neutral-surface">
      <header className="flex items-baseline justify-between gap-4 px-4 py-4 md:px-6">
        <h1 className="text-xl font-semibold text-neutral-text-primary">My Work</h1>
        {dueTodayCount > 0 && (
          <span
            className="tppm-mono text-xs text-semantic-critical"
            aria-label={`${dueTodayCount} task${dueTodayCount === 1 ? '' : 's'} due today`}
          >
            {dueTodayCount} due today
          </span>
        )}
      </header>

      {error && (
        <div
          role="alert"
          className="mx-4 mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded
            border border-semantic-critical/40 bg-semantic-critical-bg text-semantic-critical text-sm md:mx-6"
        >
          <span>Couldn&rsquo;t load your work right now.</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="text-xs font-medium underline focus-visible:outline-none
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded px-1"
          >
            Retry
          </button>
        </div>
      )}

      {isLoading ? (
        <LoadingSkeleton />
      ) : totalCount === 0 ? (
        <MyWorkEmptyState hasProjects={(projects ?? []).length > 0} />
      ) : (
        <div className="flex flex-col gap-1 px-0 md:px-2 lg:px-6 max-w-[1100px] mx-auto w-full">
          {firstPage?.retro_action_items && firstPage.retro_action_items.length > 0 && (
            <MyWorkRetroSection items={firstPage.retro_action_items} />
          )}
          {workGroups.map((group) => (
            <section
              key={group.group}
              aria-labelledby={`group-${group.group}`}
              className="flex flex-col"
            >
              <WorkGroupHeader group={group.group} taskCount={group.tasks.length} />
              <ul className="flex flex-col">
                {group.tasks.map((t) => (
                  <MyWorkTaskRow key={t.id} task={t} />
                ))}
              </ul>
            </section>
          ))}
          {hasNextPage && (
            <div className="flex justify-center py-4">
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="h-9 px-4 rounded text-sm font-medium border border-neutral-border
                  text-neutral-text-primary bg-neutral-surface hover:bg-neutral-surface-raised
                  disabled:opacity-60 disabled:cursor-progress
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                  focus-visible:ring-offset-1"
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function WorkGroupHeader({ group, taskCount }: { group: MyWorkGroup; taskCount: number }) {
  const label = GROUP_LABEL[group];
  return (
    <h2
      id={`group-${group}`}
      className="px-4 md:px-3 pt-5 pb-1 flex items-baseline justify-between gap-3
        text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
      aria-label={`${label}, ${taskCount} task${taskCount === 1 ? '' : 's'}`}
    >
      <span className="truncate border-l-2 border-brand-primary/60 pl-2 -ml-2">{label}</span>
      <span className="tppm-mono shrink-0 text-[11px]">
        {taskCount} task{taskCount === 1 ? '' : 's'}
      </span>
    </h2>
  );
}

function LoadingSkeleton() {
  return (
    <ul aria-label="Loading your tasks" className="flex flex-col gap-1 px-4 md:px-6">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <li
          key={i}
          aria-hidden="true"
          className="h-11 rounded bg-neutral-surface-sunken animate-pulse"
        />
      ))}
    </ul>
  );
}
