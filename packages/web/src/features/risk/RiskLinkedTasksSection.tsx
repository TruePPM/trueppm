import { useState } from 'react';
import type { Risk } from '@/api/types';
import type { Task } from '@/types';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useCreateTask } from '@/hooks/useTaskMutations';
import { useUpdateRisk } from '@/hooks/useRisks';
import { useTaskDrawerStore } from '@/stores/taskDrawerStore';
import { canEditRisk, canEditTask } from '@/lib/roles';
import { formatTaskStatus, taskStatusDotClass } from './taskStatusDisplay';

/**
 * "Linked tasks" section of the read-only risk detail view (#2156, ADR-0566).
 *
 * Renders the risk's linked tasks, each opening in the app-wide task drawer
 * (ADR-0138), and offers a one-click "Create mitigation task" that creates an
 * unscheduled, unassigned project task named from the risk and links it to the
 * risk. The link PATCH sends the full desired id set because the risk serializer
 * replaces the M2M set rather than appending.
 */
export interface RiskLinkedTasksSectionProps {
  projectId: string;
  risk: Risk;
  /** Closes the risk drawer — called before opening a task drawer so the two
   *  drawers never stack (desktop) or fight focus traps (mobile bottom sheet). */
  onCloseDrawer: () => void;
}

const TASK_NAME_MAX = 512;

type Feedback = { kind: 'success' | 'error' | 'partial'; message: string };

export function RiskLinkedTasksSection({
  projectId,
  risk,
  onCloseDrawer,
}: RiskLinkedTasksSectionProps) {
  const { tasks, isLoading } = useScheduleTasks(projectId);
  const { role } = useCurrentUserRole(projectId);
  const createTask = useCreateTask(projectId);
  const updateRisk = useUpdateRisk();
  const openTask = useTaskDrawerStore((s) => s.openTask);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const canCreate = canEditTask(role) && canEditRisk(role);
  const linkedIds = risk.tasks;
  const tasksById = new Map<string, Task>((tasks ?? []).map((t) => [t.id, t]));
  const isCreating = createTask.isPending || updateRisk.isPending;
  const showSkeleton = isLoading && linkedIds.length > 0 && !tasks;

  function handleOpenTask(task: Task) {
    // Close the risk drawer first, then open the task drawer on the next tick so
    // the risk drawer's document-level focus trap detaches before the task
    // drawer claims focus. openTask is a stable Zustand action, safe post-unmount.
    onCloseDrawer();
    setTimeout(() => openTask(task, projectId), 0);
  }

  function handleCreateMitigationTask() {
    setFeedback(null);
    const name = `Mitigate: ${risk.title}`.slice(0, TASK_NAME_MAX);
    // No sprint and no assignee: the task lands unscheduled in the backlog and
    // notifies no one (ADR-0566 — honors the sprint-boundary and no-surprise-work
    // VoC constraints). Task-create fires no assignee notification server-side.
    createTask.mutate(
      { name, duration: 1 },
      {
        onSuccess: (created) => {
          updateRisk.mutate(
            { projectId, id: risk.id, data: { tasks: [...risk.tasks, created.id] } },
            {
              onSuccess: () =>
                setFeedback({
                  kind: 'success',
                  message: 'Mitigation task created — unscheduled and not in any sprint.',
                }),
              // Task exists but the link failed. The stray task is a normal
              // backlog item; tell the user exactly how to recover.
              onError: () =>
                setFeedback({
                  kind: 'partial',
                  message:
                    "Task created but couldn't link it to this risk. Edit this risk to link it, or find it on the schedule.",
                }),
            },
          );
        },
        onError: () =>
          setFeedback({ kind: 'error', message: "Couldn't create the task. Please try again." }),
      },
    );
  }

  return (
    <div className="border-t border-neutral-border pt-4">
      <p className="text-xs font-medium text-neutral-text-secondary uppercase tracking-wide mb-2">
        Linked tasks{linkedIds.length > 0 ? ` (${linkedIds.length})` : ''}
      </p>

      {showSkeleton ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading linked tasks">
          <div className="h-8 rounded-card motion-safe:animate-pulse bg-neutral-border/30" />
          <div className="h-8 rounded-card motion-safe:animate-pulse bg-neutral-border/30" />
        </div>
      ) : linkedIds.length === 0 ? (
        <p className="text-xs text-neutral-text-disabled">
          {canCreate
            ? 'No tasks linked yet. Link existing tasks by editing this risk, or create one below.'
            : 'No tasks linked yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {linkedIds.map((id) => {
            const task = tasksById.get(id);
            if (!task) {
              return (
                <li
                  key={id}
                  title="This task was deleted or is not available."
                  className="flex items-center gap-2 px-2 py-1.5 text-sm text-neutral-text-disabled italic"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-neutral-text-disabled shrink-0"
                    aria-hidden="true"
                  />
                  Unavailable task
                </li>
              );
            }
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => handleOpenTask(task)}
                  aria-label={`Open task ${task.name}, status ${formatTaskStatus(task.status)}`}
                  className="w-full flex items-center gap-2 min-h-11 md:min-h-9 px-2 rounded-control text-left
                    hover:bg-neutral-row-hover
                    focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset"
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${taskStatusDotClass(task.status)}`}
                    aria-hidden="true"
                  />
                  <span className="flex-1 min-w-0 truncate text-sm text-neutral-text-primary">
                    {task.name}
                  </span>
                  <span className="text-xs text-neutral-text-secondary shrink-0">
                    {formatTaskStatus(task.status)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {canCreate && (
        <button
          type="button"
          onClick={handleCreateMitigationTask}
          disabled={isCreating}
          aria-label="Create mitigation task from this risk"
          className="mt-3 w-full md:w-auto h-9 px-3 inline-flex items-center justify-center gap-1
            rounded-control text-sm font-medium border border-neutral-border
            text-neutral-text-secondary hover:text-neutral-text-primary
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            disabled:opacity-50"
        >
          {isCreating ? (
            'Creating…'
          ) : (
            <>
              <span aria-hidden="true">+</span> Create mitigation task
            </>
          )}
        </button>
      )}

      {feedback && (
        <p
          role={feedback.kind === 'success' ? 'status' : 'alert'}
          className={[
            'mt-2 text-xs',
            feedback.kind === 'success' ? 'text-semantic-on-track' : 'text-semantic-critical',
          ].join(' ')}
        >
          {feedback.message}
        </p>
      )}
    </div>
  );
}
