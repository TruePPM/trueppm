import { useSearchParams } from 'react-router';
import { GanttView } from '@/features/gantt/GanttView';
import { WbsView } from '@/features/wbs/WbsView';
import { TaskListView } from '@/features/tasklist/TaskListView';
import { CalendarView } from '@/features/calendar/CalendarView';
import { ResourceView } from '@/features/resource/ResourceView';
import { RiskRegisterView } from '@/features/risk/RiskRegisterView';
import { BoardView } from '@/features/board/BoardView';
import { RecalculatingBadge } from './RecalculatingBadge';
import { useProjectWebSocket } from '@/hooks/useProjectWebSocket';
import { useSchedulerStore } from '@/stores/schedulerStore';

// Active view is tracked in ?view= search param so URLs are shareable
// and the TanStack Query cache key (['tasks', projectId]) stays stable
// across view switches. ViewTabs in TopBar is the navigation control;
// ProjectShell reads the param and renders the matching view.
type ViewMode = 'gantt' | 'wbs' | 'list' | 'board' | 'calendar' | 'resources' | 'risk';

export function ProjectShell() {
  const [searchParams] = useSearchParams();
  const view = (searchParams.get('view') ?? 'gantt') as ViewMode;
  const projectId = searchParams.get('project');

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

      {/* Active view */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === 'gantt' && <GanttView />}
        {view === 'wbs' && <WbsView />}
        {view === 'list' && <TaskListView />}
        {view === 'board' && <BoardView />}
        {view === 'calendar' && <CalendarView />}
        {view === 'resources' && <ResourceView />}
        {view === 'risk' && <RiskRegisterView projectId={projectId ?? ''} />}
      </div>
    </div>
  );
}
