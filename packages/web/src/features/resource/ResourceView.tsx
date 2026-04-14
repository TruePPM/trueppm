/**
 * Resource utilization view (issue #22).
 *
 * Rendered by ProjectShell when view === 'resources'.
 * Permission gate: SCHEDULER (role ≥ 2) only (rule 94).
 * Default window: rolling ±4 weeks from today (rule 93).
 */
import { useState, useRef, useEffect } from 'react';
import { ResourceToolbar } from './ResourceToolbar';
import { ResourceGrid } from './ResourceGrid';
import { ResourceEmptyState } from './ResourceEmptyState';
import { PermissionDeniedNotice } from './PermissionDeniedNotice';
import { ResourceOverallocationDrawer } from './ResourceOverallocationDrawer';
import { defaultWindow, fitToProjectWindow, addDays, formatISODate, parseUTCDate } from './resourceUtils';
import { useResourceUtilization } from '@/hooks/useResourceUtilization';
import { useResolveOverallocation } from '@/hooks/useResolveOverallocation';

// ---------------------------------------------------------------------------
// Role stub — replace with real useCurrentUserRole() when auth is wired in.
// Values mirror the Django Role enum: VIEWER=0, MEMBER=1, SCHEDULER=2, ADMIN=3.
// ---------------------------------------------------------------------------
const STUB_ROLE = 2; // SCHEDULER

const SCHEDULER_ROLE = 2;

interface Props {
  projectId?: string;
  /** ISO date string — passed from Project model for "Fit to project" baseline. */
  projectStartDate?: string;
}

export function ResourceView({ projectId, projectStartDate }: Props) {
  const [window_, setWindow] = useState(() => defaultWindow());
  const [isFitToProject, setIsFitToProject] = useState(false);

  const { data, status } = useResourceUtilization(projectId, window_.start, window_.end);
  const { target, isOpen, openDrawer, closeDrawer, ariaMessage } = useResolveOverallocation();
  const ariaLiveRef = useRef<HTMLDivElement>(null);

  // Write aria announcements via DOM ref rather than React state binding (rule 30) — avoids
  // a React render cycle between the openDrawer() call and the AT announcement.
  useEffect(() => {
    if (ariaLiveRef.current) {
      ariaLiveRef.current.textContent = ariaMessage ?? '';
    }
  }, [ariaMessage]);

  // --- Permission gate (rule 94) ---
  if (STUB_ROLE < SCHEDULER_ROLE) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <PermissionDeniedNotice />
      </div>
    );
  }

  // --- No project selected ---
  if (status === 'idle') {
    return (
      <div className="flex items-center justify-center h-full text-xs text-neutral-text-secondary">
        No project selected.
      </div>
    );
  }

  // --- 409 state (rule 95) ---
  if (status === 'schedule-not-run') {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <ResourceEmptyState onRunScheduler={() => {
          // TODO: trigger scheduler action via API
        }} />
      </div>
    );
  }

  // --- Loading ---
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center h-full text-xs text-neutral-text-secondary">
        Loading utilization…
      </div>
    );
  }

  // --- Error ---
  if (status === 'error' || !data) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-semantic-critical">
        Failed to load resource utilization.
      </div>
    );
  }

  // --- Navigation helpers ---
  function goNext() {
    setIsFitToProject(false);
    setWindow((w) => {
      const start = formatISODate(addDays(parseUTCDate(w.start), 28));
      const end = formatISODate(addDays(parseUTCDate(w.end), 28));
      return { start, end };
    });
  }

  function goPrev() {
    setIsFitToProject(false);
    setWindow((w) => {
      const start = formatISODate(addDays(parseUTCDate(w.start), -28));
      const end = formatISODate(addDays(parseUTCDate(w.end), -28));
      return { start, end };
    });
  }

  function goToday() {
    setIsFitToProject(false);
    setWindow(defaultWindow());
  }

  function handleFitToggle() {
    if (isFitToProject) {
      setIsFitToProject(false);
      setWindow(defaultWindow());
    } else {
      if (data && projectStartDate) {
        setIsFitToProject(true);
        setWindow(fitToProjectWindow(projectStartDate, data));
      }
    }
  }

  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">
        <ResourceToolbar
          windowStart={window_.start}
          windowEnd={window_.end}
          unassignedCount={data.unassigned_task_count}
          isFitToProject={isFitToProject}
          onPrev={goPrev}
          onNext={goNext}
          onToday={goToday}
          onFitToggle={handleFitToggle}
        />

        {data.resources.length === 0 ? (
          <div className="flex items-center justify-center flex-1 text-xs text-neutral-text-secondary">
            No resources assigned in this window.
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <ResourceGrid
              resources={data.resources}
              windowStart={window_.start}
              windowEnd={window_.end}
              onOpenDrawer={openDrawer}
            />
          </div>
        )}
      </div>

      {/* Aria-live region — content written via DOM ref (rule 30), not React state */}
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
