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
import { useState, useRef, useEffect, type ComponentProps } from 'react';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { ResourceToolbar, type ViewMode } from './ResourceToolbar';
import { ResourceGrid } from './ResourceGrid';
import { ResourceEmptyState } from './ResourceEmptyState';
import { PermissionDeniedNotice } from './PermissionDeniedNotice';
import { RoleReadFailedNotice } from './RoleReadFailedNotice';
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
import type { AllocationResponse, UtilizationResponse } from './resourceUtils';
import { useResourceUtilization } from '@/hooks/useResourceUtilization';
import {
  useResourceAllocation,
  useInvalidateAllocation,
  type AllocationStatus,
} from '@/hooks/useResourceAllocation';
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

type TimeWindow = { start: string; end: string };

/** Read the persisted view mode, tolerating a blocked/unavailable localStorage. */
function readStoredViewMode(): ViewMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === 'utilization' ? 'utilization' : 'timeline';
  } catch {
    return 'timeline';
  }
}

/** Persist the view mode, ignoring storage failures (private mode / quota). */
function persistViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // ignore — a non-persisted preference is acceptable
  }
}

/**
 * Permission gate (rule 94): SCHEDULER (role ≥ 2) required; a loading role defers the
 * decision, and so does a **failed** role read.
 *
 * `roleError` is a parameter rather than something inferred from `role === null`,
 * because null means two different things — "no membership" and "the request failed"
 * — and this function's answer is rendered as a permission wall. Stating the wrong one
 * as fact sends a Scheduler off to ask for access they already hold (#2998).
 */
function roleIsDenied(roleLoading: boolean, roleError: boolean, role: number | null): boolean {
  if (roleLoading || roleError) return false;
  return role === null || role < ROLE_SCHEDULER;
}

/** "My allocation" resource filter, or undefined when the shortcut is off or no user resource exists. */
function computeResourceFilter(
  myAllocationActive: boolean,
  currentUserResourceId: string | undefined,
): string[] | undefined {
  return myAllocationActive && currentUserResourceId ? [currentUserResourceId] : undefined;
}

/** Next window when "Fit to project" is switched on, or null when there is nothing to fit. */
function computeFitWindow(
  viewMode: ViewMode,
  projectStartDate: string | undefined,
  allocationData: AllocationResponse | undefined,
  utilizationData: UtilizationResponse | undefined,
): TimeWindow | null {
  if (!projectStartDate) return null;
  if (viewMode === 'timeline' && allocationData) {
    return fitToAllocationWindow(projectStartDate, allocationData);
  }
  if (viewMode === 'utilization' && utilizationData) {
    return fitToProjectWindow(projectStartDate, utilizationData);
  }
  return null;
}

/** Number of resources with at least one overallocated day in-window (timeline mode only). */
function countOverallocatedResources(
  viewMode: ViewMode,
  allocationData: AllocationResponse | undefined,
): number {
  if (viewMode !== 'timeline' || !allocationData) return 0;
  return allocationData.resources.filter((r) => {
    const over = detectOverallocatedAssignments(r.tasks, Number.parseFloat(r.max_units));
    return over.size > 0;
  }).length;
}

/** Narrow allocation rows by a case-insensitive resource-name search (client-side). */
function filterAllocationBySearch(
  allocationData: AllocationResponse | undefined,
  search: string,
): AllocationResponse | undefined {
  if (!search.trim() || !allocationData) return allocationData;
  const q = search.trim().toLowerCase();
  return {
    ...allocationData,
    resources: allocationData.resources.filter((r) => r.name.toLowerCase().includes(q)),
  };
}

/**
 * Non-ready view states (rule 246/248, #1764/#2177): a shaped busy skeleton
 * while loading, a retry-able error surface on failure, the run-scheduler empty
 * state when the schedule hasn't run, and a placeholder when no project is
 * selected. Returns null once data is ready so the caller renders the grid.
 */
function renderResourceGuard(status: AllocationStatus, onRunScheduler: () => void) {
  if (status === 'idle') {
    return (
      <div className="flex items-center justify-center h-full text-xs text-neutral-text-secondary">
        No project selected.
      </div>
    );
  }
  if (status === 'schedule-not-run') {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <ResourceEmptyState onRunScheduler={onRunScheduler} />
      </div>
    );
  }
  if (status === 'loading') {
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
  if (status === 'error') {
    // A dead surface on a primary route is an assertive, retry-able failure —
    // never a bare dead-end line (rule 246, #1764). The typed-status hook does
    // not surface a refetch, so retry reloads (matching sibling HeatmapPage).
    return <QueryErrorState message="Couldn't load resource data." />;
  }
  return null;
}

/** Timeline mode body: empty-window message, or the allocation timeline. */
function TimelinePanel({
  data,
  windowStart,
  windowEnd,
  resourceSearch,
  currentUserResourceId,
  projectId,
  onRunScheduler,
}: {
  data: AllocationResponse;
  windowStart: string;
  windowEnd: string;
  resourceSearch: string;
  currentUserResourceId: string | undefined;
  projectId: string;
  onRunScheduler: () => void;
}) {
  if (data.resources.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 text-xs text-neutral-text-secondary">
        {resourceSearch.trim() ? 'No resources match the filter.' : 'No assignments in this window.'}
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0">
      <ResourceAllocationTimeline
        data={data}
        windowStart={windowStart}
        windowEnd={windowEnd}
        currentUserResourceId={currentUserResourceId}
        projectId={projectId}
        onRunScheduler={onRunScheduler}
      />
    </div>
  );
}

/** Timeline status bar: resource/assignment counts + the allocation legend (md+ only). */
function TimelineStatusBar({
  resourceCount,
  assignmentCount,
  overallocationCount,
}: {
  resourceCount: number;
  assignmentCount: number;
  overallocationCount: number;
}) {
  return (
    <div
      className="flex-shrink-0 flex items-center gap-4 px-4 h-7 border-t border-neutral-border bg-neutral-surface-sunken text-xs text-neutral-text-secondary hidden md:flex"
      aria-label="Resource timeline summary"
    >
      <span className="tppm-mono">
        {resourceCount} resource{resourceCount !== 1 ? 's' : ''}
      </span>
      <span aria-hidden="true">·</span>
      <span className="tppm-mono">
        {assignmentCount} assignment{assignmentCount !== 1 ? 's' : ''}
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
  );
}

/** Utilization mode body: empty-window message, or the per-day load grid. */
function UtilizationPanel({
  data,
  windowStart,
  windowEnd,
  onOpenDrawer,
}: {
  data: UtilizationResponse;
  windowStart: string;
  windowEnd: string;
  onOpenDrawer: ComponentProps<typeof ResourceGrid>['onOpenDrawer'];
}) {
  if (data.resources.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 text-xs text-neutral-text-secondary">
        No resources assigned in this window.
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0">
      <ResourceGrid
        resources={data.resources}
        windowStart={windowStart}
        windowEnd={windowEnd}
        onOpenDrawer={onOpenDrawer}
      />
    </div>
  );
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
  const [viewMode, setViewMode] = useState<ViewMode>(readStoredViewMode);

  const [window_, setWindow] = useState(() => defaultWindow());
  const [isFitToProject, setIsFitToProject] = useState(false);
  const [myAllocationActive, setMyAllocationActive] = useState(false);
  const [statusFilters, setStatusFilters] = useState<string[]>(['NOT_STARTED', 'IN_PROGRESS']);
  const [resourceSearch, setResourceSearch] = useState('');

  const resourceFilter = computeResourceFilter(myAllocationActive, currentUserResourceId);

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
    persistViewMode(viewMode);
  }, [viewMode]);

  // --- Permission gate (rule 94) ---
  const {
    role,
    isLoading: roleLoading,
    isError: roleError,
    refetch: refetchRole,
  } = useCurrentUserRole(projectId);
  // A failed read is its own state, rendered before the denial branch: the hook sets
  // `retry: false`, so one blip would otherwise put a permission wall in front of an
  // Owner with no way to tell it from a real refusal (#2998).
  if (!roleLoading && roleError) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <RoleReadFailedNotice onRetry={() => refetchRole?.()} />
      </div>
    );
  }
  if (roleIsDenied(roleLoading, roleError ?? false, role)) {
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

  // idle / schedule-not-run / loading / error all render a dedicated non-ready
  // surface; only 'success' falls through to the grid below.
  const stateGuard = renderResourceGuard(activeStatus, () => void triggerScheduler());
  if (stateGuard) return stateGuard;

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
    const fit = computeFitWindow(
      viewMode,
      projectStartDate,
      allocationResult.data,
      utilizationResult.data,
    );
    if (fit) {
      setIsFitToProject(true);
      setWindow(fit);
    }
  }

  function handleMyAllocationToggle() {
    setMyAllocationActive((v) => !v);
  }

  const unassignedCount =
    viewMode === 'utilization' ? (utilizationResult.data?.unassigned_task_count ?? 0) : 0;

  const overallocationCount = countOverallocatedResources(viewMode, allocationResult.data);

  // Filter resource rows by the search query (client-side, case-insensitive).
  const filteredAllocationData = filterAllocationBySearch(allocationResult.data, resourceSearch);

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
          <TimelinePanel
            data={filteredAllocationData}
            windowStart={window_.start}
            windowEnd={window_.end}
            resourceSearch={resourceSearch}
            currentUserResourceId={currentUserResourceId}
            projectId={projectId}
            onRunScheduler={() => void triggerScheduler()}
          />
        )}

        {/* Timeline status bar — resource/assignment counts + legend */}
        {viewMode === 'timeline' &&
          filteredAllocationData &&
          filteredAllocationData.resources.length > 0 && (
            <TimelineStatusBar
              resourceCount={timelineResourceCount}
              assignmentCount={timelineAssignmentCount}
              overallocationCount={overallocationCount}
            />
          )}

        {viewMode === 'utilization' && utilizationResult.data && (
          <UtilizationPanel
            data={utilizationResult.data}
            windowStart={window_.start}
            windowEnd={window_.end}
            onOpenDrawer={openDrawer}
          />
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
