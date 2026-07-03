import { useState } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { useResourceHeatmap } from '@/hooks/useResourceHeatmap';
import { useResourceSummary } from '@/hooks/useResourceSummary';
import { useTriggerScheduler } from '@/hooks/useTriggerScheduler';
import { ResourcesKpiRow, ResourcesKpiRowSkeleton } from './ResourcesKpiRow';
import { ResourcesHeatmap, ResourcesHeatmapSkeleton } from './ResourcesHeatmap';
import { ResourceEmptyState } from './ResourceEmptyState';
import { WeeksWindowControl, readPersistedWindow } from './WeeksWindowControl';
import type { WeeksWindow } from './WeeksWindowControl';
import { registry } from '@/lib/widget-registry';

type GroupBy = 'role' | 'project' | 'none';

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

  const heatmapResult = useResourceHeatmap(
    projectId ?? undefined,
    weekStart,
    weeks,
    groupBy,
  );
  const summaryResult = useResourceSummary(projectId ?? undefined);

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
        {/* Title block */}
        <div>
          <h1 className="text-lg font-semibold text-neutral-text-primary">
            Resource allocation
          </h1>
          <p className="text-xs text-neutral-text-secondary mt-0.5">Team</p>
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
              className="w-7 h-7 flex items-center justify-center rounded border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
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
              className="w-7 h-7 flex items-center justify-center rounded border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              ›
            </button>
          </div>

          {/* Group-by toggle */}
          <button
            type="button"
            onClick={cycleGroupBy}
            className="h-7 px-3 text-xs font-medium rounded border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
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
          {/* KPI row */}
          {summaryResult.status === 'loading' ? (
            <ResourcesKpiRowSkeleton />
          ) : summaryResult.status === 'success' ? (
            <ResourcesKpiRow data={summaryResult.data!} />
          ) : (
            <div className="text-xs text-semantic-critical px-1">
              Could not load summary.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => window.location.reload()}
              >
                Retry
              </button>
            </div>
          )}

          {/* Heatmap */}
          {heatmapResult.status === 'loading' ? (
            <ResourcesHeatmapSkeleton cols={weeks} />
          ) : heatmapResult.status === 'success' && heatmapResult.data ? (
            heatmapResult.data.resources.length === 0 ? (
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
            ) : (
              <ResourcesHeatmap
                projectId={projectId ?? ''}
                weeks={heatmapResult.data.weeks}
                resources={heatmapResult.data.resources}
              />
            )
          ) : heatmapResult.status === 'error' ? (
            <div className="text-xs text-semantic-critical px-1">
              Could not load heatmap.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => window.location.reload()}
              >
                Retry
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
