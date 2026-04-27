import { useDroppable } from '@dnd-kit/core';
import type { Task, TaskStatus } from '@/types';
import { BoardCard } from './BoardCard';

interface BoardColumnProps {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  isOver: boolean;
  isDragActive: boolean;
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
}

// NOTE: BoardColumn is not used by BoardView — BoardView renders BoardCell inline.
// This file is retained for reference only and should not be imported.
const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'BACKLOG',     label: 'BACKLOG' },
  { status: 'NOT_STARTED', label: 'TO DO' },
  { status: 'IN_PROGRESS', label: 'IN PROGRESS' },
  { status: 'REVIEW',      label: 'REVIEW' },
  { status: 'COMPLETE',    label: 'DONE' },
];

export function BoardColumn({
  status,
  label,
  tasks,
  isOver,
  isDragActive,
  onMenuMove,
}: BoardColumnProps) {
  const { setNodeRef } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={`
        flex flex-col flex-shrink-0 w-[85vw] md:w-auto md:flex-1 md:min-w-[240px]
        snap-start
        rounded-lg p-3 gap-2
        transition-colors duration-150
        ${
          isOver && isDragActive
            ? 'bg-brand-primary/5 border-l-2 border-brand-primary'
            : 'bg-neutral-surface-sunken border-l-2 border-transparent'
        }
      `}
    >
      {/* Column header — rule 101 */}
      <h2
        className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary
          flex items-center px-1 pb-1"
        aria-label={`${label}, ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`}
      >
        {label}
        <span className="ml-2 text-neutral-text-disabled">{tasks.length}</span>
      </h2>

      {/* Cards */}
      <div className="flex flex-col gap-2 overflow-y-auto min-h-0 flex-1">
        {tasks.map((task) => (
          <BoardCard
            key={task.id}
            task={task}
            onMenuMove={(newStatus) => onMenuMove(task, newStatus)}
            columns={COLUMNS}
          />
        ))}
      </div>
    </div>
  );
}
