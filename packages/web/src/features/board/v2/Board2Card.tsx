import { useId, useState, type KeyboardEvent } from 'react';
import { Avatar, UnassignedAvatar } from '@/components/page2/Avatar';
import { StatusChip } from '@/components/page2/StatusChip';
import { FOCUS_RING } from '@/components/page2/classes';
import type { Task, TaskStatus } from '@/types';
import { cardChips } from './board2Model';

export interface Board2CardProps {
  task: Task;
  /** Status index of the column the card sits in, for arrow-key navigation. */
  col: number;
  laneId: string;
  held: boolean;
  draggable: boolean;
  showFields: boolean;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>, task: Task) => void;
  onDragStart: (task: Task) => void;
  /** Click or Enter opens task detail. Space is reserved for picking the card up. */
  onOpen: (task: Task) => void;
  /**
   * Touch move: when set, the card carries a "Move to…" disclosure listing these
   * destinations (the phone layout has no drag and no hardware keyboard). Absent on
   * desktop, where drag and the Space-arrow pick-up already cover moving.
   */
  moveTargets?: { status: TaskStatus; label: string }[];
  onMoveTo?: (task: Task, status: TaskStatus) => void;
}

/**
 * One Pass 2 board card. Critical, blocked and near-critical are chips that carry
 * a glyph and a word (rules 120, 440), so no state rides on color alone; a critical
 * card also gets an inset red edge. The whole card is one focusable button: arrow
 * keys move between cards, Space picks it up (handled by the page).
 */
export function Board2Card({
  task,
  col,
  laneId,
  held,
  draggable,
  showFields,
  onKeyDown,
  onDragStart,
  onOpen,
  moveTargets,
  onMoveTo,
}: Board2CardProps) {
  const chips = cardChips(task);
  const [moveOpen, setMoveOpen] = useState(false);
  const moveId = useId();
  const destinations = (moveTargets ?? []).filter((t) => t.status !== task.status);
  const owner = task.assignees[0];
  return (
    <li className="list-none">
      <button
        type="button"
        data-board2-card={task.id}
        data-col={col}
        data-lane={laneId}
        aria-pressed={held}
        draggable={draggable}
        onDragStart={() => onDragStart(task)}
        onClick={() => onOpen(task)}
        onKeyDown={(e) => onKeyDown(e, task)}
        // Space picks the card up on keydown; stop the keyup from also clicking it.
        onKeyUp={(e) => e.key === ' ' && e.preventDefault()}
        className={`flex w-full min-w-0 flex-col gap-1.5 rounded-md border border-p1-hairline bg-p1-surface-1 p-2.5 text-left text-sm text-p1-text-1 hover:bg-p1-surface-2 ${FOCUS_RING} ${
          task.isCritical ? 'border-l-[3px] border-l-p1-critical' : ''
        } ${held ? 'ring-2 ring-p1-focus' : ''}`}
      >
        <span className="line-clamp-2 break-words font-medium">{task.name}</span>
        {showFields && chips.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            {chips.map((c) =>
              c.kind === 'critical' ? (
                <StatusChip key="c" tone="critical" label="Critical" />
              ) : c.kind === 'blocked' ? (
                <StatusChip key="b" tone="blocked" label={`Blocked: ${c.reason}`} />
              ) : (
                <StatusChip key="n" tone="risk" label={`Near-critical · ${c.floatDays}d float`} />
              ),
            )}
          </span>
        )}
        {showFields && (
          <span className="flex items-center gap-1.5 text-xs text-p1-text-2">
            {owner ? (
              <>
                <Avatar name={owner.name} size={22} decorative />
                <span className="truncate">{owner.name}</span>
              </>
            ) : (
              <>
                <UnassignedAvatar size={22} />
                <span aria-hidden="true">Unassigned</span>
              </>
            )}
          </span>
        )}
      </button>
      {onMoveTo && destinations.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={moveOpen}
            aria-controls={moveId}
            aria-label={`Move ${task.name} to…`}
            onClick={() => setMoveOpen((o) => !o)}
            className={`h-11 w-full rounded-md border border-p1-hairline bg-p1-surface-1 px-3 text-left text-sm text-p1-text-1 hover:bg-p1-surface-2 ${FOCUS_RING}`}
          >
            Move to…
          </button>
          {moveOpen && (
            <ul id={moveId} aria-label={`Move ${task.name} to`} className="m-0 mt-1 flex flex-col gap-1 p-0">
              {destinations.map((d) => (
                <li key={d.status} className="list-none">
                  <button
                    type="button"
                    onClick={() => {
                      setMoveOpen(false);
                      onMoveTo(task, d.status);
                    }}
                    className={`h-11 w-full rounded-md border border-p1-hairline bg-p1-surface-2 px-3 text-left text-sm text-p1-text-1 ${FOCUS_RING}`}
                  >
                    {d.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
