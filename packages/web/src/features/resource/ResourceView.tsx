/**
 * Resource view — Utilization grid (issue #22) + Allocation Timeline (issue #85).
 *
 * Rendered by ProjectShell when view === 'resources'.
 * Permission gate: SCHEDULER (role ≥ 2) only (rule 94).
 *
 * View modes:
 *   timeline    — per-resource task spans on a time axis (default, issue #85)
 *   utilization — per-resource day-cell load heat-map (issue #22)
 *
 * The active mode is stored in localStorage so it persists per-session.
 */
import { useState, useRef, useEffect } from 'react';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { ResourceToolbar, type ViewMode } from './ResourceToolbar';
import { ResourceGrid } from './ResourceGrid';
import { ResourceEmptyState } from './ResourceEmptyState';
import { PermissionDeniedNotice } from './PermissionDeniedNotice';
import { QueryErrorState } from '@/components/QueryErrorState';
import { ResourceOverallocationDrawer } from './ResourceOverallocationDrawer';
import { ResourceAllocationTimeline } from './ResourceAllocationTimeline';
import {
  defaultWindow,
  fitToProjectWindow,
  fitToAllocationWindow,
  addDays,
  formatISODate,
  parseUTCDate,
  detectOverallocatedAssignments,
  partialAllocationStripeStyle,
} from './resourceUtils';
import { useResourceUtilization } from '@/hooks/useResourceUtilization';
import { useResourceAllocation, useInvalidateAllocation } from '@/hooks/useResourceAllocation';
import { useResolveOverallocation } from '@/hooks/useResolveOverallocation';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProjectId } from '@/hooks/useProjectId';
import { useTriggerScheduler } from '@/hooks/useTriggerScheduler';


const MODE_STORAGE_KEY = 'trueppm.resources.viewMode';

interface Props {
  projectId?: string;
  projectStartDate?: string;
  /** Current user's resource ID for "My allocation" shortcut. */
  currentUserResourceId?: string;
  /**
   * Resource ID to pre-highlight on mount (from Overview deep-link
   * via ?highlight=<uuid> query param, resolved by the parent shell).
   */
  highlightResourceId?: string;
}

export function ResourceView({
  projectId: projectIdProp,
  projectStartDate,
  currentUserResourceId,
  highlightResourceId: _highlightResourceId,
}: Props) {
  // document.title for this route is set at the router level (router.tsx
  // `handle.title`) — see RouteTitle (issue 1915, completes #1327 A4).
  const projectIdFromUrl = useProjectId();
  const projectId = projectIdProp ?? projectIdFromUrl;
  const triggerScheduler = useTriggerScheduler(projectId);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const stored = localStorage.getItem(MODE_STORAGE_KEY);
      return stored === 'utilization' ? 'utilization' : 'timeline';
    } catch {
      return 'timeline';
    }
  });

  const [window_, setWindow] = useState(() => defaultWindow());
  const [isFitToProject, setIsFitToProject] = useState(false);
  const [myAllocationActive, setMyAllocationActive] = useState(false);
  const [statusFilters, setStatusFilters] = useState<string[]>(['NOT_STARTED', 'IN_PROGRESS']);
  const [resourceSearch, setResourceSearch] = useState('');

  const resourceFilter = myAllocationActive && currentUserResourceId
    ? [currentUserResourceId]
    : undefined;

  // --- Data hooks ---
  const utilizationResult = useResourceUtilization(
    viewMode === 'utilization' ? projectId : undefined,
    window_.start,
    window_.end,
  );

  const allocationResult = useResourceAllocation(
    viewMode === 'timeline' ? projectId : undefined,
    {
      start: window_.start,
      end: window_.end,
      resource: resourceFilter,
      status: statusFilters.length > 0 ? statusFilters : undefined,
    },
  );

  // Wire this to WS assignment_* events when the WS layer is connected to ResourceView
  useInvalidateAllocation(projectId);
  const { target, isOpen, openDrawer, closeDrawer, ariaMessage } = useResolveOverallocation();
  const ariaLiveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ariaLiveRef.current) {
      ariaLiveRef.current.textContent = ariaMessage ?? '';
    }
  }, [ariaMessage]);

  // Persist view mode
  useEffect(() => {
    try {
      localStorage.setItem(MODE_STORAGE_KEY, viewMode);
    } catch {
      // ignore
    }
  }, [viewMode]);

  // --- Permission gate (rule 94) ---
  const { role, isLoading: roleLoading } = useCurrentUserRole(projectId);
  if (!roleLoading && (role === null || role < ROLE_SCHEDULER)) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <PermissionDeniedNotice />
      </div>
    );
  }

  // --- No project ---
  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-neutral-text-secondary">
        No project selected.
      </div>
    );
  }

  const activeStatus = viewMode === 'timeline' ? allocationResult.status : utilizationResult.status;

  if (activeStatus === 'idle') {
    return (
      <div className="flex items-center justify-center h-full text-xs text-neutral-text-secondary">
        No project selected.
      </div>
    );
  }

  if (activeStatus === 'schedule-not-run') {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <ResourceEmptyState onRunScheduler={() => void triggerScheduler()} />
      </div>
    );
  }

  if (activeStatus === 'loading') {
    // Row-ghost skeleton mirroring the grid/timeline shape (rule 248) — a bare
    // "Loading…" line reads as a broken surface; every peer (HeatmapPage) shows
    // a shaped skeleton within 200ms.
    return (
      <div
        className="flex h-full flex-col gap-1 p-3 bg-neutral-surface"
        role="status"
        aria-label="Loading resource data"
        aria-busy="true"
      >
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-11 rounded motion-safe:animate-pulse bg-neutral-surface-sunken"
          />
        ))}
      </div>
    );
  }

  if (activeStatus === 'error') {
    // A dead surface on a primary route is an assertive, retry-able failure —
    // never a bare dead-end line (rule 246, #1764). The typed-status hook does
    // not surface a refetch, so retry reloads (matching sibling HeatmapPage).
    return <QueryErrorState message="Couldn't load resource data." />;
  }

  // --- Navigation ---
  function goNext() {
    setIsFitToProject(false);
    setWindow((w) => ({
      start: formatISODate(addDays(parseUTCDate(w.start), 28)),
      end: formatISODate(addDays(parseUTCDate(w.end), 28)),
    }));
  }

  function goPrev() {
    setIsFitToProject(false);
    setWindow((w) => ({
      start: formatISODate(addDays(parseUTCDate(w.start), -28)),
      end: formatISODate(addDays(parseUTCDate(w.end), -28)),
    }));
  }

  function goToday() {
    setIsFitToProject(false);
    setWindow(defaultWindow());
  }

  function handleFitToggle() {
    if (isFitToProject) {
      setIsFitToProject(false);
      setWindow(defaultWindow());
      return;
    }
    if (!projectStartDate) return;

    if (viewMode === 'timeline' && allocationResult.data) {
      setIsFitToProject(true);
      setWindow(fitToAllocationWindow(projectStartDate, allocationResult.data));
    } else if (viewMode === 'utilization' && utilizationResult.data) {
      setIsFitToProject(true);
      setWindow(fitToProjectWindow(projectStartDate, utilizationResult.data));
    }
  }

  function handleMyAllocationToggle() {
    setMyAllocationActive((v) => !v);
  }

  const unassignedCount =
    viewMode === 'utilization' ? (utilizationResult.data?.unassigned_task_count ?? 0) : 0;

  // Count resources with at least one overallocated day in the current window.
  const overallocationCount =
    viewMode === 'timeline' && allocationResult.data
      ? allocationResult.data.resources.filter((r) => {
          const over = detectOverallocatedAssignments(r.tasks, Number.parseFloat(r.max_units));
          return over.size > 0;
        }).length
      : 0;

  // Filter resource rows by the search query (client-side, case-insensitive).
  const filteredAllocationData =
    resourceSearch.trim() && allocationResult.data
      ? {
          ...allocationResult.data,
          resources: allocationResult.data.resources.filter((r) =>
            r.name.toLowerCase().includes(resourceSearch.trim().toLowerCase()),
          ),
        }
      : allocationResult.data;

  const timelineResourceCount = filteredAllocationData?.resources.length ?? 0;
  const timelineAssignmentCount =
    filteredAllocationData?.resources.reduce((sum, r) => sum + r.tasks.length, 0) ?? 0;

  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">
        <h1 className="sr-only">Resources</h1>
        <ResourceToolbar
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          windowStart={window_.start}
          windowEnd={window_.end}
          unassignedCount={unassignedCount}
          overallocationCount={overallocationCount}
          isFitToProject={isFitToProject}
          myAllocationActive={myAllocationActive}
          onPrev={goPrev}
          onNext={goNext}
          onToday={goToday}
          onFitToggle={handleFitToggle}
          onMyAllocationToggle={handleMyAllocationToggle}
          showMyAllocation={!!currentUserResourceId}
          statusFilters={statusFilters}
          onStatusFiltersChange={setStatusFilters}
          resourceSearch={resourceSearch}
          onResourceSearchChange={setResourceSearch}
        />

        {viewMode === 'timeline' && filteredAllocationData && (
          filteredAllocationData.resources.length === 0 ? (
            <div className="flex items-center justify-center flex-1 text-xs text-neutral-text-secondary">
              {resourceSearch.trim() ? 'No resources match the filter.' : 'No assignments in this window.'}
            </div>
          ) : (
            <div className="flex-1 min-h-0">
              <ResourceAllocationTimeline
                data={filteredAllocationData}
                windowStart={window_.start}
                windowEnd={window_.end}
                currentUserResourceId={currentUserResourceId}
                projectId={projectId}
                onRunScheduler={() => void triggerScheduler()}
              />
            </div>
          )
        )}

        {/* Timeline status bar — resource/assignment counts + legend */}
        {viewMode === 'timeline' && filteredAllocationData && filteredAllocationData.resources.length > 0 && (
          <div
            className="flex-shrink-0 flex items-center gap-4 px-4 h-7 border-t border-neutral-border bg-neutral-surface-sunken text-xs text-neutral-text-secondary hidden md:flex"
            aria-label="Resource timeline summary"
          >
            <span className="tppm-mono">
              {timelineResourceCount} resource{timelineResourceCount !== 1 ? 's' : ''}
            </span>
            <span aria-hidden="true">·</span>
            <span className="tppm-mono">
              {timelineAssignmentCount} assignment{timelineAssignmentCount !== 1 ? 's' : ''}
            </span>
            {overallocationCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tppm-mono text-semantic-critical">
                  {overallocationCount} over-allocated
                </span>
              </>
            )}
            <div className="flex-1" />
            {/* Legend */}
            <div className="flex items-center gap-3" aria-label="Legend">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-chip bg-brand-primary inline-block" aria-hidden="true" />
                Normal
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="w-2.5 h-2.5 rounded-chip bg-brand-primary inline-block"
                  style={partialAllocationStripeStyle('legend')}
                  aria-hidden="true"
                />
                Partial (&lt;100%)
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-chip bg-semantic-critical inline-block" aria-hidden="true" />
                Over-allocated
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-chip bg-neutral-border inline-block" aria-hidden="true" />
                Complete
              </span>
            </div>
          </div>
        )}

        {viewMode === 'utilization' && utilizationResult.data && (
          utilizationResult.data.resources.length === 0 ? (
            <div className="flex items-center justify-center flex-1 text-xs text-neutral-text-secondary">
              No resources assigned in this window.
            </div>
          ) : (
            <div className="flex-1 min-h-0">
              <ResourceGrid
                resources={utilizationResult.data.resources}
                windowStart={window_.start}
                windowEnd={window_.end}
                onOpenDrawer={openDrawer}
              />
            </div>
          )
        )}
      </div>

      <div
        ref={ariaLiveRef}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />

      <ResourceOverallocationDrawer
        target={target}
        isOpen={isOpen}
        onClose={closeDrawer}
      />
    </>
  );
}
