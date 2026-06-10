import { useEffect, useRef, useState } from 'react';
import type { ApiSprint } from '@/types';
import { useSprintMutations } from '@/hooks/useSprints';
import { Button } from '@/components/Button';
import { formatDateRange, sprintDayOf } from './sprintMath';

interface Props {
  sprint: ApiSprint;
  projectId: string;
  /**
   * Whether the current viewer may edit the goal inline. Render-gate only —
   * the API independently enforces write permission. Matches the board
   * SprintPanel's SCHEDULER+ inline-edit posture (passed from SprintsView's
   * ``useCanManageScope``). When false the card is a read-only banner.
   */
  canEdit?: boolean;
}

/** The three "good sprint goal" heuristics surfaced as live, advisory hints. */
export interface GoalQuality {
  /** Reads as an outcome, not a checklist of tasks. */
  outcome: boolean;
  /** One focused theme rather than several stitched together. */
  single: boolean;
  /** Carries a cue for how you'd know it's met. */
  measurable: boolean;
}

/**
 * Score a goal draft against the three good-goal heuristics (DA-15).
 *
 * These are deliberately *soft nudges*, not validation — a goal that fails one
 * still saves. They exist to coach the writer toward an outcome statement (the
 * Scrum-Guide framing the Agile Coach persona cares about), which is why the
 * editor never blocks Save on them. Heuristics, not parsing: cheap and
 * forgiving on purpose.
 */
export function evaluateSprintGoal(raw: string): GoalQuality {
  const text = raw.trim();
  if (text.length < 8) return { outcome: false, single: false, measurable: false };
  const lower = text.toLowerCase();
  const hasBullets = /(^|\n)\s*[-*•]/.test(raw) || /(^|\n)\s*\d+[.)]/.test(raw);
  const andCount = (lower.match(/\band\b/g) ?? []).length;
  const sentenceBreaks = (text.match(/[.;]/g) ?? []).length;
  const outcome = !hasBullets && andCount <= 1 && text.length >= 12;
  const single = sentenceBreaks <= 1 && andCount <= 1 && !hasBullets;
  const measurable =
    /\d/.test(text) ||
    /\b(so that|so|can|without|proven|prove|demo|demos|demonstrate|ready|pass|passes|passed|verified|verify|live|end[- ]to[- ]end|under|within|complete|completed|signed[- ]?off|met)\b/.test(
      lower,
    );
  return { outcome, single, measurable };
}

const HINTS: { key: keyof GoalQuality; label: string }[] = [
  { key: 'outcome', label: 'Describes an outcome, not a checklist' },
  { key: 'single', label: 'Single, focused theme' },
  { key: 'measurable', label: "Has a way to know it's met" },
];

/**
 * "Sprint goal" card — the left column of the SprintsView two-column grid.
 *
 * Two states (DA-15, #920):
 *  - **Banner** (read): the goal narrative, the SP-id chip, an Edit affordance
 *    (when ``canEdit``), and the metadata row (window, day-N-of-M, tasks,
 *    points). Numerics use ``.tppm-mono`` per web CLAUDE.md rule 8c.
 *  - **Editor** (inline): a textarea bound to a draft plus the three live
 *    good-goal hints, saved through ``updateSprint``. The goal is the team's
 *    commitment artifact, so editing happens in-place in the workspace rather
 *    than only inside the full Plan-sprint modal.
 */
export function SprintGoalCard({ sprint, projectId, canEdit = false }: Props) {
  const showDayOf = sprint.state === 'ACTIVE';
  const { day, total } = sprintDayOf(sprint.start_date, sprint.finish_date);
  const taskCount = sprint.committed_task_count ?? 0;
  const points = sprint.committed_points ?? 0;

  const { updateSprint } = useSprintMutations(projectId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sprint.goal ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed the draft whenever we enter edit mode or the saved goal changes
  // underneath us (e.g. another writer updates it live).
  useEffect(() => {
    if (editing) setDraft(sprint.goal ?? '');
  }, [editing, sprint.goal]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const quality = evaluateSprintGoal(draft);
  const trimmed = draft.trim();
  const dirty = trimmed !== (sprint.goal ?? '').trim();
  const canSave = dirty && !updateSprint.isPending;

  function handleSave() {
    if (!canSave) return;
    updateSprint.mutate(
      { sprintId: sprint.id, payload: { goal: trimmed } },
      { onSuccess: () => setEditing(false) },
    );
  }

  function handleCancel() {
    setDraft(sprint.goal ?? '');
    setEditing(false);
  }

  return (
    <section
      aria-labelledby="sprint-goal-heading"
      className="rounded-md border border-neutral-border bg-neutral-surface p-4 flex flex-col gap-3"
    >
      <div className="flex items-center gap-3">
        <h2
          id="sprint-goal-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Sprint Goal
        </h2>
        <span
          className="tppm-mono text-xs px-2 py-0.5 rounded border border-neutral-border text-neutral-text-secondary"
          aria-label={`Sprint id ${sprint.short_id_display}`}
        >
          {sprint.short_id_display}
        </span>
        <div className="flex-1" />
        {canEdit && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-brand-primary hover:text-brand-primary-dark
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded px-1"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-text-secondary">
              Goal — one outcome, not a task list
            </span>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="What outcome does this sprint deliver?"
              className="px-3 py-2 rounded border border-brand-primary bg-neutral-surface
                text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled resize-none
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />
          </label>

          <ul className="flex flex-col gap-1.5" aria-label="Good-goal hints">
            {HINTS.map(({ key, label }) => (
              <GoalHint key={key} on={quality[key]} label={label} />
            ))}
          </ul>

          {updateSprint.isError && (
            <p role="alert" className="text-xs text-semantic-critical">
              Failed to save the goal. Please try again.
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="md" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleSave}
              disabled={!canSave}
            >
              {updateSprint.isPending ? 'Saving…' : 'Save goal'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-neutral-text-primary leading-relaxed">
            {sprint.goal || (
              <span className="italic text-neutral-text-disabled">
                No goal set for this sprint.
              </span>
            )}
          </p>

          <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-neutral-text-secondary">
            <div className="flex items-center gap-1.5">
              <dt className="font-medium uppercase tracking-wide text-neutral-text-disabled">
                Window
              </dt>
              <dd className="tppm-mono text-neutral-text-primary">
                {formatDateRange(sprint.start_date, sprint.finish_date)}
              </dd>
            </div>

            {showDayOf && (
              <div className="flex items-center gap-1.5">
                <dt className="font-medium uppercase tracking-wide text-neutral-text-disabled">
                  Day
                </dt>
                <dd className="tppm-mono text-neutral-text-primary">
                  {day} of {total}
                </dd>
              </div>
            )}

            <div className="flex items-center gap-1.5">
              <dt className="font-medium uppercase tracking-wide text-neutral-text-disabled">
                Tasks
              </dt>
              <dd className="tppm-mono text-neutral-text-primary">{taskCount}</dd>
            </div>

            <span
              className="tppm-mono text-xs px-2 py-0.5 rounded border border-neutral-border text-neutral-text-primary"
              aria-label={`${points} story points committed`}
            >
              {points} pts committed
            </span>
          </dl>
        </>
      )}
    </section>
  );
}

/** A single live good-goal hint: filled sage check when satisfied, hollow when not. */
function GoalHint({ on, label }: { on: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <span
        aria-hidden
        className={[
          'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[10px] font-bold',
          on
            ? 'bg-semantic-on-track text-navy-900'
            : 'border border-neutral-border text-transparent',
        ].join(' ')}
      >
        ✓
      </span>
      <span
        className={
          on
            ? 'text-neutral-text-secondary line-through decoration-neutral-text-disabled'
            : 'text-neutral-text-primary'
        }
      >
        {label}
      </span>
      <span className="sr-only">{on ? '(met)' : '(not yet)'}</span>
    </li>
  );
}
