import { BoardView } from '@/features/board/BoardView';
import { useProjectId } from '@/hooks/useProjectId';
import { SchedulePulse } from './SchedulePulse';

/**
 * Unified "Today" split view (issue 412, ADR-0180) — the dual-hat PM + Scrum-Master
 * home that the `unified` role-context lens lands on. A vertical split: the compact,
 * read-only {@link SchedulePulse} schedule strip on top, the existing first-class
 * {@link BoardView} embedded UNCHANGED below (its own toolbar, columns, keyboard, and
 * scroll). The strip surfaces the active sprint's live progress (board → schedule
 * rollup); nothing here edits sprint content — the flow is strictly one-way.
 *
 * BoardView reads the project from the route (`/projects/:projectId/today`), so it
 * needs no props; it renders exactly as it does on its own `board` route.
 */
export function TodayView() {
  const projectId = useProjectId();
  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">Today</h1>
      <SchedulePulse projectId={projectId} />
      <section aria-label="Sprint board" className="min-h-0 flex-1">
        <BoardView />
      </section>
    </div>
  );
}
