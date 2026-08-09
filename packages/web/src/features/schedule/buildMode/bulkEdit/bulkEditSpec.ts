import type { BulkUpdateOperation } from '@/hooks/useTaskMutations';
import type { DeliveryMode, GovernanceClass, Task } from '@/types';

/**
 * The ⌘⇧K bulk-edit sheet's form model and the pure translation from it to the
 * batch endpoint's `operations` array (#2756 pt.2, ADR-0810).
 *
 * Kept React-free so the two things most likely to be wrong — which rows get
 * which fields, and what the review line claims is about to happen — are unit
 * testable without mounting a sheet over a virtualized outline.
 */

/** Every field defaults to `leave`; only a field moved off it reaches the wire. */
export type TriState = 'leave' | 'set' | 'clear';

/**
 * Owner has no `clear`. `owners` is an UPSERT (ADR-0774) — owners not named are
 * left alone, and removal only happens through `DELETE /task-resources/`, which
 * the batch endpoint does not expose. So the honest states are "leave alone" and
 * "add", and the sheet's label says **Add owner**, not "Set owner": a row that
 * already has an owner gains a co-owner rather than swapping one.
 */
export interface OwnerChoice {
  mode: 'leave' | 'add';
  /** `ProjectResource.resourceId` — the Resource id the API wants, not the row id. */
  resourceId: string | null;
  /** Carried for the review line only; never sent. */
  resourceName: string | null;
  /** Whole percent as the planner types it; divided by 100 on the way out. */
  percent: number;
}

export interface DateChoice {
  mode: TriState;
  /** ISO `YYYY-MM-DD`; meaningful only when `mode === 'set'`. */
  value: string | null;
}

export interface BulkEditSpec {
  owner: OwnerChoice;
  /** `null` means leave this axis alone — same convention as ClassificationPopover. */
  governanceClass: GovernanceClass | null;
  deliveryMode: DeliveryMode | null;
  plannedStart: DateChoice;
  plannedFinish: DateChoice;
}

export const EMPTY_BULK_EDIT_SPEC: BulkEditSpec = {
  owner: { mode: 'leave', resourceId: null, resourceName: null, percent: 100 },
  governanceClass: null,
  deliveryMode: null,
  plannedStart: { mode: 'leave', value: null },
  plannedFinish: { mode: 'leave', value: null },
};

/** True once the spec would write anything — gates the Apply button. */
export function hasAnyChange(spec: BulkEditSpec): boolean {
  return (
    isOwnerWrite(spec) ||
    spec.governanceClass !== null ||
    spec.deliveryMode !== null ||
    isDateWrite(spec.plannedStart) ||
    isDateWrite(spec.plannedFinish)
  );
}

function isOwnerWrite(spec: BulkEditSpec): boolean {
  return spec.owner.mode === 'add' && spec.owner.resourceId !== null;
}

function isDateWrite(choice: DateChoice): boolean {
  return choice.mode === 'clear' || (choice.mode === 'set' && !!choice.value);
}

/** Why a row was dropped before the request, rather than rejected by the server. */
export const SKIPPED_SUMMARY_OWNER_ONLY = 'summary_owner_only';

export interface BuiltBulkEdit {
  operations: BulkUpdateOperation[];
  /**
   * Rows the sheet deliberately did not send, because every field it would have
   * written is inapplicable to them. Reported alongside the server's own
   * `skipped` so the result phase's counts add up to the selection size.
   */
  skippedLocally: Array<{ id: string; code: string; message: string }>;
}

/**
 * Translate the form to one `update` op per selected row.
 *
 * **Owner is dropped per row rather than per batch.** The server refuses an
 * `owners` write on a summary task ("Cannot assign resources to a summary
 * task"), and the 207 contract rejects at *row* granularity, not field — so
 * sending `owners` to a summary row would throw away that row's classification
 * and date changes too. Omitting the field for those rows keeps the rest of the
 * edit intact, which is what the sheet's "Owner won't apply to those" warning
 * promises. A row left with nothing to write is not sent at all: an empty
 * `update` is a write that costs a version bump and changes nothing.
 */
export function buildBulkEditOperations(spec: BulkEditSpec, tasks: Task[]): BuiltBulkEdit {
  const shared: Record<string, unknown> = {};
  if (spec.governanceClass !== null) shared.governance_class = spec.governanceClass;
  if (spec.deliveryMode !== null) shared.delivery_mode = spec.deliveryMode;
  if (spec.plannedStart.mode === 'clear') shared.planned_start = null;
  else if (spec.plannedStart.mode === 'set' && spec.plannedStart.value) {
    shared.planned_start = spec.plannedStart.value;
  }
  if (spec.plannedFinish.mode === 'clear') shared.planned_finish = null;
  else if (spec.plannedFinish.mode === 'set' && spec.plannedFinish.value) {
    shared.planned_finish = spec.plannedFinish.value;
  }

  const ownerPayload = isOwnerWrite(spec)
    ? [{ resource: spec.owner.resourceId as string, units: spec.owner.percent / 100 }]
    : null;

  const operations: BulkUpdateOperation[] = [];
  const skippedLocally: BuiltBulkEdit['skippedLocally'] = [];

  for (const task of tasks) {
    const data: Record<string, unknown> = { ...shared };
    if (ownerPayload && !task.isSummary) data.owners = ownerPayload;

    if (Object.keys(data).length === 0) {
      skippedLocally.push({
        id: task.id,
        code: SKIPPED_SUMMARY_OWNER_ONLY,
        message: 'Summary rows can’t take an owner.',
      });
      continue;
    }
    operations.push({ op: 'update', id: task.id, data });
  }

  return { operations, skippedLocally };
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
 * The review line above Apply — the sheet's one guard rail against a mis-aimed
 * batch, and the reason it is worth a unit test: "Add owner" is the single
 * irreversible field here (no clear path through this endpoint, #2792), so the
 * planner has to be able to read what is about to happen before it does.
 */
export function summarizeBulkEditSpec(spec: BulkEditSpec): string {
  const parts: string[] = [];
  if (isOwnerWrite(spec)) {
    const name = spec.owner.resourceName ?? 'owner';
    parts.push(`Add ${name} (${spec.owner.percent}%)`);
  }
  if (spec.governanceClass) parts.push(`Governed by ${GOVERNANCE_LABEL[spec.governanceClass]}`);
  if (spec.deliveryMode) parts.push(`Progress from ${DELIVERY_LABEL[spec.deliveryMode]}`);
  parts.push(...summarizeDate('Planned start', spec.plannedStart));
  parts.push(...summarizeDate('Planned finish', spec.plannedFinish));
  return parts.join(' · ');
}

function summarizeDate(label: string, choice: DateChoice): string[] {
  if (choice.mode === 'clear') return [`Clear ${label.toLowerCase()}`];
  if (choice.mode === 'set' && choice.value) return [`${label} ${choice.value}`];
  return [];
}

/** Pre-flight counts the sheet warns on, all derived client-side from the selection. */
export interface SelectionPreflight {
  total: number;
  /** Rows that will refuse an owner write server-side. */
  summaryCount: number;
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
    notEditableCount: tasks.filter((t) => t.canEdit === false).length,
  };
}

/**
 * The shared value of one field across the selection, or `'mixed'` when the rows
 * disagree. Drives the "Leave unchanged — Mixed" label: the sheet must not
 * pretend to know a single current value it does not have.
 */
export function sharedValue<V>(tasks: Task[], get: (t: Task) => V): V | 'mixed' | null {
  if (tasks.length === 0) return null;
  const first = get(tasks[0]);
  return tasks.every((t) => get(t) === first) ? first : 'mixed';
}
