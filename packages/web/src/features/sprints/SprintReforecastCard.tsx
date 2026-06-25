import { useMemo } from 'react';

import { Button } from '@/components/Button';
import {
  useAcceptSprintVelocitySuggestion,
  useDismissSprintVelocitySuggestion,
  usePendingVelocitySuggestions,
} from '@/hooks/useVelocitySuggestions';

/** Minimal task shape needed to resolve a suggestion's name + current duration. */
interface TaskLite {
  id: string;
  name: string;
  mostLikelyDuration?: number | null;
}

interface Props {
  projectId: string;
  sprintId: string;
  sprintName: string;
  /** Project tasks — resolves each suggestion's task name + current duration. */
  tasks: TaskLite[];
  /** PM/Admin (role ≥ 300). The accept/dismiss endpoints are Admin-gated. */
  canManage: boolean;
}

/**
 * Velocity reforecast panel for the sprint surface (issue 1290).
 *
 * The ADR-0065 velocity→duration accept/dismiss loop already exists, but only in
 * the Schedule task drawer (`EstimatesTab`) — so a Scrum Master who closes a
 * sprint has no front door to it where they work, and the marquee "close a sprint
 * and the master schedule reforecasts itself" loop needs two view-switches. This
 * surfaces the *same* loop (same endpoints, same gate) on the just-closed sprint's
 * outcome view: every pending suggestion this sprint generated, accept/dismiss in
 * place. Accepting writes `most_likely_duration` and enqueues a CPM recompute.
 *
 * Renders nothing when there's nothing to do (no pending rows for this sprint, or
 * the reader is below the Admin gate) so it never adds noise to a settled sprint.
 *
 * ux-design is folded into the implementation under the kaizen surfacing carve-out:
 * this reuses the approved `EstimatesTab` banner pattern on a new surface with no
 * new interaction model; ux-review validates the visual diff.
 */
export function SprintReforecastCard({ projectId, sprintId, sprintName, tasks, canManage }: Props) {
  const { data: suggestions } = usePendingVelocitySuggestions(canManage ? projectId : undefined);
  const accept = useAcceptSprintVelocitySuggestion(projectId);
  const dismiss = useDismissSprintVelocitySuggestion();

  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // This sprint's pending suggestions, excluding gate-suppressed rows
  // (suggested_duration is null when the ADR-0104 velocity gate hides the value
  // from a below-audience reader — with nothing to revise to, there's nothing to do).
  const rows = useMemo(
    () =>
      (suggestions ?? []).filter((s) => s.sprint_id === sprintId && s.suggested_duration != null),
    [suggestions, sprintId],
  );

  if (!canManage || rows.length === 0) return null;

  const busy = accept.isPending || dismiss.isPending;

  return (
    <section
      aria-label="Velocity reforecast suggestions"
      data-testid="sprint-reforecast-card"
      className="rounded-lg border border-brand-primary/40 bg-brand-primary/5 p-3 flex flex-col gap-2.5"
    >
      <div className="flex items-start gap-2">
        <span className="text-brand-primary text-lg leading-none mt-0.5" aria-hidden="true">
          📈
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-neutral-text-primary">
            Velocity reforecast available
          </h3>
          <p className="text-xs text-neutral-text-secondary mt-0.5">
            {sprintName}&rsquo;s velocity suggests revising{' '}
            {rows.length === 1 ? 'one estimate' : `${rows.length} estimates`}. Accepting updates the
            task and reforecasts the schedule.
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-1.5">
        {rows.map((s) => {
          const task = tasksById.get(s.task);
          const current = task?.mostLikelyDuration ?? null;
          return (
            <li
              key={s.id}
              className="flex items-center gap-2 rounded border border-neutral-border bg-neutral-surface px-2.5 py-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-neutral-text-primary truncate">
                  {task?.name ?? 'Task'}
                </p>
                <p className="text-xs text-neutral-text-secondary">
                  {current != null && (
                    <>
                      <span className="tppm-mono">{current}d</span>
                      {' → '}
                    </>
                  )}
                  <span className="tppm-mono font-semibold text-neutral-text-primary">
                    {s.suggested_duration}d
                  </span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => dismiss.mutate(s.id)}
                  disabled={busy}
                  aria-label={`Dismiss reforecast for ${task?.name ?? 'task'}`}
                >
                  Dismiss
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => accept.mutate(s.id)}
                  disabled={busy}
                  aria-label={`Accept reforecast for ${task?.name ?? 'task'}`}
                >
                  Accept
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
