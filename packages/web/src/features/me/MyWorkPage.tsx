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
 * payload actually returns. Where a real server-side computation exists, the
 * payload's `signals` block (#1236, ADR-0221) surfaces cross-program schedule
 * health (SPI-proxy), a Monte-Carlo P80 ship-date forecast, and a real sprint
 * burndown series. Utilization stays honestly omitted — no cross-program
 * per-user capacity computation exists to back it (rule 120). See myWorkFocus.ts.
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
import {
  useMyWork,
  type MyWorkGroup,
  type MyWorkTask,
  type MyWorkExternalItem,
} from '@/hooks/useMyWork';
import { useTimeRollup } from '@/hooks/useTimeEntry';
import { formatMinutesAsHm } from '@/lib/parseHours';
import { countBlocked, selectVisibleTasks } from './myWorkBlocked';
import { useProjects } from '@/hooks/useProjects';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { MyWorkTaskRow } from './MyWorkTaskRow';
import { ExternalWorkItemRow } from './ExternalWorkItemRow';
import { MyWorkSourceFreshness } from './MyWorkSourceFreshness';
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
  /** Read-only external items (Jira etc.) bucketed into this group (#1422). */
  externalItems: MyWorkExternalItem[];
}

// Render order + contributor-facing labels (#484). Deliberately plain language —
// "Today" / "This Sprint" / "Upcoming", never "Phase" / "Early Finish" / "WBS".
const GROUP_ORDER: MyWorkGroup[] = ['today', 'this_sprint', 'upcoming'];
const GROUP_LABEL: Record<MyWorkGroup, string> = {
  today: 'Today',
  this_sprint: 'This Sprint',
  upcoming: 'Upcoming',
};

/** Local calendar date as YYYY-MM-DD, for lexicographic compare with `due_date`. */
function localTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Bucket read-only external items into the same Today / Upcoming groups as
 * native tasks (#1422). `done` items are hidden — a "what's on me" feed should
 * not carry finished work (Jira's default JQL already excludes Done). A dated
 * item due today or overdue lands in Today; everything else in Upcoming.
 * External items never map to This Sprint (they have no TruePPM sprint). The
 * server already ordered them (due date → bucket → recency), so each group
 * preserves that order.
 */
function groupExternalItems(
  items: MyWorkExternalItem[],
  todayIso: string,
): Record<MyWorkGroup, MyWorkExternalItem[]> {
  const buckets: Record<MyWorkGroup, MyWorkExternalItem[]> = {
    today: [],
    this_sprint: [],
    upcoming: [],
  };
  for (const it of items) {
    if (it.status_category === 'done') continue;
    if (it.due_date && it.due_date <= todayIso) buckets.today.push(it);
    else buckets.upcoming.push(it);
  }
  return buckets;
}

/**
 * Partition the flat list into its contiguous server-assigned buckets and fold
 * the bucketed external items in. The response is already sorted group_rank →
 * blocked-first → due, so the native group-by preserves server ordering within
 * each section; external items are appended after native rows in the same group.
 * A group renders when it has either native tasks or external items.
 */
function groupByBucket(
  tasks: MyWorkTask[],
  externalByGroup: Record<MyWorkGroup, MyWorkExternalItem[]>,
): WorkGroup[] {
  const buckets = new Map<MyWorkGroup, MyWorkTask[]>();
  for (const t of tasks) {
    const bucket = buckets.get(t.group) ?? [];
    bucket.push(t);
    buckets.set(t.group, bucket);
  }
  return GROUP_ORDER.map((g) => ({
    group: g,
    tasks: buckets.get(g) ?? [],
    externalItems: externalByGroup[g] ?? [],
  })).filter((g) => g.tasks.length > 0 || g.externalItems.length > 0);
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
  // Cross-program focus-card signals (#1236) — first page only; undefined when
  // the server has no real data to back any of them (honest omission).
  const signals = firstPage?.signals;
  const retroItemCount = firstPage?.retro_action_items?.length ?? 0;
  // Read-only external items + per-source freshness (#1422), first page only.
  const externalItems = useMemo(() => firstPage?.external_items ?? [], [firstPage]);
  const externalSources = useMemo(() => firstPage?.external_sources ?? [], [firstPage]);
  const sourceByType = useMemo(
    () => new Map(externalSources.map((s) => [s.source_type, s])),
    [externalSources],
  );
  // Visible external items exclude `done` (hidden from the feed), matching the
  // grouping. Drives the empty-state decision so a user whose only work is a
  // Jira item still sees their feed rather than the empty state.
  const externalVisibleCount = useMemo(
    () => externalItems.filter((i) => i.status_category !== 'done').length,
    [externalItems],
  );
  // Surface count includes retro suggestions/owned items and external items so an
  // empty native task list doesn't suppress the page when a user has pending
  // suggestions (ADR-0071 §4c) or only external work (#1422).
  const totalCount = allTasks.length + retroItemCount + externalVisibleCount;
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
  // Logged-time rollup for the header (#1234) — the current week's own totals, read
  // from the shared weekly-timesheet query so the header and per-row chips agree.
  const timeRollup = useTimeRollup();
  const [blockedOnly, setBlockedOnly] = useState(false);
  const filteringBlocked = blockedOnly && blockedCount > 0;
  const visibleTasks = useMemo(
    () => selectVisibleTasks(allTasks, filteringBlocked),
    [allTasks, filteringBlocked],
  );

  // When the blocked-only filter is active, hide external items too — they have
  // no blocked concept, so a "show only blocked" view should not carry them.
  const externalByGroup = useMemo(
    () => groupExternalItems(filteringBlocked ? [] : externalItems, localTodayIso()),
    [externalItems, filteringBlocked],
  );
  const workGroups = useMemo(
    () => groupByBucket(visibleTasks, externalByGroup),
    [visibleTasks, externalByGroup],
  );
  const focusCards = useMemo(
    () => buildMyWorkFocusCards(allTasks, activeSprints, dueTodayCount, signals),
    [allTasks, activeSprints, dueTodayCount, signals],
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
          {timeRollup.weekMinutes > 0 && (
            <span
              className="tppm-mono rounded-chip border border-neutral-border px-2 py-1 text-xs text-neutral-text-secondary"
              aria-label={
                `${formatMinutesAsHm(timeRollup.todayMinutes)} logged today, ` +
                `${formatMinutesAsHm(timeRollup.weekMinutes)} this week`
              }
            >
              {formatMinutesAsHm(timeRollup.todayMinutes)} today
              <span aria-hidden="true" className="text-neutral-text-secondary/60">
                {' · '}
                {formatMinutesAsHm(timeRollup.weekMinutes)} wk
              </span>
            </span>
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
        <MyWorkEmptyState
          hasProjects={(projects ?? []).length > 0}
          hasConnectedExternalSource={externalSources.some((s) => s.status !== 'not_connected')}
        />
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
                  <WorkGroupHeader
                    group={group.group}
                    taskCount={group.tasks.length + group.externalItems.length}
                  />
                  <ul className="flex flex-col">
                    {group.tasks.map((t) => (
                      <MyWorkTaskRow key={t.id} task={t} />
                    ))}
                    {/* External items render after native tasks in the same
                        group — one unified feed, not a siloed section (#1422). */}
                    {group.externalItems.map((it) => (
                      <ExternalWorkItemRow
                        key={it.id}
                        item={it}
                        source={sourceByType.get(it.source_type)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
              {/* Per-source freshness / reconnect line for connected external
                  sources (#1422). Self-suppresses when none are connected. */}
              <MyWorkSourceFreshness sources={externalSources} />
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

            {hasWork && (
              <MyWorkSideColumn
                tasks={allTasks}
                activeSprints={activeSprints}
                forecast={signals?.forecast}
              />
            )}
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
          className="h-11 rounded-card bg-neutral-surface-sunken motion-safe:animate-pulse"
        />
      ))}
    </ul>
  );
}
