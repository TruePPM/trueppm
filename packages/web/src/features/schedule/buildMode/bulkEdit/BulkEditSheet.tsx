import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatChord } from '@/lib/platform';
import { createPortal } from 'react-dom';
import { Button } from '@/components/Button';
import { RefusalAlert } from '@/components/dialog';
import type { WriteRefusal } from '@/lib/writeRefusal';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import type { TaskBulkResponse } from '@/hooks/useTaskMutations';
import type { ApiSprint, DeliveryMode, GovernanceClass, ProjectResource, Task } from '@/types';
import { iterationLabelForms, type IterationLabelForms } from '@/lib/iterationLabel';
import {
  EMPTY_BULK_EDIT_SPEC,
  OWNER_ARMS,
  buildFieldProjection,
  buildResultLines,
  buildReviewLines,
  countChanges,
  countRows,
  hasAnyChange,
  hasDestructiveArm,
  ownerArmIsInert,
  preflightSelection,
  readAmount,
  resultIsClean,
  sharedValue,
  totalChanges,
  type BulkEditSpec,
  type BulkFieldId,
  type DateChoice,
  type FieldLine,
  type NumericChoice,
  type OwnerMode,
  type ProjectionContext,
  type RelativeOp,
  type SprintChoice,
  type TriState,
} from './bulkEditSpec';

/**
 * The ⌘⇧K bulk-edit sheet (#2756 pt.2, ADR-0810; widened to eight fields by
 * #3152 and given the owner's final geometry by #3153).
 *
 * Acts on exactly the rows issue 2727's selection already holds — **never** their
 * descendants. ⌘⇧M is the subtree lens on the same two classification fields;
 * this is the explicit-selection lens. A selection is already a deliberate act,
 * so silently extending it to descendants would make ⌘A + ⌘⇧K unbounded.
 *
 * Two phases in one dialog. The result phase lives here rather than in a toast
 * because a toast cannot hold a list, and the per-row breakdown *is* the reason
 * ADR-0810 routed the sheet through the 207 batch endpoint instead of N PATCHes.
 *
 * ## Honesty as arithmetic (`S17`–`S19`)
 *
 * The review and the result are the same computation rendered twice, in future
 * and past tense. For every field:
 *
 *     updated + unchanged + left alone + refused = the field's denominator
 *
 * with every non-zero term on screen. An item therefore **cannot** be silently
 * dropped without breaking addition a reader can see — which is what turns "the
 * sheet must not claim it changed an item it skipped" from a review note into an
 * assertion `BulkEditSheet.test.tsx` makes against the rendered DOM.
 *
 * The header counts the **selection**, never changes (`S3`): six of the eight
 * fields do not apply to every item type, so no single number at the top can be
 * honest. The result header counts **changes, not items** (`S19`), because one
 * item can be updated for one field and refused for another — `"12 of 15 items
 * updated"` is exactly the claim the equation above forbids.
 */

const SHEET_WIDTH = 400;

/** The dialog's accessible name, taken from the heading a reader can see. */
const HEADING_ID = 'bulk-edit-heading';

/** `S15` — Apply's `aria-describedby`. Deliberately NOT a live region. */
const REVIEW_ID = 'bulk-edit-review-block';

/** Rule 335(a) — the seat target's `aria-describedby` points here. */
const RESULT_PANEL_ID = 'bulk-edit-result-panel';

/** The system default forms, so the sheet renders standalone in a test. */
const DEFAULT_ITERATION_FORMS = iterationLabelForms(null);

const GOVERNANCE_OPTIONS: Array<{ value: GovernanceClass | null; label: string }> = [
  { value: null, label: 'Leave' },
  { value: 'gated', label: 'gated' },
  { value: 'flow', label: 'flow' },
  { value: 'hybrid', label: 'hybrid' },
];

const DELIVERY_OPTIONS: Array<{ value: DeliveryMode | null; label: string; disabled?: boolean }> = [
  { value: null, label: 'Leave' },
  { value: 'waterfall', label: 'waterfall' },
  { value: 'scrum', label: 'scrum' },
  { value: 'kanban', label: 'kanban' },
  // Same coupling ClassificationPopover documents: `is_milestone`, `duration = 0`
  // and this value are one fact, so a bulk write cannot manufacture milestones.
  { value: 'milestone', label: 'milestone', disabled: true },
];

const OP_OPTIONS: Array<{ value: RelativeOp; label: string }> = [
  { value: 'to', label: 'Set to' },
  { value: 'plus', label: 'Increase by' },
  { value: 'minus', label: 'Reduce by' },
];

export interface BulkEditSheetProps {
  /** The selected rows, in visible top-to-bottom order. */
  tasks: Task[];
  resourcePool: ProjectResource[];
  /** Every sprint on the project; the sheet offers PLANNED and ACTIVE only. */
  sprints?: ApiSprint[];
  /**
   * The project's own word for an iteration (ADR-0111, #1287). A prop rather
   * than a `useIterationLabel()` call inside the sheet: the hook reads through
   * `useProject`, and requiring a QueryClient would make every test of this
   * pure-presentational sheet mount a provider to render a static label.
   */
  iterationLabel?: IterationLabelForms;
  /**
   * Status the server would promote a 100%-complete row to for THIS user
   * (#2639). Threaded rather than derived so the sheet does not re-implement
   * the role rule the single-row confirmation dialog already owns.
   */
  autoPromoteTarget?: 'REVIEW' | 'COMPLETE' | null;
  isPending: boolean;
  /**
   * Non-207 failure (network, 403 on the batch itself). Switches Apply to Retry
   * **only when a replay could succeed** — see {@link WriteRefusal.retryable}.
   */
  error: WriteRefusal | null;
  /** The 207 body once a batch has landed; null while the form is showing. */
  result: TaskBulkResponse | null;
  /** Rows the sheet dropped before sending (see `buildBulkEditOperations`). */
  skippedLocallyIds?: string[];
  onApply: (spec: BulkEditSpec, ctx: ProjectionContext) => void;
  /** Re-select exactly the rows that did not apply, and focus the first. */
  onReviewFailed: (taskIds: string[]) => void;
  /** `S20` — a clean result clears the selection; a partial one keeps it. */
  onDone?: (clean: boolean) => void;
  onClose: () => void;
}

export function BulkEditSheet({
  tasks,
  resourcePool,
  sprints = [],
  iterationLabel = DEFAULT_ITERATION_FORMS,
  autoPromoteTarget = null,
  isPending,
  error,
  result,
  skippedLocallyIds = [],
  onApply,
  onReviewFailed,
  onDone,
  onClose,
}: BulkEditSheetProps) {
  const [spec, setSpec] = useState<BulkEditSpec>(EMPTY_BULK_EDIT_SPEC);
  /**
   * The field Escape reverts first (`S22`). One step, not a stack: the sheet
   * writes nothing before Apply, so there is no unsaved work to protect — only
   * the re-entry cost of the last thing you touched.
   */
  const [lastTouched, setLastTouched] = useState<BulkFieldId | null>(null);
  /** `S16` — the first ⌘⏎ over a destructive arm reads the review back instead. */
  const [chordArmed, setChordArmed] = useState(false);
  /** `S12` — set the moment an inert arm is attempted, cleared on any other act. */
  const [ownerRefusal, setOwnerRefusal] = useState<string | null>(null);
  /**
   * The projection Apply was built from. Captured at Apply so the result panel
   * reports what was *sent*, not what the form happens to hold afterwards.
   */
  const [appliedProjection, setAppliedProjection] = useState<ReturnType<
    typeof buildFieldProjection
  > | null>(null);

  const phase = result ? 'result' : 'form';
  const ctx: ProjectionContext = useMemo(
    () => ({ autoPromoteTarget, iterationLower: iterationLabel.lower }),
    [autoPromoteTarget, iterationLabel.lower],
  );

  const touch = (id: BulkFieldId) => {
    setLastTouched(id);
    setChordArmed(false);
    setOwnerRefusal(null);
  };

  const preflight = useMemo(() => preflightSelection(tasks), [tasks]);
  const projection = useMemo(() => buildFieldProjection(spec, tasks, ctx), [spec, tasks, ctx]);
  const reviewLines = useMemo(() => buildReviewLines(projection, ctx), [projection, ctx]);
  const canApply = hasAnyChange(spec) && !isPending;

  const applyRef = useRef<HTMLButtonElement | null>(null);

  const submit = () => {
    if (!canApply) return;
    setAppliedProjection(projection);
    // The same `ctx` this sheet's review was rendered from, so the payload is
    // built by the same call rather than by a second one at defaults.
    onApply(spec, ctx);
  };

  /**
   * Escape reverts one uncommitted field, then closes without confirmation.
   *
   * Routed through the trap's own `onEscape` rather than a second keydown
   * listener, so there is exactly one Escape handler in this dialog and no
   * ordering question between them.
   */
  const handleEscape = () => {
    if (lastTouched && isFieldSet(spec, lastTouched)) {
      setSpec((s) => revertField(s, lastTouched));
      setLastTouched(null);
      setChordArmed(false);
      return;
    }
    onClose();
  };

  // `focusKey` is load-bearing, not decoration (#1776): every control in the
  // form unmounts when the result replaces it, which drops focus to <body> and
  // lets the next Tab escape the dialog — the WCAG 2.1.2 trap inverted. Passing
  // the phase re-seats focus on the result's own buttons.
  const containerRef = useFocusTrap<HTMLDivElement>(true, handleEscape, phase);

  return createPortal(
    // `role="dialog"` reads as non-interactive to the rule, but ⌘⏎ is a
    // DIALOG-level chord (`S16`), not a control's own binding: it has to fire
    // wherever focus sits inside the sheet. Moving it onto the Apply button
    // would make the guard reachable only from Apply, which is the one place it
    // is least needed. The container carries `tabIndex={-1}` and the focus trap,
    // so keyboard users already reach it and nothing here is mouse-only.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      // Labelled BY the visible heading rather than repeating its text: one
      // source, so the accessible name cannot drift from what is on screen.
      aria-labelledby={HEADING_ID}
      data-testid="bulk-edit-sheet"
      tabIndex={-1}
      style={{ width: SHEET_WIDTH }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || phase === 'result') return;
        e.preventDefault();
        // `S16` — the guard is on the KIND OF WRITE, not the kind of user. An
        // Owner and a Member clearing the same dates deserve the same pause.
        if (hasDestructiveArm(spec) && !chordArmed) {
          setChordArmed(true);
          applyRef.current?.focus();
          return;
        }
        submit();
      }}
      className="fixed right-0 top-0 bottom-0 z-50 flex flex-col max-w-full
                 border-l border-neutral-border bg-neutral-surface shadow-pop
                 text-xs text-neutral-text-primary"
    >
      <header className="flex items-start gap-2 px-4 pt-3 pb-2 border-b border-neutral-border">
        <div className="flex-1 min-w-0">
          {/* `S3` — the header counts the SELECTION. Only review lines count changes. */}
          <h2 id={HEADING_ID} className="text-sm font-semibold">
            Edit {countRows(tasks.length)}
          </h2>
          {/* The pointer to ⌘⇧M lives on the Classification group, beside the
              two fields it actually concerns, rather than being said twice. */}
          <p className="mt-1 text-neutral-text-secondary leading-snug">
            {countRows(tasks.length)} only — no cascade.
          </p>
        </div>
        {/* `S21` — no ✕ at all. Escape and Cancel are the two exits, and a third
            has to be learned for nothing.
            This carried a `md:hidden` ✕ "for the phone" until ux-review checked
            it: `isMobile` is `max-width: 767px`, `buildModeActive = !isMobile`,
            and the whole toolbar returns null below md — so the sheet has no
            door in the one band the button rendered in. A control that cannot
            be reached is not a mobile affordance, it is dead code with a
            rationale attached. The footer is a flex sibling of the scroll
            region, so Cancel is never below the fold either. */}
      </header>

      {result ? (
        <ResultPhase
          lines={buildResultLines(appliedProjection ?? projection, result, skippedLocallyIds, ctx)}
          result={result}
          onReviewFailed={onReviewFailed}
          onDone={onDone}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            <Group title="Plan">
              <DateField
                idPrefix="bulk-planned-start"
                label="Planned start"
                choice={spec.plannedStart}
                onChange={(plannedStart) => {
                  touch('plannedStart');
                  setSpec((s) => ({ ...s, plannedStart }));
                }}
              />
              <DateField
                idPrefix="bulk-planned-finish"
                label="Planned finish"
                choice={spec.plannedFinish}
                onChange={(plannedFinish) => {
                  touch('plannedFinish');
                  setSpec((s) => ({ ...s, plannedFinish }));
                }}
              />
              {spec.plannedStart.mode === 'set' && spec.plannedStart.value && (
                // planned_start is the PM-committed SNET constraint, not the
                // CPM-computed early start — say what it does rather than
                // letting a planner assume the bars all jump to this date.
                <p className="text-neutral-text-secondary leading-snug">
                  Every selected item will start no earlier than {spec.plannedStart.value}.
                </p>
              )}
              <NumericField
                idPrefix="bulk-duration"
                label="Duration"
                unitLabel="days"
                choice={spec.duration}
                onChange={(duration) => {
                  touch('duration');
                  setSpec((s) => ({ ...s, duration }));
                }}
              />
              {spec.duration.mode === 'set' && preflight.durationLockedCount > 0 && (
                <Warning testId="bulk-edit-warning-duration-locked">
                  {countRows(preflight.durationLockedCount)} roll their estimate up or have no
                  duration — those are left alone. Their other changes still land.
                </Warning>
              )}
              <NumericField
                idPrefix="bulk-percent"
                label="Percent complete"
                unitLabel="%"
                choice={spec.percentComplete}
                onChange={(percentComplete) => {
                  touch('percentComplete');
                  setSpec((s) => ({ ...s, percentComplete }));
                }}
              />
            </Group>

            <Group
              title="Placement & policy"
              note={`${formatChord('mod+shift+m')} for a whole subtree`}
            >
              <SprintField
                choice={spec.sprint}
                sprints={sprints}
                itl={iterationLabel}
                onChange={(sprint) => {
                  touch('sprint');
                  setSpec((s) => ({ ...s, sprint }));
                }}
              />
              {spec.sprint.mode === 'set' && isActiveSprint(sprints, spec.sprint.sprintId) && (
                // Sprint sovereignty (ADR-0102), stated rather than discovered:
                // an injection into a RUNNING sprint is recorded and held pending
                // until someone accepts it, so the commitment does not move on
                // its own. The batch endpoint routes through the same
                // `maybe_record_scope_injection` every other write path uses (#3152).
                <p
                  data-testid="bulk-edit-sprint-pending-note"
                  className="text-neutral-text-secondary leading-snug"
                >
                  This {iterationLabel.lower} is running — added items are held pending until
                  someone accepts them, and stay out of the burndown until then.
                </p>
              )}
              <RadioRow
                name="bulk_governance_class"
                label="Governed by"
                options={GOVERNANCE_OPTIONS}
                value={spec.governanceClass}
                mixedLabel={mixedSuffix(sharedValue(tasks, (t) => t.governanceClass ?? null))}
                onChange={(v) => {
                  touch('governanceClass');
                  setSpec((s) => ({ ...s, governanceClass: v }));
                }}
              />
              <RadioRow
                name="bulk_delivery_mode"
                label="Progress from"
                options={DELIVERY_OPTIONS}
                value={spec.deliveryMode}
                mixedLabel={mixedSuffix(sharedValue(tasks, (t) => t.deliveryMode ?? null))}
                onChange={(v) => {
                  touch('deliveryMode');
                  setSpec((s) => ({ ...s, deliveryMode: v }));
                }}
                disabledTitle="A bulk edit cannot convert items into milestones — set is_milestone on the item itself."
              />
            </Group>

            {/* `S2` — People is a group of one and sits LAST, so #3153's
                not-yet-shipped arms degrade to "the last group is partly
                unavailable" rather than a hole in the middle of the list. */}
            <OwnerField
              spec={spec}
              setSpec={setSpec}
              resourcePool={resourcePool}
              summaryCount={preflight.summaryCount}
              refusal={ownerRefusal}
              onRefuse={setOwnerRefusal}
              onTouch={() => touch('owner')}
            />

            {preflight.notEditableCount > 0 && (
              <Warning testId="bulk-edit-warning-not-editable">
                {countRows(preflight.notEditableCount)} you can’t edit — they’ll be reported as
                refused.
              </Warning>
            )}
          </div>

          <footer className="px-4 py-3 border-t border-neutral-border space-y-2">
            {/*
              `S15` — the review block is Apply's `aria-describedby`, NOT a live
              region. It changes on every keystroke, so narrating it continuously
              would be unusable; describing the commit control means it is read
              on ARRIVAL at the commit, which is when a person needs it.
            */}
            <div id={REVIEW_ID} data-testid="bulk-edit-review" className="leading-snug">
              {reviewLines.length === 0 ? (
                <span className="text-neutral-text-secondary">Choose a value on any field.</span>
              ) : (
                <ul className="space-y-1">
                  {reviewLines.map((line) => (
                    <FieldLineRow key={line.id} line={line} tense="future" />
                  ))}
                </ul>
              )}
              {chordArmed && (
                <p data-testid="bulk-edit-chord-guard" className="mt-1 text-semantic-warning">
                  This takes something away. Read it back, then press {formatChord('mod+Enter')}{' '}
                  again or use Apply.
                </p>
              )}
            </div>
            {/*
              A SIBLING of the review block, not a child of it (web-rule 372b).
              The review is Apply's `aria-describedby` and changes on every
              keystroke; a refusal appended inside it would be read only on the
              next arrival at the commit, which is exactly when it is too late.
              As its own `role="alert"` it is announced when the server answers —
              which, before #3332, nothing on this sheet ever was.
            */}
            <RefusalAlert refusal={error} testId="bulk-edit-error" persistent />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                ref={applyRef}
                variant="primary"
                size="sm"
                disabled={!canApply}
                aria-describedby={REVIEW_ID}
                onClick={submit}
                data-testid="bulk-edit-apply"
              >
                {/* The verb survives a refusal the server has already decided
                    (web-rule 372a): "Apply to 14 rows" is what tells the planner
                    the scope they are about to commit, and a blanket "Retry"
                    both hid that and pointed at the one act guaranteed to be
                    refused identically. */}
                {isPending
                  ? 'Applying…'
                  : error?.retryable
                    ? 'Retry'
                    : `Apply to ${countRows(tasks.length)}`}
              </Button>
            </div>
          </footer>
        </>
      )}
    </div>,
    document.body,
  );
}

/** Is this field currently off `leave`? Drives Escape's one-step revert. */
function isFieldSet(spec: BulkEditSpec, id: BulkFieldId): boolean {
  switch (id) {
    case 'plannedStart':
      return spec.plannedStart.mode !== 'leave';
    case 'plannedFinish':
      return spec.plannedFinish.mode !== 'leave';
    case 'duration':
      return spec.duration.mode !== 'leave';
    case 'percentComplete':
      return spec.percentComplete.mode !== 'leave';
    case 'sprint':
      return spec.sprint.mode !== 'leave';
    case 'governanceClass':
      return spec.governanceClass !== null;
    case 'deliveryMode':
      return spec.deliveryMode !== null;
    case 'owner':
      return spec.owner.mode !== 'leave';
  }
}

function revertField(spec: BulkEditSpec, id: BulkFieldId): BulkEditSpec {
  return { ...spec, [id]: EMPTY_BULK_EDIT_SPEC[id] } as BulkEditSpec;
}

function isActiveSprint(sprints: ApiSprint[], id: string | null): boolean {
  return !!id && sprints.some((s) => s.id === id && s.state === 'ACTIVE');
}

/**
 * "Leave" alone, or "Leave — Mixed" / "Leave — flow" once the rows have a say.
 * `sharedValue` returns the literal `'mixed'` for a disagreeing selection, which
 * widens to `string` here — the comparison is still the only one that can match,
 * since no `GovernanceClass` or `DeliveryMode` member is spelled "mixed".
 */
function mixedSuffix(shared: string | null): string | null {
  if (shared === 'mixed') return 'Mixed';
  return shared;
}

/**
 * One field's line, in the review or the result (`S14`, `S17`).
 *
 * Every non-zero term is rendered, and the denominator is the field's own — so
 * the four outcome counts and the total are all on screen and a reader can do
 * the addition. That is the assertion, not a convention.
 */
function FieldLineRow({ line, tense }: { line: FieldLine; tense: 'future' | 'past' }) {
  const terms: string[] = [];
  const push = (n: number, word: string) => {
    if (n > 0) terms.push(`${n} ${word}`);
  };
  push(line.counts.updated, tense === 'future' ? 'to update' : 'updated');
  push(line.counts.unchanged, 'unchanged');
  push(line.counts.leftAlone, 'left alone');
  push(line.counts.refused, 'refused');

  return (
    <li data-testid={`bulk-edit-line-${line.id}`} data-denominator={line.denominator}>
      <span className="text-neutral-text-primary">{line.sentence}</span>
      <span className="text-neutral-text-secondary">
        {' '}
        — {terms.join(', ')} of {countRows(line.denominator)}
      </span>
      {line.notes.map((note) => (
        <span key={note} className="block text-neutral-text-secondary">
          {note}
        </span>
      ))}
    </li>
  );
}

function ResultPhase({
  lines,
  result,
  onReviewFailed,
  onDone,
  onClose,
}: {
  lines: FieldLine[];
  result: TaskBulkResponse;
  onReviewFailed: (taskIds: string[]) => void;
  onDone?: (clean: boolean) => void;
  onClose: () => void;
}) {
  // A rejection can carry a null id (rejected before an id parsed), which is not
  // a row anyone can navigate to — so the count and the navigable set differ.
  const failedIds = result.rejected.map((r) => r.id).filter((id): id is string => id !== null);
  const clean = resultIsClean(lines);
  const changes = totalChanges(lines);
  const seatRef = useRef<HTMLButtonElement | null>(null);

  // Rule 335(a)+(c): the seat target is focused by script, and its
  // `aria-describedby` is what makes the BREAKDOWN — not just the button's own
  // name — reach a screen-reader user who landed here without hearing the
  // live region fire.
  useEffect(() => {
    seatRef.current?.focus();
  }, []);

  return (
    <>
      {/* The WHOLE breakdown is the live region, not just the count. A screen
          reader that announces "1 of 2 items updated" and stops has withheld the
          only part a person can act on — which item failed, and why. */}
      <div
        id={RESULT_PANEL_ID}
        role="status"
        aria-live="polite"
        // Rule 360. A scroll container with NO focusable descendant is
        // unreachable by keyboard: rule 335 puts the actions in the sibling
        // footer on purpose,
        // so nothing in here can seat focus and the arrow keys scroll nothing.
        // `aria-describedby` hides this from an AT pass — it reads the whole node
        // either way — so the gap is specifically a sighted keyboard one
        // (WCAG 2.1.1). The seat effect below runs after mount and focuses a
        // footer button, so this tab stop never captures initial focus.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2
                   focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        data-testid="bulk-edit-result"
      >
        {/*
          `S19` — the header counts CHANGES, not items. One item can be updated
          for one field and refused for another, so "12 of 15 items updated" is
          exactly the claim the per-field equation forbids.
        */}
        <p className="text-sm font-medium" data-testid="bulk-edit-result-header">
          {countChanges(changes)} applied
        </p>
        <ul className="space-y-1">
          {lines.map((line) => (
            <FieldLineRow key={line.id} line={line} tense="past" />
          ))}
        </ul>
        {result.rejected.length > 0 && (
          <p className="text-neutral-text-secondary leading-snug">
            {/* One reason line, not N: a bulk edit sends one identical change,
                so the refusals are near-always the same code repeated. */}
            {result.rejected[0].message}
          </p>
        )}
      </div>
      <footer className="px-4 py-3 border-t border-neutral-border flex items-center justify-end gap-2">
        {/*
          `S20` — retry is offered ONLY for refusals, which are server-side and
          transient. A left-alone item was never going to be written, so a Retry
          beside it would be a control that cannot succeed.
        */}
        {failedIds.length > 0 && (
          <Button
            ref={seatRef}
            variant="ghost"
            size="sm"
            aria-describedby={RESULT_PANEL_ID}
            className="focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            onClick={() => onReviewFailed(failedIds)}
            data-testid="bulk-edit-review-failed"
          >
            Retry the {failedIds.length}
          </Button>
        )}
        <Button
          ref={failedIds.length === 0 ? seatRef : undefined}
          variant="primary"
          size="sm"
          aria-describedby={RESULT_PANEL_ID}
          // Rule 335(c): `focus:`, never `focus-visible:` — this is reached by a
          // SCRIPTED focus, which browsers may decline to treat as visible. And
          // it sits on a sage fill, so it takes the rule-4 navy-on-sage ring.
          className="focus:outline-none focus:ring-2 focus:ring-navy-700 focus:ring-offset-1 focus:ring-offset-sage-500"
          onClick={() => {
            onDone?.(clean);
            onClose();
          }}
          data-testid="bulk-edit-done"
        >
          Done
        </Button>
      </footer>
    </>
  );
}

/**
 * The owner control, at its **final** size (#3153 `S9`).
 *
 * Four arms in one radio group over one fixed-height payload slot. Remove and
 * Replace do not write in 0.4 and are still here: a control that changes shape
 * next release is worse than a dead one, and a dead one with no explanation is
 * worse than both. This picks the third thing — present, explained, and inert.
 *
 * **Rule 361** generalizes what this control does, and the five parts are all
 * here: the at-rest sentence in the group note, the version badge on the arm at
 * `text-xs` (rule 50's floor is not waived outside `features/settings/`),
 * `aria-disabled` **never** `disabled` so each arm keeps its tab stop and its
 * accessible name, an explicit `aria-label` on the input because the accname
 * computation trims text nodes, and a refusal region mounted before it has
 * anything to say (rule 335). The refusal therefore fires at the moment of the
 * attempt rather than silently at Apply. Labels stay at secondary contrast
 * (`S25`): the disabled token marks the state, it never carries the sentence — a
 * person who cannot use a control still has to be able to read what it is.
 *
 * ## Why there is no reduced-permission view here (`S13`, countermanded)
 *
 * The design's `S13` gated this whole group behind a higher role, on the premise
 * that assigning owners needs more authority than the sheet's other seven
 * fields. **That premise is wrong for this endpoint.** `TaskSerializer`'s
 * `owners` field inherits whatever gates the surrounding write, and on
 * `POST /projects/{pk}/tasks/bulk/` that gate is `IsProjectPlanAuthor`
 * (ADR-0773) — not `CanAssignResource`. There is no user who can edit the other
 * seven fields but not this one, so the reduced-permission state cannot occur
 * and building it would be building a screen nobody can reach.
 *
 * The asymmetry becomes real in 0.5, and points the other way: removal goes
 * through `DELETE /task-resources/`, which **is** gated on `CanAssignResource`.
 * Decide that gate when removal lands, for the two arms rather than the group.
 * Do not re-add a 0.4 permission view — the reason it was dropped is here so it
 * is not rediscovered as an omission.
 */
function OwnerField({
  spec,
  setSpec,
  resourcePool,
  summaryCount,
  refusal,
  onRefuse,
  onTouch,
}: {
  spec: BulkEditSpec;
  setSpec: (fn: (s: BulkEditSpec) => BulkEditSpec) => void;
  resourcePool: ProjectResource[];
  summaryCount: number;
  refusal: string | null;
  onRefuse: (message: string | null) => void;
  onTouch: () => void;
}) {
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const picked = useRef(false);

  useEffect(() => {
    if (spec.owner.mode === 'add' && picked.current) {
      picked.current = false;
      selectRef.current?.focus();
    }
  }, [spec.owner.mode]);

  const choose = (mode: OwnerMode) => {
    if (ownerArmIsInert(mode)) {
      // `S12` — refusal at the moment of the attempt, never silently at Apply.
      const arm = OWNER_ARMS.find((a) => a.mode === mode);
      onRefuse(
        `${arm?.gerund ?? arm?.label} an owner ships in ${arm?.shipsIn}. Nothing was changed.`,
      );
      return;
    }
    onTouch();
    picked.current = mode !== 'leave';
    setSpec((s) => ({
      ...s,
      owner: mode === 'leave' ? EMPTY_BULK_EDIT_SPEC.owner : { ...s.owner, mode },
    }));
  };

  return (
    <Group title="People">
      <fieldset className="flex items-center gap-2 flex-wrap border-0 p-0 m-0">
        <legend className="sr-only">Owner</legend>
        <span aria-hidden="true" className="w-24 shrink-0 text-neutral-text-secondary">
          Owner
        </span>
        {OWNER_ARMS.map((arm) => (
          <Chip
            key={arm.mode}
            name="bulk_owner_mode"
            checked={spec.owner.mode === arm.mode}
            ariaDisabled={arm.shipsIn !== undefined}
            label={arm.label}
            badge={arm.shipsIn}
            testId={`bulk-owner-${arm.mode}`}
            onSelect={() => choose(arm.mode)}
          />
        ))}
      </fieldset>

      {/*
        `S9` — ONE fixed-height payload slot. It is reserved whichever arm is
        chosen, so 0.5 filling it for Remove and Replace moves nothing: no
        relayout, no new tab stop, nothing re-learned.
      */}
      <div className="min-h-[28px]" data-testid="bulk-owner-payload">
        {spec.owner.mode === 'add' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-24 shrink-0" aria-hidden="true" />
            <label htmlFor="bulk-edit-owner" className="sr-only">
              Owner to add
            </label>
            <select
              id="bulk-edit-owner"
              ref={selectRef}
              data-testid="bulk-edit-owner"
              value={spec.owner.resourceId ?? ''}
              onChange={(e) => {
                const resourceId = e.target.value || null;
                const match = resourcePool.find((r) => r.resourceId === resourceId) ?? null;
                onTouch();
                setSpec((s) => ({
                  ...s,
                  owner: {
                    ...s.owner,
                    resourceId,
                    resourceName: match?.resource.name ?? null,
                  },
                }));
              }}
              className="flex-1 min-w-0 h-7 px-2 rounded border border-neutral-border bg-neutral-surface
                         focus:outline-none focus:ring-2 focus:ring-brand-primary"
            >
              <option value="">Choose someone…</option>
              {resourcePool.map((r) => (
                <option key={r.resourceId} value={r.resourceId}>
                  {r.resource.name}
                </option>
              ))}
            </select>
            <label htmlFor="bulk-edit-owner-units" className="sr-only">
              Allocation percent
            </label>
            <input
              id="bulk-edit-owner-units"
              data-testid="bulk-edit-owner-units"
              type="number"
              min={1}
              max={1000}
              value={spec.owner.percent}
              onChange={(e) => {
                onTouch();
                setSpec((s) => ({
                  ...s,
                  owner: { ...s.owner, percent: Number(e.target.value) || 100 },
                }));
              }}
              className="w-16 shrink-0 h-7 px-2 rounded border border-neutral-border bg-neutral-surface
                         focus:outline-none focus:ring-2 focus:ring-brand-primary"
            />
          </div>
        )}
      </div>

      {/* Rule 361(a) / `S12` — the reason is stated AT REST, not only on the
          attempt. A visibly inert control with no explanation is worse than an
          absent one. The version here is checked against the roadmap. */}
      <p className="text-neutral-text-secondary leading-snug">
        Add is an upsert — a lower percent is how you reduce someone. Remove and Replace ship in
        0.5; today removal stays on the item.
      </p>
      {/*
        Mounted unconditionally, text swapped (rule 335): a live region inserted
        together with its own content is announced inconsistently across AT — and
        for a screen-reader user this announcement IS `S12`'s refusal, the whole
        point of which is that it fires at the moment of the attempt. An empty
        `<p>` collapses to nothing, so there is no layout cost to always having it.
      */}
      <p
        role="status"
        aria-live="polite"
        data-testid="bulk-owner-refusal"
        className="text-semantic-warning leading-snug empty:hidden"
      >
        {refusal}
      </p>
      {spec.owner.mode === 'add' && spec.owner.resourceId !== null && summaryCount > 0 && (
        <Warning testId="bulk-edit-warning-summary">
          {countRows(summaryCount)} in the selection can’t take an owner — those are left alone.
          Their other changes still land.
        </Warning>
      )}
    </Group>
  );
}

const TRI_STATE_OPTIONS: Array<{ value: TriState; label: string }> = [
  { value: 'leave', label: 'Leave' },
  { value: 'set', label: 'Set' },
  { value: 'clear', label: 'Clear' },
];

function DateField({
  idPrefix,
  label,
  choice,
  onChange,
}: {
  idPrefix: string;
  label: string;
  choice: DateChoice;
  onChange: (choice: DateChoice) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const picked = useRef(false);
  useEffect(() => {
    if (choice.mode === 'set' && picked.current) {
      picked.current = false;
      inputRef.current?.focus();
    }
  }, [choice.mode]);

  return (
    <div className="space-y-1.5">
      <fieldset className="flex items-center gap-2 flex-wrap border-0 p-0 m-0">
        <legend className="sr-only">{label}</legend>
        <span aria-hidden="true" className="w-24 shrink-0 text-neutral-text-secondary">
          {label}
        </span>
        {TRI_STATE_OPTIONS.map((opt) => (
          <Chip
            key={opt.value}
            name={`${idPrefix}-mode`}
            checked={choice.mode === opt.value}
            label={opt.label}
            testId={`${idPrefix}-${opt.value}`}
            onSelect={() => {
              picked.current = opt.value === 'set';
              onChange({ ...choice, mode: opt.value });
            }}
          />
        ))}
      </fieldset>
      {choice.mode === 'set' && (
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0" aria-hidden="true" />
          <label htmlFor={idPrefix} className="sr-only">
            {label} date
          </label>
          <input
            id={idPrefix}
            ref={inputRef}
            data-testid={`${idPrefix}-value`}
            type="date"
            value={choice.value ?? ''}
            onChange={(e) => onChange({ mode: 'set', value: e.target.value || null })}
            className="flex-1 min-w-0 h-7 px-2 rounded border border-neutral-border bg-neutral-surface
                       focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Duration and percent complete — the two fields a re-plan actually changes,
 * and the only two that take a relative operation (`S5`).
 *
 * Two arms, not three. `Clear` is absent for a stated reason rather than an
 * oversight: duration is non-nullable server-side, and clearing a percent is
 * `Set to 0` under another name. A second route to one write is not an arm.
 *
 * **Dates deliberately do not get this control** (`S8`): a relative date shift
 * is a reschedule, and that belongs to the scheduling engine, not a field write.
 */
function NumericField({
  idPrefix,
  label,
  unitLabel,
  choice,
  onChange,
}: {
  idPrefix: string;
  label: string;
  unitLabel: string;
  choice: NumericChoice;
  onChange: (choice: NumericChoice) => void;
}) {
  const opRef = useRef<HTMLSelectElement | null>(null);
  const picked = useRef(false);
  useEffect(() => {
    if (choice.mode === 'set' && picked.current) {
      picked.current = false;
      opRef.current?.focus();
    }
  }, [choice.mode]);

  /**
   * The amount field keeps its RAW text, not `String(choice.value)`.
   *
   * A controlled input rendered from the parsed number cannot hold a lone `+`,
   * so the first keystroke of `+2` round-trips to `''` and the sign is gone
   * before the `2` arrives — the shortcut then silently does nothing, which is
   * indistinguishable from a planner who never learned it.
   */
  const [raw, setRaw] = useState(choice.value === null ? '' : String(choice.value));
  useEffect(() => {
    // Re-sync when the field is reverted from outside (Escape, or Leave).
    if (choice.value === null && choice.mode !== 'set') setRaw('');
  }, [choice.value, choice.mode]);

  return (
    <div className="space-y-1.5">
      <fieldset className="flex items-center gap-2 flex-wrap border-0 p-0 m-0">
        <legend className="sr-only">{label}</legend>
        <span aria-hidden="true" className="w-24 shrink-0 text-neutral-text-secondary">
          {label}
        </span>
        {TRI_STATE_OPTIONS.filter((o) => o.value !== 'clear').map((opt) => (
          <Chip
            key={opt.value}
            name={`${idPrefix}-mode`}
            checked={choice.mode === opt.value}
            label={opt.label}
            testId={`${idPrefix}-${opt.value}`}
            onSelect={() => {
              picked.current = opt.value === 'set';
              onChange({ ...choice, mode: opt.value });
            }}
          />
        ))}
      </fieldset>
      {choice.mode === 'set' && (
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0" aria-hidden="true" />
          {/* `S6` — a worded select, not a sign glyph and not a mode. A mode is a
              state you can be in without noticing; a glyph has to be taught. */}
          <label htmlFor={`${idPrefix}-op`} className="sr-only">
            {label} operation
          </label>
          <select
            id={`${idPrefix}-op`}
            ref={opRef}
            data-testid={`${idPrefix}-op`}
            value={choice.op}
            onChange={(e) => onChange({ ...choice, op: e.target.value as RelativeOp })}
            className="h-7 px-2 rounded border border-neutral-border bg-neutral-surface
                       focus:outline-none focus:ring-2 focus:ring-brand-primary"
          >
            {OP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <label htmlFor={`${idPrefix}-amount`} className="sr-only">
            {label} amount in {unitLabel}
          </label>
          <input
            id={`${idPrefix}-amount`}
            data-testid={`${idPrefix}-amount`}
            type="text"
            inputMode="numeric"
            value={raw}
            // `S6` — typing `+2` / `-2` flips the operator. A shortcut, never the
            // only route: the select above is always present and always correct.
            onChange={(e) => {
              setRaw(e.target.value);
              const { op, value } = readAmount(e.target.value, choice.op);
              onChange({ ...choice, op, value });
            }}
            className="w-16 shrink-0 h-7 px-2 rounded border border-neutral-border bg-neutral-surface
                       focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
          <span className="text-neutral-text-secondary" aria-hidden="true">
            {unitLabel}
          </span>
        </div>
      )}
    </div>
  );
}

function SprintField({
  choice,
  sprints,
  itl,
  onChange,
}: {
  choice: SprintChoice;
  sprints: ApiSprint[];
  itl: IterationLabelForms;
  onChange: (choice: SprintChoice) => void;
}) {
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const picked = useRef(false);
  useEffect(() => {
    if (choice.mode === 'set' && picked.current) {
      picked.current = false;
      selectRef.current?.focus();
    }
  }, [choice.mode]);

  // A closed sprint is not a destination — moving work into one would be
  // rewriting history, and the server refuses it.
  const options = sprints.filter((s) => s.state === 'PLANNED' || s.state === 'ACTIVE');

  return (
    <div className="space-y-1.5">
      <fieldset className="flex items-center gap-2 flex-wrap border-0 p-0 m-0">
        <legend className="sr-only">{itl.singular}</legend>
        <span aria-hidden="true" className="w-24 shrink-0 text-neutral-text-secondary">
          {itl.singular}
        </span>
        {TRI_STATE_OPTIONS.map((opt) => (
          <Chip
            key={opt.value}
            name="bulk-sprint-mode"
            checked={choice.mode === opt.value}
            label={opt.label}
            testId={`bulk-sprint-${opt.value}`}
            onSelect={() => {
              picked.current = opt.value === 'set';
              onChange({ ...choice, mode: opt.value });
            }}
          />
        ))}
      </fieldset>
      {choice.mode === 'set' && (
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0" aria-hidden="true" />
          <label htmlFor="bulk-sprint-value" className="sr-only">
            {itl.singular} to move into
          </label>
          <select
            id="bulk-sprint-value"
            ref={selectRef}
            data-testid="bulk-sprint-value"
            value={choice.sprintId ?? ''}
            onChange={(e) => {
              const sprintId = e.target.value || null;
              const match = options.find((s) => s.id === sprintId) ?? null;
              onChange({ mode: 'set', sprintId, sprintName: match?.name ?? null });
            }}
            className="flex-1 min-w-0 h-7 px-2 rounded border border-neutral-border bg-neutral-surface
                       focus:outline-none focus:ring-2 focus:ring-brand-primary"
          >
            <option value="">Choose a {itl.lower}…</option>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.state === 'ACTIVE' ? ' (running)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        {/* text-xs, not text-[11px]: the compact-density exception (rule 118) is
            scoped to features/settings/ only, and this is a schedule surface. */}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
          {title}
        </h3>
        {note && <span className="ml-auto text-neutral-text-secondary">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Warning({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    // Text, never color alone — the amber is reinforcement (WCAG 1.4.1). The glyph
    // is aria-hidden: U+26A0 announces inconsistently across screen readers
    // ("warning", "warning sign", or nothing at all depending on symbol level),
    // and the sentence already says what is wrong, so it is decoration.
    <p data-testid={testId} className="text-semantic-warning leading-snug">
      <span aria-hidden="true">⚠</span> {children}
    </p>
  );
}

/**
 * One field as a native radio group. Native `<input type="radio">` rather than
 * `role="radio"` buttons, for the same reason ClassificationPopover gives:
 * arrow-key traversal, group semantics and the selected-item announcement all
 * come from the platform, and a chip is only a visual treatment of a radio.
 *
 * `S21` — a native radio group is ONE tab stop for the whole field, which is
 * exactly the keyboard contract the design asks for; nothing here has to build it.
 */
function RadioRow<V extends string | null>({
  name,
  label,
  options,
  value,
  mixedLabel,
  onChange,
  disabledTitle,
}: {
  name: string;
  label: string;
  options: Array<{ value: V; label: string; disabled?: boolean }>;
  value: V;
  mixedLabel: string | null;
  onChange: (v: V) => void;
  disabledTitle?: string;
}) {
  return (
    <fieldset className="flex items-center gap-2 flex-wrap border-0 p-0 m-0">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className="w-24 shrink-0 text-neutral-text-secondary">
        {label}
      </span>
      {options.map((opt) => (
        <Chip
          key={opt.label}
          name={name}
          checked={opt.value === value}
          disabled={opt.disabled}
          title={opt.disabled ? disabledTitle : undefined}
          // "Leave — Mixed" tells the planner the rows disagree without the
          // sheet inventing a single current value it does not have.
          label={opt.value === null && mixedLabel ? `${opt.label} — ${mixedLabel}` : opt.label}
          testId={`${name}-${opt.value ?? 'leave'}`}
          onSelect={() => onChange(opt.value)}
        />
      ))}
    </fieldset>
  );
}

function Chip({
  name,
  checked,
  label,
  badge,
  testId,
  onSelect,
  disabled,
  ariaDisabled,
  title,
}: {
  name: string;
  checked: boolean;
  label: string;
  /** `S12` — the release an inert arm ships in, worn on the arm itself. */
  badge?: string;
  testId: string;
  onSelect: () => void;
  disabled?: boolean;
  ariaDisabled?: boolean;
  title?: string;
}) {
  return (
    // The testid is on the LABEL, not the `sr-only` input: the label is what a
    // person clicks, and it covers the input completely — so a test driving the
    // input directly is blocked by its own label ("intercepts pointer events").
    // The input keeps a `-input` testid for state assertions like `toBeDisabled`.
    <label
      title={title}
      data-testid={testId}
      className={[
        'inline-flex items-center gap-1 rounded-chip border px-2 py-0.5 cursor-pointer',
        'focus-within:outline-none focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1',
        // rule 122: half-opacity body text fails WCAG 1.4.3. An inert control
        // recolors at full opacity and keeps its focus ring.
        disabled
          ? 'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border/55 cursor-not-allowed'
          : '',
        // `S25` — the state is marked by the border and the badge, NEVER by
        // dropping the label to disabled contrast: a person who cannot use a
        // control still has to be able to read what it is.
        ariaDisabled ? 'border-dashed cursor-not-allowed' : '',
        checked
          ? 'border-brand-primary bg-brand-primary/10 text-brand-primary font-medium'
          : 'border-neutral-border text-neutral-text-secondary',
      ].join(' ')}
    >
      <input
        type="radio"
        className="sr-only"
        name={name}
        checked={checked}
        disabled={disabled}
        aria-disabled={ariaDisabled || undefined}
        // Rule 361(d): an explicit name, not the label's text. The accname TRIMS
        // each text node before joining, so `Remove` + an `sr-only` carrier
        // renders as "Removeships in 0.5" — the space between two sibling nodes
        // does not survive. One attribute states the whole name instead.
        aria-label={badge ? `${label} — ships in ${badge}` : undefined}
        data-testid={`${testId}-input`}
        // Rule 361(c) / `S12` — `preventDefault` on the click keeps an `aria-disabled`
        // radio inert WITHOUT `disabled`: the arm keeps its tab stop and its
        // accessible name, nothing is checked, and `onSelect` still runs so the
        // refusal is stated at the moment of the attempt. A prevented click
        // never fires `change`, which is why the inert arm is wired here instead.
        onClick={
          ariaDisabled
            ? (e) => {
                e.preventDefault();
                onSelect();
              }
            : undefined
        }
        onChange={ariaDisabled ? undefined : onSelect}
      />
      {label}
      {badge && (
        <>
          {/* rule 50: `text-xs` is the floor and rule 118's compact exception is
              scoped to features/settings — this is a schedule surface. */}
          <span
            data-testid={`${testId}-badge`}
            // A bare version number would land in the radio's accessible name as
            // an uninterpretable value ("Remove 0.5"). The glyph is hidden and
            // the input's own `aria-label` carries the phrase instead.
            aria-hidden="true"
            className="rounded-chip bg-neutral-surface-sunken px-1 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary"
          >
            {badge}
          </span>
        </>
      )}
    </label>
  );
}

export { REVIEW_ID, RESULT_PANEL_ID };
