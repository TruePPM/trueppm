import type { Task } from '@/types';
import { BoardActivityPanel } from '../activity/BoardActivityPanel';
import { StandupMode } from '../standup/StandupMode';
import { ScopePendingReviewPanel } from '@/features/sprints/ScopePendingReviewPanel';

interface BoardSidePanelsProps {
  projectId: string;
  tasks: Task[];
  /** True when a card id resolves to a live card — a deleted card is not openable. */
  isTaskOpenable: (taskId: string) => boolean;
  onOpenTask: (taskId: string) => void;
  activityOpen: boolean;
  onCloseActivity: () => void;
  /** The active sprint's id, or null — scopes the activity feed (ADR-0412). */
  activeSprintId: string | null;
  standupOpen: boolean;
  onCloseStandup: () => void;
  scopeReviewOpen: boolean;
  canManageScope: boolean;
  onCloseScopeReview: () => void;
}

/**
 * The board's docked/full-surface panels: the activity feed rail, standup
 * walk-the-board mode, and the scope-injection review slide-over. All three are
 * non-modal companions to the grid rather than dialogs over it.
 */
export function BoardSidePanels({
  projectId,
  tasks,
  isTaskOpenable,
  onOpenTask,
  activityOpen,
  onCloseActivity,
  activeSprintId,
  standupOpen,
  onCloseStandup,
  scopeReviewOpen,
  canManageScope,
  onCloseScopeReview,
}: BoardSidePanelsProps) {
  return (
    <>
      {/* Board activity feed (ADR-0160, issue 1261) — a docked right-edge rail
          (overlay on mobile). Clicking an event opens its card via the same
          selectedTaskId drawer; a deleted/absent card is not openable. The panel
          is non-modal, dismissed via its close button or the toolbar toggle. */}
      {projectId && activityOpen && (
        <div className="fixed inset-y-0 right-0 z-30 flex w-full max-w-sm border-l border-neutral-border md:w-80">
          <BoardActivityPanel
            projectId={projectId}
            onClose={onCloseActivity}
            onOpenTask={onOpenTask}
            isTaskOpenable={isTaskOpenable}
            // ADR-0412 (#1946): when a sprint is active, open the feed scoped to it
            // ("This sprint" default with a Whole-board toggle) — Activity where the
            // team already looks, narrowed to the ~40 sprint cards Alex/Jordan watch.
            sprintId={activeSprintId}
          />
        </div>
      )}

      {/* Daily standup walk-the-board (ADR-0166, issue 1278) — a focused
          full-surface mode driven by the active sprint's per-person walk; opens
          the same selectedTaskId drawer when a card is clicked. Mounted off
          ?standup=1. */}
      {projectId && standupOpen && (
        <StandupMode projectId={projectId} onClose={onCloseStandup} onOpenTask={onOpenTask} />
      )}

      {/* Sprint scope-injection review slide-over (ADR-0102 §5). Mounted only
          for a team-owned actor (canManageScope); offline disables the
          accept/reject controls — chips still render but no action queues
          (ADR-0102 §6 / frontend rule 152: a stale accept could re-commit
          rejected work, so we never queue these). */}
      {scopeReviewOpen && projectId && activeSprintId && canManageScope && (
        <ScopePendingReviewPanel
          projectId={projectId}
          sprintId={activeSprintId}
          tasks={tasks}
          offline={typeof navigator !== 'undefined' && !navigator.onLine}
          onClose={onCloseScopeReview}
        />
      )}
    </>
  );
}
