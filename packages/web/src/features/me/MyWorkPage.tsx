/**
 * My Work page — cross-project contributor surface (issue #499, ADR-0065 Gap 2;
 * grouping reworked in #484 / ADR-0122; v2 home in #1228).
 *
 * Route: /me/work. The v2 home leads with a time-aware greeting + a mono date
 * chip, a row of three (or two) risk-ranked focus cards, then a two-column
 * layout: the left column is the assigned-task list grouped into Today / This
 * Sprint / Upcoming (the buckets a contributor thinks in, computed server-side
 * via `task.group` and returned pre-sorted so the page groups by a contiguous
 * walk and never re-derives date math); the right column is a method-adaptive
 * stack (active sprints + an on-the-critical-path mini) that self-suppresses
 * when empty. No CPM vocabulary anywhere on the surface; the API returns a
 * deliberately flat shape with `is_critical` as a single boolean rendered as an
 * icon plus plain-English tooltip, and a `blocked_reason` that drives a
 * prominent blocked badge.
 *
 * Cross-program reality: the focus cards reference only data the /me/work/
 * payload actually returns. The spec's SPI / Monte-Carlo P80 / utilization
 * signals are project-level and not available here, so they are deliberately
 * not rendered rather than fabricated (rule 120). See myWorkFocus.ts.
 *
 * Loading shows a row skeleton (no spinners — rule 3 / progressive
 * disclosure). Errors surface as a banner with retry; cached data, if any,
 * remains visible below the banner so a transient failure doesn't wipe the
 * page.
 *
 * Status updates from this surface go through the existing task PATCH path
 * with header ``X-Source: my_work`` (see ``useMyWorkStatusUpdate``).
 */
import { useMemo, useState } from 'react';
import { useMyWork, type MyWorkGroup, type MyWorkTask } from '@/hooks/useMyWork';
import { countBlocked, selectVisibleTasks } from './myWorkBlocked';
import { useProjects } from '@/hooks/useProjects';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { MyWorkTaskRow } from './MyWorkTaskRow';
import { MyWorkEmptyState } from './MyWorkEmptyState';
import { MyWorkRetroSection } from './MyWorkRetroSection';
import { MyWorkFocusCards } from './MyWorkFocusCards';
import { MyWorkSideColumn } from './MyWorkSideColumn';
import { LandingPrimaryUsePrompt } from './LandingPrimaryUsePrompt';
import { LandingContextHint } from './LandingContextHint';
import {
  buildMyWorkFocusCards,
  greeting,
  greetingSubline,
  dateChip,
} from './myWorkFocus';

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
  // Name for the time-aware greeting. Already cached from the shell.
  const { user } = useCurrentUser();

  const allTasks = useMemo<MyWorkTask[]>(
    () => (data?.pages ?? []).flatMap((p) => p.results),
    [data],
  );
  const firstPage = data?.pages[0];
  // Stable reference so the focus-card memo doesn't recompute every render when
  // the active-sprints array is otherwise unchanged.
  const activeSprints = useMemo(() => firstPage?.active_sprints ?? [], [firstPage]);
  const retroItemCount = firstPage?.retro_action_items?.length ?? 0;
  // Surface count includes retro suggestions/owned items so an empty task list
  // doesn't suppress the "From retros" section when a user has pending
  // suggestions but no other assigned work (ADR-0071 §4c).
  const totalCount = allTasks.length + retroItemCount;
  const dueTodayCount = firstPage?.due_today_count ?? 0;
  const criticalCount = useMemo(
    () => allTasks.filter((t) => t.is_critical).length,
    [allTasks],
  );

  // Blocked quick-filter: a top-of-page "N blocked" chip the contributor
  // taps to narrow the list to flagged-blocked tasks. Reads `is_blocked` already
  // on each row — no extra request. The filter auto-clears if the count falls to
  // zero (chip hides), so we never strand the user on an empty filtered view.
  const blockedCount = useMemo(() => countBlocked(allTasks), [allTasks]);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const filteringBlocked = blockedOnly && blockedCount > 0;
  const visibleTasks = useMemo(
    () => selectVisibleTasks(allTasks, filteringBlocked),
    [allTasks, filteringBlocked],
  );

  const workGroups = useMemo(() => groupByBucket(visibleTasks), [visibleTasks]);
  const focusCards = useMemo(
    () => buildMyWorkFocusCards(allTasks, activeSprints, dueTodayCount),
    [allTasks, activeSprints, dueTodayCount],
  );

  // Computed once per render — `new Date()` keeps the greeting honest to the
  // viewer's local clock without a re-render timer (a stale-by-minutes greeting
  // is harmless; a ticking clock would be noise — rule 70).
  const now = new Date();
  const hasWork = totalCount > 0;

  return (
    <main className="flex flex-col h-full overflow-y-auto bg-app-canvas">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-5 md:px-6">
        <div className="flex min-w-0 flex-col gap-1">
          {/* Time-aware greeting (v2 My Work spec). This IS the page <h1>. */}
          <h1 className="font-display text-2xl font-semibold tracking-tight text-neutral-text-primary">
            {greeting(user?.display_name, now)}
          </h1>
          <p className="text-sm text-neutral-text-secondary">
            {greetingSubline(dueTodayCount, criticalCount)}
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
              className={[
                'tppm-mono rounded-chip border px-2 py-1 text-xs transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                filteringBlocked
                  ? 'border-semantic-critical bg-semantic-critical-bg text-semantic-critical font-medium'
                  : 'border-semantic-critical/40 bg-semantic-critical-bg/60 text-semantic-critical hover:bg-semantic-critical-bg',
              ].join(' ')}
            >
              {blockedCount} blocked
            </button>
          )}
          <span
            className="tppm-mono rounded-chip border border-neutral-border px-2 py-1 text-xs text-neutral-text-secondary"
            aria-label={`Today is ${dateChip(now)}`}
          >
            {dateChip(now)}
          </span>
        </div>
      </header>

      {/* Role-based landing transparency (ADR-0129). Both self-gate and
          render null when not applicable — the hint explains "why am I here",
          the prompt is the contributor-first first-login home picker. */}
      <LandingContextHint />
      <LandingPrimaryUsePrompt />

      {error && (
        <div
          role="alert"
          className="mx-4 mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded-card
            border border-semantic-critical/40 bg-semantic-critical-bg text-semantic-critical text-sm md:mx-6"
        >
          <span>Couldn&rsquo;t load your work right now.</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="text-xs font-medium underline focus-visible:outline-none
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control px-1"
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
        <div className="flex w-full max-w-[1100px] flex-col gap-5 px-4 pb-6 md:px-6 mx-auto">
          {/* Focus row — risk-ranked, worst signal leads. */}
          <section aria-label="Your focus">
            <MyWorkFocusCards cards={focusCards} />
          </section>

          {/* Two-column: assigned-task list (left) + method-adaptive stack
              (right). The right column self-suppresses when the user has no
              active sprint and nothing on the critical path, so the list spans
              full width for a calm contributor. */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.55fr_1fr]">
            <section aria-label="Assigned to me" className="flex flex-col gap-1">
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
                    className="h-9 px-4 rounded-control text-sm font-medium border border-neutral-border
                      text-neutral-text-primary bg-neutral-surface hover:bg-neutral-surface-raised
                      disabled:opacity-60 disabled:cursor-progress
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                      focus-visible:ring-offset-1"
                  >
                    {isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </section>

            {hasWork && <MyWorkSideColumn tasks={allTasks} activeSprints={activeSprints} />}
          </div>
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
      <span className="tppm-mono shrink-0 text-xs">
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
          className="h-11 rounded-card bg-neutral-surface-sunken animate-pulse"
        />
      ))}
    </ul>
  );
}
