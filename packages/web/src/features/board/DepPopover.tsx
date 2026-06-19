import { useEffect, useRef } from 'react';
import { useTaskDependencies, type TaskDependencyEdge } from '@/hooks/useTaskDependencies';
import type { Task, TaskStatus } from '@/types';

interface DepPopoverProps {
  task: Task;
  /** Map of all task ids → task — used to resolve names + status of related tasks. */
  taskIndex: Map<string, Task>;
  onClose: () => void;
  onJumpTo?: (taskId: string) => void;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  NOT_STARTED: 'To Do',
  IN_PROGRESS: 'In Progress',
  REVIEW: 'Review',
  ON_HOLD: 'On Hold',
  COMPLETE: 'Done',
};

function statusPillClass(status: TaskStatus): string {
  switch (status) {
    case 'COMPLETE':
      return 'bg-semantic-on-track-bg border-semantic-on-track/30 text-semantic-on-track';
    case 'IN_PROGRESS':
      return 'bg-brand-primary/10 border-brand-primary/30 text-brand-primary';
    case 'REVIEW':
      return 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark';
    case 'BACKLOG':
    case 'ON_HOLD':
    default:
      return 'bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary';
  }
}

interface DepRowProps {
  edge: TaskDependencyEdge;
  task: Task | undefined;
  isBlocking: boolean;
  onJumpTo?: (taskId: string) => void;
}

function DepRow({ edge, task, isBlocking, onJumpTo }: DepRowProps) {
  const name = task?.name ?? `Task ${edge.predecessorId.slice(0, 6)}`;
  const status = task?.status ?? 'NOT_STARTED';

  return (
    <button
      type="button"
      onClick={() => task && onJumpTo?.(task.id)}
      disabled={!task}
      className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs
        hover:bg-neutral-surface-raised
        focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset
        focus-visible:outline-none
        disabled:opacity-60 disabled:cursor-default"
    >
      <span aria-hidden="true" className="shrink-0">
        {isBlocking ? (
          <span className="inline-flex w-2 h-2 rounded-full bg-semantic-critical" />
        ) : (
          <span className="inline-flex text-neutral-text-disabled">🔗</span>
        )}
      </span>
      <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{name}</span>
      <span
        className={[
          'shrink-0 inline-block px-1.5 py-px rounded-chip border text-xs',
          statusPillClass(status),
        ].join(' ')}
      >
        {STATUS_LABEL[status]}
      </span>
    </button>
  );
}

/**
 * Dependency popover anchored to a board card (issue #182).
 *
 * Lists predecessors and successors with status pills. Predecessors that are
 * not COMPLETE get a red blocking dot. Esc or backdrop click closes; clicking
 * a row jumps focus to that card on the board.
 */
export function DepPopover({ task, taskIndex, onClose, onJumpTo }: DepPopoverProps) {
  const { predecessors, successors, isLoading } = useTaskDependencies(task.id);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`dep-popover-${task.id}-title`}
      className="fixed inset-0 z-30 flex items-start justify-center bg-neutral-text-primary/40 p-4 pt-20"
      onPointerDown={onClose}
    >
      <div
        className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-[280px] max-h-[60vh] overflow-y-auto"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-3 border-b border-neutral-border">
          <div className="min-w-0">
            <h2
              id={`dep-popover-${task.id}-title`}
              className="text-sm font-semibold text-neutral-text-primary truncate"
            >
              Dependencies
            </h2>
            <p className="text-xs text-neutral-text-secondary truncate">{task.name}</p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            className="text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:outline-none rounded-control p-1 -mt-1 -mr-1"
            aria-label="Close dependency list"
          >
            ×
          </button>
        </div>

        {isLoading ? (
          <div className="p-3 text-xs text-neutral-text-secondary">Loading…</div>
        ) : predecessors.length === 0 && successors.length === 0 ? (
          <div className="p-3 text-xs text-neutral-text-secondary">No active dependencies.</div>
        ) : (
          <>
            {predecessors.length > 0 && (
              <section>
                <h3 className="px-3 pt-2 pb-1 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
                  Predecessors ({predecessors.length})
                </h3>
                {predecessors.map((edge) => {
                  const pred = taskIndex.get(edge.predecessorId);
                  const isBlocking = pred ? pred.status !== 'COMPLETE' : false;
                  return (
                    <DepRow
                      key={edge.id}
                      edge={edge}
                      task={pred}
                      isBlocking={isBlocking}
                      onJumpTo={onJumpTo}
                    />
                  );
                })}
              </section>
            )}
            {successors.length > 0 && (
              <section className="border-t border-neutral-border">
                <h3 className="px-3 pt-2 pb-1 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
                  Successors ({successors.length})
                </h3>
                {successors.map((edge) => {
                  const succ = taskIndex.get(edge.successorId);
                  return (
                    <DepRow
                      key={edge.id}
                      edge={edge}
                      task={succ}
                      isBlocking={false}
                      onJumpTo={onJumpTo}
                    />
                  );
                })}
              </section>
            )}
          </>
        )}

        <div className="px-3 py-2 border-t border-neutral-border text-xs text-neutral-text-disabled">
          Press{' '}
          <kbd className="bg-neutral-surface-raised border border-neutral-border rounded-chip px-1 tppm-mono">
            Esc
          </kbd>{' '}
          to close
        </div>
      </div>
    </div>
  );
}
