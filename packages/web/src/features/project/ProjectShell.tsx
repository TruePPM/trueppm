import { useSearchParams } from 'react-router';
import { GanttView } from '@/features/gantt/GanttView';
import { WbsView } from '@/features/wbs/WbsView';
import { TaskListView } from '@/features/tasklist/TaskListView';
import { RecalculatingBadge } from './RecalculatingBadge';

// The three sub-views within the project Gantt experience.
// Active view is tracked in ?view= search param so URLs are shareable
// and the TanStack Query cache key (['tasks', projectId]) stays stable
// across view switches.
type ViewMode = 'gantt' | 'wbs' | 'list';

const VIEW_LABELS: Record<ViewMode, string> = {
  gantt: 'Gantt',
  wbs: 'WBS',
  list: 'Table',
};

export function ProjectShell() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = (searchParams.get('view') ?? 'gantt') as ViewMode;

  function setView(v: ViewMode) {
    setSearchParams({ view: v }, { replace: true });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Primary toolbar — view mode switcher (rule 42) */}
      <div
        className="flex items-center gap-2 px-4 h-10 border-b border-neutral-border
          bg-neutral-surface-raised flex-shrink-0"
      >
        <div role="group" aria-label="View mode" className="flex items-center gap-1">
          {(['gantt', 'wbs', 'list'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`
                border rounded h-7 px-3 text-xs font-medium
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
                ${
                  view === v
                    ? 'border-brand-primary/40 bg-brand-primary/10 text-brand-primary'
                    : 'border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary'
                }
              `}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* RecalculatingBadge — wired to WebSocket scheduler events (issue #40) */}
        <RecalculatingBadge isVisible={false} />
      </div>

      {/* Active view */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === 'gantt' && <GanttView />}
        {view === 'wbs' && <WbsView />}
        {view === 'list' && <TaskListView />}
      </div>
    </div>
  );
}
