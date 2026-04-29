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
import { ResourceToolbar, type ViewMode } from './ResourceToolbar';
import { ResourceGrid } from './ResourceGrid';
import { ResourceEmptyState } from './ResourceEmptyState';
import { PermissionDeniedNotice } from './PermissionDeniedNotice';
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
} from './resourceUtils';
import { useResourceUtilization } from '@/hooks/useResourceUtilization';
import { useResourceAllocation, useInvalidateAllocation } from '@/hooks/useResourceAllocation';
import { useResolveOverallocation } from '@/hooks/useResolveOverallocation';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProjectId } from '@/hooks/useProjectId';
import { useTriggerScheduler } from '@/hooks/useTriggerScheduler';

const SCHEDULER_ROLE = 2;

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
  if (!roleLoading && (role === null || role < SCHEDULER_ROLE)) {
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
        <ResourceEmptyState onRunScheduler={triggerScheduler} />
      </div>
    );
  }

  if (activeStatus === 'loading') {
    return (
      <div className="flex items-center justify-center h-full text-xs text-neutral-text-secondary">
        Loading…
      </div>
    );
  }

  if (activeStatus === 'error') {
    return (
      <div className="flex items-center justify-center h-full text-xs text-semantic-critical">
        Failed to load resource data.
      </div>
    );
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
          const over = detectOverallocatedAssignments(r.tasks, parseFloat(r.max_units));
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

  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">
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
                onRunScheduler={triggerScheduler}
              />
            </div>
          )
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
