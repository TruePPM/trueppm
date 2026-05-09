import { useSprints } from '@/hooks/useSprints';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import type { DrawerSectionProps } from '@/lib/widget-registry';

const SELECT_CLASS =
  'w-full h-9 rounded border border-neutral-border bg-neutral-surface px-3 ' +
  'text-sm text-neutral-text-primary ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

const LABEL_CLASS =
  'text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2';

/**
 * Sprint assignment section (ADR-0059 / ADR-0037).
 *
 * Rendered only for leaf, non-milestone tasks (canRender guard in index.ts).
 * Shows the current sprint with a dropdown to change it, and a "Remove" button
 * when the task is already in a sprint. If no PLANNED or ACTIVE sprints exist,
 * renders an empty-state nudge toward the Sprints tab.
 */
export function SprintSection({ taskId, projectId }: DrawerSectionProps) {
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  const { sprints, isLoading } = useSprints(projectId);
  const { mutate: updateTask, isPending } = useUpdateTask();

  if (!task) return null;

  const assignable = sprints.filter(
    (s) => s.state === 'ACTIVE' || s.state === 'PLANNED',
  );

  const currentSprint = sprints.find((s) => s.id === task.sprintId);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value || null;
    updateTask({ id: taskId, projectId, sprint: value });
  }

  function handleRemove() {
    updateTask({ id: taskId, projectId, sprint: null });
  }

  return (
    <div className="space-y-3">
      <div>
        <div className={LABEL_CLASS}>Sprint</div>
        {isLoading ? (
          <div className="h-9 rounded bg-neutral-surface-raised animate-pulse w-full" aria-label="Loading sprints" />
        ) : assignable.length === 0 && !task.sprintId ? (
          <p className="text-sm italic text-neutral-text-secondary">
            No active or planned sprints — create one in the Sprints tab.
          </p>
        ) : (
          <select
            aria-label="Sprint assignment"
            value={task.sprintId ?? ''}
            onChange={handleChange}
            disabled={isPending}
            className={SELECT_CLASS}
          >
            <option value="">— No sprint —</option>
            {assignable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.state === 'ACTIVE' ? ' (Active)' : ' (Planned)'}
                {' · '}
                {s.start_date} – {s.finish_date}
              </option>
            ))}
          </select>
        )}
      </div>

      {currentSprint && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={[
                'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border',
                currentSprint.state === 'ACTIVE'
                  ? 'border-semantic-on-track/40 text-semantic-on-track'
                  : 'border-neutral-border text-neutral-text-secondary',
              ].join(' ')}
            >
              {currentSprint.state === 'ACTIVE' ? 'Active' : 'Planned'}
            </span>
            <span className="text-xs text-neutral-text-secondary tppm-mono truncate">
              {currentSprint.start_date} – {currentSprint.finish_date}
            </span>
          </div>
          <button
            type="button"
            onClick={handleRemove}
            disabled={isPending}
            aria-label="Remove from sprint"
            className="text-xs text-neutral-text-secondary hover:text-semantic-critical rounded shrink-0
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Remove ×
          </button>
        </div>
      )}
    </div>
  );
}
