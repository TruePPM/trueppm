import { LockIcon } from '@/components/Icons';
import { useState } from 'react';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { canEditTask } from '@/lib/roles';
import type { Task } from '@/types';

const LABEL_CLASS =
  'block text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2';

const DATE_INPUT_CLASS =
  'w-full h-9 rounded-control border border-neutral-border bg-neutral-surface px-3 ' +
  'text-sm text-neutral-text-primary ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ' +
  'read-only:opacity-50 read-only:cursor-not-allowed';

/** Statuses on which the server permits an `actual_finish` (ADR-1153 sign-off gate). */
const SIGNOFF_STATUSES: ReadonlySet<Task['status']> = new Set(['REVIEW', 'COMPLETE']);

/** Which of the two fields an edit targets. Also the key for per-field error state. */
type ActualField = 'actualStart' | 'actualFinish';

const API_FIELD: Record<ActualField, 'actual_start' | 'actual_finish'> = {
  actualStart: 'actual_start',
  actualFinish: 'actual_finish',
};

/** Today as `YYYY-MM-DD` in the viewer's local zone — the date inputs' picker ceiling. */
function todayIso(): string {
  const now = new Date();
  return [
    String(now.getFullYear()).padStart(4, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Read a DRF field error for `field` out of an unknown thrown value.
 *
 * The server owns the copy for every rule it alone can evaluate (the future bound
 * needs the project's data date; the sign-off gate needs the stored status), so the
 * component displays the server's sentence verbatim rather than paraphrasing a rule
 * it cannot compute. Returns null when the shape is anything else — a network drop
 * must not be reported as a validation failure on this field.
 */
function fieldErrorFrom(error: unknown, field: 'actual_start' | 'actual_finish'): string | null {
  const data: unknown = (error as { response?: { data?: unknown } } | null)?.response?.data;
  if (typeof data !== 'object' || data === null) return null;
  const detail: unknown = (data as Record<string, unknown>)[field];
  if (Array.isArray(detail) && typeof detail[0] === 'string') return detail[0];
  if (typeof detail === 'string') return detail;
  return null;
}

/** An em-dash stands in for an unrecorded date in the read-only rendering. */
const NOT_RECORDED = '—';

/**
 * Actual dates — the only surface in the product where a user can state or correct
 * when a task really started and finished (ADR-1153, #3529).
 *
 * Deliberately a low-frequency drawer section rather than a prompt on the completion
 * paths. Completion has three entry points, one a board drag and one a bulk batch; a
 * dialog on them either interrupts a gesture mid-motion, fires per row on a batch, or
 * is bypassed on two of the three — enforcing nothing while reading as a guarantee.
 *
 * Validation is split by what each side can actually compute:
 *   - **Ordering** (`actual start <= actual finish`) is pre-checked here, because both
 *     operands are in hand and a round trip for it is pure latency. The server enforces
 *     it too — it is what stops a bad pair from raising `InvalidScheduleInput` and
 *     failing the whole project's next recompute.
 *   - **The future bound** is server-only: it is `max(project data date, today)`, and
 *     this component does not load the project. `max` on the input is a picker ceiling,
 *     not a guarantee — a typed value bypasses it in several browsers — so a future
 *     date round-trips and surfaces the server's own message.
 *   - **The sign-off gate** (`actual_finish` only on REVIEW/COMPLETE) is client-visible
 *     from the task's status, so the field is inert with an explanation rather than
 *     offering a write that would 400.
 *
 * Two different "you cannot type here" states, per web-rule 302 — they are NOT the same
 * and do not get the same treatment:
 *   - **No edit rights** → the authoring apparatus is ABSENT. The dates render as static
 *     text with a lock line. A Viewer still needs to *read* an actual date, so the values
 *     stay; only the inputs go.
 *   - **Rights, wrong status** → the input is PRESENT and inert (`readOnly`, not
 *     `disabled`), because one status change gets the user back. `readOnly` rather than
 *     `disabled` is load-bearing: a disabled input leaves the tab order, which takes its
 *     `aria-describedby` explanation with it, so the one state that most needs explaining
 *     would be the one a screen-reader user could not reach.
 *
 * A finish with no start is **by design** (ADR-0136) and is never rendered as an error,
 * a warning, or an incomplete state.
 */
export function ActualDatesSection({ taskId, projectId, userRole, canEdit }: DrawerSectionProps) {
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  const { mutate: updateTask } = useUpdateTask();

  // Per-field state, keyed by field. A single shared `useMutation` would report task
  // A's refusal against field B: `useUpdateTask` is one instance for both inputs, so
  // its `error` cannot say which write failed. `drafts` holds the typed value across a
  // rejection so a 400 never makes the user retype what they entered.
  const [errors, setErrors] = useState<Partial<Record<ActualField, string>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<ActualField, string>>>({});

  // ADR-0133/1142: prefer the server-derived verdict the drawer threads down; fall
  // back to the client role rule only when it is absent.
  const editable = canEdit ?? canEditTask(userRole);

  if (!task) return null;

  const inSignoff = SIGNOFF_STATUSES.has(task.status);
  const startValue = drafts.actualStart ?? task.actualStart ?? '';
  const finishValue = drafts.actualFinish ?? task.actualFinish ?? '';

  function commit(field: ActualField, raw: string) {
    const value = raw === '' ? null : raw;
    setDrafts((d) => ({ ...d, [field]: raw }));

    // Ordering pre-check against the other field's effective value.
    const otherRaw = field === 'actualStart' ? finishValue : startValue;
    const other = otherRaw === '' ? null : otherRaw;
    if (value !== null && other !== null) {
      const [start, finish] = field === 'actualStart' ? [value, other] : [other, value];
      if (start > finish) {
        setErrors((e) => ({
          ...e,
          [field]: `Actual finish cannot be earlier than actual start (${start}).`,
        }));
        return;
      }
    }

    setErrors((e) => ({ ...e, [field]: undefined }));
    updateTask(
      { id: taskId, projectId, [API_FIELD[field]]: value },
      {
        onSuccess: () => {
          // Drop the draft so the server value governs from here on.
          setDrafts((d) => ({ ...d, [field]: undefined }));
        },
        onError: (err: unknown) => {
          setErrors((e) => ({
            ...e,
            [field]:
              fieldErrorFrom(err, API_FIELD[field]) ??
              'Could not save that date. Check your connection and try again.',
          }));
        },
      },
    );
  }

  const startId = `actual-start-${taskId}`;
  const finishId = `actual-finish-${taskId}`;
  const startErrorId = `${startId}-error`;
  const finishErrorId = `${finishId}-error`;
  const finishHelpId = `${finishId}-help`;

  // No edit rights (web-rule 302): the apparatus is absent, the information is not.
  if (!editable) {
    return (
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className={LABEL_CLASS}>Actual start</dt>
            <dd className="text-sm text-neutral-text-primary">
              {task.actualStart ?? NOT_RECORDED}
            </dd>
          </div>
          <div>
            <dt className={LABEL_CLASS}>Actual finish</dt>
            <dd className="text-sm text-neutral-text-primary">
              {task.actualFinish ?? NOT_RECORDED}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-neutral-text-secondary flex items-start gap-1.5">
          <LockIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
          <span>Actual dates are read-only for your role.</span>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor={startId}>
            Actual start
          </label>
          <input
            id={startId}
            type="date"
            aria-invalid={errors.actualStart ? true : undefined}
            aria-describedby={errors.actualStart ? startErrorId : undefined}
            value={startValue}
            max={todayIso()}
            onChange={(e) => commit('actualStart', e.target.value)}
            className={DATE_INPUT_CLASS}
          />
          {errors.actualStart && (
            <p id={startErrorId} role="alert" className="mt-1.5 text-xs text-semantic-critical">
              {errors.actualStart}
            </p>
          )}
        </div>

        <div>
          <label className={LABEL_CLASS} htmlFor={finishId}>
            Actual finish
          </label>
          <input
            id={finishId}
            type="date"
            aria-invalid={errors.actualFinish ? true : undefined}
            aria-describedby={
              [errors.actualFinish ? finishErrorId : null, !inSignoff ? finishHelpId : null]
                .filter(Boolean)
                .join(' ') || undefined
            }
            value={finishValue}
            max={todayIso()}
            // `readOnly`, not `disabled` — see the component docstring. A `readOnly`
            // date input still opens its picker in some browsers, so `commit` is the
            // enforcement and this is the affordance; the server refuses regardless.
            readOnly={!inSignoff}
            onChange={(e) => {
              if (!inSignoff) return;
              commit('actualFinish', e.target.value);
            }}
            className={DATE_INPUT_CLASS}
          />
          {!inSignoff && (
            <p id={finishHelpId} className="mt-1.5 text-xs text-neutral-text-secondary">
              Set when the task moves to In review or Complete.
            </p>
          )}
          {errors.actualFinish && (
            <p id={finishErrorId} role="alert" className="mt-1.5 text-xs text-semantic-critical">
              {errors.actualFinish}
            </p>
          )}
        </div>
      </div>

      {/* One line covering both what these dates DO and why a missing start is normal.
          Without the second half, an empty Actual start on a completed task reads as a
          gap the user should fill — which is exactly what ADR-0136 says not to do. */}
      <p className="text-xs text-neutral-text-secondary">
        Actual dates pin this task&apos;s place in the schedule. A finish with no start is normal —
        the schedule derives the span backward from the finish.
      </p>
    </div>
  );
}
