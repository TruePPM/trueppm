/**
 * My Work page — cross-project contributor surface (issue #499, ADR-0065 Gap 2).
 *
 * Route: /me/work. Grouped client-side by active sprint, then a single "Not
 * in a sprint" group at the end. No CPM vocabulary anywhere on the surface;
 * the API returns a deliberately flat shape with `is_critical` as a single
 * boolean rendered as an icon plus plain-English tooltip.
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
import { useMyWork, type MyWorkActiveSprint, type MyWorkTask } from '@/hooks/useMyWork';
import { useProjects } from '@/hooks/useProjects';
import { MyWorkTaskRow } from './MyWorkTaskRow';
import { MyWorkEmptyState } from './MyWorkEmptyState';

interface SprintGroup {
  sprint: MyWorkActiveSprint;
  tasks: MyWorkTask[];
}

function partitionBySprintId(
  tasks: MyWorkTask[],
  activeSprints: MyWorkActiveSprint[],
): { sprintGroups: SprintGroup[]; orphanTasks: MyWorkTask[] } {
  const bySprint = new Map<string, MyWorkTask[]>();
  const orphans: MyWorkTask[] = [];
  for (const t of tasks) {
    if (t.sprint_id) {
      const bucket = bySprint.get(t.sprint_id) ?? [];
      bucket.push(t);
      bySprint.set(t.sprint_id, bucket);
    } else {
      orphans.push(t);
    }
  }
  const sprintGroups = activeSprints
    .map((s) => ({ sprint: s, tasks: bySprint.get(s.id) ?? [] }))
    .filter((g) => g.tasks.length > 0);
  return { sprintGroups, orphanTasks: orphans };
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
  const totalCount = allTasks.length;
  const dueTodayCount = firstPage?.due_today_count ?? 0;

  const { sprintGroups, orphanTasks } = useMemo(
    () => partitionBySprintId(allTasks, firstPage?.active_sprints ?? []),
    [allTasks, firstPage],
  );

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
          {sprintGroups.map((group) => (
            <section
              key={group.sprint.id}
              aria-labelledby={`group-${group.sprint.id}`}
              className="flex flex-col"
            >
              <SprintGroupHeader sprint={group.sprint} taskCount={group.tasks.length} />
              <ul className="flex flex-col">
                {group.tasks.map((t) => (
                  <MyWorkTaskRow key={t.id} task={t} />
                ))}
              </ul>
            </section>
          ))}
          {orphanTasks.length > 0 && (
            <section aria-labelledby="group-not-in-sprint" className="flex flex-col">
              <NonSprintGroupHeader taskCount={orphanTasks.length} />
              <ul className="flex flex-col">
                {orphanTasks.map((t) => (
                  <MyWorkTaskRow key={t.id} task={t} />
                ))}
              </ul>
            </section>
          )}
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

function SprintGroupHeader({ sprint, taskCount }: { sprint: MyWorkActiveSprint; taskCount: number }) {
  return (
    <h2
      id={`group-${sprint.id}`}
      className="px-4 md:px-3 pt-4 pb-1 flex items-baseline justify-between gap-3
        text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
      aria-label={`${sprint.name}, ${sprint.project_name}, ${sprint.days_remaining} days remaining, ${taskCount} tasks`}
    >
      <span className="truncate">
        {sprint.name} · {sprint.project_name}
      </span>
      <span className="tppm-mono shrink-0 text-[11px]">
        {sprint.days_remaining}d · {taskCount} task{taskCount === 1 ? '' : 's'}
      </span>
    </h2>
  );
}

function NonSprintGroupHeader({ taskCount }: { taskCount: number }) {
  return (
    <h2
      id="group-not-in-sprint"
      className="px-4 md:px-3 pt-6 pb-1 flex items-baseline justify-between gap-3
        text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
      aria-label={`Not in a sprint, ${taskCount} tasks`}
    >
      <span>Not in a sprint</span>
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
