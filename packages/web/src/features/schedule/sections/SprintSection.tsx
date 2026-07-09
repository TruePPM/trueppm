import { type ChangeEvent, useState } from 'react';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useSprints } from '@/hooks/useSprints';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import {
  useUpdateTask,
  parseGuardrailWarnings,
  parseGuardrailBlockedError,
  type GuardrailWarning,
  type GuardrailBlockedError,
} from '@/hooks/useTaskMutations';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { canEditTask } from '@/lib/roles';
import { isPhaseTask } from '../isPhaseTask';
import { GuardrailNotice } from './GuardrailNotice';
import { GuardrailBlock } from './GuardrailBlock';

const SELECT_CLASS =
  'w-full h-9 rounded-control border border-neutral-border bg-neutral-surface px-3 ' +
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
export function SprintSection({ taskId, projectId, userRole, canEdit }: DrawerSectionProps) {
  const itl = useIterationLabel(projectId);
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  const { sprints, isLoading } = useSprints(projectId);
  const { mutate: updateTask, isPending } = useUpdateTask();

  // ADR-0133/1142: gate write controls off the server-derived verdict; fall back to the client role rule only when absent.
  const editable = canEdit ?? canEditTask(userRole);

  // Guardrail UI state (ADR-0101). `warnings` is shown after a successful
  // assignment that tripped a warn-level rule; `priorSprintId` lets Undo revert
  // to exactly what was there before. `block` is shown when the Owner escalated
  // a rule and the assignment was rejected (the FK was never changed).
  const [warnings, setWarnings] = useState<GuardrailWarning[]>([]);
  const [priorSprintId, setPriorSprintId] = useState<string | null>(null);
  const [block, setBlock] = useState<GuardrailBlockedError | null>(null);

  if (!task) return null;

  // Phase hard-exclusion (ADR-0293, #1755): a phase (a non-subtask task with a
  // structural non-subtask child) can never be committed to a sprint — the API
  // rejects it unconditionally with `phase_in_sprint_forbidden`. Rather than let
  // the user pick a sprint and bounce off a 400, exclude it structurally: show the
  // outcome-language guidance instead of the picker. This is a precise, component-
  // level guard layered under the coarser `!isSummary` canRender gate in
  // sections/index.ts (isSummary also hides a leaf-with-subtasks summary, which is
  // a legitimate `summary_in_sprint` warn case, not a phase).
  const phase = isPhaseTask(task, tasks ?? []);
  if (phase) {
    return (
      <div>
        <div className={LABEL_CLASS}>{itl.singular}</div>
        <p className="text-sm italic text-neutral-text-secondary">
          Phases group work; assign the tasks inside it to the {itl.lower} instead.
        </p>
      </div>
    );
  }

  const assignable = sprints.filter(
    (s) => s.state === 'ACTIVE' || s.state === 'PLANNED',
  );

  const currentSprint = sprints.find((s) => s.id === task.sprintId);

  function assignSprint(value: string | null, prior: string | null) {
    setBlock(null);
    setWarnings([]);
    updateTask(
      { id: taskId, projectId, sprint: value },
      {
        onSuccess: (data) => {
          // Warn path: the write succeeded; surface any guardrail warnings with
          // a one-tap override. Remember the prior value so Undo can revert.
          const w = parseGuardrailWarnings(data);
          if (w.length > 0) {
            setPriorSprintId(prior);
            setWarnings(w);
          }
        },
        onError: (err) => {
          // Block path: the Owner escalated this rule. Show the (non-overridable)
          // block notice; the FK was never changed server-side.
          const b = parseGuardrailBlockedError(err);
          if (b) setBlock(b);
        },
      },
    );
  }

  function handleChange(e: ChangeEvent<HTMLSelectElement>) {
    assignSprint(e.target.value || null, task?.sprintId ?? null);
  }

  function handleRemove() {
    assignSprint(null, task?.sprintId ?? null);
  }

  function handleKeep() {
    // The assignment already stuck; just dismiss the notice. The override is
    // recorded server-side via the task's history (history_change_reason).
    setWarnings([]);
  }

  function handleUndo() {
    setWarnings([]);
    updateTask({ id: taskId, projectId, sprint: priorSprintId });
  }

  return (
    <div className="space-y-3">
      <div>
        <div className={LABEL_CLASS}>{itl.singular}</div>
        {isLoading ? (
          <div className="h-9 rounded-control bg-neutral-surface-raised motion-safe:animate-pulse w-full" aria-label={`Loading ${itl.lowerPlural}`} />
        ) : !editable ? (
          // Read-only: show the assigned iteration name as static text (the
          // state badge / dates / remove control render separately below).
          <p className="text-sm text-neutral-text-primary">
            {currentSprint ? currentSprint.name : <span className="italic text-neutral-text-secondary">Not assigned</span>}
          </p>
        ) : assignable.length === 0 && !task.sprintId ? (
          <p className="text-sm italic text-neutral-text-secondary">
            No active or planned {itl.lowerPlural} — create one in the {itl.plural} tab.
          </p>
        ) : (
          <select
            aria-label={`${itl.singular} assignment`}
            value={task.sprintId ?? ''}
            onChange={handleChange}
            disabled={isPending}
            className={SELECT_CLASS}
          >
            <option value="">— No {itl.lower} —</option>
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

      {block && (
        <GuardrailBlock detail={block.detail} onDismiss={() => setBlock(null)} />
      )}

      {warnings.length > 0 && (
        <GuardrailNotice warnings={warnings} onUndo={handleUndo} onKeep={handleKeep} />
      )}

      {currentSprint && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={[
                'inline-flex items-center px-1.5 py-0.5 rounded-chip text-xs font-medium border',
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
          {editable && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={isPending}
              aria-label={`Remove from ${itl.lower}`}
              className="text-xs text-neutral-text-secondary hover:text-semantic-critical rounded-control shrink-0
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Remove ×
            </button>
          )}
        </div>
      )}

      {task.sprintScopeChanges && task.sprintScopeChanges.length > 0 && (
        <div>
          <div className={LABEL_CLASS}>Scope changes</div>
          <div className="space-y-1.5">
            {task.sprintScopeChanges.map((sc, i) => (
              <div key={i} className="flex items-start gap-2">
                <span
                  className="mt-1.5 h-1.5 w-1.5 rounded-full bg-semantic-at-risk shrink-0"
                  aria-hidden="true"
                />
                <span className="text-xs text-neutral-text-secondary">
                  <span className="text-neutral-text-primary">{sc.itemName}</span>
                  {sc.goalImpact ? (
                    <span className="ml-1 text-semantic-at-risk font-medium">· affects goal</span>
                  ) : ''}
                  {sc.addedByName ? ` · added by ${sc.addedByName}` : ''}
                  {' · '}
                  <time
                    dateTime={sc.addedAt}
                    className="tppm-mono"
                  >
                    {new Date(sc.addedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </time>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
