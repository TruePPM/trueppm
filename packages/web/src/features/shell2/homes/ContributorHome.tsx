import { useMemo, useState } from 'react';
import { useMyWork } from '@/hooks/useMyWork';
import { useTimeRollup } from '@/hooks/useTimeEntry';
import { useHasAnyProjects } from '@/hooks/useHasAnyProjects';
import { useProjects } from '@/hooks/useProjects';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { isMemberProject } from '@/lib/projectMembership';
import { formatMinutesAsHm } from '@/lib/parseHours';
import { localTodayIso } from '@/lib/localDate';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { dateChip, greeting } from '@/features/me/myWorkFocus';
import { countBlocked, selectVisibleTasks } from '@/features/me/myWorkBlocked';
import { MyWorkTaskRow } from '@/features/me/MyWorkTaskRow';
import { ExternalWorkItemRow } from '@/features/me/ExternalWorkItemRow';
import { MyWorkSourceFreshness } from '@/features/me/MyWorkSourceFreshness';
import { MyWorkEmptyState } from '@/features/me/MyWorkEmptyState';
import { MyWorkRetroSection } from '@/features/me/MyWorkRetroSection';
import { WorkGroupHeader, groupByBucket, groupExternalItems } from '@/features/me/MyWorkPage';
import { contributorHomeState, contributorSubline } from './contributorHomeModel';

const CHIP =
  'tppm-mono rounded-chip border border-neutral-border px-2 py-1 text-xs text-neutral-text-secondary';

/**
 * Shell-v2 Contributor home (#4768): the person's own work, grouped Today / This
 * Sprint / Upcoming, and nothing a project manager reads (#1561). It reuses My
 * Work's rows and server-side grouping and drops the schedule-health focus cards,
 * the projects health summary and the critical-path side column.
 */
export function ContributorHome() {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useMyWork();
  const { user } = useCurrentUser();
  const hasAnyProjects = useHasAnyProjects();
  const { data: listedProjects } = useProjects();
  const memberProjects = useMemo(
    () => (listedProjects ?? []).filter(isMemberProject),
    [listedProjects],
  );
  const timeRollup = useTimeRollup();
  const [blockedOnly, setBlockedOnly] = useState(false);

  const tasks = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.results).filter((t) => !t.is_phase),
    [data],
  );
  const firstPage = data?.pages[0];
  const externalItems = useMemo(() => firstPage?.external_items ?? [], [firstPage]);
  const externalSources = useMemo(() => firstPage?.external_sources ?? [], [firstPage]);
  const sourceByType = useMemo(
    () => new Map(externalSources.map((s) => [s.source_type, s])),
    [externalSources],
  );
  const retroItems = firstPage?.retro_action_items ?? [];
  const externalVisible = externalItems.filter((i) => i.status_category !== 'done').length;
  const itemCount = tasks.length + retroItems.length + externalVisible;

  const blockedCount = useMemo(() => countBlocked(tasks), [tasks]);
  const filteringBlocked = blockedOnly && blockedCount > 0;
  const visibleTasks = useMemo(
    () => selectVisibleTasks(tasks, filteringBlocked),
    [tasks, filteringBlocked],
  );
  const groups = useMemo(
    () =>
      groupByBucket(
        visibleTasks,
        groupExternalItems(filteringBlocked ? [] : externalItems, localTodayIso()),
      ),
    [visibleTasks, externalItems, filteringBlocked],
  );

  const state = contributorHomeState({ isLoading, hasError: Boolean(error), itemCount });
  if (state.kind === 'loading') return <LoadingSkeleton label="Loading your work…" rows={5} />;
  if (state.kind === 'error') {
    return <QueryErrorState message="Couldn't load your work." onRetry={() => void refetch()} />;
  }

  const now = new Date();
  return (
    <section aria-label="My Work" className="flex h-full flex-col overflow-y-auto bg-app-canvas">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-5 md:px-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-neutral-text-primary">
            {greeting(user?.display_name, now)}
          </h1>
          <p className="text-sm text-neutral-text-secondary">
            {contributorSubline(firstPage?.due_today_count ?? 0, tasks.length)}
          </p>
        </div>
        <div className="flex shrink-0 items-baseline gap-2">
          {blockedCount > 0 && (
            <button
              type="button"
              onClick={() => setBlockedOnly((v) => !v)}
              aria-pressed={filteringBlocked}
              aria-label={
                filteringBlocked
                  ? `Showing only ${blockedCount} blocked task${blockedCount === 1 ? '' : 's'}. Show all tasks.`
                  : `Filter to ${blockedCount} blocked task${blockedCount === 1 ? '' : 's'}`
              }
              className="tppm-mono min-h-[44px] rounded-chip border border-semantic-critical/40 bg-semantic-critical-bg/60 px-3 text-xs text-semantic-critical focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 aria-pressed:border-semantic-critical aria-pressed:font-medium"
            >
              {blockedCount} blocked
            </button>
          )}
          {timeRollup.weekMinutes > 0 && (
            <span
              className={CHIP}
              aria-label={`${formatMinutesAsHm(timeRollup.todayMinutes)} logged today, ${formatMinutesAsHm(timeRollup.weekMinutes)} this week`}
            >
              {formatMinutesAsHm(timeRollup.todayMinutes)} today
            </span>
          )}
          <span className={CHIP} aria-label={`Today is ${dateChip(now)}`}>
            {dateChip(now)}
          </span>
        </div>
      </header>

      {state.kind === 'ready' && state.staleError && (
        <QueryErrorState
          variant="inline"
          message="Couldn't refresh your work."
          onRetry={() => void refetch()}
          className="mx-4 mb-3 md:mx-6"
        />
      )}

      {state.kind === 'empty' ? (
        <MyWorkEmptyState
          hasProjects={hasAnyProjects}
          reachableOnlyViaProgram={hasAnyProjects && memberProjects.length === 0}
          hasConnectedExternalSource={externalSources.some((s) => s.status !== 'not_connected')}
        />
      ) : (
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-1 px-4 pb-6 md:px-6">
          {retroItems.length > 0 && <MyWorkRetroSection items={retroItems} />}
          {groups.map((g) => (
            <section key={g.group} aria-labelledby={`group-${g.group}`} className="flex flex-col">
              <WorkGroupHeader
                group={g.group}
                taskCount={g.tasks.length + g.externalItems.length}
              />
              <ul className="flex flex-col">
                {g.tasks.map((t) => (
                  <MyWorkTaskRow key={t.id} task={t} />
                ))}
                {g.externalItems.map((it) => (
                  <ExternalWorkItemRow
                    key={it.id}
                    item={it}
                    source={sourceByType.get(it.source_type)}
                  />
                ))}
              </ul>
            </section>
          ))}
          <MyWorkSourceFreshness sources={externalSources} />
          {hasNextPage && (
            <div className="flex justify-center py-4">
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="min-h-[44px] rounded-control border border-neutral-border bg-neutral-surface px-4 text-sm font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 disabled:cursor-progress disabled:opacity-60"
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
