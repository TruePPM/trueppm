import { useState } from 'react';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { useProjectId } from '@/hooks/useProjectId';
import { useResourceHeatmap } from '@/hooks/useResourceHeatmap';
import { useResourceSummary } from '@/hooks/useResourceSummary';
import { useTriggerScheduler } from '@/hooks/useTriggerScheduler';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ResourcesKpiRow, ResourcesKpiRowSkeleton } from './ResourcesKpiRow';
import { ResourcesHeatmap, ResourcesHeatmapSkeleton } from './ResourcesHeatmap';
import { ResourceEmptyState } from './ResourceEmptyState';
import { PermissionDeniedNotice } from './PermissionDeniedNotice';
import { RoleReadFailedNotice } from './RoleReadFailedNotice';
import { WeeksWindowControl, readPersistedWindow } from './WeeksWindowControl';
import type { WeeksWindow } from './WeeksWindowControl';
import { registry } from '@/lib/widget-registry';

type GroupBy = 'role' | 'project' | 'none';

/**
 * Permission gate (rule 94, #3844): SCHEDULER (role >= ROLE_SCHEDULER) required,
 * same floor as the Allocation tab (`ResourceView.tsx`) and the server-side
 * `IsProjectScheduler` gate on the `heatmap` / `resources_summary` actions.
 *
 * Copied verbatim from `ResourceView.tsx`'s `roleIsDenied` rather than shared,
 * since neither module exports it (#2998 covers why `roleLoading`/`roleError`
 * are explicit parameters instead of inferring from `role === null`).
 */
function roleIsDenied(roleLoading: boolean, roleError: boolean, role: number | null): boolean {
  if (roleLoading || roleError) return false;
  return role === null || role < ROLE_SCHEDULER;
}

/** ISO date string for the Monday of the current week. */
function currentWeekMonday(): string {
  const today = new Date();
  const diff = today.getDay() === 0 ? -6 : 1 - today.getDay(); // getDay: 0=Sun
  const monday = new Date(today);
  monday.setDate(today.getDate() + diff);
  return monday.toISOString().slice(0, 10);
}

/** Format an ISO week label into a display string, e.g. "W18" → "W18". */
function weekDisplay(isoWeek: string): string {
  return isoWeek.includes('-W') ? `W${isoWeek.split('-W')[1]}` : isoWeek;
}

type HeatmapResult = ReturnType<typeof useResourceHeatmap>;
type SummaryResult = ReturnType<typeof useResourceSummary>;

/** KPI row for the Heatmap page: skeleton while loading, 4-card row on success, retry line on error. */
function KpiSection({ summary, heatmap }: { summary: SummaryResult; heatmap: HeatmapResult }) {
  if (summary.status === 'loading') return <ResourcesKpiRowSkeleton />;
  if (summary.status === 'success') {
    // Single source of truth for headcount + the "No team members yet" empty
    // state below (#3478): derive headcount from the heatmap's OWN resource
    // list rather than the summary endpoint's independently-computed count,
    // so the two numbers on this page can never disagree. Falls back to the
    // summary's headcount while the heatmap query is still loading or has
    // errored — a transient heatmap failure should not blank an otherwise-
    // successful KPI row.
    const headcount =
      heatmap.status === 'success' && heatmap.data
        ? heatmap.data.resources.length
        : summary.data!.headcount;
    return <ResourcesKpiRow data={summary.data!} headcount={headcount} />;
  }
  return (
    <div className="text-xs text-semantic-critical px-1">
      Could not load summary.{' '}
      <button type="button" className="underline" onClick={() => window.location.reload()}>
        Retry
      </button>
    </div>
  );
}

/**
 * Week × person heatmap grid: skeleton while loading, the grid (or an empty
 * "no team members" prompt) on success, a retry line on error.
 */
function HeatmapSection({
  heatmap,
  weeks,
  projectId,
}: {
  heatmap: HeatmapResult;
  weeks: WeeksWindow;
  projectId: string | undefined;
}) {
  if (heatmap.status === 'loading') return <ResourcesHeatmapSkeleton cols={weeks} />;
  if (heatmap.status === 'error') {
    return (
      <div className="text-xs text-semantic-critical px-1">
        Could not load heatmap.{' '}
        <button type="button" className="underline" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }
  if (heatmap.status === 'success' && heatmap.data) {
    if (heatmap.data.resources.length === 0) {
      return (
        <div
          className="flex items-center justify-center py-12 text-sm text-neutral-text-secondary"
          role="status"
        >
          No team members yet —{' '}
          <a
            href={`../roster`}
            className="ml-1 underline text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            add resources via the Roster tab
          </a>
          .
        </div>
      );
    }
    return (
      <ResourcesHeatmap
        projectId={projectId ?? ''}
        weeks={heatmap.data.weeks}
        resources={heatmap.data.resources}
      />
    );
  }
  return null;
}

/**
 * Resources / Team — Heatmap sub-page (issues #217 + #219, ADR-0042).
 *
 * Composed of:
 *  - Page header strip (title, over-allocated pill, week nav, group-by, window, Level loads)
 *  - ResourcesKpiRow (4 KPI cards)
 *  - ResourcesHeatmap (week × person grid)
 */
export function HeatmapPage() {
  const projectId = useProjectId();
  const triggerScheduler = useTriggerScheduler(projectId);

  const [weekStart, setWeekStart] = useState(currentWeekMonday);
  const [weeks, setWeeks] = useState<WeeksWindow>(readPersistedWindow);
  const [groupBy, setGroupBy] = useState<GroupBy>('none');

  // --- Permission gate (rule 94, #3844) ---
  const {
    role,
    isLoading: roleLoading,
    isError: roleError,
    refetch: refetchRole,
  } = useCurrentUserRole(projectId);
  const denied = roleIsDenied(roleLoading, roleError ?? false, role);

  // Check the role BEFORE firing the data query: a denied caller never gets a
  // project id threaded into either hook, so no request for named per-person
  // utilization data goes out. (The initial-load race while the role read is
  // still in flight is the same one `ResourceView.tsx` accepts — the server's
  // `IsProjectScheduler` gate is the actual enforcement point either way.)
  const gatedProjectId = denied ? undefined : projectId;

  const heatmapResult = useResourceHeatmap(
    gatedProjectId,
    weekStart,
    weeks,
    groupBy,
  );
  const summaryResult = useResourceSummary(gatedProjectId);

  // A failed role read is its own state, rendered before the denial branch — see
  // `ResourceView.tsx`'s identical gate (#2998) for why isError must not become a
  // blanket denial.
  if (!roleLoading && roleError) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <RoleReadFailedNotice onRetry={() => refetchRole?.()} />
      </div>
    );
  }
  if (denied) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <PermissionDeniedNotice />
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Week navigation helpers
  // --------------------------------------------------------------------------

  function shiftWeeks(direction: -1 | 1) {
    const date = new Date(weekStart + 'T00:00:00');
    date.setDate(date.getDate() + direction * 7);
    setWeekStart(date.toISOString().slice(0, 10));
  }

  function cycleGroupBy() {
    // Cycle none → role → none (project grouping deferred to Enterprise)
    setGroupBy((g) => (g === 'none' ? 'role' : 'none'));
  }

  // --------------------------------------------------------------------------
  // Derived state for header
  // --------------------------------------------------------------------------

  const overAllocatedCount =
    summaryResult.status === 'success' ? summaryResult.data!.over_allocated_count : 0;

  const currentWeekNum = heatmapResult.data?.weeks[0]
    ? weekDisplay(heatmapResult.data.weeks[0])
    : weekDisplay(`2000-W01`);

  const isScheduleNotRun =
    heatmapResult.status === 'schedule-not-run' ||
    summaryResult.status === 'schedule-not-run';

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {/* Title block — "Team" everywhere (rail, breadcrumb, heading, document
            title; #3478): Roster / Allocation / Heatmap are its tabs, not
            separate page identities. */}
        <div>
          <h1 className="text-lg font-semibold text-neutral-text-primary">Team</h1>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Over-allocated pill */}
          {overAllocatedCount > 0 && (
            <span className="text-xs font-medium px-2.5 py-1 rounded-full border border-semantic-at-risk/80 bg-semantic-at-risk-bg text-semantic-at-risk tppm-mono">
              {overAllocatedCount} over-allocated
            </span>
          )}

          {/* Week navigation */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => shiftWeeks(-1)}
              aria-label="Previous week"
              className="w-11 h-11 md:w-7 md:h-7 flex items-center justify-center rounded border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              ‹
            </button>
            <span className="text-xs font-medium text-neutral-text-primary tppm-mono min-w-[32px] text-center">
              {currentWeekNum}
            </span>
            <button
              type="button"
              onClick={() => shiftWeeks(1)}
              aria-label="Next week"
              className="w-11 h-11 md:w-7 md:h-7 flex items-center justify-center rounded border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              ›
            </button>
          </div>

          {/* Group-by toggle */}
          <button
            type="button"
            onClick={cycleGroupBy}
            className="min-h-11 md:min-h-7 px-3 text-xs font-medium rounded border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            aria-label={`Group by: ${groupBy === 'role' ? 'Role' : 'None'}`}
          >
            Group: {groupBy === 'role' ? 'Role' : 'None'}
          </button>

          {/* Window control */}
          <WeeksWindowControl value={weeks} onChange={setWeeks} />

          {/* Level loads — Enterprise injects its button via the
              resources_heatmap.level_loads slot. In OSS the slot has no
              override, so we render nothing: adoption-first forbids a disabled
              Enterprise teaser in the OSS UI (issue 1614). The within-program
              leveling engine is separately tracked in issue 1442. */}
          {registry
            .get('resources_heatmap.level_loads')
            .map(({ id, component: Component }) => (
              <Component key={id} />
            ))}
        </div>
      </div>

      {/* Schedule-not-run empty state covers both KPI and heatmap */}
      {isScheduleNotRun ? (
        <ResourceEmptyState onRunScheduler={() => void triggerScheduler()} />
      ) : (
        <>
          <KpiSection summary={summaryResult} heatmap={heatmapResult} />
          <HeatmapSection heatmap={heatmapResult} weeks={weeks} projectId={projectId} />
        </>
      )}
    </div>
  );
}
