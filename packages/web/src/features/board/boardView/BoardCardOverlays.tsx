import type { Task } from '@/types';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';
import { KeyboardCheatsheet } from '../KeyboardCheatsheet';
import { ShareViewDialog } from '@/features/share/ShareViewDialog';
import { BoardSettingsPanel } from '../BoardSettingsPanel';
import { DepPopover } from '../DepPopover';
import { RiskPopover } from '../RiskPopover';
import { BoardCardPopover } from '../BoardCardPopover';
import { TaskDetailDrawer } from '@/features/schedule/TaskDetailDrawer';
import { TaskFormModal } from '../TaskFormModal';

interface BoardCardOverlaysProps {
  projectId: string;
  isMobile: boolean;
  taskIndex: Map<string, Task>;
  showCheatsheet: boolean;
  onCloseCheatsheet: () => void;
  shareOpen: boolean;
  onCloseShare: () => void;
  showSettings: boolean;
  onCloseSettings: () => void;
  rawColumns: BoardColumnDef[];
  onSaveBoardConfig: (columns: BoardColumnDef[]) => Promise<void>;
  showCustomFieldsOnCards: boolean;
  onToggleCustomFieldsOnCards: (next: boolean) => void;
  /** Column/WIP config is a shared-board write — SCHEDULER+ (#2146). */
  canConfigureBoard: boolean;
  depTask: Task | null;
  onCloseDeps: () => void;
  onJumpToTask: (taskId: string) => void;
  riskTask: Task | null;
  onCloseRisks: () => void;
  popoverTask: Task | null;
  popoverAnchor: HTMLElement | null;
  onClosePopover: () => void;
  onOpenDetail: (taskId: string) => void;
  onEditTask: (taskId: string) => void;
  selectedTaskId: string | null;
  onCloseDrawer: () => void;
  onDrawerSwapCanceled: (keptId: string) => void;
  editTaskId: string | null;
  onCloseEditModal: () => void;
  onEditModalDeleted: () => void;
}

/**
 * Per-card overlay layer — cheatsheet, share, board settings, the dependency and
 * risk popovers, the card popover, the task-detail drawer and the edit modal.
 * At most one of the "board batch 3" overlays is open at a time; `BoardView`
 * enforces that exclusivity when it sets the state.
 */
export function BoardCardOverlays({
  projectId,
  isMobile,
  taskIndex,
  showCheatsheet,
  onCloseCheatsheet,
  shareOpen,
  onCloseShare,
  showSettings,
  onCloseSettings,
  rawColumns,
  onSaveBoardConfig,
  showCustomFieldsOnCards,
  onToggleCustomFieldsOnCards,
  canConfigureBoard,
  depTask,
  onCloseDeps,
  onJumpToTask,
  riskTask,
  onCloseRisks,
  popoverTask,
  popoverAnchor,
  onClosePopover,
  onOpenDetail,
  onEditTask,
  selectedTaskId,
  onCloseDrawer,
  onDrawerSwapCanceled,
  editTaskId,
  onCloseEditModal,
  onEditModalDeleted,
}: BoardCardOverlaysProps) {
  return (
    <>
      {/* Board batch 3 overlays — at most one open at a time. */}
      {showCheatsheet && <KeyboardCheatsheet onClose={onCloseCheatsheet} />}
      {shareOpen && projectId && (
        <ShareViewDialog projectId={projectId} contentKind="board" onClose={onCloseShare} />
      )}
      {showSettings && (
        <BoardSettingsPanel
          columns={rawColumns}
          onSave={onSaveBoardConfig}
          onClose={onCloseSettings}
          showCustomFieldsOnCards={showCustomFieldsOnCards}
          onToggleCustomFieldsOnCards={onToggleCustomFieldsOnCards}
          // The panel ships a complete view-only mode ("schedulers can edit
          // columns") that was never wired; a Member/Viewer could edit and hit a
          // raw 403.
          readOnly={!canConfigureBoard}
        />
      )}
      <BoardTaskOverlays
        projectId={projectId}
        isMobile={isMobile}
        taskIndex={taskIndex}
        depTask={depTask}
        onCloseDeps={onCloseDeps}
        onJumpToTask={onJumpToTask}
        riskTask={riskTask}
        onCloseRisks={onCloseRisks}
        popoverTask={popoverTask}
        popoverAnchor={popoverAnchor}
        onClosePopover={onClosePopover}
        onOpenDetail={onOpenDetail}
        onEditTask={onEditTask}
        selectedTaskId={selectedTaskId}
        onCloseDrawer={onCloseDrawer}
        onDrawerSwapCanceled={onDrawerSwapCanceled}
        editTaskId={editTaskId}
        onCloseEditModal={onCloseEditModal}
        onEditModalDeleted={onEditModalDeleted}
      />
    </>
  );
}

type BoardTaskOverlaysProps = Pick<
  BoardCardOverlaysProps,
  | 'projectId'
  | 'isMobile'
  | 'taskIndex'
  | 'depTask'
  | 'onCloseDeps'
  | 'onJumpToTask'
  | 'riskTask'
  | 'onCloseRisks'
  | 'popoverTask'
  | 'popoverAnchor'
  | 'onClosePopover'
  | 'onOpenDetail'
  | 'onEditTask'
  | 'selectedTaskId'
  | 'onCloseDrawer'
  | 'onDrawerSwapCanceled'
  | 'editTaskId'
  | 'onCloseEditModal'
  | 'onEditModalDeleted'
>;

/**
 * The task-scoped half of the overlay layer: dependency and risk popovers, the
 * card popover, the detail drawer and the edit modal. Split from
 * {@link BoardCardOverlays} so neither half carries the whole board's overlay
 * branching.
 */
function BoardTaskOverlays({
  projectId,
  isMobile,
  taskIndex,
  depTask,
  onCloseDeps,
  onJumpToTask,
  riskTask,
  onCloseRisks,
  popoverTask,
  popoverAnchor,
  onClosePopover,
  onOpenDetail,
  onEditTask,
  selectedTaskId,
  onCloseDrawer,
  onDrawerSwapCanceled,
  editTaskId,
  onCloseEditModal,
  onEditModalDeleted,
}: BoardTaskOverlaysProps) {
  return (
    <>
      {depTask && (
        <DepPopover
          task={depTask}
          taskIndex={taskIndex}
          onClose={onCloseDeps}
          onJumpTo={onJumpToTask}
        />
      )}
      {riskTask && projectId && (
        <RiskPopover projectId={projectId} task={riskTask} onClose={onCloseRisks} />
      )}

      {/* Card information popover (issue #304) — primary card-click target.
          "Open detail" hands off to TaskDetailDrawer below; "Edit" routes
          there in edit mode. */}
      {popoverTask && projectId && (
        <BoardCardPopover
          task={popoverTask}
          projectId={projectId}
          anchor={popoverAnchor}
          isMobile={isMobile}
          onClose={onClosePopover}
          onOpenDetail={() => onOpenDetail(popoverTask.id)}
          onEdit={() => onEditTask(popoverTask.id)}
        />
      )}

      {/* Task detail drawer — driven by the popover's "Open detail" action;
          shares the same registry-backed entry path as the Schedule view
          (ADR-0050). Conditionally mounted on selection so a closed
          `role="dialog"` does not collide with other dialogs' loose
          `getByRole('dialog')` locators. */}
      {projectId && selectedTaskId && (
        <TaskDetailDrawer
          task={taskIndex.get(selectedTaskId) ?? null}
          projectId={projectId}
          onClose={onCloseDrawer}
          // Keep-editing on a dirty swap: the card click already moved selection
          // to the new task; restore it to the one the drawer is still showing so
          // selection and drawer stay in sync (#1978).
          onSwapCanceled={onDrawerSwapCanceled}
        />
      )}

      {/* Task edit modal (issue #305) — opened by the popover's "Edit" action.
          Same component handles create/edit; mode is inferred from `task`. */}
      {projectId && editTaskId && (
        <TaskFormModal
          projectId={projectId}
          task={taskIndex.get(editTaskId) ?? null}
          isMobile={isMobile}
          onClose={onCloseEditModal}
          onDeleted={onEditModalDeleted}
        />
      )}
    </>
  );
}
