import { useState, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useCreateTask } from '@/hooks/useTaskMutations';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import type { Task, TaskStatus } from '@/types';

const STATUS_DOT: Record<TaskStatus, string> = {
  BACKLOG: 'bg-neutral-text-disabled',
  NOT_STARTED: 'bg-neutral-text-disabled',
  IN_PROGRESS: 'bg-brand-primary',
  REVIEW: 'bg-semantic-at-risk',
  ON_HOLD: 'bg-neutral-text-disabled',
  COMPLETE: 'bg-semantic-on-track',
};

const LABEL_CLASS =
  'text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2';

function SubtaskRow({ subtask }: { subtask: Task }) {
  const isComplete = subtask.status === 'COMPLETE';
  return (
    <div className="flex items-center gap-2 py-1.5 px-1 rounded hover:bg-neutral-surface-raised">
      <span
        className={[
          'mt-px h-2 w-2 rounded-full shrink-0',
          STATUS_DOT[subtask.status] ?? 'bg-neutral-text-disabled',
        ].join(' ')}
        aria-hidden="true"
      />
      <span
        className={[
          'flex-1 text-sm min-w-0 truncate',
          isComplete
            ? 'line-through text-neutral-text-disabled'
            : 'text-neutral-text-primary',
        ].join(' ')}
      >
        {subtask.name}
      </span>
      <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">
        {Math.round(subtask.progress)}%
      </span>
    </div>
  );
}

/**
 * Drawer section for managing one level of subtasks beneath a task (ADR-0060 #308).
 *
 * Subtasks are first-class CPM participants: the parent's finish propagates from
 * max(subtask finishes). Depth is capped at 1 — adding a subtask to a subtask
 * is rejected by the API and blocked in the UI.
 */
export function SubtasksSection({ taskId, projectId }: DrawerSectionProps) {
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  const { mutate: createTask, isPending } = useCreateTask(projectId);

  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  if (!task) return null;

  // Depth-1 guard — show an informational message instead of the create form.
  if (task.isSubtask) {
    return (
      <div className="rounded border border-neutral-border bg-neutral-surface-raised px-3 py-2">
        <p className="text-xs text-neutral-text-secondary">
          Subtasks cannot be nested — this task is already a subtask.
        </p>
      </div>
    );
  }

  const subtasks = (tasks ?? []).filter(
    (t) => t.parentId === taskId && t.isSubtask === true,
  );

  const completedCount = subtasks.filter((t) => t.status === 'COMPLETE').length;
  const rollupProgress =
    subtasks.length > 0
      ? Math.round(
          subtasks.reduce((sum, t) => sum + t.progress, 0) / subtasks.length,
        )
      : 0;
  const allComplete = subtasks.length > 0 && completedCount === subtasks.length;

  function startAdding() {
    setIsAdding(true);
    setDraftName('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancelAdding() {
    setIsAdding(false);
    setDraftName('');
  }

  function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    createTask(
      { name, duration: 1, parent_id: taskId, is_subtask: true },
      {
        onSuccess: () => {
          setIsAdding(false);
          setDraftName('');
        },
      },
    );
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelAdding();
    }
  }

  return (
    <div className="space-y-3">
      <div className={LABEL_CLASS}>
        Subtasks
        {subtasks.length > 0 && (
          <span className="ml-2 font-normal normal-case tracking-normal text-neutral-text-disabled">
            {completedCount}/{subtasks.length}
          </span>
        )}
      </div>

      {subtasks.length > 0 && (
        <>
          <div>
            <div
              className="h-1.5 w-full rounded-full bg-neutral-surface-raised overflow-hidden"
              role="progressbar"
              aria-valuenow={rollupProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Subtask completion: ${rollupProgress}%`}
            >
              <div
                className={[
                  'h-full rounded-full transition-all',
                  allComplete ? 'bg-semantic-on-track' : 'bg-brand-primary',
                ].join(' ')}
                style={{ width: `${rollupProgress}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-neutral-text-secondary">
              {allComplete ? 'All complete' : `${rollupProgress}% complete`}
            </p>
          </div>

          <div className="space-y-0.5">
            {subtasks.map((sub) => (
              <SubtaskRow key={sub.id} subtask={sub} />
            ))}
          </div>
        </>
      )}

      {subtasks.length === 0 && !isAdding && (
        <p className="text-sm italic text-neutral-text-secondary">
          No subtasks yet — break this task into smaller pieces.
        </p>
      )}

      {isAdding ? (
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Subtask name"
            disabled={isPending}
            aria-label="New subtask name"
            className={[
              'flex-1 h-8 rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary',
              'placeholder:text-neutral-text-disabled',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            ].join(' ')}
          />
          <button
            type="submit"
            disabled={!draftName.trim() || isPending}
            className={[
              'h-8 px-3 rounded text-xs font-medium text-white bg-brand-primary',
              'hover:bg-brand-primary/90',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-brand-primary',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            ].join(' ')}
          >
            Add
          </button>
          <button
            type="button"
            onClick={cancelAdding}
            aria-label="Cancel adding subtask"
            className={[
              'h-8 px-2 rounded text-sm text-neutral-text-secondary hover:text-neutral-text-primary',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            ].join(' ')}
          >
            ×
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={startAdding}
          className={[
            'text-xs font-medium text-brand-primary hover:text-brand-primary/80 rounded',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
          ].join(' ')}
        >
          + Add subtask
        </button>
      )}
    </div>
  );
}
