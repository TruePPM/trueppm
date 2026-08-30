import { countRows } from '../../rowVocabulary';
import { DEFAULT_ITERATION_LABEL } from '@/lib/iterationLabel';
import type { BulkUpdateOperation, TaskBulkResponse } from '@/hooks/useTaskMutations';
import type { DeliveryMode, GovernanceClass, Task } from '@/types';

/**
 * The ⌘⇧K bulk-edit sheet's form model and the pure translation from it to the
 * batch endpoint's `operations` array (#2756 pt.2, ADR-0810; widened to eight
 * fields by #3152 / #3153).
 *
 * Kept React-free so the three things most likely to be wrong — which rows get
 * which fields, what the review line claims is about to happen, and whether the
 * result's arithmetic adds up — are unit testable without mounting a sheet over
 * a virtualized outline.
 *
 * ## The eight fields, and why they are grouped this way (`S1`, `S2`)
 *
 * | Group              | Fields                                                        |
 * |--------------------|---------------------------------------------------------------|
 * | Plan               | planned start · planned finish · duration · percent complete  |
 * | Placement & policy | sprint · governance class · delivery mode                     |
 * | People             | owner                                                         |
 *
 * Grouping is by **write shape** (checkable in code); the order *within* a group
 * is by change frequency, which is a customer habit that rots silently — so it
 * only ever decides the order, never the structure. People is a group of one and
 * sits last so #3153's not-yet-shipped arms degrade to "the last group is
 * partly unavailable" rather than a hole in the middle of the list.
 *
 * ## The tri-state model is not widened (`S5`)
 *
 * Every field is still `leave | set | clear`. Duration and percent complete gain
 * an **operator inside `set`** — `to` / `plus` / `minus` — which is a widening of
 * one arm, not a fourth state. Dates deliberately do **not** get one: a relative
 * date shift is a reschedule, and that belongs to the scheduling engine rather
 * than to a field write (`S8`).
 *
 * Two fields carry no `clear` arm, and the reason is the server's, not a
 * preference:
 *   * **duration** is non-nullable — there is no value a "clear" could write.
 *   * **percent complete** would clear to `0`, which is exactly `Set to 0`. A
 *     second route to one write is not an arm; it is a second name for one.
 * `sprint` does get one, because `sprint: null` is a genuinely distinct write
 * (take this batch out of its sprint) that no `set` can express.
 */

/** Lowercased system default, for the pure functions' `iterationLower` fallback. */
const DEFAULT_ITERATION_LOWER = DEFAULT_ITERATION_LABEL.toLowerCase();

/** Every field defaults to `leave`; only a field moved off it reaches the wire. */
export type TriState = 'leave' | 'set' | 'clear';

/**
 * The operator inside `set`, for the two numeric fields (`S5`, `S6`).
 *
 * Worded in the UI as `Set to` / `Increase by` / `Reduce by` — never a sign
 * glyph and never a mode, because a mode is a state a planner can be in without
 * noticing and a glyph is a symbol they have to have been taught.
 */
export type RelativeOp = 'to' | 'plus' | 'minus';

export interface NumericChoice {
  /** `clear` is unreachable for both numeric fields today — see the module note. */
  mode: TriState;
  op: RelativeOp;
  /** Whole units as typed: working days for duration, percent for progress. */
  value: number | null;
}

export interface DateChoice {
  mode: TriState;
  /** ISO `YYYY-MM-DD`; meaningful only when `mode === 'set'`. */
  value: string | null;
}

export interface SprintChoice {
  mode: TriState;
  sprintId: string | null;
  /** Carried for the review line only; never sent. */
  sprintName: string | null;
}

/**
 * The owner control's four arms (#3153 `S9`).
 *
 * `Remove` and `Replace` are declared here in 0.4 even though neither writes
 * anything yet: the geometry ships at its final size now, so landing removal in
 * 0.5 deletes a badge, a predicate and a paragraph — no relayout, no new tab
 * stop, nothing re-learned. `bulkEditSpec.test.ts` locks the roster and its
 * order so that promise is checkable rather than asserted.
 */
export type OwnerMode = 'leave' | 'add' | 'remove' | 'replace';

/** The arms in render order. The order is the contract, so it lives in one place. */
export const OWNER_ARMS: ReadonlyArray<{
  mode: OwnerMode;
  label: string;
  /**
   * The label as a gerund, for a sentence rather than a button.
   * "Remove an owner ships in 0.5" is not English; "Removing" is.
   */
  gerund?: string;
  /**
   * Present, labelled and keyboard-reachable, but refusing (`S12`). Rendered
   * with `aria-disabled`, **never** `disabled`, so the arm keeps its tab stop
   * and its accessible name and the refusal fires at the moment of the attempt
   * rather than silently at Apply.
   */
  shipsIn?: string;
}> = [
  { mode: 'leave', label: 'Leave' },
  { mode: 'add', label: 'Add' },
  { mode: 'remove', label: 'Remove', gerund: 'Removing', shipsIn: '0.5' },
  { mode: 'replace', label: 'Replace', gerund: 'Replacing', shipsIn: '0.5' },
];

/** True for an arm that is present but cannot yet write. */
export function ownerArmIsInert(mode: OwnerMode): boolean {
  return OWNER_ARMS.some((a) => a.mode === mode && a.shipsIn !== undefined);
}

export interface OwnerChoice {
  mode: OwnerMode;
  /** `ProjectResource.resourceId` — the Resource id the API wants, not the row id. */
  resourceId: string | null;
  /** Carried for the review line only; never sent. */
  resourceName: string | null;
  /** Whole percent as the planner types it; divided by 100 on the way out. */
  percent: number;
}

export interface BulkEditSpec {
  plannedStart: DateChoice;
  plannedFinish: DateChoice;
  duration: NumericChoice;
  percentComplete: NumericChoice;
  sprint: SprintChoice;
  /** `null` means leave this axis alone — same convention as ClassificationPopover. */
  governanceClass: GovernanceClass | null;
  deliveryMode: DeliveryMode | null;
  owner: OwnerChoice;
}

export const EMPTY_BULK_EDIT_SPEC: BulkEditSpec = {
  plannedStart: { mode: 'leave', value: null },
  plannedFinish: { mode: 'leave', value: null },
  duration: { mode: 'leave', op: 'to', value: null },
  percentComplete: { mode: 'leave', op: 'to', value: null },
  sprint: { mode: 'leave', sprintId: null, sprintName: null },
  governanceClass: null,
  deliveryMode: null,
  owner: { mode: 'leave', resourceId: null, resourceName: null, percent: 100 },
};

// ---------------------------------------------------------------------------
// Counting vocabulary (`S24`, `S25`)
// ---------------------------------------------------------------------------

/**
 * Four nouns and no more: **item · field · change · selection**.
 *
 * Items go through `countRows` from the row vocabulary (#3031), so a count-bearing
 * sentence here reaches the same word the outline's buttons do instead of agreeing
 * with them by luck. `change` and `field` are this sheet's own, and they get their
 * own helpers for the same reason: a count is authored through one function or it
 * drifts, and an interpolated literal at the call site is exactly the drift.
 */
export function countChanges(n: number): string {
  return `${n} ${n === 1 ? 'change' : 'changes'}`;
}

export function countFields(n: number): string {
  return `${n} ${n === 1 ? 'field' : 'fields'}`;
}

/** Re-exported so a caller never reaches past this module for the item noun. */
export { countRows };

// ---------------------------------------------------------------------------
// Relative arithmetic (`S5`–`S8`)
// ---------------------------------------------------------------------------

export interface NumericBounds {
  min: number;
  max: number | null;
}

/**
 * Floor of one working day (`S8`). A zero-day bar is a milestone, and a bulk
 * write must not be able to manufacture one — the same coupling the delivery-mode
 * field states out loud by disabling `milestone`.
 */
export const DURATION_BOUNDS: NumericBounds = { min: 1, max: null };

/** Percent complete is a closed interval; results clamp, never wrap (`S8`). */
export const PERCENT_BOUNDS: NumericBounds = { min: 0, max: 100 };

export interface AppliedRelative {
  value: number;
  /** True when a bound moved the result — stated before Apply, never silently. */
  clamped: boolean;
}

/**
 * Apply one operator to one item's current value, then clamp.
 *
 * **Clamping, not wrapping.** `+30` on a task at 90% lands on 100, not on 20.
 * The wrap is arithmetically tidier and is the wrong answer for every planner
 * who ever typed it, so the count of items a bound moved is surfaced in the
 * review rather than folded into "updated".
 */
export function applyRelative(
  op: RelativeOp,
  current: number,
  amount: number,
  bounds: NumericBounds,
): AppliedRelative {
  const raw = op === 'to' ? amount : op === 'plus' ? current + amount : current - amount;
  let value = Math.max(bounds.min, raw);
  if (bounds.max !== null) value = Math.min(bounds.max, value);
  return { value, clamped: value !== raw };
}

/** What one field will do to one item, before the server has had a say. */
export type ExpectedOutcome = 'updated' | 'unchanged' | 'leftAlone';

/** The four kinds the result panel renders, and the terms of `S18`'s equation. */
export type OutcomeKind = ExpectedOutcome | 'refused';

export interface NumericResolution {
  kind: ExpectedOutcome;
  /** The value to send; null when nothing is written for this item. */
  value: number | null;
  clamped: boolean;
}

/**
 * Resolve a numeric field for one item.
 *
 * **A relative operation on an item with no current value leaves it alone**
 * (`S7`) — `+2 days` on a row with no duration has no referent, and initialising
 * it from nothing would be the sheet inventing a number nobody typed. `Set to`
 * is absolute and therefore still writes: it names the value outright.
 */
export function resolveNumeric(
  choice: NumericChoice,
  current: number | null | undefined,
  bounds: NumericBounds,
): NumericResolution {
  if (choice.mode !== 'set' || choice.value === null) {
    return { kind: 'leftAlone', value: null, clamped: false };
  }
  const has = typeof current === 'number' && Number.isFinite(current);
  if (!has && choice.op !== 'to') {
    return { kind: 'leftAlone', value: null, clamped: false };
  }
  const base = has ? current : 0;
  const { value, clamped } = applyRelative(choice.op, base, choice.value, bounds);
  return { kind: has && value === base ? 'unchanged' : 'updated', value, clamped };
}

/**
 * Read a typed amount, honoring the `+2` / `-2` shortcut (`S6`).
 *
 * A shortcut, never the only route: the worded select is always there and always
 * correct, so a planner who has never seen this still reaches every operation.
 */
export function readAmount(raw: string, currentOp: RelativeOp): { op: RelativeOp; value: number | null } {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '+' || trimmed === '-') return { op: currentOp, value: null };
  const op: RelativeOp = trimmed.startsWith('+')
    ? 'plus'
    : trimmed.startsWith('-')
      ? 'minus'
      : currentOp;
  const n = Number(trimmed.replace(/^[+-]/, ''));
  if (!Number.isFinite(n)) return { op: currentOp, value: null };
  return { op, value: Math.abs(n) };
}

// ---------------------------------------------------------------------------
// Which fields are written at all
// ---------------------------------------------------------------------------

export type BulkFieldId =
  | 'plannedStart'
  | 'plannedFinish'
  | 'duration'
  | 'percentComplete'
  | 'sprint'
  | 'governanceClass'
  | 'deliveryMode'
  | 'owner';

/** Field order is `S1`'s table, flattened. Review, result and render all read it. */
export const BULK_FIELD_ORDER: readonly BulkFieldId[] = [
  'plannedStart',
  'plannedFinish',
  'duration',
  'percentComplete',
  'sprint',
  'governanceClass',
  'deliveryMode',
  'owner',
];

export const BULK_FIELD_LABEL: Record<BulkFieldId, string> = {
  plannedStart: 'Planned start',
  plannedFinish: 'Planned finish',
  duration: 'Duration',
  percentComplete: 'Percent complete',
  sprint: 'Sprint',
  governanceClass: 'Governance class',
  deliveryMode: 'Delivery mode',
  owner: 'Owner',
};

function isDateWrite(choice: DateChoice): boolean {
  return choice.mode === 'clear' || (choice.mode === 'set' && !!choice.value);
}

function isNumericWrite(choice: NumericChoice): boolean {
  return choice.mode === 'set' && choice.value !== null;
}

function isSprintWrite(choice: SprintChoice): boolean {
  return choice.mode === 'clear' || (choice.mode === 'set' && !!choice.sprintId);
}

function isOwnerWrite(spec: BulkEditSpec): boolean {
  return spec.owner.mode === 'add' && spec.owner.resourceId !== null;
}

/** The fields currently off `leave` and carrying enough to write, in render order. */
export function writtenFields(spec: BulkEditSpec): BulkFieldId[] {
  return BULK_FIELD_ORDER.filter((id) => {
    switch (id) {
      case 'plannedStart':
        return isDateWrite(spec.plannedStart);
      case 'plannedFinish':
        return isDateWrite(spec.plannedFinish);
      case 'duration':
        return isNumericWrite(spec.duration);
      case 'percentComplete':
        return isNumericWrite(spec.percentComplete);
      case 'sprint':
        return isSprintWrite(spec.sprint);
      case 'governanceClass':
        return spec.governanceClass !== null;
      case 'deliveryMode':
        return spec.deliveryMode !== null;
      case 'owner':
        return isOwnerWrite(spec);
    }
  });
}

/** True once the spec would write anything — gates the Apply button. */
export function hasAnyChange(spec: BulkEditSpec): boolean {
  return writtenFields(spec).length > 0;
}

/**
 * True when any arm that *takes something away* is set (`S16`).
 *
 * The guard the first `⌘⏎` trips is on the **kind of write**, not the kind of
 * user: an Owner and a Member deleting the same dates deserve the same pause.
 */
export function hasDestructiveArm(spec: BulkEditSpec): boolean {
  return (
    spec.plannedStart.mode === 'clear' ||
    spec.plannedFinish.mode === 'clear' ||
    spec.sprint.mode === 'clear' ||
    spec.owner.mode === 'remove' ||
    spec.owner.mode === 'replace'
  );
}

// ---------------------------------------------------------------------------
// Per-item projection — the one computation review, result and payload share
// ---------------------------------------------------------------------------

export interface FieldProjection {
  id: BulkFieldId;
  label: string;
  /**
   * **The whole selection, every time.**
   *
   * `S18`'s equation is `updated + unchanged + left alone + refused =
   * denominator`, and its purpose is that an item cannot be dropped without
   * breaking addition that is on screen. Narrowing a field's denominator to
   * "the items it applies to" would restore exactly the silent drop the
   * equation exists to prevent — so inapplicable items are counted as **left
   * alone** inside the denominator rather than removed from it.
   */
  denominator: number;
  /** What this field expects to do to each item, keyed by task id. */
  byTask: Record<string, ExpectedOutcome>;
  /** The value to write per item; absent means "write nothing for this item". */
  valueByTask: Record<string, unknown>;
  /** Items a bound moved (`S8`). */
  clampedCount: number;
  /** Items a percent write to 100 would also silently promote (#2639). */
  autoPromoteCount: number;
  /** The act, without its counts — "Increase by 2 days", "Add Ana Rivera (50%)". */
  sentence: string;
}

/** Room for the sheet to say things it can only know from outside the selection. */
export interface ProjectionContext {
  /**
   * The project's own word for an iteration, lowercased (ADR-0111, #1287) — a
   * project that calls them "PI"s must not be told about its "sprints". Defaults
   * to the system default rather than being required, so the pure functions stay
   * callable without a React tree.
   */
  iterationLower?: string;
  /**
   * Status the server's auto-promotion would move a 100% row to, for THIS user
   * (`progressCompleteAutoStatus`). Null when the caller could not resolve a
   * role — in which case the disclosure says a promotion may happen without
   * naming a status it is guessing at.
   */
  autoPromoteTarget?: 'REVIEW' | 'COMPLETE' | null;
}

function dateSentence(label: string, choice: DateChoice): string {
  if (choice.mode === 'clear') return `Clear ${label.toLowerCase()}`;
  return `${label} ${choice.value}`;
}

function numericSentence(choice: NumericChoice, unit: string): string {
  const amount = `${choice.value}${unit}`;
  if (choice.op === 'plus') return `Increase by ${amount}`;
  if (choice.op === 'minus') return `Reduce by ${amount}`;
  return `Set to ${amount}`;
}

const GOVERNANCE_LABEL: Record<GovernanceClass, string> = {
  gated: 'gated',
  flow: 'flow',
  hybrid: 'hybrid',
};

const DELIVERY_LABEL: Record<DeliveryMode, string> = {
  waterfall: 'waterfall',
  scrum: 'scrum',
  kanban: 'kanban',
  milestone: 'milestone',
};

/**
 * Project every written field over every selected item.
 *
 * This is the single computation the payload, the review block and the result
 * panel all read. They cannot disagree about what happened because there is
 * only one answer, computed once — which is the mechanical half of `S17`'s
 * promise that the result is the review in past tense.
 *
 * That claim holds only while every caller passes the SAME `ctx`. Nothing in the
 * type system enforces it, so `useBulkEdit.apply` takes the sheet's own context
 * rather than defaulting: today `ctx` reaches only copy (`sentence`, `notes`)
 * and never `valueByTask`, so a mismatch would be invisible — which is exactly
 * the shape of a trap, not a reason to leave it.
 */
export function buildFieldProjection(
  spec: BulkEditSpec,
  tasks: Task[],
  ctx: ProjectionContext = {},
): FieldProjection[] {
  const denominator = tasks.length;
  const iteration = ctx.iterationLower ?? DEFAULT_ITERATION_LOWER;

  return writtenFields(spec).map((id): FieldProjection => {
    const byTask: Record<string, ExpectedOutcome> = {};
    const valueByTask: Record<string, unknown> = {};
    let clampedCount = 0;
    let autoPromoteCount = 0;
    let sentence = '';

    for (const t of tasks) {
      switch (id) {
        case 'plannedStart': {
          sentence = dateSentence('Planned start', spec.plannedStart);
          const target = spec.plannedStart.mode === 'clear' ? null : spec.plannedStart.value;
          const current = t.plannedStart ?? null;
          byTask[t.id] = current === target ? 'unchanged' : 'updated';
          valueByTask[t.id] = target;
          break;
        }
        case 'plannedFinish': {
          sentence = dateSentence('Planned finish', spec.plannedFinish);
          // The outline never reads `planned_finish` back, so there is no current
          // value to compare against. Claiming "unchanged" would be a claim this
          // client cannot support; "updated" is the honest projection, and the
          // server's own no-op write costs a version bump, not a wrong number.
          byTask[t.id] = 'updated';
          valueByTask[t.id] = spec.plannedFinish.mode === 'clear' ? null : spec.plannedFinish.value;
          break;
        }
        case 'duration': {
          sentence = numericSentence(spec.duration, 'd');
          // Σ — a container's estimate rolls up from its children and the server
          // enforces it (`phase_estimate_rollup_locked`), and a milestone's
          // duration is zero by definition (#340). Both are EXPECTED non-writes,
          // so they are left alone rather than sent and refused.
          if (t.isSummary || t.isMilestone) {
            byTask[t.id] = 'leftAlone';
            break;
          }
          const r = resolveNumeric(spec.duration, t.duration, DURATION_BOUNDS);
          byTask[t.id] = r.kind;
          if (r.clamped) clampedCount += 1;
          if (r.value !== null) valueByTask[t.id] = r.value;
          break;
        }
        case 'percentComplete': {
          sentence = numericSentence(spec.percentComplete, '%');
          const r = resolveNumeric(spec.percentComplete, t.progress, PERCENT_BOUNDS);
          byTask[t.id] = r.kind;
          if (r.clamped) clampedCount += 1;
          if (r.value !== null) valueByTask[t.id] = r.value;
          // #2639: writing 100 with no explicit status silently promotes the row.
          // A single-row edit gets a confirmation dialog; a batch cannot, so the
          // disclosure moves into the review and is counted rather than dropped.
          if (r.value === 100 && r.kind === 'updated' && !AUTO_STATUS_EXEMPT.has(t.status)) {
            autoPromoteCount += 1;
          }
          break;
        }
        case 'sprint': {
          const target = spec.sprint.mode === 'clear' ? null : spec.sprint.sprintId;
          sentence =
            spec.sprint.mode === 'clear'
              ? `Take out of its ${iteration}`
              : `Move into ${spec.sprint.sprintName ?? `the ${iteration}`}`;
          const current = t.sprintId ?? null;
          byTask[t.id] = current === target ? 'unchanged' : 'updated';
          valueByTask[t.id] = target;
          break;
        }
        case 'governanceClass': {
          // Non-null by construction: `writtenFields` only yields this id when
          // the axis is set, which the compiler cannot see through the filter.
          const target = spec.governanceClass as GovernanceClass;
          sentence = `Governed by ${GOVERNANCE_LABEL[target]}`;
          byTask[t.id] = (t.governanceClass ?? null) === target ? 'unchanged' : 'updated';
          valueByTask[t.id] = target;
          break;
        }
        case 'deliveryMode': {
          const target = spec.deliveryMode as DeliveryMode;
          sentence = `Progress from ${DELIVERY_LABEL[target]}`;
          byTask[t.id] = (t.deliveryMode ?? null) === target ? 'unchanged' : 'updated';
          valueByTask[t.id] = target;
          break;
        }
        case 'owner': {
          sentence = `Add ${spec.owner.resourceName ?? 'owner'} (${spec.owner.percent}%)`;
          // Owner is dropped per ROW, not per batch: the server refuses `owners`
          // on a summary task, and the 207 contract rejects at row granularity —
          // so sending it would throw away that row's other changes too.
          if (t.isSummary) {
            byTask[t.id] = 'leftAlone';
            break;
          }
          const units = spec.owner.percent / 100;
          const held = (t.assignees ?? []).find((a) => a.resourceId === spec.owner.resourceId);
          byTask[t.id] = held && held.units === units ? 'unchanged' : 'updated';
          valueByTask[t.id] = [{ resource: spec.owner.resourceId as string, units }];
          break;
        }
      }
    }

    return {
      id,
      label: BULK_FIELD_LABEL[id],
      denominator,
      byTask,
      valueByTask,
      clampedCount,
      autoPromoteCount,
      sentence,
    };
  });
}

/**
 * Statuses the server's auto-promotion never fires from. Mirrors
 * `useProgressAutoStatusConfirm`'s own set, which mirrors the serializer's.
 */
const AUTO_STATUS_EXEMPT: ReadonlySet<string> = new Set(['COMPLETE', 'REVIEW', 'BACKLOG']);

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Why a row was dropped before the request, rather than rejected by the server. */
export const SKIPPED_NOTHING_TO_WRITE = 'nothing_to_write';

export interface BuiltBulkEdit {
  operations: BulkUpdateOperation[];
  /**
   * Rows the sheet deliberately did not send, because every field it would have
   * written is inapplicable to them. Reported alongside the server's own
   * `skipped` so the result phase's counts add up to the selection size.
   */
  skippedLocally: Array<{ id: string; code: string; message: string }>;
  /** The projection the payload was built from — carried into the result phase. */
  projection: FieldProjection[];
}

/** Wire key per field. One place, so a rename cannot half-land. */
const WIRE_KEY: Record<BulkFieldId, string> = {
  plannedStart: 'planned_start',
  plannedFinish: 'planned_finish',
  duration: 'duration',
  percentComplete: 'percent_complete',
  sprint: 'sprint',
  governanceClass: 'governance_class',
  deliveryMode: 'delivery_mode',
  owner: 'owners',
};

/**
 * Translate the form to one `update` op per selected row.
 *
 * **Per row, not per batch.** Before #3152 every row got the same `data` object
 * plus a per-row owner drop. A relative operation breaks that: `+2 days` is a
 * different number on every row, so the payload is now assembled from the same
 * per-item projection the review renders. A row left with nothing to write is
 * not sent at all — an empty `update` is a write that costs a version bump and
 * changes nothing.
 */
export function buildBulkEditOperations(
  spec: BulkEditSpec,
  tasks: Task[],
  ctx: ProjectionContext = {},
): BuiltBulkEdit {
  const projection = buildFieldProjection(spec, tasks, ctx);
  const operations: BulkUpdateOperation[] = [];
  const skippedLocally: BuiltBulkEdit['skippedLocally'] = [];

  for (const task of tasks) {
    const data: Record<string, unknown> = {};
    for (const field of projection) {
      if (field.byTask[task.id] === 'leftAlone') continue;
      if (!(task.id in field.valueByTask)) continue;
      data[WIRE_KEY[field.id]] = field.valueByTask[task.id];
    }

    if (Object.keys(data).length === 0) {
      skippedLocally.push({
        id: task.id,
        code: SKIPPED_NOTHING_TO_WRITE,
        message: 'Nothing to write on this one.',
      });
      continue;
    }
    operations.push({ op: 'update', id: task.id, data });
  }

  return { operations, skippedLocally, projection };
}

// ---------------------------------------------------------------------------
// Review (`S14`, `S15`) and result (`S17`–`S19`)
// ---------------------------------------------------------------------------

export interface OutcomeCounts {
  updated: number;
  unchanged: number;
  leftAlone: number;
  refused: number;
}

export interface FieldLine {
  id: BulkFieldId;
  label: string;
  sentence: string;
  denominator: number;
  counts: OutcomeCounts;
  /** Disclosures that belong to this field alone — clamping, auto-promotion. */
  notes: string[];
}

function emptyCounts(): OutcomeCounts {
  return { updated: 0, unchanged: 0, leftAlone: 0, refused: 0 };
}

function notesFor(field: FieldProjection, ctx: ProjectionContext): string[] {
  const notes: string[] = [];
  if (field.clampedCount > 0) {
    const bound = field.id === 'percentComplete' ? '0–100%' : 'the 1-day floor';
    notes.push(`${countRows(field.clampedCount)} stop at ${bound}.`);
  }
  if (field.autoPromoteCount > 0) {
    const target = ctx.autoPromoteTarget;
    notes.push(
      target
        ? `${countRows(field.autoPromoteCount)} will also move to ${target === 'COMPLETE' ? 'Complete' : 'In review'}.`
        : `${countRows(field.autoPromoteCount)} will also have their status promoted.`,
    );
  }
  const leftAlone = Object.values(field.byTask).filter((k) => k === 'leftAlone').length;
  if (leftAlone > 0 && field.id === 'duration') {
    notes.push('Summary rows roll their estimate up, and a milestone has no duration.');
  }
  if (leftAlone > 0 && field.id === 'owner') {
    notes.push('Summary rows can’t take an owner.');
  }
  return notes;
}

/**
 * One line per written field, in field order, each with its own denominator
 * (`S14`).
 *
 * Never one merged sentence: six of the eight fields do not apply to every item
 * type, so a single sentence would have to pick one denominator and be wrong
 * about the rest — which is also why `S3` keeps the header counting the
 * *selection* and leaves counting changes to these lines.
 */
export function buildReviewLines(
  projection: FieldProjection[],
  ctx: ProjectionContext = {},
): FieldLine[] {
  return projection.map((field) => {
    const counts = emptyCounts();
    for (const kind of Object.values(field.byTask)) counts[kind] += 1;
    return {
      id: field.id,
      label: field.label,
      sentence: field.sentence,
      denominator: field.denominator,
      counts,
      notes: notesFor(field, ctx),
    };
  });
}

/**
 * The review in past tense: same fields, same order, same denominators (`S17`).
 *
 * For every field, `updated + unchanged + left alone + refused = denominator` —
 * and every non-zero term is rendered, so **an item cannot be silently dropped
 * without breaking addition that is on screen**. That is what turns "the sheet
 * must not claim it changed an item it skipped" from a review note into a
 * rendered-DOM assertion.
 */
export function buildResultLines(
  projection: FieldProjection[],
  result: TaskBulkResponse,
  skippedLocallyIds: string[],
  ctx: ProjectionContext = {},
): FieldLine[] {
  const refused = new Set(result.rejected.map((r) => r.id).filter((id): id is string => !!id));
  const skipped = new Set<string>([
    ...result.skipped.map((s) => s.id).filter((id): id is string => !!id),
    ...skippedLocallyIds,
  ]);

  return projection.map((field) => {
    const counts = emptyCounts();
    for (const [taskId, expected] of Object.entries(field.byTask)) {
      if (refused.has(taskId)) counts.refused += 1;
      // A row the server skipped wrote nothing, whatever this field expected —
      // an expected non-write and a forced one read the same to a planner.
      else if (skipped.has(taskId)) counts.leftAlone += 1;
      else counts[expected] += 1;
    }
    return {
      id: field.id,
      label: field.label,
      sentence: field.sentence,
      denominator: field.denominator,
      counts,
      notes: notesFor(field, ctx),
    };
  });
}

/** Total changes — `(item, field)` pairs that moved. The result header's number. */
export function totalChanges(lines: FieldLine[]): number {
  return lines.reduce((n, l) => n + l.counts.updated, 0);
}

/** True when nothing was refused — `S20`'s condition for clearing the selection. */
export function resultIsClean(lines: FieldLine[]): boolean {
  return lines.every((l) => l.counts.refused === 0);
}

/**
 * The review line above Apply, as one string (`S14`'s sentence, without counts).
 *
 * Kept for the compact footer restatement and for `useBulkEdit`'s tests; the
 * per-field breakdown is the primary surface.
 */
export function summarizeBulkEditSpec(
  spec: BulkEditSpec,
  tasks: Task[] = [],
  ctx: ProjectionContext = {},
): string {
  return buildFieldProjection(spec, tasks, ctx)
    .map((f) => f.sentence)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/** Pre-flight counts the sheet warns on, all derived client-side from the selection. */
export interface SelectionPreflight {
  total: number;
  /** Rows that will refuse an owner write server-side. */
  summaryCount: number;
  /** Rows whose duration is rolled up or definitionally zero. */
  durationLockedCount: number;
  /**
   * Rows the server has already told us this user may not edit (`can_edit`).
   * A **warning**, never a filter: the client does not re-derive an
   * authorization rule that lives server-side on purpose — these rows are still
   * sent, and the 207's `rejected` list is what reports them.
   */
  notEditableCount: number;
}

export function preflightSelection(tasks: Task[]): SelectionPreflight {
  return {
    total: tasks.length,
    summaryCount: tasks.filter((t) => t.isSummary).length,
    durationLockedCount: tasks.filter((t) => t.isSummary || t.isMilestone).length,
    notEditableCount: tasks.filter((t) => t.canEdit === false).length,
  };
}

/**
 * The shared value of one field across the selection, or `'mixed'` when the rows
 * disagree. Drives the "Leave — Mixed" label: the sheet must not pretend to know
 * a single current value it does not have.
 */
export function sharedValue<V>(tasks: Task[], get: (t: Task) => V): V | 'mixed' | null {
  if (tasks.length === 0) return null;
  const first = get(tasks[0]);
  return tasks.every((t) => get(t) === first) ? first : 'mixed';
}
