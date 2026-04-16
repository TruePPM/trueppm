import { Outlet } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjectWebSocket } from '@/hooks/useProjectWebSocket';
import { useSchedulerStore } from '@/stores/schedulerStore';
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

  useProjectWebSocket(projectId);

  const isRecalculating = useSchedulerStore((s) => s.isRecalculating);

  return (
    <div className="flex flex-col h-full overflow-hidden">
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
