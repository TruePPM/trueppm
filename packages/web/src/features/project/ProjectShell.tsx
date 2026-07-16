import axios from 'axios';
import { Outlet } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useProjectWebSocket } from '@/hooks/useProjectWebSocket';
import { useRecordProjectVisit } from '@/hooks/useRecordProjectVisit';
import { useSchedulerStore } from '@/stores/schedulerStore';
import { ProjectNotFound } from './ProjectNotFound';
import { ProjectSampleIndicator } from './ProjectSampleIndicator';
import { RecalculatingBadge } from './RecalculatingBadge';

/**
 * Layout shell for all project-scoped views.
 *
 * Reads the active projectId from the URL path param `:projectId` (ADR-0030)
 * and opens the project WebSocket. Each view (Overview, Gantt, WBS, Board …)
 * is rendered as a child route via <Outlet />.
 */
export function ProjectShell() {
  const projectId = useProjectId() ?? null;

  // Gate every project route on the project record: a deleted (or missing)
  // project 404s server-side (#1111), and losing access mid-session — a revoked
  // membership, or a bookmark to a project you were removed from — resolves the
  // same way, because the detail endpoint is queryset-scoped to the caller's
  // memberships, so a non-member's project falls out of the queryset and 404s
  // (the object-level 403 never runs). A 403 can still arrive on a future/edge
  // path, so both are treated as "unavailable" here (#2040). React Query dedupes
  // this against the same ['project', id] query the tab bar already issues, so it
  // adds no extra request.
  const { error: projectError } = useProject(projectId);
  const status = axios.isAxiosError(projectError) ? projectError.response?.status : undefined;
  const projectUnavailable = status === 404 || status === 403;

  // Suppress the WebSocket once the project is unavailable: the WS ticket
  // endpoint 403s for a non-member, so leaving the socket live would spin a dead
  // reconnect loop against a project the user can no longer reach (#2040).
  useProjectWebSocket(projectUnavailable ? null : projectId);

  // Record a real last-visited ping so the app's landing default lands the user
  // on the project they actually last opened (ADR-0150). Fire-and-forget.
  useRecordProjectVisit(projectUnavailable ? null : projectId);

  const isRecalculating = useSchedulerStore((s) => s.isRecalculating);

  if (projectUnavailable) {
    return <ProjectNotFound />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Demo-data indicator — present on every project-level view of a sample
          program so the "this is demo data" cue survives navigation (#1053). */}
      <ProjectSampleIndicator projectId={projectId} />

      {/* RecalculatingBadge strip — visible while CPM is running (issue #40) */}
      {isRecalculating && (
        <div className="flex justify-end px-4 py-1 border-b border-neutral-border bg-neutral-surface-raised flex-shrink-0">
          <RecalculatingBadge isVisible={isRecalculating} />
        </div>
      )}

      {/* Active view — rendered by the matched child route */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
