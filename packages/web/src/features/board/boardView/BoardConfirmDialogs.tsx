import type { RefObject } from 'react';
import type { Task } from '@/types';
import { BacklogDemoteConfirmDialog } from '../BacklogDemoteConfirmDialog';
import { WipLimitConfirmDialog } from '../WipLimitConfirmDialog';
import { ScheduleTaskDialog } from '@/features/schedule/ScheduleTaskDialog';
import { WorkshopExitDialog } from './WorkshopExitDialog';
import type { WipBreach } from '../wipBreach';
import type { ApiSprint } from '@/types';

export interface PendingWipMove {
  breach: WipBreach;
  taskName: string;
  perform: () => void;
}

interface BoardConfirmDialogsProps {
  projectId: string;
  selectedSprint: ApiSprint | null;
  /** NOT_STARTED card dropped on the backlog band, awaiting a deliberate demote. */
  backlogDemoteCandidate: Task | null;
  onBacklogDemoteCancel: () => void;
  onBacklogDemoteConfirm: (task: Task) => void;
  /** Move deferred behind the styled WIP-breach alertdialog (#2050). */
  wipMoveCandidate: PendingWipMove | null;
  onWipMoveCancel: () => void;
  onWipMoveConfirm: (perform: () => void) => void;
  scheduleDialogTask: Task | null;
  onScheduleDialogClose: () => void;
  workshopExitOpen: boolean;
  workshopEnding: boolean;
  workshopToggleRef: RefObject<HTMLButtonElement | null>;
  onWorkshopExitCancel: () => void;
  onWorkshopExitConfirm: () => void;
}

/**
 * Sprint assignment for a keyboard promote (#2170). Keyboard parity with
 * drag-to-assign: when the board is scoped to a PLANNED/ACTIVE sprint, promoting
 * a backlog card also pulls it into that sprint — otherwise the promoted card is
 * committed-but-unscoped and hidden from the sprint board. Mirrors
 * `handleDragEnd`'s assignSprintId gate (#429); a COMPLETED sprint is read-only.
 */
function promoteSprintTarget(sprint: ApiSprint | null, task: Task) {
  if (!sprint) return null;
  if (sprint.state !== 'ACTIVE' && sprint.state !== 'PLANNED') return null;
  if (task.sprintId === sprint.id) return null;
  return { id: sprint.id, name: sprint.name, pending: sprint.state === 'ACTIVE' };
}

/**
 * The board's confirm/create dialog layer: every surface that interrupts a
 * gesture to ask for a decision, plus the create/promote modals.
 */
export function BoardConfirmDialogs({
  projectId,
  selectedSprint,
  backlogDemoteCandidate,
  onBacklogDemoteCancel,
  onBacklogDemoteConfirm,
  wipMoveCandidate,
  onWipMoveCancel,
  onWipMoveConfirm,
  scheduleDialogTask,
  onScheduleDialogClose,
  workshopExitOpen,
  workshopEnding,
  workshopToggleRef,
  onWorkshopExitCancel,
  onWorkshopExitConfirm,
}: BoardConfirmDialogsProps) {
  return (
    <>
      {/* Backlog demote confirm — opens when a NOT_STARTED card drops on the
          band (ADR-0057, Option C). Audit row is captured automatically by
          simple_history on the status field change. */}
      {backlogDemoteCandidate && (
        <BacklogDemoteConfirmDialog
          task={backlogDemoteCandidate}
          onCancel={onBacklogDemoteCancel}
          onConfirm={() => onBacklogDemoteConfirm(backlogDemoteCandidate)}
        />
      )}

      {/* WIP-limit breach confirm (#232, #2050) — replaces a native window.confirm
          fired mid-drop. Cancel-first: dismissing keeps the card in place. */}
      {wipMoveCandidate && (
        <WipLimitConfirmDialog
          taskName={wipMoveCandidate.taskName}
          columnLabel={wipMoveCandidate.breach.label}
          count={wipMoveCandidate.breach.count}
          limit={wipMoveCandidate.breach.limit}
          onCancel={onWipMoveCancel}
          onConfirm={() => onWipMoveConfirm(wipMoveCandidate.perform)}
        />
      )}

      {/* Schedule "…" dialog (#318, rule 135) — keyboard alternative to dragging
          a backlog idea onto the Schedule view's timeline. Opened from a
          BacklogCard's ··· action; issues the same
          { planned_start, status: 'NOT_STARTED' } promote PATCH (decision A2). */}
      {scheduleDialogTask && projectId && (
        <ScheduleTaskDialog
          task={scheduleDialogTask}
          projectId={projectId}
          assignSprint={promoteSprintTarget(selectedSprint, scheduleDialogTask)}
          onClose={onScheduleDialogClose}
        />
      )}


      {/* Workshop exit confirmation dialog (ADR-0046) */}
      {workshopExitOpen && (
        <WorkshopExitDialog
          isEnding={workshopEnding}
          triggerRef={workshopToggleRef}
          onCancel={onWorkshopExitCancel}
          onConfirm={onWorkshopExitConfirm}
        />
      )}
    </>
  );
}
